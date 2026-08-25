import config from '../config.js';
import { chromium } from 'patchright';

const MIN_RESTAURANT = config.discounts.restaurant;
const CONCURRENCY = config.ubereats.concurrency;

const LOC_COOKIE = encodeURIComponent(JSON.stringify({
  address: 'San José de Calasanz 50',
  reference: '',
  referenceType: 'google_places',
  latitude: parseFloat(config.lat),
  longitude: parseFloat(config.lng),
}));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchSession() {
  const feedUrl = `${config.ubereats.baseUrl}/ar/feed?pl=${LOC_COOKIE}`;
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1366, height: 768 },
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    let title = await page.title();
    if (title.includes('momento') || title.includes('Momento')) {
      console.log('[UberEats] Waiting for Cloudflare...');
      await page.waitForTimeout(15000);
      title = await page.title();
    }

    if (title.includes('momento') || title.includes('denegado')) {
      throw new Error('Cloudflare blocked');
    }

    console.log(`[UberEats] CF passed, title: ${title.substring(0, 60)}`);

    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return cookieStr;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function parseDiscount(text) {
  if (!text) return 0;
  const m = text.match(/(\d+)%\s*(off|dto|descuento)/i);
  if (m) return parseInt(m[1], 10);
  if (/buy\s*1.*get\s*1|2x1|2da\s*unidad/i.test(text)) return 50;
  return 0;
}

function extractFromStoreV1(data, uuid) {
  let discount = 0;
  let promoText = '';

  if (data.promotion) {
    const d = parseDiscount(data.promotion.text || data.promotion);
    if (d > discount) { discount = d; promoText = data.promotion.text || data.promotion; }
  }

  if (data.suggestedPromotion?.text) {
    const d = parseDiscount(data.suggestedPromotion.text);
    if (d > discount) { discount = d; promoText = data.suggestedPromotion.text; }
  }

  if (data.hasStorePromotion && discount === 0) {
    discount = 20;
    promoText = 'Store promotion';
  }

  const sections = data.catalogSectionsMap || {};
  for (const [, arr] of Object.entries(sections)) {
    for (const section of arr) {
      const title = section?.payload?.standardItemsPayload?.title || '';
      if (/buy\s*1.*get\s*1|2x1|ofertas?|descuentos?|promo/i.test(title)) {
        const items = section.payload.standardItemsPayload.catalogItems || [];
        for (const item of items) {
          if (item.purchaseInfo?.purchaseOptions?.length > 0) {
            if (50 > discount) { discount = 50; promoText = title; }
          }
        }
      }
    }
  }

  if (discount < MIN_RESTAURANT) return null;

  const name = data.title || 'Restaurante';
  const eta = data.etaRange?.text || '';
  const rating = data.rating?.ratingValue || '';
  const url = data.slug
    ? `${config.ubereats.baseUrl}/store/${data.slug}/${uuid}`
    : `${config.ubereats.baseUrl}/store/${uuid}`;

  return {
    platform: 'UberEats', category: 'restaurante',
    restaurant: name, slug: uuid, discount,
    description: promoText || `${discount}% OFF`,
    originalPrice: null, currentPrice: null,
    url, deliveryTime: eta, rating,
    imageUrl: data.heroImageUrls?.[0] || '',
  };
}

function extractFromFeed(item) {
  const store = item.store;
  if (!store) return null;

  const signposts = store.signposts || [];
  let discount = 0;
  let promoText = '';

  for (const sp of signposts) {
    const text = sp.text || '';
    const m = parseDiscount(text);
    if (m > discount) { discount = m; promoText = text; }
  }

  if (discount < MIN_RESTAURANT) return null;

  const name = store.title?.text || 'Restaurante';
  const uuid = store.storeUuid || store.uuid || '';
  const eta = store.meta?.find(m => m.badgeType === 'ETD')?.text || '';
  const rating = store.rating?.text || '';
  const actionUrl = store.actionUrl || '';

  let url = `${config.ubereats.baseUrl}/ar`;
  if (actionUrl) {
    url = actionUrl.startsWith('http') ? actionUrl : `${config.ubereats.baseUrl}${actionUrl}`;
  } else if (uuid) {
    url = `${config.ubereats.baseUrl}/store/${uuid}`;
  }

  return {
    platform: 'UberEats', category: 'restaurante',
    restaurant: name, slug: uuid, discount,
    description: promoText || `${discount}% OFF`,
    originalPrice: null, currentPrice: null,
    url, deliveryTime: eta, rating,
    imageUrl: store.image?.items?.[0]?.url || '',
  };
}

