import { chromium } from 'patchright';
import config from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Lane PedidosYa (v2): navegación UI-natural SIN lógica anti-detección.
// Arquitectura evidenciada por recon (2026-10-23):
//   - El homepage pasa Cloudflare con el setup existente.
//   - goto DIRECTO a tiendas dispara challenge persistente -> prohibido.
//   - El path que funciona: home -> setear dirección Córdoba (modal) ->
//     buscador "Buscar locales" -> click al resultado de la tienda ->
//     API interna de groceries desde la página cargada (datos estructurados).
//   - La extracción por API interna (fetchCategories/fetchCategoryBatch/scanStore)
//     se conserva del scraper original: es código probado y devuelve datos limpios.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_FILE = join(__dirname, '..', 'data', 'py-store-scans.json');
const ROTATION_FILE = join(__dirname, '..', 'data', config.pedidosya.rotationFile || 'py-rotation.json');
const STATE_FILE = join(__dirname, '..', '.py-state.json');

const HOME = 'https://www.pedidosya.com.ar/';
const ADDRESS_QUERY = 'San Jose de Calasanz 50';

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function proxyConfig() {
  return process.env.PROXY_URL ? { proxy: { server: process.env.PROXY_URL } } : {};
}

export function isChallenged(title) {
  const t = (title || '').toLowerCase();
  return t.includes('momento') || t.includes('denegado') || t.includes('verific') || t.includes('captcha');
}

// ---- helpers puros (testeables) ----

/** Extrae el token único (uuid) de la URL de una tienda PY para matchear hrefs de resultados. */
export function extractStoreToken(url) {
  const m = String(url || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

/** La sugerencia correcta del autocomplete es la de Córdoba (hay una idéntica para Buenos Aires). */
export function isCordobaSuggestion(text) {
  return !!text && /calasanz/i.test(text) && /ciudad de c[oó]rdoba/i.test(text);
}

/** El botón "Enviar a ..." refleja la dirección activa de la sesión. */
export function addressIsCordoba(text) {
  return /calasanz|c[oó]rdoba/i.test(text || '');
}

// ---- navegación UI-natural ----

async function waitForClear(page, label, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const title = await page.title().catch(() => '');
    if (!isChallenged(title)) return true;
    await page.waitForTimeout(5000);
  }
  return false;
}

async function humanWarmup(page) {
  for (let k = 0; k < 3; k++) {
    const x = 150 + Math.random() * 1000;
    const y = 150 + Math.random() * 500;
    await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) }).catch(() => {});
    await page.waitForTimeout(300 + Math.random() * 700);
  }
  await page.evaluate(() => window.scrollBy(0, 250 + Math.random() * 450));
  await page.waitForTimeout(500 + Math.random() * 800);
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Clic real de mouse al centro del primer elemento visible cuyo texto matchea. */
async function realClickByText(page, regex, maxLen = 120) {
  const box = await page.evaluate(({ source, maxLen }) => {
    const rx = new RegExp(source, 'i');
    const el = [...document.querySelectorAll('button, [role="button"], a, div, li, section, span, p')]
      .find(el => el.offsetParent && (el.innerText || '').trim()
        && rx.test(el.innerText) && el.innerText.trim().length <= maxLen);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.innerText.trim().substring(0, 80) };
  }, { source: regex.source, maxLen }).catch(() => null);
  if (!box) return null;
  await page.mouse.click(box.x, box.y).catch(() => {});
  return box.text;
}

/** Cierra modales de onboarding/bienvenida si aparecen (variantes de primera visita). */
async function dismissOnboarding(page) {
  await realClickByText(page, /^(entendido|aceptar|continuar|omitir)\b/i, 40);
}

async function readAddress(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .find(el => /enviar a/i.test(el.innerText || ''));
    return el ? (el.innerText || '').trim().replace(/\s+/g, ' ') : '';
  }).catch(() => '');
}

/** Coordenadas de la sugerencia de Córdoba dentro del modal (para clic real). */
async function findCordobaSuggestion(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('div, li, section, span, p')].filter(el =>
      el.offsetParent && el.innerText
      && /calasanz/i.test(el.innerText) && /ciudad de c[oó]rdoba/i.test(el.innerText)
      && el.innerText.trim().length < 200);
    if (all.length === 0) return null;
    const deepest = all.filter(el => !all.some(o => o !== el && el.contains(o)));
    const el = deepest[0] || all[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.innerText.trim().substring(0, 120) };
  }).catch(() => null);
}

