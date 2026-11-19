// Formato del mensaje de ofertas: una sola pieza de texto clara, sin markdown.
// Regla: sólo supermercados, umbral por plataforma y link directo a la tienda.

export function offerKey(product) {
  return `${product.platform}|${product.storeId}|${product.productId}|${product.price}`;
}

function money(value) {
  return `$${Number(value).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

function saving(product) {
  if (!product.beforePrice) return null;
  const diff = product.beforePrice - product.price;
  return diff > 0 ? money(diff) : null;
}

function offerBlock(product, index) {
  const lines = [`${index}. ${product.discount}% ${product.name}`];
  const before = product.beforePrice ? ` · antes ${money(product.beforePrice)}` : '';
  const saved = saving(product);
  lines.push(`   ${money(product.price)}${before}${saved ? ` · ahorrás ${saved}` : ''}`);
  lines.push(`   ${product.storeName}`);
  if (product.url && /^https:\/\//.test(product.url)) lines.push(`   ${product.url}`);
  return lines.join('\n');
}

const PLATFORM_LABEL = { PedidosYa: 'PEDIDOSYA', Rappi: 'RAPPI', UberEats: 'UBER EATS' };

/**
 * Arma el mensaje completo. Sin tablas ni símbolos raros: se lee en el celular.
 * `keep` filtra productos ya notificados; `maxPerPlatform` evita listas infinitas.
 */
export function buildDigest(ranked, {
  keep = () => true,
  coverages = [],
  thresholds = {},
  maxPerPlatform = 6,
  maxFlash = 4,
  now = new Date(),
} = {}) {
  const when = now.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const buckets = Object.entries(ranked?.byPlatform ?? {});
  const flash = buckets
    .flatMap(([, bucket]) => bucket.flash ?? [])
    .filter(keep)
    .sort((a, b) => b.discount - a.discount)
    .slice(0, maxFlash);

  const rule = Object.entries(thresholds)
    .filter(([, value]) => Number.isFinite(value))
    .map(([platform, value]) => `${PLATFORM_LABEL[platform] ?? platform} ≥${value}%`)
    .join(' · ');

  const lines = [];
  lines.push('🛒 OFERTAS SUPER · Córdoba');
  lines.push(`${when}${rule ? ` · ${rule}` : ''}`);

  if (flash.length) {
    lines.push('');
    lines.push('⚡ FLASH');
    flash.forEach((product, index) => {
      lines.push(offerBlock(product, index + 1));
    });
  }

  const fresh = {};
  for (const [platform, bucket] of buckets) {
    const offers = (bucket.topDiscount ?? []).filter(keep);
    if (!offers.length) continue;
    fresh[platform] = offers.slice(0, maxPerPlatform);
    lines.push('');
    lines.push(`${PLATFORM_LABEL[platform] ?? platform.toUpperCase()} · ${offers.length} oferta${offers.length === 1 ? '' : 's'} ≥${thresholds[platform] ?? ''}%`);
    fresh[platform].forEach((product, index) => {
      lines.push(offerBlock(product, index + 1));
    });
    if (offers.length > maxPerPlatform) {
      lines.push(`   …y ${offers.length - maxPerPlatform} más`);
    }
  }

  const covered = coverages
    .filter(coverage => coverage.storesScanned > 0)
    .map(coverage => `${coverage.platform} ${coverage.storesScanned}/${coverage.storesAvailable ?? '?'}`)
    .join(' · ');
  if (covered) {
    lines.push('');
    lines.push(`Cobertura: ${covered}`);
  }

  const hasOffers = flash.length > 0 || Object.keys(fresh).length > 0;
  return {
    text: hasOffers ? lines.join('\n') : '',
    count: flash.length + Object.values(fresh).reduce((sum, list) => sum + list.length, 0),
    raw: {
      flash,
      offers: Object.values(fresh).flat(),
    },
  };
}

/** Telegram corta en 4096; se parte por líneas para no romper un bloque. */
export function chunk(text, limit = 3500) {
  if (!text) return [];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line).length + 1 > limit) {
      parts.push(current.trimEnd());
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) parts.push(current.trimEnd());
  return parts;
}
