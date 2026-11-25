// Adaptador PedidosYa: browser (sÃ³lo por cookies CF/PX) + APIs internas same-origin.
// Contrato verificado en spike/py/modal9.log y modal11.log (2026-11-18).
// La direcciÃ³n de entrega NO se usa: la cobertura sale del header `point` del shoplist.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { PEDIDOSYA } from '../core/platforms.js';
import { normalizeProduct } from '../core/normalize.js';

const HOME = 'https://www.pedidosya.com.ar/';

const SUPER_BRANDS = /(jumbo|disco|vea|carrefour|makro|coto|la an.nima|pedidosya market|sumo|changomas|walmart)/i;

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

async function storeCatalog(page, vendorId, { maxCategories, maxPages, concurrency = 4, log }) {
  return page.evaluate(async ({ vendorId, maxCategories, maxPages, concurrency }) => {
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
    const targets = maxCategories > 0 ? flat.slice(0, maxCategories) : flat;

    // Varias categorías en paralelo para que el barrido completo entre en tiempo.
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const category = targets[cursor++];
        let pageNumber = 0;
        while (true) {
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
          pageNumber += 1;
          if (maxPages > 0 && pageNumber >= maxPages) { truncated = true; break; }
          if (pageNumber > 40) { truncated = true; break; }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        scanned += 1;
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    return {
      status: categoriesResponse.status,
      categories: categories.length,
      categoriesScanned: scanned,
      scanned,
      requests,
      truncated,
      failed,
      items: [...items.values()],
    };
  }, { vendorId, maxCategories, maxPages, concurrency });
}

/**
 * Recolecta ofertas de PedidosYa para un punto de entrega.
 * Requiere patchright + chromium instalados.
 */
export async function collectPedidosYa({
  point,
  stateFile = '.py-state.json',
  maxStores = 0,
  maxCategories = 0,
  maxPages = 0,
  concurrency = 4,
  cacheDir = 'data/cache/py',
  cacheTtlMs = 90 * 60 * 1000,
  timeBudgetMs = 25 * 60 * 1000,
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
  // PedidosYa funciona por WARP; un proxy pÃºblico suele estar bloqueado (403).
  // Por eso usa su propio env y no hereda PROXY_URL genÃ©rico.
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
    const eligible = maxStores > 0 ? pool.slice(0, maxStores) : pool;

    // Caché por tienda: cada barrida cubre todas las tiendas, pero sólo refresca las vencidas.
    const readCache = id => {
      try {
        const data = JSON.parse(readFileSync(join(cacheDir, `${id}.json`), 'utf8'));
        return data && Array.isArray(data.products) ? data : null;
      } catch { return null; }
    };
    const writeCache = (id, list) => {
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, `${id}.json`), `${JSON.stringify({ fetchedAt: Date.now(), products: list })}\n`, 'utf8');
      } catch {}
    };

    const caches = new Map();
    for (const vendor of eligible) caches.set(vendor.id, readCache(vendor.id));

    const startedAt = Date.now();
    const ordered = [...eligible].sort((a, b) => (caches.get(a.id)?.fetchedAt ?? 0) - (caches.get(b.id)?.fetchedAt ?? 0));
    let cachedCount = 0;

    for (const vendor of ordered) {
      const cache = caches.get(vendor.id);
      const fresh = cache && Date.now() - cache.fetchedAt < cacheTtlMs;
      const overBudget = Date.now() - startedAt > timeBudgetMs;

      if (fresh || (overBudget && cache)) {
        products.push(...cache.products);
        cachedCount += 1;
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, items: cache.products.length, cached: true });
        continue;
      }
      if (overBudget) {
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, items: 0, error: 'sin tiempo en esta corrida' });
        continue;
      }

      try {
        let catalog = await storeCatalog(page, vendor.id, { maxCategories, maxPages, concurrency, log });
        // PedidosYa corta con 403 al pasar ~200 requests seguidas: se espera y se reintenta una vez.
        if (catalog.error) {
          log(`pedidosya ${vendor.name}: ${catalog.error}, esperando 45s`);
          await sleep(45000);
          catalog = await storeCatalog(page, vendor.id, { maxCategories, maxPages, concurrency, log });
        }
        if (catalog.error) throw new Error(`pedidosya ${vendor.name}: ${catalog.error}`);
        const normalized = [];
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
          if (result.ok) normalized.push(result.product);
        }
        products.push(...normalized);
        writeCache(vendor.id, normalized);
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, categories: catalog.categories, categoriesScanned: catalog.categoriesScanned, items: normalized.length, truncated: catalog.truncated, failed: catalog.failed });
        log(`pedidosya ${vendor.name}: ${normalized.length} productos (${catalog.requests} requests, ${catalog.categoriesScanned}/${catalog.categories} categorías)`);
      } catch (error) {
        scanned.push({ id: vendor.id, name: vendor.name, kind: vendor.kind, items: 0, error: error.message });
        log(`pedidosya ${vendor.name}: ${error.message}`);
      }
      await sleep(500);
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
        cachedStores: cachedCount,
        truncated: (maxStores > 0 && pool.length > maxStores) || scanned.some(store => store.truncated),
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
    // No pisar una sesiÃ³n buena con una bloqueada: sÃ³lo se guarda si hubo datos.
    if (stateFile && products.length > 0) {
      try { await context.storageState({ path: stateFile }); } catch {}
    }
    await context.close().catch(() => {});
  }
}





