import config from '../config.js';
import { chromium } from 'patchright';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MIN_RESTAURANT = config.discounts.uberEats;
const LAT = parseFloat(config.lat);
const LNG = parseFloat(config.lng);
const ADDRESS = 'San José de Calasanz 50, Córdoba, Argentina';
const CITY_RE = /c[oó]rdoba/i;

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * Extrae la mejor promo de un listado de líneas de texto.
 * Devuelve null si no hay promo o si no alcanza minDiscount.
 * Se usa tanto en el listing del homepage como en las visitas directas.
 */
export function parseStorePromos(lines, minDiscount = 0) {
  let best = null;

  for (const rawLine of lines || []) {
    const line = String(rawLine ?? '').trim();
    if (!line) continue;

    const percentMatch = line.match(/(\d+)%\s*(off|dto|descuento|en\s+artículos?\s+seleccionados)/i)
      || line.match(/hasta\s+(\d+)%/i);
    let discount = percentMatch ? parseInt(percentMatch[1], 10) : 0;
    if (/buy\s*1.*get\s*1|2x1|2da\s*unidad/i.test(line)) {
      discount = Math.max(discount, 50);
    }

    if (discount > 0 && (!best || discount > best.discount)) {
      best = { discount, promoText: line };
    }
  }

  if (!best || best.discount < minDiscount) return null;
  return best;
}

/**
 * La URL directa lleva la dirección embebida en el parámetro `pl`.
 * Si la tienda trae `url` completa se usa tal cual; si no, se arma desde slug/id + pl.
 */
function buildDirectStoreUrl(store) {
  if (store.url) return store.url;

  const base = `https://www.ubereats.com/ar/store/${store.slug}/${store.storeId}`;
  const pl = store.pl || config.ubereats?.directPl || '';
  return `${base}?diningMode=DELIVERY${pl ? `&pl=${pl}` : ''}`;
}

async function scrapeHomepageListing(page) {
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
    return [];
  }
  console.log(`[UberEats] CF passed, title: ${title.substring(0, 60)}`);

  console.log('[UberEats] Entering address...');
  const addressInput = await page.$('input[data-testid="address-autocomplete-input"], input[placeholder*="dirección"], input[placeholder*="address"], input[id*="location"], input[aria-label*="dirección"], input[aria-label*="address"]');
  if (addressInput) {
    await addressInput.click();
    await page.waitForTimeout(500);
    await addressInput.fill(ADDRESS);
    await page.waitForTimeout(3000);

    const suggestions = await page.$$('[data-testid="address-option"], [role="option"], li[id*="result"]');
    let picked = false;
    for (const s of suggestions) {
      const text = (await s.textContent()) || '';
      console.log(`[UberEats] Suggestion: ${text.trim().substring(0, 80)}`);
    }
    for (const s of suggestions) {
      const text = (await s.textContent()) || '';
      if (CITY_RE.test(text)) {
        await s.click();
        picked = true;
        console.log(`[UberEats] Selected Córdoba: ${text.trim().substring(0, 80)}`);
        break;
      }
    }

    if (!picked) {
      console.log('[UberEats] Córdoba AR no confirmada en sugerencias, abortando listing');
      return [];
    }
    await page.waitForTimeout(3000);

    const headerText = await page.evaluate(() => document.body.innerText.match(/dirección[^\n]{0,60}|entrega[^\n]{0,60}/i)?.[0] || '');
    console.log(`[UberEats] Header address: ${headerText.trim().substring(0, 80)}`);
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
    await page.evaluate(() => window.scrollBy(0, 500 + Math.random() * 300));
    if (i % 4 === 0) {
      await page.mouse.move(150 + Math.random() * 1000, 150 + Math.random() * 500, { steps: 10 }).catch(() => {});
    }
    await page.waitForTimeout(300 + Math.random() * 400);
  }

  const debugInfo = await page.evaluate(() => ({
    allLinks: document.querySelectorAll('a').length,
    storeLinks: document.querySelectorAll('a[href*="/store/"]').length,
    allText: document.body.innerText.length,
    firstText: document.body.innerText.substring(0, 500),
  }));
  console.log(`[UberEats] DOM: ${debugInfo.allLinks} links, ${debugInfo.storeLinks} stores, ${debugInfo.allText} chars`);

  const cityCheck = await page.evaluate(() => {
    const t = document.body.innerText;
    const hasCordoba = /c[oó]rdoba/i.test(t);
    const hasArgentina = /argentina/i.test(t) || /\bAR\b/.test(t);
    const noForeign = !/(buenos aires|rosario|mendoza|santiago de chile|lima|mexico|ciudad de méxico|quilmes|la plata|mar del plata|salta|tucumán|montevideo|quito|bogotá|caracas)/i.test(t.substring(0, 2000));
    return { hasCordoba, hasArgentina, noForeign };
  });

  if (!cityCheck.hasCordoba || !cityCheck.noForeign) {
    console.log(`[UberEats] Ciudad NO confirmada como Córdoba (${JSON.stringify(cityCheck)}), abortando listing`);
    return [];
  }
  console.log('[UberEats] Ciudad confirmada: Córdoba, Argentina');

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
      let eta = '';
      let rating = '';

      for (const line of lines) {
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

      if (name) {
        results.push({ name, lines, eta, rating, url });
      }
    }

    return results;
  });

  const listingOffers = [];
  for (const r of restaurants) {
    const promo = parseStorePromos(r.lines, 0);
    if (!promo) continue;

    if (promo.discount >= MIN_RESTAURANT) {
      listingOffers.push({
        platform: 'UberEats', category: 'restaurante',
        restaurant: r.name, slug: '', discount: promo.discount,
        description: promo.promoText || `${promo.discount}% OFF`,
        originalPrice: null, currentPrice: null,
        url: r.url, deliveryTime: r.eta, rating: r.rating, imageUrl: '',
      });
    }
  }

  return listingOffers;
}

