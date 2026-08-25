import config from '../config.js';
import { chromium } from 'patchright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MIN_RESTAURANT = config.discounts.restaurant;

const LAT = parseFloat(config.lat);
const LNG = parseFloat(config.lng);

function parseDiscount(text) {
  if (!text) return 0;
  const m = text.match(/(\d+)%\s*(off|dto|descuento|en\s+artículos?\s+seleccionados)/i);
  if (m) return parseInt(m[1], 10);
  if (/buy\s*1.*get\s*1|2x1|2da\s*unidad/i.test(text)) return 50;
  const h = text.match(/hasta\s+(\d+)%/i);
  if (h) return parseInt(h[1], 10);
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
  let tmpDir;

  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'ue-'));
    context = await chromium.launchPersistentContext(tmpDir, {
      headless: false,
      viewport: { width: 1366, height: 768 },
      geolocation: { latitude: LAT, longitude: LNG },
      permissions: ['geolocation'],
    });

    const page = context.pages()[0] || await context.newPage();

    console.log('[UberEats] Loading homepage first...');
    await page.goto('https://www.ubereats.com/ar', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

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
    console.log(`[UberEats] CF passed on homepage, title: ${title.substring(0, 60)}`);

    const feedUrl = `https://www.ubereats.com/ar/feed?diningMode=DELIVERY&pl=${encodeURIComponent(JSON.stringify({
      address: 'San José de Calasanz 50, Córdoba, Argentina',
      reference: '',
      referenceType: 'google_places',
      latitude: LAT,
      longitude: LNG,
    }))}`;

    console.log('[UberEats] Navigating to feed...');
    await page.goto(feedUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(5000);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('[role="dialog"], [data-testid="modal"], [class*="overlay"], [class*="Overlay"], [class*="modal"], [class*="Modal"]');
      overlays.forEach(el => el.remove());
      document.body.style.overflow = 'auto';
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const closeBtn = btns.find(b =>
        b.textContent?.includes('Cerrar') || b.textContent?.includes('X') ||
        b.getAttribute('aria-label')?.includes('close') || b.getAttribute('aria-label')?.includes('Close')
      );
      if (closeBtn) closeBtn.click();
      const overlayBtn = btns.find(b => b.textContent?.includes('No, gracias'));
      if (overlayBtn) overlayBtn.click();
    });
    await page.waitForTimeout(1000);

    await autoScroll(page, 12, 600, 400);

    const debugInfo = await page.evaluate(() => ({
      allLinks: document.querySelectorAll('a').length,
      storeLinks: document.querySelectorAll('a[href*="/store/"]').length,
      allText: document.body.innerText.length,
      firstText: document.body.innerText.substring(0, 300),
    }));
    console.log(`[UberEats] DOM: ${debugInfo.allLinks} links, ${debugInfo.storeLinks} stores, ${debugInfo.allText} chars`);
    console.log(`[UberEats] Body: ${debugInfo.firstText}`);

    const restaurants = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/store/"]');

      for (const link of links) {
        let container = link;
        for (let i = 0; i < 6; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          if (container.offsetHeight > 100) break;
        }

        const text = container.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);

        let name = '';
        let discount = 0;
        let promoText = '';
        let eta = '';
        let rating = '';

        for (const line of lines) {
          const dm = line.match(/(\d+)%\s*(off|dto|descuento|en\s+artículos?\s+seleccionados)/i) || line.match(/hasta\s+(\d+)%/i);
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
            if (line.length > 3 && line.length < 80 &&
                !line.match(/^\$/) && !line.match(/^\d+%/) &&
                !line.match(/^\d+\s*min/) && !line.match(/^·$/) &&
                !line.match(/^Envío/) && !line.match(/^Ver/) &&
                !line.match(/^Abierto/) && !line.match(/^Cerrado/) &&
                !line.match(/^El costo/) && !line.match(/^Costo/)) {
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
