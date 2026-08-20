import puppeteer from 'puppeteer';

const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';

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

    const feedUrl = `https://www.rappi.com.ar/restaurantes?lat=${LAT}&lng=${LNG}`;
    await page.goto(feedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Click on "Promos" filter
    try {
      const promoBtn = await page.evaluateHandle(() => {
        const spans = document.querySelectorAll('span, button, div');
        for (const s of spans) {
          if (s.textContent.trim() === 'Promos') return s;
        }
        return null;
      });
      if (promoBtn) {
        await promoBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch {}

    // Scroll to load all restaurants
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 600));
    }

    // Extract from full text - Rappi layout:
    // ... "$ 790,00" / "4.3" / "45% OFF" / "Shasho" / "24 min" / "·"
    const restaurants = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      const results = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match discount patterns
        const discountMatch = line.match(/^(\d+)%\s*OFF$/i) ||
                             line.match(/^Hasta\s+(\d+)%\s*Off$/i);

        if (discountMatch) {
          const discount = parseInt(discountMatch[1], 10);

          // Restaurant name is typically 1-2 lines AFTER the discount
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

          // Delivery time is after the name
          let deliveryTime = '';
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + 6); j++) {
            if (lines[j].match(/\d+\s*min/)) {
              deliveryTime = lines[j];
              break;
            }
          }

          // Rating is before the discount (1-2 lines up)
          let rating = '';
          for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
            if (lines[j].match(/^\d\.\d$/)) {
              rating = lines[j];
              break;
            }
          }

          // Price is 2-3 lines before discount
          let price = '';
          for (let j = i - 2; j >= Math.max(0, i - 4); j--) {
            if (lines[j].match(/^\$\s*[\d.,]+$/)) {
              price = lines[j];
              break;
            }
          }

          // Find the restaurant link
          let url = '';
          const links = document.querySelectorAll('a[href*="/restaurantes/"]');
          for (const link of links) {
            if (link.textContent.trim().includes(name) || name.includes(link.textContent.trim().split('\n')[0])) {
              url = link.href;
              break;
            }
          }

          if (name) {
            results.push({
              name,
              discount,
              promoText: line,
              deliveryTime,
              rating,
              price,
              url: url || `https://www.rappi.com.ar/restaurantes`,
            });
          }
        }
      }

      return results;
    });

    const minDiscount = parseFloat(process.env.MIN_DISCOUNT || '60');
    for (const r of restaurants) {
      if (r.discount >= minDiscount) {
        offers.push({
          platform: 'Rappi',
          restaurant: r.name,
          slug: r.url,
          discount: r.discount,
          description: r.promoText,
          originalPrice: r.price || null,
          currentPrice: null,
          url: r.url,
          deliveryTime: r.deliveryTime,
          rating: r.rating,
          imageUrl: '',
        });
      }
    }

    // Log all found discounts for debugging
    console.log(`[Rappi] Todos los descuentos encontrados:`);
    for (const r of restaurants) {
      const marker = r.discount >= minDiscount ? ' >> NUEVA' : '';
      console.log(`  ${r.discount}% OFF - ${r.name} (${r.deliveryTime})${marker}`);
    }
    console.log(`[Rappi] ${offers.length} ofertas >${minDiscount}% de ${restaurants.length} descuentos totales`);
  } catch (err) {
    console.error(`[Rappi] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
