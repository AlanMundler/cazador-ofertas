// Adaptador Uber Eats: browser headed (Cloudflare/bot-defense) + RPCs internos.
// Contrato verificado en spike/ue/run-final.log (2026-11-18):
//   getFeedByIdV1 {feedID:"shop_feed"} = directorio grocery del punto (una página, hasMore:false)
//   getStoreV1     {storeUuid, catalogSectionOffset:1} = catálogo (~15 secciones)
// La cookie `uev2.loc` manda: la ubicación se setea por la dirección, no por el body.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { UBEREATS } from '../core/platforms.js';
import { normalizeProduct } from '../core/normalize.js';

const ORIGIN = 'https://www.ubereats.com';
const SUPER_BRANDS = /(jumbo|disco|vea|carrefour|coto|makro|la an[oó]nima|walmart|changomas|sumo)/i;
const MINI_SUPER = /(super|hiper|mercado|market|almac[eé]n)/i;

export function classifyUberStore({ title = '', merchantType = null } = {}) {
  if (merchantType && merchantType !== 'MERCHANT_TYPE_GROCERY') return 'otro';
  if (SUPER_BRANDS.test(title) || MINI_SUPER.test(title)) return SUPER_BRANDS.test(title) ? 'super' : 'vertical';
  return 'vertical';
}

export function catalogItems(storeJson) {
  const rows = [];
  const sections = storeJson?.data?.catalogSectionsMap ?? {};
  for (const chunks of Object.values(sections)) {
    for (const chunk of Array.isArray(chunks) ? chunks : Object.values(chunks ?? {})) {
      const payload = chunk?.payload?.standardItemsPayload;
      if (!payload) continue;
      const sectionTitle = payload.title?.text ?? payload.title ?? null;
      for (const item of payload.catalogItems ?? []) {
        rows.push({ ...item, __sectionTitle: sectionTitle });
      }
    }
  }
  return rows;
}

export function feedStores(feedJson) {
  const items = feedJson?.data?.feedItems ?? [];
  const stores = new Map();
  for (const item of items) {
    if (item?.type === 'MINI_STORE' && item.store?.storeUuid) {
      stores.set(item.store.storeUuid, {
        storeUuid: item.store.storeUuid,
        title: item.store.title?.text ?? '',
        actionUrl: item.store.actionUrl ?? '',
      });
    }
    for (const store of item?.carousel?.stores ?? []) {
      if (store?.storeUuid && !stores.has(store.storeUuid)) {
        stores.set(store.storeUuid, {
          storeUuid: store.storeUuid,
          title: store.title?.text ?? '',
          actionUrl: store.actionUrl ?? '',
        });
      }
    }
  }
  return [...stores.values()];
}

const DROP_HEADERS = /^(:|content-length$|accept-encoding$|connection$|host$|sec-fetch-|priority$)/i;
const safeHeaders = headers => Object.fromEntries(
  Object.entries(headers ?? {}).filter(([name]) => !DROP_HEADERS.test(name)),
);

function decodeJsonish(value) {
  const attempts = [
    () => JSON.parse(value),
    () => JSON.parse(decodeURIComponent(value)),
    () => JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
    () => JSON.parse(decodeURIComponent(Buffer.from(value, 'base64').toString('utf8'))),
  ];
  for (const attempt of attempts) {
    try { const parsed = attempt(); if (parsed) return parsed; } catch {}
  }
  return null;
}