async function fetchStoreV1(cookies, uuid) {
  const res = await fetch(`${config.ubereats.storeEndpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'es-AR,es;q=0.9',
      'x-csrf-token': 'x',
      'User-Agent': UA,
      'Origin': config.ubereats.baseUrl,
      'Referer': `${config.ubereats.baseUrl}/ar/feed`,
      'Cookie': cookies,
    },
    body: JSON.stringify({
      storeUuid: uuid,
      diningMode: 'DELIVERY',
      time: { asap: true },
      cbType: 'EATER_ENDORSED',
    }),
  });
  const json = await res.json();
  return json.status === 'success' ? json.data : null;
}

async function batchMap(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

export async function scrapeUberEats() {
  const offers = [];
  const seen = new Set();
  const needStoreV1 = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cookies = await fetchSession();
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const body = offset > 0
          ? { pageInfo: { offset, pageSize: 80 } }
          : {};

        const feedRes = await fetch(config.ubereats.feedEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept-Language': 'es-AR,es;q=0.9',
            'x-csrf-token': 'x',
            'User-Agent': UA,
            'Origin': config.ubereats.baseUrl,
            'Referer': `${config.ubereats.baseUrl}/ar/feed`,
            'Cookie': cookies,
          },
          body: JSON.stringify(body),
        });

        const feedData = await feedRes.json();
        if (feedData.status !== 'success') {
          console.log(`[UberEats] Feed status: ${feedData.status}`);
          break;
        }

        const feedItems = feedData.data?.feedItems || [];
        const meta = feedData.data?.meta || {};
        hasMore = meta.hasMore === true && feedItems.length > 0;

        for (const item of feedItems) {
          if (item.type === 'REGULAR_CAROUSEL') {
            const children = item.children || item.storeList || [];
            for (const child of children) {
              const store = child.store || child;
              const uuid = store?.storeUuid || store?.uuid || '';
              if (!uuid || seen.has(uuid)) continue;
              seen.add(uuid);
              const offer = extractFromFeed({ store });
              if (offer) offers.push(offer);
              else needStoreV1.push(uuid);
            }
            continue;
          }
          if (item.type !== 'REGULAR_STORE') continue;

          const store = item.store;
          const uuid = store?.storeUuid || store?.uuid || '';
          if (!uuid || seen.has(uuid)) continue;
          seen.add(uuid);

          const feedOffer = extractFromFeed(item);
          if (feedOffer) {
            offers.push(feedOffer);
          } else {
            needStoreV1.push(uuid);
          }
        }

        offset += feedItems.length;
        if (offset >= 500) break;
      }

      console.log(`[UberEats] Feed: ${seen.size} stores, ${offers.length} from signposts, ${needStoreV1.length} need getStoreV1`);
      console.log(`[UberEats] Feed items total: ${feedItems.length}, offset: ${offset}`);

      if (needStoreV1.length > 0) {
        const results = await batchMap(needStoreV1, async (uuid) => {
          try {
            const data = await fetchStoreV1(cookies, uuid);
            return data ? extractFromStoreV1(data, uuid) : null;
          } catch {
            return null;
          }
        }, CONCURRENCY);

        for (const offer of results) {
          if (offer) offers.push(offer);
        }
        console.log(`[UberEats] getStoreV1: ${results.filter(Boolean).length} offers from ${needStoreV1.length} stores`);
      }

      console.log(`[UberEats] Total: ${offers.length} offers >${MIN_RESTAURANT}%`);
      return offers;
    } catch (err) {
      console.error(`[UberEats] Attempt ${attempt} error: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return offers;
}
