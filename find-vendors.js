import { chromium } from 'patchright';

const ctx = await chromium.launchPersistentContext('', { headless: false, viewport: { width: 1366, height: 768 } });
const page = ctx.pages()[0] || await ctx.newPage();

page.on('response', async (resp) => {
  const url = resp.url();
  if (url.includes('/vendors/') && (url.includes('/categories') || url.includes('/products'))) {
    console.log(`[API] ${url}`);
  }
});

console.log('--- JUMBO ---');
await page.goto('https://www.pedidosya.com.ar/restaurantes/cordoba/jumbo-cordoba-791c33b2-6317-4717-8b90-6bee5a9554fa-menu', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000);

const jumboInfo = await page.evaluate(() => {
  const html = document.documentElement.innerHTML;
  // Look for vendor ID patterns
  const vendorMatch = html.match(/"id"\s*:\s*(\d{5,7})/);
  const busMatch = html.match(/"businessTypeId"\s*:\s*"?(\d+)/);
  const typeMatch = html.match(/"type"\s*:\s*"([^"]+)"/);
  return { vendor: vendorMatch?.[1], business: busMatch?.[1], type: typeMatch?.[1] };
});
console.log('Jumbo info:', JSON.stringify(jumboInfo));

// Try clicking on products to trigger API
console.log('Trying to find products...');
const productLinks = await page.$$('a[href*="/producto"]');
console.log(`Found ${productLinks.length} product links`);

// Check page content for business type
const pageText = await page.evaluate(() => {
  const el = document.querySelector('[data-testid]') || document.querySelector('main') || document.body;
  return el?.textContent?.substring(0, 500);
});
console.log('Page text:', pageText?.substring(0, 200));

// Try the groceries API with the UUID
const groceryTest = await page.evaluate(async (uuid) => {
  try {
    const resp = await fetch('/groceries/web/v1/vendors/' + uuid + '/categories', { credentials: 'include' });
    return { status: resp.status, body: await resp.text().then(t => t.substring(0, 200)) };
  } catch(e) { return { error: e.message }; }
}, '791c33b2-6317-4717-8b90-6bee5a9554fa');
console.log('Jumbo grocery API with UUID:', JSON.stringify(groceryTest));

// Try regular vendor API
const vendorTest = await page.evaluate(async () => {
  try {
    const resp = await fetch('/v1/vendors/791c33b2-6317-4717-8b90-6bee5a9554fa', { credentials: 'include' });
    return { status: resp.status, body: await resp.text().then(t => t.substring(0, 300)) };
  } catch(e) { return { error: e.message }; }
});
console.log('Jumbo vendor API with UUID:', JSON.stringify(vendorTest));

await ctx.close();