/**
 * Setea la dirección de Córdoba via UI (receta del recon: botón Enviar a ->
 * input dirección -> sugerencia Ciudad de Córdoba -> Confirmar).
 * Devuelve true si quedó seteada; false si no (la lane termina sin ofertas, sin error fatal).
 */
async function ensureAddress(page) {
  let addr = await readAddress(page);
  if (addressIsCordoba(addr)) {
    console.log(`[PedidosYa] Dirección ya activa: ${addr}`);
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    await dismissOnboarding(page);

    const opened = await realClickByText(page, /^enviar a/i, 40);
    if (!opened) {
      console.log('[PedidosYa] Botón "Enviar a" no encontrado');
      return false;
    }
    await page.waitForTimeout(4000);

    const focused = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')]
        .find(i => i.offsetParent && /direcci|referencia/i.test(i.placeholder || ''));
      if (el) { el.focus(); return true; }
      return false;
    }).catch(() => false);
    if (!focused) {
      console.log('[PedidosYa] Input de dirección no encontrado en el modal');
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }

    await page.keyboard.type(ADDRESS_QUERY, { delay: 70 });

    // la latencia del autocomplete varía (9s en un recon, >9s en otro): polling con diagnóstico
    let sug = null;
    const sugDeadline = Date.now() + 20000;
    while (Date.now() < sugDeadline && !sug) {
      sug = await findCordobaSuggestion(page);
      if (!sug) await page.waitForTimeout(2000);
    }
    if (!sug) {
      const modalDump = await page.evaluate(() => {
        const dlg = document.querySelector('.react-responsive-modal-modal, [role="dialog"]');
        return dlg ? (dlg.innerText || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 15) : null;
      }).catch(() => null);
      console.log(`[PedidosYa] Intento ${attempt}: sugerencia de Córdoba no apareció. Modal: ${JSON.stringify(modalDump)}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(2000);
      continue;
    }
    await page.mouse.click(sug.x, sug.y);
    console.log(`[PedidosYa] Sugerencia elegida: ${sug.text}`);
    await page.waitForTimeout(7000);

    // Confirmación: el botón real es <button type="submit" data-testid="location-v2-map-footer-confirm">
    // (evidencia recon 12). Queda bajo el fold en viewports de 768px: los clics por coordenadas
    // no aterrizaban; el locator de Playwright hace scroll y actionability checks.
    for (let step = 0; step < 4; step++) {
      const primary = page.locator('[data-testid="location-v2-map-footer-confirm"]').first();
      const fallback = page.getByRole('button', { name: /^Confirmar$/i }).first();
      const btn = (await primary.count().catch(() => 0)) > 0 ? primary : fallback;
      const count = await btn.count().catch(() => 0);
      if (count === 0) break;
      const disabled = await btn.isDisabled().catch(() => null);
      if (disabled) {
        console.log('[PedidosYa] Confirmar deshabilitado, esperando geocodificación...');
        await page.waitForTimeout(4000);
        continue;
      }
      const clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(e => {
        console.log(`[PedidosYa] click en Confirmar falló: ${e.message.substring(0, 80)}`);
        return false;
      });
      if (!clicked) break;
      console.log(`[PedidosYa] Confirmación paso ${step + 1} clickeada`);
      await page.waitForTimeout(5000);
      const addrNow = await readAddress(page);
      if (addressIsCordoba(addrNow)) break;
    }

    // Diagnóstico: si quedó un modal abierto, loguearlo (evidencia para iterar)
    const modalLeft = await page.evaluate(() => {
      const dlg = document.querySelector('.react-responsive-modal-modal, [role="dialog"]');
      return dlg && dlg.offsetParent
        ? (dlg.innerText || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12)
        : null;
    }).catch(() => null);
    if (modalLeft) console.log('[PedidosYa] Modal restante tras confirmar:', JSON.stringify(modalLeft));

    addr = await readAddress(page);
    if (addressIsCordoba(addr)) {
      console.log(`[PedidosYa] Dirección seteada: ${addr}`);
      return true;
    }
    // verificación con recarga fresca (el botón puede quedar stale)
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(8000);
    addr = await readAddress(page);
    if (addressIsCordoba(addr)) {
      console.log(`[PedidosYa] Dirección seteada (tras recarga): ${addr}`);
      return true;
    }
    console.log(`[PedidosYa] Intento ${attempt}: dirección sigue en "${addr || 'vacía'}"`);
  }

  console.log('[PedidosYa] No se pudo setear la dirección de Córdoba, lane sin ofertas');
  return false;
}

/**
 * Carga la página de una tienda vía buscador (NO goto directo: challenge).
 * Devuelve true si la tienda quedó cargada y limpia de challenge.
 */
async function searchStorePage(page, store) {
  const token = extractStoreToken(store.url);
  if (!token) {
    console.log(`  [${store.name}] URL sin token único, no se puede buscar`);
    return false;
  }

  const hasSearch = await page.evaluate(() => {
    const el = [...document.querySelectorAll('input')]
      .find(i => i.offsetParent && /buscar/i.test(i.placeholder || ''));
    if (el) { el.focus(); return true; }
    return false;
  }).catch(() => false);
  if (!hasSearch) {
    console.log(`  [${store.name}] Buscador no encontrado en el home`);
    return false;
  }

  await page.keyboard.type(store.name, { delay: 70 });

  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const box = await page.evaluate(token => {
      const a = [...document.querySelectorAll(`a[href*="${token}"]`)][0];
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href };
    }, token).catch(() => null);

    if (box) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(10000);
      let title = await page.title().catch(() => '');
      if (isChallenged(title)) {
        console.log(`  [${store.name}] Challenge al entrar, esperando 20s una vez`);
        await page.waitForTimeout(20000);
        title = await page.title().catch(() => '');
      }
      if (isChallenged(title)) {
        console.log(`  [${store.name}] Tienda bloqueada, se salta`);
        return false;
      }
      console.log(`  [${store.name}] Tienda cargada: ${title.substring(0, 70)}`);
      return true;
    }
    await page.waitForTimeout(1500);
  }

  console.log(`  [${store.name}] Sin resultados de búsqueda`);
  return false;
}

// ---- rotación (existente, intacta) ----

function loadScanTimes() {
  try {
    if (!existsSync(SCAN_FILE)) return {};
    return JSON.parse(readFileSync(SCAN_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveScanTimes(times) {
  try {
    const dir = dirname(SCAN_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SCAN_FILE, JSON.stringify(times, null, 2));
  } catch {}
}

function loadRotationCursor() {
  try {
    if (!existsSync(ROTATION_FILE)) return 0;
    const data = JSON.parse(readFileSync(ROTATION_FILE, 'utf-8'));
    return Number.isInteger(data.cursor) && data.cursor >= 0 ? data.cursor : 0;
  } catch { return 0; }
}

function saveRotationCursor(cursor) {
  try {
    const dir = dirname(ROTATION_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ROTATION_FILE, JSON.stringify({ cursor }));
  } catch {}
}

export function getStoresToScan(storeFilter) {
  const now = Date.now();
  const scans = loadScanTimes();
  const cooldown = config.pedidosya.storeScanCooldownMs;

  if (storeFilter) {
    return config.pedidosya.stores.filter(s => s.vendorId === storeFilter || s.name === storeFilter);
  }

  let pool = config.pedidosya.stores.filter(s => now - (scans[s.vendorId] || 0) >= cooldown);
  if (pool.length === 0) {
    pool = [...config.pedidosya.stores];
  }

  const perRun = Math.min(config.pedidosya.storesPerRun || pool.length, pool.length);
  const start = loadRotationCursor() % pool.length;
  const toScan = [];
  for (let i = 0; i < perRun; i++) {
    toScan.push(pool[(start + i) % pool.length]);
  }
  saveRotationCursor(start + perRun);

  return toScan;
}

function markScanned(vendorIds) {
  const scans = loadScanTimes();
  const now = Date.now();
  for (const id of vendorIds) {
    scans[id] = now;
  }
  saveScanTimes(scans);
}

// ---- API interna de groceries (existente, probada; requiere sesión con cookies) ----

// Errores que indican que la página fue destruida por un re-challenge (Cloudflare/PX)
const isNavDamage = msg => /Execution context was destroyed|Target crashed|Target closed|Protocol error/i.test(msg || '');

// Solo trae las categorías de la tienda y devuelve el array plano de ids (tope + hijas)
async function fetchCategories(page, vendorId) {
  try {
    return await page.evaluate(async (vendorId) => {
      try {
        const catResp = await fetch(`/groceries/web/v1/vendors/${vendorId}/categories`, { credentials: 'include' });
        if (!catResp.ok) return { error: `categories:${catResp.status}` };
        const catData = await catResp.json();
        const allCatIds = [];
        for (const cat of (catData.categories || [])) {
          allCatIds.push(cat.id);
          for (const child of (cat.children || [])) {
            allCatIds.push(child.id);
          }
        }
        return { catIds: allCatIds };
      } catch (e) {
        return { error: e.message };
      }
    }, vendorId);
  } catch (e) {
    return { error: e.message };
  }
}

// Escanea UN lote chico de categorías en un solo page.evaluate (parsing intacto)
async function fetchCategoryBatch(page, vendorId, catIds, maxPriceCheap) {
  return page.evaluate(async ({ vendorId, catIds, maxPriceCheap }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const discountedItems = [];
      const cheapItems = [];
      let throttleCount = 0;
      let catsScanned = 0;
      const PAGE_LIMIT = 100;

      for (const catId of catIds) {
        let page = 0;
        let hasMore = true;
        let catRetries = 0;

        while (hasMore) {
          try {
            const resp = await fetch(`/groceries/web/v1/vendors/${vendorId}/products?categoryId=${catId}&limit=${PAGE_LIMIT}&page=${page}`, { credentials: 'include' });
            if (resp.status === 429) {
              throttleCount++;
              if (catRetries < 2 && throttleCount < 6) {
                catRetries++;
                await sleep(15000 + Math.random() * 15000);
                continue;
              }
              break;
            }
            catRetries = 0;
            if (resp.status !== 200) break;
            const pData = await resp.json();
            const items = pData.items || [];
            if (items.length === 0) break;

            for (const item of items) {
              const name = item.name || item.description || '';
              const price = item.pricing?.price ?? 0;
              const originalPrice = item.pricing?.beforePrice ?? item.pricing?.price ?? 0;
              const formattedPrice = item.pricing?.formattedPrices?.price || null;
              const formattedOriginal = item.pricing?.formattedPrices?.originalPrice || null;
              let discount = 0;
              let campaignTag = '';

              if (item.campaigns && item.campaigns.length > 0) {
                for (const c of item.campaigns) {
                  const val = c.configuration?.value || 0;
                  const tag = (c.tag || '').toLowerCase();
                  const type = c.type || '';
                  let effectiveDiscount = val;

                  if (type === 'multi-buy' || type === 'free_item') {
                    const m = tag.match(/(\d+)\s*x\s*(\d+)/);
                    if (m) {
                      const pay = parseInt(m[2]);
                      const get = parseInt(m[1]);
                      effectiveDiscount = Math.round(((get - pay) / get) * 100);
                    }
                  }

                  if (/1\s*ud\.?\s*al\s*\d+%|2da\.?\s*ud|segunda\s*unidad|dto\.?\s*en\s*2da/.test(tag)) {
                    effectiveDiscount = Math.round(val / 2);
                  }

                  if (effectiveDiscount > discount) {
                    discount = effectiveDiscount;
                    campaignTag = c.tag || '';
                  }
                }
              }

              if (discount > 0 && name) {
                discountedItems.push({ name, discount, campaignTag, price, originalPrice, formattedPrice, formattedOriginal });
              }

              if (price > 0 && name && price < maxPriceCheap) {
                const isAlwaysCheap = /jugo.*(polvo|concentrado|instantáneo)|en\s*polvo|clight|jugoi|tang(?!\s)|drew|frutigran|naranjú|saborizante|caramelo|masticable|turr[oó]n|oblea|alfajor|chupet|mentita|menta|cabezal|pastilla|golosina|chocolate.*\d+\s*g|galleta.*\d+\s*g|palito|surtido|bocadito|codito|lamparita|mini\s|bollar|buyla|bajonero/i.test(name);
                if (!isAlwaysCheap) {
                  cheapItems.push({ name, price });
                }
              }
            }

            hasMore = items.length >= PAGE_LIMIT;
            page++;
            if (hasMore) await sleep(80 + Math.random() * 200);
          } catch {
            break;
          }
        }
        catsScanned++;
      }

      return { discountedItems, cheapItems, catsScanned, throttles: throttleCount };
    } catch (e) {
      return { error: e.message };
    }
  }, { vendorId, catIds, maxPriceCheap });
}

// Re-establece la página tras un re-challenge (Turnstile / home limpio)
async function recoverPage(page, storeName) {
  console.log(`  [${storeName}] Página inestable tras challenge, recuperando...`);
  await page.waitForTimeout(5000);
  let title = await page.title().catch(() => '');
  if (isChallenged(title)) {
    console.log(`  [${storeName}] Challenge detectado, esperando (hasta 60s)...`);
    if (!await waitForClear(page, storeName, 60000)) {
      console.log(`  [${storeName}] Sigue bloqueado, recargando home...`);
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(8000 + Math.random() * 4000);
      if (isChallenged(await page.title().catch(() => ''))) return false;
    }
  }
  await humanWarmup(page).catch(() => {});
  return true;
}

// Escanea la tienda por lotes: si un lote muere por re-challenge reintenta hasta 3 veces;
// si sigue fallando, aborta los lotes restantes PERO conserva lo ya recolectado (parcial)
async function scanStore(page, store, maxPriceCheap) {
  const BATCH = 5;
  const catRes = await fetchCategories(page, store.vendorId);
  if (catRes.error) return { error: catRes.error };

  const allCatIds = catRes.catIds;
  const discountedItems = [];
  const cheapItems = [];
  let catsScanned = 0;
  let throttleCount = 0;
  let aborted = false;

  for (let i = 0; i < allCatIds.length; i += BATCH) {
    const batchIds = allCatIds.slice(i, i + BATCH);
    let batchRes = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        batchRes = await fetchCategoryBatch(page, store.vendorId, batchIds, maxPriceCheap);
      } catch (e) {
        batchRes = { error: e.message };
      }
      if (batchRes && !batchRes.error) break;

      if (isNavDamage(batchRes?.error)) {
        if (attempt < 3) {
          if (!await recoverPage(page, store.name)) {
            batchRes = { error: 'categories:403 blocked-unrecoverable' };
            break;
          }
          continue;
        }
      }
      break;
    }

    if (!batchRes || batchRes.error) {
      console.log(`  [${store.name}] Lote ${Math.floor(i / BATCH) + 1} falló (${batchRes?.error || 'desconocido'}), se conservan resultados parciales`);
      aborted = true;
      break;
    }

    discountedItems.push(...batchRes.discountedItems);
    cheapItems.push(...batchRes.cheapItems);
    catsScanned += batchRes.catsScanned;
    throttleCount += batchRes.throttles;

    if (i + BATCH < allCatIds.length) await page.waitForTimeout(400 + Math.random() * 600);
  }

  const hasData = discountedItems.length > 0 || cheapItems.length > 0;
  if (aborted && !hasData && catsScanned === 0) {
    return { error: 'categories:403 aborted-no-data' };
  }

  return {
    discountedItems, cheapItems,
    totalCats: allCatIds.length,
    catsScanned: Math.min(catsScanned, allCatIds.length),
    rateLimited: throttleCount > 0,
    throttles: throttleCount,
    partial: aborted,
  };
}

// ---- orquestador ----

export async function scrapePedidosYa(storeFilter = '') {
  const offers = [];
  const stores = getStoresToScan(storeFilter);

  if (stores.length === 0) {
    console.log('[PedidosYa] All stores scanned recently, skipping');
    return offers;
  }

  console.log(`[PedidosYa] Scraping ${stores.length} stores: ${stores.map(s => s.name).join(', ')}`);

  let context;
  const scannedIds = [];
  try {
    const launchOpts = {
      headless: process.env.HEADLESS === 'true',
      viewport: pick(VIEWPORTS),
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      ...proxyConfig(),
    };
    if (existsSync(STATE_FILE)) {
      console.log('[PedidosYa] Restoring previous session...');
      launchOpts.storageState = STATE_FILE;
    }
    context = await chromium.launchPersistentContext('', launchOpts);

    const page = context.pages()[0] || await context.newPage();

    // Fase 1: home (pasa CF con el setup existente)
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500 + Math.random() * 2000);
    await humanWarmup(page).catch(() => {});

    if (isChallenged(await page.title().catch(() => ''))) {
      console.log('[PedidosYa] Waiting for Turnstile (up to 60s)...');
      if (!await waitForClear(page, 'home', 60000)) {
        console.log('[PedidosYa] Blocked by Cloudflare');
        return offers;
      }
    }
    console.log('[PedidosYa] Cloudflare passed!');
    await page.waitForTimeout(2000);

    // Fase 2: dirección de Córdoba (necesaria para que el buscador devuelva tiendas locales)
    const okAddress = await ensureAddress(page);
    if (!okAddress) return offers;

    // Fase 3: por tienda: búsqueda -> página cargada -> API interna
    for (const store of stores) {
      console.log(`\n[PedidosYa] Scraping: ${store.name} (vendorId=${store.vendorId})`);
      try {
        const loaded = await searchStorePage(page, store);
        if (!loaded) continue;

        const data = await scanStore(page, store, config.maxPriceCheap);
        if (!data || data.error) {
          console.log(`  [${store.name}] Skipped: ${JSON.stringify(data)}`);
          continue;
        }

        scannedIds.push(store.vendorId);
        console.log(`  [${store.name}] ${data.catsScanned}/${data.totalCats} cats, ${data.discountedItems.length} discounted, ${data.cheapItems.length} under $${config.maxPriceCheap}${data.rateLimited ? ' [RATE LIMITED]' : ''}`);

        for (const item of data.discountedItems) {
          if (item.discount >= (store.minDiscount || config.discounts.super)) {
            const promoMatch = item.campaignTag?.match(/(\d+)\s*x\s*(\d+)/i);
            offers.push({
              platform: 'PedidosYa', category: 'supermercado',
              restaurant: store.name, slug: store.url || '', discount: item.discount,
              name: item.name,
              description: `${item.discount}% OFF ${item.campaignTag} - ${item.name}`,
              originalPrice: item.formattedOriginal || (item.originalPrice ? `$${item.originalPrice.toLocaleString('es-AR')}` : null),
              currentPrice: item.formattedPrice || (item.price ? `$${item.price.toLocaleString('es-AR')}` : null),
              url: store.url || '', deliveryTime: '', rating: '', imageUrl: '',
              promoType: promoMatch ? `${promoMatch[1]}x${promoMatch[2]}` : null,
            });
          }
        }

        for (const item of data.cheapItems) {
          offers.push({
            platform: 'PedidosYa', category: 'supermercado',
            restaurant: store.name, slug: store.url || '', discount: 0,
            name: item.name,
            description: `$${item.price} - ${item.name}`,
            originalPrice: null, currentPrice: `$${item.price}`,
            url: store.url || '', deliveryTime: '', rating: '', imageUrl: '',
            isCheapProduct: true,
          });
        }
      } catch (e) {
        console.log(`  [${store.name}] Error: ${e.message.substring(0, 120)}`);
      }

      // volver al home para la próxima búsqueda (el home pasa CF; las tiendas no por goto)
      if (store !== stores[stores.length - 1]) {
        await page.waitForTimeout(2000 + Math.random() * 2000);
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(6000);
        if (isChallenged(await page.title().catch(() => ''))) {
          if (!await waitForClear(page, 'home', 30000)) {
            console.log('[PedidosYa] Home bloqueado entre tiendas, corto la corrida');
            break;
          }
        }
      }
    }

    if (scannedIds.length > 0) markScanned(scannedIds);
    console.log(`[PedidosYa] ${offers.length} ofertas encontradas`);
  } catch (err) {
    console.error(`[PedidosYa] Error: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return offers;
}
