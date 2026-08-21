import { chromium } from 'patchright';

const LAT = process.env.LATITUDE || '-31.41307';
const LNG = process.env.LONGITUDE || '-64.19635';
const MIN_DISCOUNT_SUPER = parseInt(process.env.MIN_DISCOUNT_SUPER || '60');
const MAX_PRICE_CHEAP = parseInt(process.env.MAX_PRICE_CHEAP || '100');

const GROCERIES_URL = `https://www.pedidosya.com.ar/restaurantes?bt=GROCERIES&origin=home&lat=${LAT}&lng=${LNG}&areaId=16631&areaName=Alberdi&address=San%20Jos%C3%A9%20de%20Calasanz%2049`;

const KNOWN_STORES = [
  { name: 'Carrefour Express', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/carrefour-express-blvd-san-juan-785-93a8196b-9665-4322-8f7e-31b7af23c22f-menu?origin=shop_list' },
  { name: 'PedidosYa Market 25 de Mayo', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-25-de-mayo-bb184a2a-707c-4e62-86e8-0003e06e57af-menu?origin=shop_list' },
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

    let vendorUrls = [...KNOWN_STORES];

    try {
      console.log('[PedidosYa] Trying to discover vendors from GROCERIES page...');
      await page.goto(GROCERIES_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(8000);

      title = await page.title();
      if (!title.includes('momento') && !title.includes('denegado')) {
        const allLinks = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          return links
            .map(a => ({ href: a.href, text: a.innerText.split('\n')[0].trim() }))
            .filter(l => l.href.includes('-menu') && l.text.length > 1 && l.text.length < 80);
        });

        console.log(`[PedidosYa] Found ${allLinks.length} vendor links on page`);
        for (const link of allLinks) {
          if (!vendorUrls.find(v => v.url === link.href)) {
            vendorUrls.push({ name: link.text, url: link.href });
          }
        }
      }
    } catch (e) {
      console.log(`[PedidosYa] GROCERIES page error: ${e.message.substring(0, 80)}`);
    }

    console.log(`[PedidosYa] Scraping ${vendorUrls.length} stores`);

    for (const vendor of vendorUrls.slice(0, 15)) {
      console.log(`\n[PedidosYa] Scraping: ${vendor.name}`);

      try {
        let capturedVendorId = null;

        const responseHandler = (response) => {
          const url = response.url();
          const match = url.match(/\/groceries\/web\/v1\/vendors\/(\d+)\//);
          if (match) capturedVendorId = match[1];
        };
        page.on('response', responseHandler);

        await page.goto(vendor.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(8000);

        page.off('response', responseHandler);

        title = await page.title();
        if (title.includes('momento') || title.includes('denegado')) {
          console.log(`  [${vendor.name}] Blocked, skipping`);
          continue;
        }

        if (!capturedVendorId) {
          capturedVendorId = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const m = s.textContent?.match(/"vendorId"\s*:\s*(\d+)/);
              if (m) return m[1];
            }
            return null;
          });
        }

        if (!capturedVendorId) {
          console.log(`  [${vendor.name}] Could not find vendor ID, skipping`);
          continue;
        }

        console.log(`  [${vendor.name}] vendorId=${capturedVendorId}`);

        const storeData = await page.evaluate(async (args) => {
          const vendorId = args.vendorId;
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
                  const name = item.description || '';
                  const price = item.selling_price ?? item.price ?? item.salePrice ?? 0;
                  const originalPrice = item.price_without_discount ?? item.originalPrice ?? item.price ?? 0;
                  let discount = 0;
                  let campaignTag = '';

                  if (item.campaigns && item.campaigns.length > 0) {
                    for (const c of item.campaigns) {
                      const val = c.configuration?.value || 0;
                      if (val > discount) {
                        discount = val;
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
        }, { vendorId: capturedVendorId });

        if (!storeData || storeData.error) {
          console.log(`  [${vendor.name}] Error: ${JSON.stringify(storeData)}`);
          continue;
        }

        console.log(`  [${vendor.name}] ${storeData.catsScanned}/${storeData.totalCats} cats, ${storeData.discountedItems.length} discounted, ${storeData.cheapItems.length} under $${MAX_PRICE_CHEAP}`);

        for (const item of storeData.discountedItems) {
          console.log(`    ${item.discount}% OFF ${item.campaignTag} - ${item.name}`);
          if (item.discount >= MIN_DISCOUNT_SUPER) {
            offers.push({
              platform: 'PedidosYa', category: 'supermercado',
              restaurant: vendor.name, slug: vendor.url, discount: item.discount,
              description: `${item.discount}% OFF ${item.campaignTag} - ${item.name}`,
              originalPrice: item.originalPrice ? `$${item.originalPrice}` : null,
              currentPrice: item.price ? `$${item.price}` : null,
              url: vendor.url, deliveryTime: '', rating: '', imageUrl: '',
            });
          }
        }

        for (const item of storeData.cheapItems) {
          console.log(`    $${item.price} - ${item.name}`);
          offers.push({
            platform: 'PedidosYa', category: 'supermercado',
            restaurant: vendor.name, slug: vendor.url, discount: 0,
            description: `$${item.price} - ${item.name}`,
            originalPrice: null, currentPrice: `$${item.price}`,
            url: vendor.url, deliveryTime: '', rating: '', imageUrl: '',
            isCheapProduct: true,
          });
        }

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      } catch (e) {
        console.log(`  [${vendor.name}] Error: ${e.message.substring(0, 80)}`);
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
