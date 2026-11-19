// Adaptador PedidosYa: browser (sólo por cookies CF/PX) + APIs internas same-origin.
// Contrato verificado en spike/py/modal9.log y modal11.log (2026-11-18).
// La dirección de entrega NO se usa: la cobertura sale del header `point` del shoplist.

import { existsSync } from 'fs';

import { PEDIDOSYA } from '../core/platforms.js';
import { normalizeProduct } from '../core/normalize.js';

const HOME = 'https://www.pedidosya.com.ar/';

const SUPER_BRANDS = /(jumbo|disco|vea|carrefour|makro|coto|la an[oó]nima|pedidosya market|sumo|changomas|walmart)/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function classifyPedidosYaStore(name) {
  return SUPER_BRANDS.test(String(name ?? '')) ? 'super' : 'vertical';
}

export function productUrl(vendorId) {
  return `https://www.pedidosya.com.ar/mi-compra/${vendorId}`;
}

export function isChallenged(title) {
  const text = String(title ?? '').toLowerCase();
  return text.includes('momento') || text.includes('denegado') || text.includes('verific') || text.includes('captcha');
}

async function shoplistPage(page, point, pageNumber) {
  return page.evaluate(async ({ point, pageNumber }) => {
    const response = await fetch(`/v4/shoplist/vendors?size=30&page=${pageNumber}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filters: [],
        businessTypes: ['GROCERIES'],
        countryId: 3,
        point,
        sort: 'RANKING',
        offer: { occasions: ['DELIVERY', 'PICKUP'] },
      }),
    });
    const text = await response.text();
    try { return { status: response.status, body: JSON.parse(text) }; }
    catch { return { status: response.status, body: null, text: text.slice(0, 200) }; }
  }, { point, pageNumber });
}

async function storeCatalog(page, vendorId, { maxCategories, maxPages, log }) {
  return page.evaluate(async ({ vendorId, maxCategories, maxPages }) => {
    const categoriesResponse = await fetch(`/groceries/web/v1/vendors/${vendorId}/categories`, { credentials: 'include' });
    const categoriesBody = await categoriesResponse.json().catch(() => null);
    const categories = categoriesBody?.categories ?? [];
    if (!categoriesResponse.ok || categories.length === 0) {
      // Sin sesión válida (cookies CF/PX) esta API devuelve vacío: no confundir con "tienda sin catálogo".
      return { status: categoriesResponse.status, categories: 0, scanned: 0, requests: 0, truncated: false, failed: 1, items: [], error: `categories ${categoriesResponse.status}` };
    }
    const flat = [];
    for (const category of categories) {
      flat.push(category);
      for (const child of category.children ?? []) flat.push(child);
    }

    const items = new Map();
    let requests = 0;
    let scanned = 0;
    let truncated = false;
    let failed = 0;
    for (const category of flat.slice(0, maxCategories)) {
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const response = await fetch(`/groceries/web/v1/vendors/${vendorId}/products?categoryId=${category.id}&limit=100&page=${pageNumber}`, { credentials: 'include' });
        requests += 1;
        if (!response.ok) { failed += 1; break; }
        const body = await response.json().catch(() => null);
        const list = body?.items ?? [];
        for (const item of list) {
          const id = String(item?.id ?? item?.productId ?? '');
          if (id && !items.has(id)) items.set(id, item);
        }
        if (body?.lastPage || list.length < 100) break;
        if (pageNumber === maxPages - 1) truncated = true;
      }
      scanned += 1;
    }

    return {
      status: categoriesResponse.status,
      categories: categories.length,
      scanned,
      requests,
      truncated,
      failed,
      items: [...items.values()],
    };
  }, { vendorId, maxCategories, maxPages });
}

/**
 * Recolecta ofertas de PedidosYa para un punto de entrega.
 * Requiere patchright + chromium instalados.
 */
export async function collectPedidosYa({
  point,
  stateFile = '.py-state.json',
  maxStores = 23,
  maxCategories = 8,
  maxPages = 3,
  headless = false,
  log = () => {},
} = {}) {
  const { chromium } = await import('patchright');
  const launchOptions = {
    headless,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    viewport: { width: 1366, height: 768 },
  };
  // PedidosYa funciona por WARP; un proxy público suele estar bloqueado (403).
  // Por eso usa su propio env y no hereda PROXY_URL genérico.
  if (process.env.PY_PROXY_URL) launchOptions.proxy = { server: process.env.PY_PROXY_URL };
  if (stateFile && existsSync(stateFile)) launchOptions.storageState = stateFile;

  const context = await chromium.launchPersistentContext('', launchOptions);
  const products = [];
  const scanned = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    let title = await page.title().catch(() => '');
    if (isChallenged(title)) {
      log(`pedidosya: challenge (${title}), esperando 45s y recargando`);
      await page.waitForTimeout(45000);
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(4000);
      title = await page.title().catch(() => '');
    }
    if (isChallenged(title)) throw new Error(`pedidosya challenge: ${title}`);

    const first = await shoplistPage(page, point, 1);
    if (first.status !== 200 || !first.body?.vendors) {
      throw new Error(`pedidosya shoplist failed: ${first.status}`);
    }

    const vendors = new Map();
    let pageNumber = 1;
    let batch = first.body.vendors;
    while (batch.length > 0 && pageNumber <= 10) {
      for (const vendor of batch) {
        const id = String(vendor?.id ?? '');
        if (!id) continue;
        vendors.set(id, {
          id,
          name: vendor?.name ?? `Tienda ${id}`,
          modes: vendor?.delivery?.modes ?? [],
          kind: classifyPedidosYaStore(vendor?.name),
        });
      }
      pageNumber += 1;
      if (batch.length < 30) break;
      const next = await shoplistPage(page, point, pageNumber);
      if (next.status !== 200 || !next.body?.vendors) break;
      batch = next.body.vendors;
      await sleep(400);
    }

    const pool = [...vendors.values()]
      .filter(vendor => (vendor.modes.length === 0 || vendor.modes.includes('DELIVERY')))
      .sort((a, b) => (a.kind === 'super' ? 0 : 1) - (b.kind === 'super' ? 0 : 1));
    const eligible = pool.slice(0, maxStores);

    for (const vendor of eligible) {
      try {
        const catalog = await storeCatalog(page, vendor.id, { maxCategories, maxPages, log });
        if (catalog.error) throw new Error(`pedidosya ${vendor.name}: ${catalog.error}`);
        for (const item of catalog.items) {
          const result = normalizeProduct(item, {
            platform: PEDIDOSYA,
            storeId: vendor.id,
            storeName: vendor.name,
            storeKind: vendor.kind,
            sampled: false,
            deliverability: 'verified',
            url: productUrl(vendor.id),
            fetchedAt: new Date().toISOString(),
          });
          if (result.ok) products.push(result.product);
        }
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, categories: catalog.categories, items: catalog.items.length, truncated: catalog.truncated, failed: catalog.failed });
        log(`pedidosya ${vendor.name}: ${catalog.items.length} productos (${catalog.requests} requests)`);
      } catch (error) {
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, items: 0, error: error.message });
        log(`pedidosya ${vendor.name}: ${error.message}`);
      }
      await sleep(700);
    }

    const byKind = scanned.reduce((acc, store) => ({ ...acc, [store.kind]: (acc[store.kind] ?? 0) + 1 }), {});
    return {
      products,
      coverage: {
        platform: PEDIDOSYA,
        point,
        fetchedAt: new Date().toISOString(),
        storesSeen: scanned.length,
        storesAvailable: pool.length,
        truncated: pool.length > maxStores || scanned.some(store => store.truncated),
        storesByKind: byKind,
        missingChains: [],
        catalogCoverage: {
          itemsSeen: products.length,
          aislesAnnounced: scanned.reduce((sum, store) => sum + (store.categories ?? 0), 0),
          sampled: scanned.some(store => store.truncated),
        },
        scanned,
      },
    };
  } finally {
    // No pisar una sesión buena con una bloqueada: sólo se guarda si hubo datos.
    if (stateFile && products.length > 0) {
      try { await context.storageState({ path: stateFile }); } catch {}
    }
    await context.close().catch(() => {});
  }
}
