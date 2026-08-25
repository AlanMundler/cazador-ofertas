import config from '../config.js';
import { chromium } from 'patchright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MIN_RESTAURANT = config.discounts.uberEats;
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

    console.log('[UberEats] Loading homepage...');
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
    console.log(`[UberEats] CF passed, title: ${title.substring(0, 60)}`);

    console.log('[UberEats] Entering address...');
    const addressInput = await page.$('input[data-testid="address-autocomplete-input"], input[placeholder*="dirección"], input[placeholder*="address"], input[id*="location"], input[aria-label*="dirección"], input[aria-label*="address"]');
    if (addressInput) {
      await addressInput.click();
      await page.waitForTimeout(500);
      await addressInput.fill('Buenos Aires 500, Córdoba, Argentina');
      await page.waitForTimeout(3000);

      const suggestions = await page.$$('[data-testid="address-option"], [role="option"], li[id*="result"]');
      for (const s of suggestions) {
        const text = await s.textContent();
        console.log(`[UberEats] Suggestion: ${text?.trim().substring(0, 80)}`);
      }
      let picked = false;
      for (const s of suggestions) {
        const text = await s.textContent();
        if (text && /córdoba.*argentina|argentina.*córdoba/i.test(text)) {
          await s.click();
          picked = true;
          console.log(`[UberEats] Selected: ${text.trim().substring(0, 80)}`);
          break;
        }
      }
      if (!picked && suggestions.length > 0) {
        await suggestions[0].click();
        const text = await suggestions[0].textContent();
        console.log(`[UberEats] Picked first: ${text?.trim().substring(0, 80)}`);
      } else if (!picked) {
        await page.keyboard.press('Enter');
        console.log('[UberEats] No suggestions, pressed Enter');
      }
      await page.waitForTimeout(3000);
    } else {
      console.log('[UberEats] No address input found, trying search icon...');
      const searchBtn = await page.$('[data-testid="header-search-bar"], button[aria-label*="Search"], button[aria-label*="Buscar"]');
      if (searchBtn) {
        await searchBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    await page.waitForTimeout(5000);
    title = await page.title();
    console.log(`[UberEats] After address, title: ${title.substring(0, 60)}`);

    const bodyPreview = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[UberEats] Body: ${bodyPreview.substring(0, 150)}`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.querySelectorAll('[role="dialog"], [data-testid="modal"], [class*="overlay"], [class*="Overlay"], [class*="modal"], [class*="Modal"]').forEach(el => el.remove());
      document.body.style.overflow = 'auto';
    });
    await page.waitForTimeout(500);

    for (let i = 0; i < 15; i++) {
      await page.evaluate(d => window.scrollBy(0, 600), null);
      await page.waitForTimeout(400);
    }

    const debugInfo = await page.evaluate(() => ({
      allLinks: document.querySelectorAll('a').length,
      storeLinks: document.querySelectorAll('a[href*="/store/"]').length,
      allText: document.body.innerText.length,
      firstText: document.body.innerText.substring(0, 500),
    }));
    console.log(`[UberEats] DOM: ${debugInfo.allLinks} links, ${debugInfo.storeLinks} stores, ${debugInfo.allText} chars`);

    const restaurants = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href*="/store/"]');

      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const storeId = href.match(/\/store\/([^/?]+)/)?.[1];
        if (storeId && seen.has(storeId)) continue;
        if (storeId) seen.add(storeId);

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
          url: r.url, deliveryTime: r.eta, rating: r.rating, imageUrl: '',
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
