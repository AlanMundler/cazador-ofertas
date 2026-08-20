import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';

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

    // Intercept XHR responses for restaurant data
    const apiData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('vendors') || url.includes('restaurants') || url.includes('stores')) {
        try {
          const text = await response.text();
          if (text.length > 100 && (text.includes('"name"') || text.includes('"title"'))) {
            const json = JSON.parse(text);
            apiData.push(json);
          }
        } catch {}
      }
    });

    const urls = [
      'https://www.pedidosya.com.ar/restaurantes/cordoba',
      `https://www.pedidosya.com.ar/restaurantes?latitude=${LAT}&longitude=${LNG}`,
    ];

    let loaded = false;
    for (const url of urls) {
      console.log(`[PedidosYa] Trying: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 5000));

        const pageText = await page.evaluate(() => document.body.innerText);
        if (!pageText.includes('tráfico inusual') && !pageText.includes('comprobación')) {
          loaded = true;
          console.log(`[PedidosYa] Page loaded successfully`);
          break;
        }
        console.log(`[PedidosYa] CAPTCHA on ${url}`);
      } catch (e) {
        console.log(`[PedidosYa] Failed: ${e.message}`);
      }
    }

    if (loaded) {
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 1000));
      }

      const restaurants = await page.evaluate(() => {
        const items = [];
        const cards = document.querySelectorAll('[class*="restaurant"], [class*="vendor"], [class*="store"], li[class*="card"], a[href*="/restaurantes/"]');
        for (const card of cards) {
          const text = card.textContent || '';
          const discountMatch = text.match(/(\d+)%\s*(?:OFF|off|de descuento)/i);
          if (discountMatch) {
            const nameEl = card.querySelector('h2, h3, [class*="name"], [class*="title"]');
            const name = nameEl?.textContent?.trim() || '';
            const href = card.href || card.querySelector('a')?.href || '';
            items.push({
              name: name || 'Restaurante',
              discount: parseInt(discountMatch[1], 10),
              url: href,
            });
          }
        }
        return items;
      });

      for (const r of restaurants) {
        if (r.discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
          if (!offers.find(o => o.restaurant === r.name && o.discount === r.discount)) {
            offers.push({
              platform: 'PedidosYa',
              restaurant: r.name,
              slug: r.url || '',
              discount: r.discount,
              description: `${r.discount}% OFF`,
              originalPrice: null,
              currentPrice: null,
              url: r.url || 'https://www.pedidosya.com.ar/restaurantes/cordoba',
              deliveryTime: '',
              rating: '',
              imageUrl: '',
            });
          }
        }
      }

      const pageText = await page.evaluate(() => document.body.innerText);
      const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const discountMatch = line.match(/(\d+)%\s*(?:OFF|off|de descuento)/i);
        if (discountMatch) {
          const discount = parseInt(discountMatch[1], 10);
          if (discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
            let name = '';
            for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
              const next = lines[j];
              if (next.length > 2 && next.length < 60 && !next.match(/^\d+%$/)) {
                name = next;
                break;
              }
            }
            if (name && !offers.find(o => o.restaurant === name && o.discount === discount)) {
              offers.push({
                platform: 'PedidosYa',
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

    // Check intercepted API data
    for (const data of apiData) {
      const restaurants = data.restaurants || data.vendors || data.data || [];
      if (Array.isArray(restaurants)) {
        for (const r of restaurants) {
          const discount = r.discount || r.promotion?.discount || 0;
          if (discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
            const name = r.name || r.title || 'Restaurante';
            if (!offers.find(o => o.restaurant === name)) {
              offers.push({
                platform: 'PedidosYa',
                restaurant: name,
                slug: r.slug || '',
                discount,
                description: `${discount}% OFF`,
                originalPrice: r.priceOriginal || null,
                currentPrice: r.priceFinal || null,
                url: r.slug ? `https://www.pedidosya.com.ar/${r.slug}` : 'https://www.pedidosya.com.ar/restaurantes/cordoba',
                deliveryTime: r.deliveryTime || '',
                rating: r.rating?.toString() || '',
                imageUrl: r.image || '',
              });
            }
          }
        }
      }
    }

    console.log(`[PedidosYa] ${offers.length} ofertas >${process.env.MIN_DISCOUNT || '60'}% encontradas`);
  } catch (err) {
    console.error(`[PedidosYa] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
