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

export async function scrapeUberEats() {
  const offers = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cookies = await fetchSession();

      const feedRes = await fetch('https://www.ubereats.com/_p/api/getFeedV1?localeCode=es-ar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'x',
          'User-Agent': UA,
          'Origin': 'https://www.ubereats.com',
          'Referer': 'https://www.ubereats.com/ar/feed',
          'Cookie': cookies,
        },
        body: JSON.stringify({
          cacheKey: '/DELIVERY///0/0//JTVCJTVE/undefined//////HOME////////',
          feedSessionCount: { announcementCount: 0, announcementLabel: '' },
          userQuery: '',
          date: '',
          startTime: 0,
          endTime: 0,
          sortAndFilters: [],
          isUserInitiatedRefresh: false,
          billboardUuid: '',
          feedProvider: '',
          promotionUuid: '',
          targetingStoreTag: '',
          venueUUID: '',
          selectedSectionUUID: '',
          favorites: '',
          vertical: '',
          searchSource: '',
          searchType: '',
          keyName: '',
          serializedRequestContext: '',
          carouselId: '',
        }),
      });

      const feedData = await feedRes.json();

      if (feedData.status !== 'success') {
        console.log(`[UberEats] API status: ${feedData.status}`);
        if (attempt === 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return offers;
      }

      const feedItems = feedData.data?.feedItems || [];
      console.log(`[UberEats] API returned ${feedItems.length} items`);

      for (const item of feedItems) {
        const store = item.store;
        if (!store) continue;

        const signposts = store.signposts || [];
        let discount = 0;
        let promoText = '';

        for (const sp of signposts) {
          const text = sp.text || '';
          const match = text.match(/(\d+)%\s*off/i);
          if (match) {
            const d = parseInt(match[1], 10);
            if (d > discount) {
              discount = d;
              promoText = text;
            }
          }
          if (text.match(/buy\s*1.*get\s*1/i) || text.match(/2x1/i)) {
            if (50 > discount) {
              discount = 50;
              promoText = text;
            }
          }
        }

        if (discount >= MIN_RESTAURANT) {
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

          offers.push({
            platform: 'UberEats',
            category: 'restaurante',
            restaurant: name,
            slug: uuid,
            discount,
            description: promoText || `${discount}% OFF`,
            originalPrice: null,
            currentPrice: null,
            url,
            deliveryTime: eta,
            rating,
            imageUrl: store.image?.items?.[0]?.url || '',
          });
        }
      }

      console.log(`[UberEats] ${offers.length} ofertas >${MIN_RESTAURANT}% de restaurantes`);
      return offers;
    } catch (err) {
      console.error(`[UberEats] Attempt ${attempt} error: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return offers;
}
