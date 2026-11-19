// Ranking intra-plataforma. Nunca compara precios entre apps.

import { brandKey, normalizeName, productKey, sizeKey } from './identity.js';
import { PLATFORM_IDS } from './platforms.js';

const PLATFORMS = PLATFORM_IDS;

function emptyBucket() {
  return { topDiscount: [], bestPriceByProduct: [], flash: [] };
}

function compareNames(a, b) {
  const left = a.name ?? '';
  const right = b.name ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function byDiscount(a, b) {
  return (b.discount ?? 0) - (a.discount ?? 0)
    || a.price - b.price
    || compareNames(a, b);
}

/** Clave de identidad para "mejor precio": marca + tamaño exacto + nombre normalizado. */
function bestPriceKey(product) {
  const size = sizeKey(product.size);
  if (!size) return null;
  return `${brandKey(product.brand) ?? ''}|${size}|${normalizeName(product.name)}`;
}

/**
 * Rankea por plataforma: top descuento, mejor precio por producto y flash.
 * `minDiscount` puede ser número o mapa por plataforma: {PedidosYa:50, Rappi:50, UberEats:35}.
 * Devuelve {byPlatform, rejected:[{reason,count}], thresholds}.
 */
export function rankByPlatform(products, { minDiscount = 30, flash = 75, maxPerStore = Infinity } = {}) {
  const thresholdFor = platform => (typeof minDiscount === 'number'
    ? minDiscount
    : Number(minDiscount?.[platform] ?? minDiscount?.default ?? 30));
  const byPlatform = Object.fromEntries(PLATFORMS.map(platform => [platform, emptyBucket()]));
  const rejectedCounts = new Map();
  const valid = [];
  const seen = new Set();

  const reject = reason => rejectedCounts.set(reason, (rejectedCounts.get(reason) ?? 0) + 1);

  for (const product of Array.isArray(products) ? products : []) {
    if (!product || !Number.isFinite(product.price) || product.price < 100 || product.price > 10_000_000) {
      reject('price_out_of_range');
      continue;
    }
    if (product.available === false) {
      reject('unavailable');
      continue;
    }
    if (product.deliverability === 'unverified') {
      reject('deliverability_unverified');
      continue;
    }

    const key = `${productKey(product)}|${product.price}`;
    if (seen.has(key)) {
      reject('duplicate');
      continue;
    }
    seen.add(key);
    valid.push(product);
  }

  for (const product of valid) {
    if (!byPlatform[product.platform]) byPlatform[product.platform] = emptyBucket();
  }

  for (const platform of Object.keys(byPlatform)) {
    const bucket = byPlatform[platform];
    const list = valid.filter(product => product.platform === platform);
    if (list.length === 0) continue;

    const perStore = new Map();
    const min = thresholdFor(platform);
    for (const product of list.filter(item => (item.discount ?? 0) >= min).sort(byDiscount)) {
      const store = product.storeId ?? product.storeName ?? 'unknown';
      const count = perStore.get(store) ?? 0;
      if (count >= maxPerStore) continue;
      perStore.set(store, count + 1);
      bucket.topDiscount.push(product);
    }

    bucket.flash = list
      .filter(product => (product.discount ?? 0) >= flash)
      .sort(byDiscount);

    const groups = new Map();
    for (const product of list) {
      const key = bestPriceKey(product);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }

    for (const key of [...groups.keys()].sort()) {
      const offers = groups.get(key);
      const storeCount = new Set(offers.map(offer => offer.storeId ?? offer.storeName)).size;
      if (offers.length < 2 || storeCount < 2) continue;

      offers.sort((a, b) => (a.effectivePrice ?? a.price) - (b.effectivePrice ?? b.price) || byDiscount(a, b));
      bucket.bestPriceByProduct.push({
        key,
        product: offers[0],
        offerCount: offers.length,
        storeCount,
      });
    }
  }

  const rejected = [...rejectedCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  return { byPlatform, rejected };
}
