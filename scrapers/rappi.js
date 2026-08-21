import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';
const MIN_SUPER = 60;
const MIN_RESTAURANT = 60;

const SUPER_STORES = [
  { slug: '214965-jumbo', name: 'Jumbo' },
  { slug: '247115-disco', name: 'Disco' },
  { slug: '248079-vea', name: 'Vea' },
  { slug: '262682-turbo-veinticuatro-market-nc', name: 'Turbo Market' },
  { slug: '126292-carrefour-express', name: 'Carrefour Express' },
  { slug: '258919-turbo-express-nc', name: 'La Despensa' },
  { slug: '115860-punto-sur', name: 'Punto Sur Multimercado' },
  { slug: '188551-minishoppritty-mt-nc', name: 'Maxikiosco Pritty' },
];

export async function scrapeRappi() {
  const offers = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // --- RESTAURANTES ---
    console.log('[Rappi] Scrapeando restaurantes...');
    await page.goto(`https://www.rappi.com.ar/restaurantes?lat=${LAT}&lng=${LNG}`, {
      waitUntil: 'networkidle2', timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 3000));

    try {
      const promoBtn = await page.evaluateHandle(() => {
        for (const s of document.querySelectorAll('span, button, div')) {
          if (s.textContent.trim() === 'Promos') return s;
        }
        return null;
      });
      if (promoBtn) { await promoBtn.click(); await new Promise(r => setTimeout(r, 3000)); }
    } catch {}

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 600));
    }

    const restaurants = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      const results = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const discountMatch = line.match(/^(\d+)%\s*OFF$/i) || line.match(/^Hasta\s+(\d+)%\s*Off$/i);
        if (discountMatch) {
          const discount = parseInt(discountMatch[1], 10);
          let name = '';
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
            const next = lines[j];
            if (next.length > 1 && next.length < 60 &&
                !next.match(/^\d+\s*min/) && !next.match(/^·$/) &&
                !next.match(/^\$/) && !next.match(/^\d+\.\d$/) &&
                !next.match(/^Envío/) && !next.match(/^Ver más/) &&
                !next.match(/^Elige/) && !next.match(/^Preguntas/)) {
              name = next;
              break;
            }
          }
          let deliveryTime = '';
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + 6); j++) {
            if (lines[j].match(/\d+\s*min/)) { deliveryTime = lines[j]; break; }
          }
          let rating = '';
          for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
            if (lines[j].match(/^\d\.\d$/)) { rating = lines[j]; break; }
          }
          let url = '';
          const links = document.querySelectorAll('a[href*="/restaurantes/"]');
          for (const link of links) {
            if (link.textContent.trim().includes(name) || name.includes(link.textContent.trim().split('\n')[0])) {
              url = link.href; break;
            }
          }
          if (name) results.push({ name, discount, promoText: line, deliveryTime, rating, url: url || '' });
        }
      }
      return results;
    });

    console.log(`[Rappi] Todos los descuentos de restaurantes:`);
    for (const r of restaurants) {
      const marker = r.discount >= MIN_RESTAURANT ? ' >> NUEVA' : '';
      console.log(`  ${r.discount}% OFF - ${r.name} (${r.deliveryTime})${marker}`);
    }

    for (const r of restaurants) {
      if (r.discount >= MIN_RESTAURANT) {
        offers.push({
          platform: 'Rappi', category: 'restaurante', restaurant: r.name,
          slug: r.url, discount: r.discount, description: r.promoText,
          originalPrice: null, currentPrice: null,
          url: r.url || 'https://www.rappi.com.ar/restaurantes',
          deliveryTime: r.deliveryTime, rating: r.rating, imageUrl: '',
        });
      }
    }
    console.log(`[Rappi Restaurantes] ${offers.filter(o => o.category === 'restaurante').length} ofertas >${MIN_RESTAURANT}%`);

    // --- SUPER / MARKET ---
    console.log('[Rappi] Scrapeando supermercados...');

    for (const store of SUPER_STORES) {
      const storeUrl = `https://www.rappi.com.ar/cordoba/tiendas/${store.slug}`;
      try {
        await page.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        // Scroll to load products
        for (let i = 0; i < 8; i++) {
          await page.evaluate(() => window.scrollBy(0, 700));
          await new Promise(r => setTimeout(r, 800));
        }

        // Parse products: pattern is
        // $ 1.743,60  (current price)
        // $ 2.906,00  (original price) - only if discounted
        // 40%         (discount %) - only if discounted
        // ($3.69/ml)  (unit price)
        // Schneider Cerveza Remix Limón  (product name)
        // 1 x 473 cc  (quantity)
        const storeOffers = await page.evaluate(() => {
          const text = document.body.innerText;
          const lines = text.split('\n').map(l => l.trim()).filter(l => l);
          const results = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match standalone discount percentage
            const discountMatch = line.match(/^(\d+)%$/);
            if (discountMatch) {
              const discount = parseInt(discountMatch[1], 10);

              // Find current price (line before, starting with $)
              let currentPrice = '';
              for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
                if (lines[j].match(/^\$\s*[\d.,]+$/)) {
                  currentPrice = lines[j];
                  break;
                }
              }

              // Find original price (line before current price, starting with $)
              let originalPrice = '';
              for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
                if (lines[j].match(/^\$\s*[\d.,]+$/) && lines[j] !== currentPrice) {
                  originalPrice = lines[j];
                  break;
                }
              }

              // Find product name: skip unit price ($X/ml), qty (1 x), Agregar, etc.
              let productName = '';
              for (let j = i + 1; j <= Math.min(lines.length - 1, i + 6); j++) {
                const next = lines[j];
                if (next.length > 3 && next.length < 100 &&
                    !next.match(/^\$/) && !next.match(/^\d+%$/) &&
                    !next.match(/^\(/) && !next.match(/^Agregar$/) &&
                    !next.match(/^Ver$/) && !next.match(/^Ver más$/) &&
                    !next.match(/^Ofertas$/) && !next.match(/^\d+\s*x\s*/i) &&
                    !next.match(/^1\s+X\s*/i) && !next.match(/^0$/) &&
                    !next.match(/^Envío/) && !next.match(/^Más vendidos/)) {
                  productName = next;
                  break;
                }
              }

              if (productName || discount >= 30) {
                results.push({
                  discount,
                  productName: productName || 'Producto',
                  originalPrice,
                  currentPrice,
                });
              }
            }
          }
          return results;
        });

        const storeDiscounts = storeOffers.filter(o => o.discount >= MIN_SUPER);
        if (storeOffers.length > 0) {
          console.log(`  [${store.name}] ${storeOffers.length} productos con descuento, ${storeDiscounts.length} >${MIN_SUPER}%`);
          for (const o of storeOffers) {
            const marker = o.discount >= MIN_SUPER ? ' >> NUEVA' : '';
            console.log(`    ${o.discount}% OFF - ${o.productName}${marker}`);
          }
        }

        for (const o of storeDiscounts) {
          offers.push({
            platform: 'Rappi', category: 'supermercado', restaurant: store.name,
            slug: storeUrl, discount: o.discount,
            description: `${o.discount}% OFF - ${o.productName}`,
            originalPrice: o.originalPrice || null, currentPrice: o.currentPrice || null,
            url: storeUrl, deliveryTime: '', rating: '', imageUrl: '',
          });
        }
      } catch (e) {
        console.log(`  [${store.name}] Error: ${e.message}`);
      }
    }

    console.log(`[Rappi Super] ${offers.filter(o => o.category === 'supermercado').length} ofertas >${MIN_SUPER}%`);

  } catch (err) {
    console.error(`[Rappi] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
