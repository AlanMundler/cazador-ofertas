import { chromium } from 'patchright';
import config from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_FILE = join(__dirname, '..', 'data', 'py-store-scans.json');

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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
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

function getStoresToScan(storeFilter) {
  const now = Date.now();
  const scans = loadScanTimes();
  const toScan = [];

  for (const store of config.pedidosya.stores) {
    if (storeFilter && store.vendorId !== storeFilter && store.name !== storeFilter) continue;
    if (storeFilter || store.priority) {
      toScan.push(store);
      continue;
    }
    const lastScan = scans[store.vendorId] || 0;
    if (now - lastScan >= config.pedidosya.storeScanCooldownMs) {
      toScan.push(store);
    }
  }

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

async function fetchStoreData(page, vendorId, maxPriceCheap) {
  return page.evaluate(async ({ vendorId, maxPriceCheap }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
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

      const discountedItems = [];
      const cheapItems = [];
      const BATCH = 5;
      let throttleCount = 0;
      let catsScanned = 0;
      const PAGE_LIMIT = 100;

      for (let i = 0; i < allCatIds.length; i += BATCH) {
        const batch = allCatIds.slice(i, i + BATCH);

        for (const catId of batch) {
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

        if (i + BATCH < allCatIds.length) await sleep(400 + Math.random() * 600);
      }

      return { discountedItems, cheapItems, totalCats: allCatIds.length, catsScanned: Math.min(catsScanned, allCatIds.length), rateLimited: throttleCount > 0, throttles: throttleCount };
    } catch (e) {
      return { error: e.message };
    }
  }, { vendorId, maxPriceCheap });
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
      headless: false,
      viewport: pick(VIEWPORTS),
      userAgent: pick(USER_AGENTS),
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
    await context.storageState({ path: STATE_FILE }).catch(() => {});

    const scannedIds = [];

    for (const store of stores) {
      console.log(`\n[PedidosYa] Scraping: ${store.name} (vendorId=${store.vendorId})`);

      let storeData = null;

      try {
        storeData = await fetchStoreData(page, store.vendorId, config.maxPriceCheap);
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

          storeData = await fetchStoreData(page, store.vendorId, config.maxPriceCheap);
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