async function scrapeDirectStores(page) {
  const directStores = config.ubereats?.directStores || [];
  const directOffers = [];

  for (const store of directStores) {
    const storeUrl = buildDirectStoreUrl(store);

    try {
      console.log(`[UberEats] Direct: visitando ${store.name} — ${storeUrl}`);
      try {
        await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(6000);
      } catch (e) {
        console.log(`[UberEats] ${store.name}: navegación con error (${e.message.substring(0, 80)}), revisando estado...`);
      }
      await page.waitForTimeout(3000);

      let directTitle = await page.title();
      if (/momento|denegado/i.test(directTitle)) {
        console.log(`[UberEats] ${store.name}: challenge (${directTitle.substring(0, 60)}), esperando 20s...`);
        await page.waitForTimeout(20000);
        directTitle = await page.title();
      }

      if (/momento|denegado/i.test(directTitle)) {
        console.log(`[UberEats] ${store.name}: tienda bloqueada, se salta`);
        continue;
      }

      const storeData = await page.evaluate(() => {
        const titleEls = document.querySelectorAll('[data-testid="store-title"], h1');
        const name = [...titleEls].map(el => el.textContent?.trim() || '').find(Boolean) || '';
        const lines = document.body.innerText
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .slice(0, 400);
        return { name, lines };
      });

      const storeName = storeData.name || store.name;
      const best = parseStorePromos(storeData.lines, 0);
      console.log(
        `[UberEats] ${store.name}: name="${storeName}", best=${best ? best.discount : 0}%`
        + (best ? `, line="${best.promoText.substring(0, 100)}"` : '')
      );

      const promo = parseStorePromos(storeData.lines, store.minDiscount);
      if (!promo) {
        const idxs = [];
        for (let i = 0; i < storeData.lines.length; i++) {
          const l = storeData.lines[i];
          if (l.length <= 100 && /%|2x1|2da unidad|dto|descuento/i.test(l)) idxs.push(i);
        }
        const ctx = idxs.slice(0, 8).map(i =>
          storeData.lines.slice(Math.max(0, i - 3), i + 2).join(' | '));
        console.log(`[UberEats] ${store.name}: debug ctx=${JSON.stringify(ctx)}`);
        console.log(`[UberEats] ${store.name}: sin promo >=${store.minDiscount}%, se salta`);
        continue;
      }

      directOffers.push({
        platform: 'UberEats', category: store.category || 'supermercado',
        restaurant: storeName, slug: store.slug || '', discount: promo.discount,
        description: promo.promoText || `${promo.discount}% OFF`,
        originalPrice: null, currentPrice: null,
        url: storeUrl, deliveryTime: '', rating: '', imageUrl: '',
      });
      console.log(`[UberEats] ${store.name}: oferta ${promo.discount}% agregada`);
    } catch (e) {
      console.log(`[UberEats] ${store.name}: error ${e.message.substring(0, 100)}, se salta`);
    }
  }

  return directOffers;
}

export async function scrapeUberEats() {
  const offers = [];
  let context;
  let tmpDir;

  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'ue-'));
    context = await chromium.launchPersistentContext(tmpDir, {
      headless: process.env.HEADLESS === 'true',
      viewport: pick(VIEWPORTS),
      ...(process.env.PROXY_URL ? { proxy: { server: process.env.PROXY_URL } } : {}),
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      geolocation: { latitude: LAT, longitude: LNG },
      permissions: ['geolocation'],
    });

    const page = context.pages()[0] || await context.newPage();

    let listingCount = 0;
    try {
      const listingOffers = await scrapeHomepageListing(page);
      listingCount = listingOffers.length;
      offers.push(...listingOffers);
      console.log(`[UberEats] Listing: ${listingCount} offers >${MIN_RESTAURANT}%`);
    } catch (err) {
      console.error(`[UberEats] Listing error: ${err.message}`);
    }

    let directCount = 0;
    try {
      const directOffers = await scrapeDirectStores(page);
      directCount = directOffers.length;
      offers.push(...directOffers);
    } catch (err) {
      console.error(`[UberEats] Direct stores error: ${err.message}`);
    }

    console.log(`[UberEats] Total: ${listingCount} listing offers + ${directCount} direct-store offers`);
  } catch (err) {
    console.error(`[UberEats] Error: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return offers;
}
