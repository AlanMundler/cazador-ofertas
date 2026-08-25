import config from '../config.js';
import { chromium } from 'patchright';

const MIN_RESTAURANT = config.discounts.restaurant;

const LOC_COOKIE = encodeURIComponent(JSON.stringify({
  address: 'San José de Calasanz 50',
  reference: '',
  referenceType: 'google_places',
  latitude: parseFloat(config.lat),
  longitude: parseFloat(config.lng),
}));

function parseDiscount(text) {
  if (!text) return 0;
  const m = text.match(/(\d+)%\s*(off|dto|descuento)/i);
  if (m) return parseInt(m[1], 10);
  if (/buy\s*1.*get\s*1|2x1|2da\s*unidad/i.test(text)) return 50;
  if (/hasta\s+(\d+)%/i.test(text)) return parseInt(text.match(/hasta\s+(\d+)%/i)[1], 10);
  return 0;
}

async function autoScroll(page, times, distance, delay) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(d => window.scrollBy(0, d), distance);
    await page.waitForTimeout(delay);
  }
}

export async function scrapeUberEats() {
  const offers = [];
  let context;

  try {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      viewport: { width: 1366, height: 768 },
    });

    const page = context.pages()[0] || await context.newPage();
    const feedUrl = `${config.ubereats.baseUrl}/ar/feed?pl=${LOC_COOKIE}`;

    console.log('[UberEats] Loading feed...');
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    let title = await page.title();
    if (title.includes('momento') || title.includes('Momento')) {
      console.log('[UberEats] Waiting for Cloudflare...');
      await page.waitForTimeout(15000);
      title = await page.title();
    }

    if (title.includes('momento') || title.includes('denegado')) {
      console.log('[UberEats] Blocked by Cloudflare');
      return offers;
    }

    console.log(`[UberEats] CF passed, title: ${title.substring(0, 60)}`);

    await autoScroll(page, 15, 600, 500);

    const restaurants = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/store/"]');

      for (const link of links) {
        const container = link.closest('[data-testid]') || link.parentElement?.parentElement?.parentElement;
        if (!container) continue;

        const text = container.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);

        let name = '';
        let discount = 0;
        let promoText = '';
        let eta = '';
        let rating = '';

        for (const line of lines) {
          const dm = line.match(/(\d+)%\s*(off|dto|descuento)/i) || line.match(/hasta\s+(\d+)%/i);
          if (dm) {
            const d = parseInt(dm[1], 10);
            if (d > discount) { discount = d; promoText = line; }
          }
          if (/buy\s*1.*get\s*1|2x1|2da\s*unidad/i.test(line)) {
            if (50 > discount) { discount = 50; promoText = line; }
          }
          if (line.match(/\d+\s*min/) && !eta) eta = line;
          if (line.match(/^\d\.\d$/) && !rating) rating = line;
        }

        if (!name) {
          const nameEl = container.querySelector('h3, [data-testid="store-title"]');
          name = nameEl?.textContent?.trim() || '';
        }
        if (!name) {
          for (const line of lines) {
            if (line.length > 3 && line.length < 60 &&
                !line.match(/^\$/) && !line.match(/^\d+%/) &&
                !line.match(/^\d+\s*min/) && !line.match(/^·$/) &&
                !line.match(/^Envío/) && !line.match(/^Ver/) &&
                !line.match(/^Abierto/) && !line.match(/^Cerrado/)) {
              name = line;
              break;
            }
          }
        }

        const href = link.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : `https://www.ubereats.com${href}`;

        if (name && discount > 0) {
          results.push({ name, discount, promoText, eta, rating, url });
        }
      }

      return results;
    });

    for (const r of restaurants) {
      if (r.discount >= MIN_RESTAURANT) {
        offers.push({
          platform: 'UberEats', category: 'restaurante',
          restaurant: r.name, slug: '', discount: r.discount,
          description: r.promoText || `${r.discount}% OFF`,
          originalPrice: null, currentPrice: null,
          url: r.url || feedUrl, deliveryTime: r.eta, rating: r.rating, imageUrl: '',
        });
      }
    }

    console.log(`[UberEats] Total: ${offers.length} offers >${MIN_RESTAURANT}%`);
  } catch (err) {
    console.error(`[UberEats] Error: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return offers;
}