export function deepLocation(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (typeof node.latitude === 'number' && typeof node.longitude === 'number') {
    return { address: node.address?.address ?? node.address ?? node.reference ?? null, lat: node.latitude, lng: node.longitude };
  }
  for (const value of Object.values(node)) {
    const found = deepLocation(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function locationFromCookie(value) {
  const decoded = decodeJsonish(value);
  return decoded ? deepLocation(decoded) : null;
}

async function setAddress(page, address, log) {
  const input = await page.$('input[data-testid="address-autocomplete-input"], input[placeholder*="dirección"], input[placeholder*="address"], input[id*="location"], input[aria-label*="dirección"], input[aria-label*="address"]');
  if (!input) return false;
  await input.click();
  await page.waitForTimeout(400);
  await input.fill(address);
  await page.waitForTimeout(4000);

  const suggestions = [];
  for (const element of await page.$$('[data-testid="address-option"], [role="option"], li[id*="result"]')) {
    suggestions.push({ element, text: ((await element.textContent()) ?? '').trim() });
  }
  const best = suggestions
    .filter(item => /c[oó]rdoba/i.test(item.text))
    .map(item => ({
      ...item,
      score: (/calasanz/i.test(item.text) ? 2 : 0) + (/(^|\D)58(\D|$)/.test(item.text) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best) {
    log(`ubereats: sin sugerencia de Córdoba (${suggestions.length} opciones)`);
    return false;
  }
  await best.element.click();
  await page.waitForTimeout(5500);
  log(`ubereats: dirección "${best.text.slice(0, 60)}"`);
  return true;
}

/**
 * Recolecta ofertas de Uber Eats para una dirección.
 * Requiere patchright + chromium y modo headed (headless = reCAPTCHA).
 */
export async function collectUberEats({
  address = 'San José de Calasanz 58, Córdoba, Argentina',
  point = { lat: -31.412943, lng: -64.1966036 },
  maxStores = 10,
  headless = false,
  log = () => {},
} = {}) {
  const { chromium } = await import('patchright');
  const profile = mkdtempSync(join(tmpdir(), 'ue-adapter-'));
  const traffic = [];
  const launchOptions = {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    geolocation: { latitude: point.lat, longitude: point.lng },
    permissions: ['geolocation'],
  };
  const proxyUrl = process.env.UE_PROXY_URL || process.env.PROXY_URL;
  if (proxyUrl) launchOptions.proxy = { server: proxyUrl };
  const context = await chromium.launchPersistentContext(profile, launchOptions);

  const products = [];
  const scanned = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.on('response', async response => {
      let url;
      try { url = response.url(); } catch { return; }
      if (!url.includes('_p/api/')) return;
      const record = { path: new URL(url).pathname, status: response.status(), headers: {}, postData: null, json: null };
      try { record.headers = await response.request().allHeaders(); } catch {}
      try { record.postData = response.request().postData(); } catch {}
      try { record.json = await response.json(); } catch {}
      traffic.push(record);
    });

    await page.goto(`${ORIGIN}/ar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const title = await page.title().catch(() => '');
    if (/momento|denegado|just a moment/i.test(title)) {
      await page.waitForTimeout(20000);
    }

    await setAddress(page, address, log);
    await page.waitForTimeout(3000);

    // Fallback determinístico: si el modal no dejó la cookie, se inyecta el `uev2.loc`
    // (misma forma que usa la app: address/lat/lng URL-encoded) y se recarga.
    let cookies = await context.cookies(ORIGIN);
    let locCookie = cookies.find(cookie => cookie.name === 'uev2.loc');
    if (!locCookie) {
      const payload = {
        address,
        reference: address,
        referenceType: 'google_places',
        latitude: point.lat,
        longitude: point.lng,
      };
      await context.addCookies([{
        name: 'uev2.loc',
        value: encodeURIComponent(JSON.stringify(payload)),
        domain: '.ubereats.com',
        path: '/',
      }]).catch(() => {});
      await page.goto(`${ORIGIN}/ar`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(4000);
      cookies = await context.cookies(ORIGIN);
      locCookie = cookies.find(cookie => cookie.name === 'uev2.loc');
      log('ubereats: uev2.loc inyectada por fallback');
    }
    const location = locCookie ? locationFromCookie(locCookie.value) : null;
    if (!location) {
      log('ubereats: sin uev2.loc; se usa GEOIP + coordenadas de config para el feed');
    }

    const template = traffic
      .filter(record => /getFeedV1/.test(record.path) && record.status === 200 && record.json?.status === 'success')
      .sort((a, b) => JSON.stringify(b.json).length - JSON.stringify(a.json).length)[0];

    // CI puede no disparar getFeedV1 en la home: se usan headers estáticos.
    // Verificado: getFeedByIdV1 responde 200 con `x-csrf-token: x` (probe WARP, run 44529098634).
    const headers = template
      ? safeHeaders(template.headers)
      : {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': 'x',
        origin: ORIGIN,
        referer: `${ORIGIN}/ar`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      };
    if (!template) log('ubereats: sin getFeedV1 capturado; headers estáticos');
    const replay = async (path, body) => {
      const result = await page.evaluate(async ({ path, body, headers }) => {
        const response = await fetch(`https://www.ubereats.com${path}`, {
          method: 'POST', headers, body: JSON.stringify(body), credentials: 'include',
        });
        const text = await response.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        return { status: response.status, json };
      }, { path, body, headers });
      return result;
    };

    const shopFeed = await replay('/_p/api/getFeedByIdV1?localeCode=ar', {
      feedID: 'shop_feed',
      deliveryLocation: [{ type: 'USER' }, { type: 'GEOIP' }],
      feedmakerCtx: '',
      cacheKey: '',
    });
    if (shopFeed.status !== 200 || shopFeed.json?.status !== 'success') {
      throw new Error(`ubereats feed failed: ${shopFeed.status}`);
    }

    const available = feedStores(shopFeed.json)
      .filter(store => !/farmacia|veterinaria|drugstore|pets|mascota/i.test(store.title));
    if (available.length === 0) {
      throw new Error('ubereats: feed vacío (¿IP fuera de Argentina?)');
    }
    // Guardia de ciudad: sólo se acepta el feed si trae marcas argentinas conocidas.
    // (Sin cookie, `GEOIP` en CI puede resolver a EE.UU. — caso real: Liquor Stores.)
    const AR_BRANDS = /carrefour|tadicor|justmart|jumbo|disco|coto|pedidosya|farmacity|carnave|la an[oó]nima|makro|sumo|d[ií]a\b|vea\b|changomas|walmart argentina|kiosco 30|365 (argentina|kioscos)/i;
    const argentine = available.filter(store => AR_BRANDS.test(store.title));
    if (argentine.length === 0) {
      throw new Error(`ubereats: feed fuera de Argentina (${available.slice(0, 3).map(s => s.title).join(', ')})`);
    }
    const stores = argentine.slice(0, maxStores);
    for (const store of stores) {
      const catalog = await replay('/_p/api/getStoreV1?localeCode=ar', {
        storeUuid: store.storeUuid,
        catalogSectionOffset: 1,
      });
      const data = catalog.json?.data ?? {};
      const merchantType = data.storeMerchantTypeInfo?.uberMerchantType?.type ?? null;
      const kind = classifyUberStore({ title: store.title, merchantType });
      const rows = catalogItems(catalog.json);
      const url = store.actionUrl ? `${ORIGIN}${store.actionUrl}` : `${ORIGIN}/ar`;
      for (const row of rows) {
        const result = normalizeProduct({ ...row, url }, {
          platform: UBEREATS,
          storeId: store.storeUuid,
          storeName: store.title,
          storeKind: kind,
          sampled: true,
          fetchedAt: new Date().toISOString(),
        });
        if (result.ok) products.push(result.product);
      }
      scanned.push({ id: store.storeUuid, name: store.title, kind, items: rows.length });
      log(`ubereats ${store.title}: ${rows.length} productos`);
    }

    const byKind = scanned.reduce((acc, store) => ({ ...acc, [store.kind]: (acc[store.kind] ?? 0) + 1 }), {});
    return {
      products,
      coverage: {
        platform: UBEREATS,
        point: { lat: location?.lat ?? point.lat, lng: location?.lng ?? point.lng },
        fetchedAt: new Date().toISOString(),
        storesSeen: scanned.length,
        storesAvailable: available.length,
        truncated: available.length > maxStores,
        storesByKind: byKind,
        missingChains: [],
        catalogCoverage: { itemsSeen: products.length, aislesAnnounced: null, sampled: true },
        scanned,
      },
    };
  } finally {
    await context.close().catch(() => {});
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
