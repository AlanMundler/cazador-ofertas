import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const LAT = '-31.4201';
const LNG = '-64.1888';

export async function scrapePedidosYa() {
  const offers = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768', '--lang=es-AR',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    await page.evaluateOnNewDocument(() => {
      delete navigator.__proto__.webdriver;
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { app: { isInstalled: false }, runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => { const p = [1, 2, 3]; p.length = 3; return p; }
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['es-AR', 'es', 'en-US', 'en']
      });
    });

    const apiData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (response.status() === 200 && (url.includes('vendors') || url.includes('restaurants') || url.includes('stores') || url.includes('graphql'))) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const text = await response.text();
            if (text.length > 100) apiData.push(JSON.parse(text));
          }
        } catch {}
      }
    });

    // Step 1: Visit home page first (sometimes less protected)
    console.log('[PedidosYa] Loading home page...');
    try {
      await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 5000));
    } catch {}

    const homeTitle = await page.title();
    const isBlocked = homeTitle.includes('denegado') || homeTitle.includes('momento');

    if (isBlocked) {
      console.log('[PedidosYa] Blocked by PerimeterX on home page');
      console.log(`[PedidosYa] ${offers.length} ofertas encontradas`);
      return offers;
    }

    console.log('[PedidosYa] Home page loaded, navigating to supermercados...');

    // Step 2: Try supermercado URLs with delays
    const superUrls = [
      `https://www.pedidosya.com.ar/restaurantes?latitude=${LAT}&longitude=${LNG}`,
    ];

    for (const url of superUrls) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        if (resp.status() === 200) {
          const title = await page.title();
          if (!title.includes('denegado') && !title.includes('momento')) {
            // Scroll and parse
            for (let i = 0; i < 12; i++) {
              await page.evaluate(() => window.scrollBy(0, 600));
              await new Promise(r => setTimeout(r, 700));
            }

            const pageText = await page.evaluate(() => document.body.innerText);
            const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const discountMatch = line.match(/(\d+)%\s*(?:OFF|off|de descuento)/i);
              if (discountMatch) {
                const discount = parseInt(discountMatch[1], 10);
                if (discount >= 70) {
                  let name = '';
                  for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
                    const next = lines[j];
                    if (next.length > 2 && next.length < 60 &&
                        !next.match(/^\d+%$/) && !next.match(/^\$/) &&
                        !next.match(/^Envío/) && !next.match(/^Ver más/)) {
                      name = next;
                      break;
                    }
                  }
                  if (name && !offers.find(o => o.restaurant === name)) {
                    offers.push({
                      platform: 'PedidosYa', category: 'restaurante',
                      restaurant: name, slug: '', discount,
                      description: line, originalPrice: null, currentPrice: null,
                      url, deliveryTime: '', rating: '', imageUrl: '',
                    });
                  }
                }
              }
            }

            console.log(`[PedidosYa] Parsed restaurantes, ${offers.length} ofertas >70%`);
          }
        }
      } catch (e) {
        console.log(`[PedidosYa] Error on ${url}: ${e.message.substring(0, 80)}`);
      }
    }

    // Also parse API data
    for (const data of apiData) {
      const restaurants = data.restaurants || data.vendors || data.data || [];
      if (Array.isArray(restaurants)) {
        for (const r of restaurants) {
          const discount = r.discount || r.promotion?.discount || 0;
          if (discount >= 70) {
            const name = r.name || r.title || 'Restaurante';
            if (!offers.find(o => o.restaurant === name)) {
              offers.push({
                platform: 'PedidosYa', category: 'restaurante',
                restaurant: name, slug: r.slug || '',
                discount, description: `${discount}% OFF`,
                originalPrice: null, currentPrice: null,
                url: r.slug ? `https://www.pedidosya.com.ar/${r.slug}` : '',
                deliveryTime: '', rating: '', imageUrl: '',
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
