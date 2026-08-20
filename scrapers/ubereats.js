import puppeteer from 'puppeteer';

const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';

export async function scrapeUberEats() {
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

    // Go to UberEats Argentina landing
    await page.goto('https://www.ubereats.com/ar', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Try to set location via the address input
    try {
      // Wait for address input
      const inputSelector = 'input[id*="location"], input[data-testid*="location"], input[placeholder*="dirección"], input[placeholder*="address"], input[placeholder*="Enter"]';
      await page.waitForSelector(inputSelector, { timeout: 5000 });

      const input = await page.$(inputSelector);
      if (input) {
        await input.click();
        await new Promise(r => setTimeout(r, 500));
        await input.type('Avenida General Paz, Cordoba, Argentina', { delay: 30 });
        await new Promise(r => setTimeout(r, 2000));

        // Click first suggestion
        const suggestionSelector = '[data-testid*="suggestion"], [role="option"], [id*="result"], li';
        try {
          await page.waitForSelector(suggestionSelector, { timeout: 3000 });
          const suggestion = await page.$(suggestionSelector);
          if (suggestion) {
            await suggestion.click();
            await new Promise(r => setTimeout(r, 5000));
          }
        } catch {}
      }
    } catch (e) {
      console.log(`[UberEats] Location input: ${e.message}`);
    }

    // Check current URL
    const currentUrl = page.url();
    console.log(`[UberEats] URL after location: ${currentUrl}`);

    // If we're still on landing page, try direct feed URL with coordinates
    if (!currentUrl.includes('/feed')) {
      // Try the feed URL with a properly encoded location
      const locationData = {
        address: 'Avenida General Paz 400, Cordoba, Argentina',
        reference: 'here:af:streetsection:PAvGrPaz:Cordoba400',
        referenceType: 'here_places',
        latitude: parseFloat(LAT),
        longitude: parseFloat(LNG),
      };
      const pl = btoa(encodeURIComponent(JSON.stringify(locationData)));
      await page.goto(`https://www.ubereats.com/feed?diningMode=DELIVERY&pl=${pl}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
    }

    // Scroll to load content
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 800));
    }

    const finalUrl = page.url();
    console.log(`[UberEats] Final URL: ${finalUrl}`);

    // Extract from page text
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const discountMatch = line.match(/^(\d+)%\s*(?:OFF|off)/i) ||
                           line.match(/^Buy 1, Get 1 Free$/i) ||
                           line.match(/^(\d+)\s*Offers?\s*Available$/i);

      if (discountMatch) {
        let discount = 0;
        if (line.match(/(\d+)%/)) {
          discount = parseInt(line.match(/(\d+)%/)[1], 10);
        } else if (line.includes('Buy 1, Get 1') || line.includes('2x1')) {
          discount = 50;
        }

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
            platform: 'UberEats',
            restaurant: name || 'Restaurante',
            slug: '',
            discount,
            description: line,
            originalPrice: null,
            currentPrice: null,
            url: 'https://www.ubereats.com/ar',
            deliveryTime: '',
            rating: '',
            imageUrl: '',
          });
        }
      }
    }

    // Also check for store links with discounts
    const storeLinks = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/store/"]');
      const results = [];
      for (const link of links) {
        const text = link.textContent || '';
        const card = link.closest('[class*="card"]') || link;
        const cardText = card.textContent || '';
        const promoMatch = cardText.match(/(\d+)%\s*(?:OFF|off)/i);
        if (promoMatch) {
          const name = card.querySelector('h2, h3')?.textContent?.trim() || link.textContent.trim().split('\n')[0];
          results.push({ name, discount: parseInt(promoMatch[1], 10), url: link.href });
        }
      }
      return results;
    });

    for (const s of storeLinks) {
      if (s.discount >= parseFloat(process.env.MIN_DISCOUNT || '60')) {
        offers.push({
          platform: 'UberEats',
          restaurant: s.name,
          slug: s.url,
          discount: s.discount,
          description: `${s.discount}% OFF`,
          originalPrice: null,
          currentPrice: null,
          url: s.url,
          deliveryTime: '',
          rating: '',
          imageUrl: '',
        });
      }
    }

    console.log(`[UberEats] ${offers.length} ofertas >${process.env.MIN_DISCOUNT || '60'}% encontradas`);
  } catch (err) {
    console.error(`[UberEats] Error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return offers;
}
