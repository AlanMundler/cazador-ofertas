// Digest de mejores ofertas: adapta el deck nuevo a la forma que espera el notifier.

export function toTelegramOffer(product) {
  return {
    platform: product.platform,
    category: 'supermercado',
    restaurant: product.storeName,
    slug: product.storeId,
    discount: product.discount,
    name: product.name,
    description: product.promoDetail ?? '',
    originalPrice: product.beforePrice ? `$ ${formatPrice(product.beforePrice)}` : '',
    currentPrice: `$ ${formatPrice(product.price)}`,
    url: product.url,
    promoType: product.promoType,
    imageUrl: '',
  };
}

function formatPrice(value) {
  return Number(value).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

export function offerKey(product) {
  return `${product.platform}|${product.storeId}|${product.productId}|${product.price}`;
}

/**
 * Arma las tres listas que consume sendMessage.
 * `keep` filtra sobre el producto normalizado antes de mapear (dedupe entre corridas).
 */
export function buildDigest(ranked, { maxOffers = 24, maxFlash = 10, keep = () => true } = {}) {
  const buckets = Object.values(ranked?.byPlatform ?? {});
  const interleaved = [];
  const max = Math.max(0, ...buckets.map(bucket => bucket.topDiscount.length));
  for (let index = 0; index < max; index += 1) {
    for (const bucket of buckets) {
      const offer = bucket.topDiscount[index];
      if (offer && keep(offer)) interleaved.push(offer);
    }
  }

  const flash = buckets.flatMap(bucket => bucket.flash ?? []).filter(keep);
  const bestPrice = buckets.flatMap(bucket => bucket.bestPriceByProduct.map(entry => entry.product)).filter(keep);

  const offers = interleaved.slice(0, maxOffers);
  const flashList = flash.sort((a, b) => b.discount - a.discount).slice(0, maxFlash);

  return {
    offers: offers.map(toTelegramOffer),
    flash: flashList.map(toTelegramOffer),
    bestPrice: bestPrice.map(toTelegramOffer),
    raw: { offers, flash: flashList, bestPrice },
  };
}

export function digestSummary(deck) {
  return (deck.coverages ?? [])
    .map(coverage => `${coverage.platform}: ${coverage.storesSeen} tiendas, ${coverage.catalogCoverage.itemsSeen} productos (${coverage.health})`)
    .join(' | ');
}
