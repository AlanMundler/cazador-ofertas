import { chromium } from 'patchright';
import config from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_FILE = join(__dirname, '..', 'data', 'py-store-scans.json');
const ROTATION_FILE = join(__dirname, '..', 'data', config.pedidosya.rotationFile || 'py-rotation.json');

function loadRotationCursor() {
  try {
    if (!existsSync(ROTATION_FILE)) return 0;
    const data = JSON.parse(readFileSync(ROTATION_FILE, 'utf-8'));
    return Number.isInteger(data.cursor) && data.cursor >= 0 ? data.cursor : 0;
  } catch { return 0; }
}

function saveRotationCursor(cursor) {
  const dir = dirname(ROTATION_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(ROTATION_FILE, JSON.stringify({ cursor }));
}

function loadScanTimes() {
  try {
    if (!existsSync(SCAN_FILE)) return {};
    return JSON.parse(readFileSync(SCAN_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveScanTimes(times) {
  const dir = dirname(SCAN_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SCAN_FILE, JSON.stringify(times, null, 2));
}

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const STATE_FILE = join(__dirname, '..', '.py-state.json');

function proxyConfig() {
  return process.env.PROXY_URL ? { proxy: { server: process.env.PROXY_URL } } : {};
}

function isChallenged(title) {
  const t = (title || '').toLowerCase();
  return t.includes('momento') || t.includes('denegado') || t.includes('verific') || t.includes('captcha');
}

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

export function getStoresToScan(storeFilter) {
  const now = Date.now();
  const scans = loadScanTimes();
  const cooldown = config.pedidosya.storeScanCooldownMs;

  // Filtro manual por tienda: se respeta tal cual, sin tocar la rotación
  if (storeFilter) {
    return config.pedidosya.stores.filter(s => s.vendorId === storeFilter || s.name === storeFilter);
  }

  // Pool de candidatas respetando el cooldown de escaneo (rotación sobre TODAS las tiendas, incluidas las priority)
  let pool = config.pedidosya.stores.filter(s => now - (scans[s.vendorId] || 0) >= cooldown);
  if (pool.length === 0) {
    // Si el cooldown excluye a todas, volvemos al listado completo para que la corrida nunca quede vacía
    pool = [...config.pedidosya.stores];
  }

  // Round-robin con cursor persistido: avanza en cada corrida
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

// Errores que indican que la página fue destruida por un re-challenge (Cloudflare/PX) en medio del escaneo
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

// Escanea UN lote chico de categorías en un solo page.evaluate (lógica de parsing intacta)
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
    console.log(`  [${storeName}] Challenge detectado, esperando Turnstile (hasta 60s)...`);
    if (!await waitForClear(page, storeName, 60000)) {
      console.log(`  [${storeName}] Sigue bloqueado, recargando home...`);
      await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
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
      // Error no recuperable o sin más reintentos: cortamos acá
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

    // Pausa entre lotes (misma semántica 400-600ms del escaneo anterior)
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

export async function scrapePedidosYa(storeFilter = '') {
  const offers = [];
  const stores = getStoresToScan(storeFilter);

  if (stores.length === 0) {
    console.log('[PedidosYa] All stores scanned recently, skipping');
    return offers;
  }

  console.log(`[PedidosYa] Scraping ${stores.length} stores: ${stores.map(s => s.name).join(', ')}`);

  let context;
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

    let page = context.pages()[0] || await context.newPage();

    await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500 + Math.random() * 2000);
    await humanWarmup(page);

    let title = await page.title();
    if (isChallenged(title)) {
      console.log('[PedidosYa] Waiting for Turnstile (up to 60s)...');
      if (!await waitForClear(page, 'home', 60000)) {
        if (existsSync(STATE_FILE)) {
          console.log('[PedidosYa] Saved session looks poisoned, retrying fresh...');
          try { unlinkSync(STATE_FILE); } catch {}
          await context.close().catch(() => {});
          delete launchOpts.storageState;
          context = await chromium.launchPersistentContext('', launchOpts);
          const fresh = context.pages()[0] || await context.newPage();
          await fresh.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await fresh.waitForTimeout(5000);
          if (!await waitForClear(fresh, 'home-fresh', 60000)) {
            console.log('[PedidosYa] Blocked by Cloudflare');
            return offers;
          }
          page = context.pages()[0] || await context.newPage();
          await context.storageState({ path: STATE_FILE }).catch(() => {});
          console.log('[PedidosYa] Cloudflare passed with fresh session!');
        }
        console.log('[PedidosYa] Blocked by Cloudflare');
        return offers;
      }
    }

    console.log('[PedidosYa] Cloudflare passed!');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await context.storageState({ path: STATE_FILE }).catch(() => {});

    const scannedIds = [];

    for (const store of stores) {
      console.log(`\n[PedidosYa] Scraping: ${store.name} (vendorId=${store.vendorId})`);

      let storeData = null;

      try {
        storeData = await scanStore(page, store, config.maxPriceCheap);
        if (storeData && !storeData.error) {
          console.log(`  [${store.name}] API directa OK (sin navegar)`);
        }
      } catch (e) {
        storeData = { error: e.message };
      }

      for (let attempt = 1; storeData?.error && attempt <= 3; attempt++) {
        const challenge = /403|blocked|captcha|challenge|momento|denegado|verific/i.test(storeData.error || '');
        if (!challenge) {
          console.log(`  [${store.name}] API error no desafiable (${storeData.error}), skipping`);
          break;
        }
        try {
          if (store.url) {
            console.log(`  [${store.name}] Navegando a tienda (intento ${attempt}/3)...`);
            await page.goto(store.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(4000 + Math.random() * 2500);
            await humanWarmup(page);

            if (isChallenged(await page.title())) {
              console.log(`  [${store.name}] Challenge, esperando Turnstile (hasta 60s)...`);
              if (!await waitForClear(page, store.name, 60000)) {
                console.log(`  [${store.name}] Still blocked, reloading home...`);
                await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(8000 + Math.random() * 4000);
                if (isChallenged(await page.title())) {
                  console.log(`  [${store.name}] Home también bloqueado, skipping`);
                  break;
                }
                storeData = { error: 'categories:403 retry-after-home' };
                continue;
              }
            }
          }

          storeData = await scanStore(page, store, config.maxPriceCheap);
          if (!storeData?.error) break;
          console.log(`  [${store.name}] Intento ${attempt}: ${storeData.error}`);
        } catch (e) {
          console.log(`  [${store.name}] Error: ${e.message.substring(0, 80)}`);
          storeData = { error: e.message };
        }
      }

      if (!storeData || storeData.error) {
        console.log(`  [${store.name}] Skipped: ${JSON.stringify(storeData)}`);
        continue;
      }

      scannedIds.push(store.vendorId);
      console.log(`  [${store.name}] ${storeData.catsScanned}/${storeData.totalCats} cats, ${storeData.discountedItems.length} discounted, ${storeData.cheapItems.length} under $${config.maxPriceCheap}${storeData.rateLimited ? ' [RATE LIMITED]' : ''}`);

      for (const item of storeData.discountedItems) {
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

      for (const item of storeData.cheapItems) {
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

      if (store !== stores[stores.length - 1]) {
        await page.waitForTimeout(2000 + Math.random() * 2000);
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
