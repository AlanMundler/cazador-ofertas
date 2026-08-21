import { chromium } from 'patchright';

const LAT = process.env.LATITUDE || '-31.41307';
const LNG = process.env.LONGITUDE || '-64.19635';
const MIN_DISCOUNT_SUPER = parseInt(process.env.MIN_DISCOUNT_SUPER || '60');
const MAX_PRICE_CHEAP = parseInt(process.env.MAX_PRICE_CHEAP || '100');

const GROCERIES_URL = `https://www.pedidosya.com.ar/restaurantes?bt=GROCERIES&origin=home&lat=${LAT}&lng=${LNG}&areaId=16631&areaName=Alberdi&address=San%20Jos%C3%A9%20de%20Calasanz%2049`;

const KNOWN_STORES = [
  { name: 'Carrefour Express', vendorId: '398683', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/carrefour-express-blvd-san-juan-785-93a8196b-9665-4322-8f7e-31b7af23c22f-menu?origin=shop_list' },
  { name: 'PedidosYa Market 25 de Mayo', vendorId: '169481', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-25-de-mayo-bb184a2a-707c-4e62-86e8-0003e06e57af-menu?origin=shop_list' },
];

export async function scrapePedidosYa() {
  const offers = [];
  let context;

  try {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      viewport: { width: 1366, height: 768 },
    });

    const page = context.pages()[0] || await context.newPage();

    console.log('[PedidosYa] Loading home...');
    await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

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

    const stores = [...KNOWN_STORES];

    try {
      console.log('[PedidosYa] Trying shoplist API from home...');
      const apiResult = await page.evaluate(async ({ lat, lng }) => {
        try {
          const resp = await fetch(`/v3/shoplist/filters?businessTypes=GROCERIES&country=3&point=${lat},${lng}`, { credentials: 'include' });
          if (!resp.ok) return { error: resp.status };
          return await resp.json();
        } catch(e) {
          return { error: e.message };
        }
      }, { lat: LAT, lng: LNG });

      if (apiResult && !apiResult.error) {
        console.log(`[PedidosYa] Shoplist API returned filters`);
        const vendorResp = await page.evaluate(async ({ lat, lng }) => {
          try {
            const resp = await fetch(`/v4/shoplist/vendors?size=30&page=1&businessTypes=GROCERIES&country=3&point=${lat},${lng}`, { credentials: 'include' });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch(e) {
            return { error: e.message };
          }
        }, { lat: LAT, lng: LNG });

        if (vendorResp && !vendorResp.error && vendorResp.vendors) {
          console.log(`[PedidosYa] Found ${vendorResp.vendors.length} vendors from API`);
          for (const v of vendorResp.vendors) {
            if (v.id && v.name && !stores.find(s => s.vendorId === String(v.id))) {
              stores.push({
                name: v.name,
                vendorId: String(v.id),
                url: v.link ? `https://www.pedidosya.com.ar${v.link}` : '',
              });
            }
          }
        } else {
          console.log(`[PedidosYa] Vendor API: ${JSON.stringify(vendorResp).substring(0, 200)}`);
        }
      } else {
        console.log(`[PedidosYa] Shoplist API error: ${JSON.stringify(apiResult).substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`[PedidosYa] API discovery error: ${e.message.substring(0, 80)}`);
    }

    console.log(`[PedidosYa] Scraping ${stores.length} stores`);

    for (const store of stores.slice(0, 15)) {
      console.log(`\n[PedidosYa] Scraping: ${store.name} (vendorId=${store.vendorId})`);

      try {
        if (store.url) {
          await page.goto(store.url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(5000);

          title = await page.title();
          if (title.includes('momento') || title.includes('denegado')) {
            console.log(`  [${store.name}] Blocked, skipping`);
            continue;
          }
        }

        const storeData = await page.evaluate(async ({ vendorId }) => {
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
            const catsScanned = Math.min(allCatIds.length, 30);

            for (const catId of allCatIds.slice(0, catsScanned)) {
              try {
                const pResp = await fetch(`/groceries/web/v1/vendors/${vendorId}/products?categoryId=${catId}&limit=50`, { credentials: 'include' });
                if (pResp.status !== 200) continue;
                const pData = await pResp.json();

                for (const item of (pData.items || [])) {
                  const name = item.name || item.description || '';
                  const price = item.selling_price ?? item.price ?? item.salePrice ?? 0;
                  const originalPrice = item.price_without_discount ?? item.originalPrice ?? item.price ?? 0;
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
                    discountedItems.push({ name, discount, campaignTag, price, originalPrice });
                  }

                  if (price > 0 && price < 100 && name) {
                    cheapItems.push({ name, price });
                  }
                }
              } catch {}
            }

            return { discountedItems, cheapItems, totalCats: allCatIds.length, catsScanned };
          } catch (e) {
            return { error: e.message };
          }
        }, { vendorId: store.vendorId });

        if (!storeData || storeData.error) {
          console.log(`  [${store.name}] Error: ${JSON.stringify(storeData)}`);
          continue;
        }

        console.log(`  [${store.name}] ${storeData.catsScanned}/${storeData.totalCats} cats, ${storeData.discountedItems.length} discounted, ${storeData.cheapItems.length} under $${MAX_PRICE_CHEAP}`);

        for (const item of storeData.discountedItems) {
          console.log(`    ${item.discount}% OFF ${item.campaignTag} - ${item.name}`);
          if (item.discount >= MIN_DISCOUNT_SUPER) {
            offers.push({
              platform: 'PedidosYa', category: 'supermercado',
              restaurant: store.name, slug: store.url || '', discount: item.discount,
              name: item.name,
              description: `${item.discount}% OFF ${item.campaignTag} - ${item.name}`,
              originalPrice: item.originalPrice ? `$${item.originalPrice}` : null,
              currentPrice: item.price ? `$${item.price}` : null,
              url: store.url || '', deliveryTime: '', rating: '', imageUrl: '',
            });
          }
        }

        for (const item of storeData.cheapItems) {
          console.log(`    $${item.price} - ${item.name}`);
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

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      } catch (e) {
        console.log(`  [${store.name}] Error: ${e.message.substring(0, 80)}`);
      }
    }

    console.log(`[PedidosYa] ${offers.length} ofertas encontradas`);
  } catch (err) {
    console.error(`[PedidosYa] Error: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return offers;
}
