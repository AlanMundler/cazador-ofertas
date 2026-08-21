import { chromium } from 'patchright';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1366, height: 768 },
});
const page = context.pages()[0] || await context.newPage();

try {
  // Pass Cloudflare
  await page.goto('https://www.pedidosya.com.ar/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);
  let title = await page.title();
  if (title.includes('momento')) { await page.waitForTimeout(20000); title = await page.title(); }
  if (title.includes('momento')) throw new Error('BLOCKED');

  // Navigate to a store
  await page.goto('https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-25-de-mayo-bb184a2a-707c-4e62-86e8-0003e06e57af-menu?origin=shop_list', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(8000);

  // Get one category and print FULL item structure
  const fullItem = await page.evaluate(async () => {
    const catResp = await fetch('/groceries/web/v1/vendors/169481/categories', { credentials: 'include' });
    const catData = await catResp.json();
    const cats = catData.categories || [];
    
    // Get all category IDs
    const allCatIds = [];
    for (const cat of cats) {
      allCatIds.push(cat.id);
      for (const child of (cat.children || [])) {
        allCatIds.push(child.id);
      }
    }
    
    // Fetch products from a category that has campaigns (discounts)
    for (const catId of allCatIds.slice(0, 5)) {
      try {
        const pResp = await fetch(`/groceries/web/v1/vendors/169481/products?categoryId=${catId}&limit=5`, { credentials: 'include' });
        const pData = await pResp.json();
        if (pData.items && pData.items.length > 0) {
          const withDiscount = pData.items.find(i => i.campaigns && i.campaigns.length > 0);
          if (withDiscount) {
            return {
              categoryId: catId,
              categoryCount: allCatIds.length,
              fullItem: withDiscount,
              totalItems: pData.items.length,
              allItems: pData.items.map(i => ({
                name: i.description || i.name,
                price: i.price,
                salePrice: i.salePrice,
                originalPrice: i.originalPrice,
                unitPrice: i.unitPrice,
                campaigns: i.campaigns,
                tags: i.tags,
              }))
            };
          }
        }
      } catch(e) {}
    }
    
    // Fallback: just get first category items
    for (const catId of allCatIds.slice(0, 3)) {
      try {
        const pResp = await fetch(`/groceries/web/v1/vendors/169481/products?categoryId=${catId}&limit=5`, { credentials: 'include' });
        const pData = await pResp.json();
        if (pData.items && pData.items.length > 0) {
          return {
            categoryId: catId,
            categoryCount: allCatIds.length,
            fullItem: pData.items[0],
            totalItems: pData.items.length,
            allItems: pData.items.map(i => ({
              name: i.description || i.name,
              price: i.price,
              salePrice: i.salePrice,
              originalPrice: i.originalPrice,
              unitPrice: i.unitPrice,
              campaigns: i.campaigns,
              tags: i.tags,
            }))
          };
        }
      } catch(e) {}
    }
    
    return { error: 'no items found', catCount: allCatIds.length };
  });

  console.log('=== FULL PRODUCT STRUCTURE ===');
  console.log('Category IDs:', fullItem.categoryCount);
  console.log('Items in category:', fullItem.totalItems);
  console.log('\nFull item (with campaign):');
  console.log(JSON.stringify(fullItem.fullItem, null, 2));
  console.log('\nAll items summary:');
  for (const item of fullItem.allItems) {
    console.log(`  ${item.name} | price:${item.price} sale:${item.salePrice} orig:${item.originalPrice} | campaigns:${JSON.stringify(item.campaigns)}`);
  }

  // Also check for Carrefour which had the 70% off
  console.log('\n\n=== Carrefour Express (id=398683) ===');
  await page.goto('https://www.pedidosya.com.ar/restaurantes/cordoba/carrefour-express-blvd-san-juan-785-93a8196b-9665-4322-8f7e-31b7af23c22f-menu?origin=shop_list', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(8000);

  const carrefourData = await page.evaluate(async () => {
    const catResp = await fetch('/groceries/web/v1/vendors/398683/categories', { credentials: 'include' });
    const catData = await catResp.json();
    const cats = catData.categories || [];
    
    const allCatIds = [];
    for (const cat of cats) {
      allCatIds.push(cat.id);
      for (const child of (cat.children || [])) {
        allCatIds.push(child.id);
      }
    }
    
    const results = [];
    for (const catId of allCatIds) {
      try {
        const pResp = await fetch(`/groceries/web/v1/vendors/398683/products?categoryId=${catId}&limit=50`, { credentials: 'include' });
        const pData = await pResp.json();
        if (pData.items) {
          for (const item of pData.items) {
            if (item.campaigns && item.campaigns.length > 0) {
              results.push({
                name: item.description,
                price: item.price,
                salePrice: item.salePrice,
                originalPrice: item.originalPrice,
                unitPrice: item.unitPrice,
                campaigns: item.campaigns,
              });
            }
          }
        }
      } catch(e) {}
    }
    return { discountedItems: results, totalCats: allCatIds.length };
  });

  console.log(`Found ${carrefourData.discountedItems.length} discounted items across ${carrefourData.totalCats} categories`);
  for (const item of carrefourData.discountedItems) {
    console.log(`  ${item.name} | $${item.price} (orig:$${item.originalPrice}) | ${JSON.stringify(item.campaigns)}`);
  }

} catch(e) {
  console.log('Error:', e.message.substring(0, 500));
}

await context.close();
console.log('\nDone');
