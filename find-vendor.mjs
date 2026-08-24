import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('', { headless: false, viewport: { width: 1366, height: 768 } });
const page = ctx.pages()[0] || await ctx.newPage();

let allUrls = [];
page.on('request', req => allUrls.push(req.url()));

try {
  await page.goto('https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-crisol-047c172b-2380-4da9-901b-2f29711032db-menu?origin=shop_list', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Waiting for CF...');
  await page.waitForTimeout(25000);
  console.log('Title:', await page.title());
  
  // Now scroll / click to trigger API calls
  await page.waitForTimeout(5000);
  
  const groceryUrls = allUrls.filter(u => u.includes('grocer') || u.includes('vendor') || u.includes('store') || u.includes('menu'));
  console.log('\nRelevant URLs:');
  groceryUrls.forEach(u => console.log(u.substring(0, 300)));
  
  // Try extracting from page HTML
  const vendorData = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      const m = text.match(/vendorId['":\s]+['"]?(\d+)/);
      if (m) return { vendorId: m[1], source: 'script' };
    }
    // Try window state
    for (const key of Object.keys(window)) {
      try {
        const val = JSON.stringify(window[key]);
        if (val && val.includes('vendorId')) {
          const m2 = val.match(/"vendorId":\s*"?(\d+)/);
          if (m2) return { vendorId: m2[1], source: key };
        }
      } catch {}
    }
    return { vendorId: null };
  });
  console.log('\nVendor data:', JSON.stringify(vendorData));

} catch(e) {
  console.log('Error:', e.message);
}

await ctx.close();
