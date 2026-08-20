import puppeteer from 'puppeteer';
import fetch from 'node-fetch';

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

    // Try mobile user agent to avoid CAPTCHA
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    // Try the mobile site
    await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`[PedidosYa] Page loaded: ${pageText.substring(0, 100)}`);

    // If we got past CAPTCHA, try to navigate
    if (!pageText.includes('comprobación de seguridad')) {
      // Try direct restaurant listing
      await page.goto(`https://www.pedidosya.com.ar/restaurantes?lat=${LAT}&lng=${LNG}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));

      // Scroll
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 800));
      }

      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const discountMatch = line.match(/^(\d+)%\s*OFF$/i) ||
                             line.match(/^Hasta\s+(\d+)%/i) ||
                             line.match(/^(\d+)%\s*descuento/i);

        if (discountMatch) {
          const discount = parseInt(discountMatch[1], 10);
          if (discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
            let name = '';
            for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
              const next = lines[j];
              if (next.length > 2 && next.length < 60 && !next.match(/^\$/) && !next.match(/min$/)) {
                name = next;
                break;
              }
            }

            offers.push({
              platform: 'PedidosYa',
              restaurant: name || 'Restaurante',
              slug: '',
              discount,
              description: line,
              originalPrice: null,
              currentPrice: null,
              url: `https://www.pedidosya.com.ar/restaurantes`,
              deliveryTime: '',
              rating: '',
              imageUrl: '',
            });
          }
        }
      }
    } else {
      console.log('[PedidosYa] CAPTCHA bloqueado - intentando API movil...');
    }

    // Also try the mobile API directly
    try {
      const apiUrl = `https://api.pedidosya.com/v1/restaurants?latitude=${LAT}&longitude=${LNG}&limit=50&sort=discount`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'PedidosYa/10.0 (Android; 13)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        const restaurants = data?.data || data?.restaurants || data || [];
        if (Array.isArray(restaurants)) {
          for (const r of restaurants) {
            const promos = r.promotions || r.offers || r.discountInfo || [];
            for (const promo of promos) {
              const text = typeof promo === 'string' ? promo : (promo.description || promo.text || '');
              const m = text.match(/(\d+)\s*%/);
              if (m) {
                const discount = parseInt(m[1], 10);
                if (discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
                  offers.push({
                    platform: 'PedidosYa',
                    restaurant: r.name || r.restaurantName || '',
                    slug: '',
                    discount,
                    description: text,
                    originalPrice: null,
                    currentPrice: null,
                    url: `https://www.pedidosya.com.ar/restaurantes`,
                    deliveryTime: '',
                    rating: '',
                    imageUrl: '',
                  });
                }
              }
            }
          }
        }
        console.log(`[PedidosYa] API response: ${JSON.stringify(data).substring(0, 200)}`);
      } else {
        console.log(`[PedidosYa] API: ${res.status}`);
      }
    } catch (e) {
      console.log(`[PedidosYa] API Error: ${e.message}`);
    }

    console.log(`[PedidosYa] ${offers.length} ofertas >${process.env.MIN_DISCOUNT || '60'}% encontradas`);
  } catch (err) {
    console.error(`[PedidosYa] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
