import config from '../config.js';
import { chromium } from 'patchright';

const MIN_RESTAURANT = config.discounts.restaurant;

const LOC_COOKIE = encodeURIComponent(JSON.stringify({
  address: 'San José de Calasanz 50',
  reference: '',
  referenceType: 'google_places',
  latitude: parseFloat(config.lat),
  longitude: parseFloat(config.lng),
}));

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

export async function scrapeUberEats() {
  const offers = [];
  const needStoreV1Uuids = [];
  let context;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      context = await chromium.launchPersistentContext('', {
        headless: false,
        viewport: { width: 1366, height: 768 },
      });

      const page = context.pages()[0] || await context.newPage();
      const feedUrl = `${config.ubereats.baseUrl}/ar/feed?pl=${LOC_COOKIE}`;
      await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      let title = await page.title();
      if (title.includes('momento') || title.includes('Momento')) {
        console.log('[UberEats] Waiting for Cloudflare...');
        await page.waitForTimeout(15000);
        title = await page.title();
      }

      if (title.includes('momento') || title.includes('denegado')) {
        console.log('[UberEats] Cloudflare blocked, retrying...');
        await context.close().catch(() => {});
        context = null;
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      console.log(`[UberEats] CF passed, title: ${title.substring(0, 60)}`);

      await page.evaluate((loc) => {
        document.cookie = `uev2.loc=${loc}; path=/; domain=.ubereats.com`;
      }, LOC_COOKIE);

      const seen = new Set();
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const feedData = await page.evaluate(async ({ endpoint, body }) => {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
            body: JSON.stringify(body),
          });
          return res.json();
        }, {
          endpoint: config.ubereats.feedEndpoint,
          body: offset > 0 ? { pageInfo: { offset, pageSize: 80 } } : {},
        });

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
              else needStoreV1Uuids.push(uuid);
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
            needStoreV1Uuids.push(uuid);
          }
        }

        offset += feedItems.length;
        if (offset >= 500) break;
      }

      console.log(`[UberEats] Feed: ${seen.size} stores, ${offers.length} from signposts, ${needStoreV1Uuids.length} need getStoreV1`);

      for (const uuid of needStoreV1Uuids) {
        try {
          const data = await page.evaluate(async ({ endpoint, uuid }) => {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
              body: JSON.stringify({
                storeUuid: uuid,
                diningMode: 'DELIVERY',
                time: { asap: true },
                cbType: 'EATER_ENDORSED',
              }),
            });
            const json = await res.json();
            return json.status === 'success' ? json.data : null;
          }, { endpoint: config.ubereats.storeEndpoint, uuid });

          if (data) {
            const offer = extractFromStoreV1(data, uuid);
            if (offer) offers.push(offer);
          }
        } catch {}
      }

      console.log(`[UberEats] Total: ${offers.length} offers >${MIN_RESTAURANT}%`);
      break;
    } catch (err) {
      console.error(`[UberEats] Attempt ${attempt} error: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    } finally {
      if (context) { await context.close().catch(() => {}); context = null; }
    }
  }

  return offers;
}
