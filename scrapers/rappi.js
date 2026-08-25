import { chromium } from 'patchright';
import config from '../config.js';

const MIN_SUPER = config.discounts.super;
const MIN_RESTAURANT = config.discounts.restaurant;

async function autoScroll(page, times, distance, delay) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(d => window.scrollBy(0, d), distance);
    await page.waitForTimeout(delay);
  }
}

export async function scrapeRappi() {
  const offers = [];
  let context;

  try {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      viewport: { width: 1366, height: 768 },
      geolocation: { latitude: parseFloat(config.lat), longitude: parseFloat(config.lng) },
      permissions: ['geolocation'],
    });

    const page = context.pages()[0] || await context.newPage();

    console.log('[Rappi] Setting location to Córdoba...');
    await page.goto('https://www.rappi.com.ar/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    try {
      await page.evaluate(({ lat, lng }) => {
        localStorage.setItem('lat', lat);
        localStorage.setItem('lng', lng);
        localStorage.setItem('address', 'San José de Calasanz 50');
        localStorage.setItem('city', 'Córdoba');
        document.cookie = `lat=${lat}; path=/`;
        document.cookie = `lng=${lng}; path=/`;
      }, { lat: config.lat, lng: config.lng });
    } catch {}

    await page.waitForTimeout(1000);

    console.log('[Rappi] Scrapeando restaurantes...');
    await page.goto(config.rappi.restaurantsUrl, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(2000);

    try {
      const promoHandle = await page.evaluateHandle(() => {
        for (const s of document.querySelectorAll('span, button, div')) {
          if (s.textContent.trim() === 'Promos') return s;
        }
        return null;
      });
      const promoBtn = promoHandle.asElement();
      if (promoBtn) { await promoBtn.click(); await page.waitForTimeout(1500); }
    } catch {}

    await autoScroll(page, 10, 500, 400);

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
                !next.match(/^\$/) && !next.match(/^\d\.\d$/) &&
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

    console.log('[Rappi] Scrapeando supermercados...');

    for (const store of config.rappi.stores) {
      const storeUrl = `https://www.rappi.com.ar/tiendas/${store.slug}`;
      try {
        await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);

        const blocked = await page.evaluate(() => {
          const t = document.title.toLowerCase();
          return t.includes('blocked') || t.includes('captcha') || t.includes('verificación') || document.body.innerText.length < 100;
        });
        if (blocked) {
          console.log(`  [${store.name}] Blocked/bot detection, skipping`);
          continue;
        }

        await autoScroll(page, 6, 700, 500);

        const storeOffers = await page.evaluate(() => {
          const text = document.body.innerText;
          const lines = text.split('\n').map(l => l.trim()).filter(l => l);
          const results = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const discountMatch = line.match(/^(\d+)%$/);
            if (discountMatch) {
              const discount = parseInt(discountMatch[1], 10);

              let currentPrice = '';
              for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
                if (lines[j].match(/^\$\s*[\d.,]+$/)) { currentPrice = lines[j]; break; }
              }

              let originalPrice = '';
              for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
                if (lines[j].match(/^\$\s*[\d.,]+$/) && lines[j] !== currentPrice) { originalPrice = lines[j]; break; }
              }

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
                results.push({ discount, productName: productName || 'Producto', originalPrice, currentPrice });
              }
            }
          }
          return results;
        });

        const storeDiscounts = storeOffers.filter(o => o.discount >= MIN_SUPER);
        if (storeOffers.length > 0) {
          console.log(`  [${store.name}] ${storeOffers.length} productos con descuento, ${storeDiscounts.length} >${MIN_SUPER}%`);
        }

        for (const o of storeDiscounts) {
          offers.push({
            platform: 'Rappi', category: 'supermercado', restaurant: store.name,
            slug: storeUrl, discount: o.discount, name: o.productName,
            description: `${o.discount}% OFF - ${o.productName}`,
            originalPrice: o.originalPrice || null, currentPrice: o.currentPrice || null,
            url: storeUrl, deliveryTime: '', rating: '', imageUrl: '',
          });
        }
      } catch (e) {
        console.log(`  [${store.name}] Error: ${e.message.substring(0, 60)}`);
      }
    }

    console.log(`[Rappi Super] ${offers.filter(o => o.category === 'supermercado').length} ofertas >${MIN_SUPER}%`);

  } catch (err) {
    console.error(`[Rappi] Error: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return offers;
}
