import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';
const MIN_SUPER = 60;
const MIN_RESTAURANT = 70;

export async function scrapePedidosYa() {
  const offers = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    const apiData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('vendors') || url.includes('restaurants') || url.includes('stores')) {
        try {
          const text = await response.text();
          if (text.length > 100 && (text.includes('"name"') || text.includes('"title"'))) {
            apiData.push(JSON.parse(text));
          }
        } catch {}
      }
    });

    // Try restaurantes
    const restaurantUrls = [
      'https://www.pedidosya.com.ar/restaurantes/cordoba',
      `https://www.pedidosya.com.ar/restaurantes?latitude=${LAT}&longitude=${LNG}`,
    ];

    let restaurantsLoaded = false;
    for (const url of restaurantUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 4000));
        const pageText = await page.evaluate(() => document.body.innerText);
        if (!pageText.includes('tráfico inusual') && !pageText.includes('comprobación')) {
          restaurantsLoaded = true;
          break;
        }
      } catch {}
    }

    if (restaurantsLoaded) {
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 800));
      }

      const pageText = await page.evaluate(() => document.body.innerText);
      const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const discountMatch = line.match(/(\d+)%\s*(?:OFF|off|de descuento)/i);
        if (discountMatch) {
          const discount = parseInt(discountMatch[1], 10);
          if (discount >= MIN_RESTAURANT) {
            let name = '';
            for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
              if (lines[j].length > 2 && lines[j].length < 60 && !lines[j].match(/^\d+%$/)) {
                name = lines[j];
                break;
              }
            }
            if (name && !offers.find(o => o.restaurant === name)) {
              offers.push({
                platform: 'PedidosYa',
                category: 'restaurante',
                restaurant: name,
                slug: '',
                discount,
                description: line,
                originalPrice: null,
                currentPrice: null,
                url: 'https://www.pedidosya.com.ar/restaurantes/cordoba',
                deliveryTime: '',
                rating: '',
                imageUrl: '',
              });
            }
          }
        }
      }
    }

    // Try market/super
    const superUrls = [
      'https://www.pedidosya.com.ar/cordoba/tiendas/tipo/market',
      'https://www.pedidosya.com.ar/tiendas/cordoba',
    ];

    for (const url of superUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
        const pageText = await page.evaluate(() => document.body.innerText);
        if (!pageText.includes('tráfico inusual') && !pageText.includes('comprobación')) {
          for (let i = 0; i < 10; i++) {
            await page.evaluate(() => window.scrollBy(0, 600));
            await new Promise(r => setTimeout(r, 500));
          }

          const text = await page.evaluate(() => document.body.innerText);
          const lines = text.split('\n').map(l => l.trim()).filter(l => l);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const discountMatch = line.match(/(\d+)%/);
            if (discountMatch) {
              const discount = parseInt(discountMatch[1], 10);
              if (discount >= MIN_SUPER) {
                let name = '';
                for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
                  if (lines[j].length > 2 && lines[j].length < 60 && !lines[j].match(/^\d+%$/)) {
                    name = lines[j];
                    break;
                  }
                }
                if (name && !offers.find(o => o.restaurant === name)) {
                  offers.push({
                    platform: 'PedidosYa',
                    category: 'supermercado',
                    restaurant: name,
                    slug: '',
                    discount,
                    description: line,
                    originalPrice: null,
                    currentPrice: null,
                    url,
                    deliveryTime: '',
                    rating: '',
                    imageUrl: '',
                  });
                }
              }
            }
          }
          break;
        }
      } catch {}
    }

    for (const data of apiData) {
      const restaurants = data.restaurants || data.vendors || data.data || [];
      if (Array.isArray(restaurants)) {
        for (const r of restaurants) {
          const discount = r.discount || r.promotion?.discount || 0;
          if (discount >= MIN_RESTAURANT) {
            const name = r.name || r.title || 'Restaurante';
            if (!offers.find(o => o.restaurant === name)) {
              offers.push({
                platform: 'PedidosYa',
                category: 'restaurante',
                restaurant: name,
                slug: r.slug || '',
                discount,
                description: `${discount}% OFF`,
                originalPrice: null,
                currentPrice: null,
                url: r.slug ? `https://www.pedidosya.com.ar/${r.slug}` : 'https://www.pedidosya.com.ar/restaurantes/cordoba',
                deliveryTime: '',
                rating: '',
                imageUrl: '',
              });
            }
          }
        }
      }
    }

    console.log(`[PedidosYa] ${offers.length} ofertas encontradas`);
  } catch (err) {
    console.error(`[PedidosYa] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
