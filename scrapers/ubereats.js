const LAT = process.env.LATITUDE || '-31.4201';
const LNG = process.env.LONGITUDE || '-64.1888';
const MIN_RESTAURANT = parseInt(process.env.MIN_DISCOUNT || '60');

const LOC_COOKIE = encodeURIComponent(JSON.stringify({
  address: { title: "Cordoba, Argentina" },
  latitude: parseFloat(LAT),
  longitude: parseFloat(LNG),
  type: "google_places",
  source: "manual_auto_complete",
}));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchSession() {
  const res = await fetch('https://www.ubereats.com/ar', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  const cookies = setCookies.map(c => c.split(';')[0]).join('; ');
  return `${cookies}; uev2.loc=${LOC_COOKIE}`;
}

function extractDiscounts(item) {
  const store = item.store;
  if (!store) return null;

  const signposts = store.signposts || [];
  let discount = 0;
  let promoText = '';

  for (const sp of signposts) {
    const text = sp.text || '';
    const match = text.match(/(\d+)%\s*off/i);
    if (match) {
      const d = parseInt(match[1], 10);
      if (d > discount) { discount = d; promoText = text; }
    }
    if (text.match(/buy\s*1.*get\s*1/i) || text.match(/2x1/i)) {
      if (50 > discount) { discount = 50; promoText = text; }
    }
  }

  for (const field of [store.meta, store.meta2, store.meta4]) {
    if (!Array.isArray(field)) continue;
    for (const entry of field) {
      const text = entry?.text || entry?.richText?.accessibilityText || '';
      const m = text.match(/(\d+)%\s*(off|dto|descuento)/i);
      if (m) {
        const d = parseInt(m[1], 10);
        if (d > discount) { discount = d; promoText = text; }
      }
      if (text.match(/2x1|buy\s*1.*get\s*1|2da\s*unidad/i)) {
        if (50 > discount) { discount = 50; promoText = text; }
      }
    }
  }

  const overlay = store.imageOverlay;
  if (overlay?.text) {
    const m = overlay.text.match(/(\d+)%\s*(off|dto)/i);
    if (m) {
      const d = parseInt(m[1], 10);
      if (d > discount) { discount = d; promoText = overlay.text; }
    }
  }

  if (discount < MIN_RESTAURANT) return null;

  const name = store.title?.text || 'Restaurante';
  const uuid = store.storeUuid || store.uuid || '';
  const eta = store.meta?.find(m => m.badgeType === 'ETD')?.text || '';
  const rating = store.rating?.text || '';
  const actionUrl = store.actionUrl || '';

  let url = 'https://www.ubereats.com/ar';
  if (actionUrl) {
    url = actionUrl.startsWith('http') ? actionUrl : `https://www.ubereats.com${actionUrl}`;
  } else if (uuid) {
    url = `https://www.ubereats.com/store/${uuid}`;
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
  const seen = new Set();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cookies = await fetchSession();
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const body = offset > 0
          ? { pageInfo: { offset, pageSize: 80 } }
          : {};

        const feedRes = await fetch('https://www.ubereats.com/_p/api/getFeedV1?localeCode=es-ar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept-Language': 'es-AR,es;q=0.9',
            'x-csrf-token': 'x',
            'User-Agent': UA,
            'Origin': 'https://www.ubereats.com',
            'Referer': 'https://www.ubereats.com/ar/feed',
            'Cookie': cookies,
          },
          body: JSON.stringify(body),
        });

        const feedData = await feedRes.json();

        if (feedData.status !== 'success') {
          console.log(`[UberEats] API status: ${feedData.status}`);
          break;
        }

        const feedItems = feedData.data?.feedItems || [];
        const meta = feedData.data?.meta || {};
        hasMore = meta.hasMore === true && feedItems.length > 0;

        if (offset === 0 && feedItems.length > 0) {
          const sample = feedItems.find(i => i.type === 'REGULAR_STORE');
          if (sample?.store) {
            const s = sample.store;
            console.log(`[UberEats] Sample store fields: signposts=${JSON.stringify(s.signposts)?.substring(0,100)} meta=${JSON.stringify(s.meta)?.substring(0,100)} meta2=${JSON.stringify(s.meta2)?.substring(0,100)} meta4=${JSON.stringify(s.meta4)?.substring(0,100)} imageOverlay=${JSON.stringify(s.imageOverlay)?.substring(0,100)} endorsements=${JSON.stringify(s.endorsements)?.substring(0,100)}`);
          }
        }

        for (const item of feedItems) {
          if (item.type !== 'REGULAR_STORE') continue;

          const offer = extractDiscounts(item);
          if (offer && !seen.has(offer.slug)) {
            seen.add(offer.slug);
            offers.push(offer);
          }
        }

        offset += feedItems.length;
        if (offset >= 500) break;
      }

      console.log(`[UberEats] ${offers.length} ofertas >${MIN_RESTAURANT}% de restaurantes (${offset} stores scanned)`);
      return offers;
    } catch (err) {
      console.error(`[UberEats] Attempt ${attempt} error: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return offers;
}
