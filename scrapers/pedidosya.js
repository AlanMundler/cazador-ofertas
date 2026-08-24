import { chromium } from 'patchright';
import config from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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

function getStoresToScan() {
  const now = Date.now();
  const scans = loadScanTimes();
  const toScan = [];

  for (const store of config.pedidosya.stores) {
    if (store.priority) {
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
      const BATCH = 8;
      let rateLimited = false;
      let catsScanned = 0;
      const PAGE_LIMIT = 100;

      for (let i = 0; i < allCatIds.length; i += BATCH) {
        if (rateLimited) break;
        const batch = allCatIds.slice(i, i + BATCH);

        for (const catId of batch) {
          if (rateLimited) break;
          let page = 0;
          let hasMore = true;

          while (hasMore && !rateLimited) {
            try {
              const resp = await fetch(`/groceries/web/v1/vendors/${vendorId}/products?categoryId=${catId}&limit=${PAGE_LIMIT}&page=${page}`, { credentials: 'include' });
              if (resp.status === 429) { rateLimited = true; break; }
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
            } catch {
              break;
            }
          }
          catsScanned++;
        }

        if (i + BATCH < allCatIds.length) await sleep(150);
      }

      return { discountedItems, cheapItems, totalCats: allCatIds.length, catsScanned: Math.min(catsScanned, allCatIds.length), rateLimited };
    } catch (e) {
      return { error: e.message };
    }
  }, { vendorId, maxPriceCheap });
}

export async function scrapePedidosYa() {
  const offers = [];
  const stores = getStoresToScan();

  if (stores.length === 0) {
    console.log('[PedidosYa] All stores scanned recently, skipping');
    return offers;
  }

  console.log(`[PedidosYa] Scraping ${stores.length} stores: ${stores.map(s => s.name).join(', ')}`);

  let context;
  try {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      viewport: { width: 1366, height: 768 },
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    let title = await page.title();
    if (title.includes('momento')) {
      console.log('[PedidosYa] Waiting for Turnstile...');
      await page.waitForTimeout(20000);
      title = await page.title();
    }

    if (title.includes('momento')) {
      console.log('[PedidosYa] Blocked by Cloudflare');
      return offers;
    }

    console.log('[PedidosYa] Cloudflare passed!');

    const scannedIds = [];

    for (const store of stores) {
      console.log(`\n[PedidosYa] Scraping: ${store.name} (vendorId=${store.vendorId})`);

      let storeData = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (store.url) {
            await page.goto(store.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(2000);

            title = await page.title();
            if (title.includes('momento') || title.includes('denegado')) {
              if (attempt === 1) {
                console.log(`  [${store.name}] Blocked, reloading home...`);
                await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(5000);
                continue;
              }
              console.log(`  [${store.name}] Blocked on retry, skipping`);
              break;
            }
          }

          storeData = await fetchStoreData(page, store.vendorId, config.maxPriceCheap);

          if (storeData && storeData.error && attempt === 1) {
            console.log(`  [${store.name}] Failed (${storeData.error}), reloading home...`);
            await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(5000);
            storeData = null;
            continue;
          }
          break;
        } catch (e) {
          if (attempt === 2) {
            console.log(`  [${store.name}] Error: ${e.message.substring(0, 80)}`);
          }
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
