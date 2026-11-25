// Mensaje de ofertas: agrupado por plataforma y por supermercado.
// Formato HTML de Telegram: el nombre del local es el link. Precio final + % (par si es multibuy).

import { normalizeName, sizeKey } from './core/identity.js';

export function offerKey(product) {
  return `${product.platform}|${product.storeId}|${product.productId}|${product.price}`;
}

function money(value) {
  return `$${Number(value).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function storeLink(store) {
  const name = escapeHtml(store.name || 'Local');
  if (store.url && /^https:\/\//.test(store.url)) return `<a href="${store.url}">${name}</a>`;
  return name;
}

function offerLine(product) {
  const shown = Math.max(product.discount ?? 0, product.advertisedDiscount ?? 0);
  const qty = Number(product.requiresQty) > 1 ? Number(product.requiresQty) : 1;

  if (product.promoType === 'multibuy' && qty > 1) {
    const perUnit = Number.isFinite(product.effectivePrice) ? product.effectivePrice : product.price;
    const total = perUnit * qty;
    const note = product.promoDetail ? ` (${escapeHtml(product.promoDetail)})` : '';
    return `   • ${shown}% ${escapeHtml(product.name)} — ${money(total)} las ${qty} (${money(perUnit)} c/u)${note}`;
  }

  return `   • ${shown}% ${escapeHtml(product.name)} — ${money(product.price)}`;
}

const PLATFORM_LABEL = { PedidosYa: 'PEDIDOSYA', Rappi: 'RAPPI', UberEats: 'UBER EATS' };

function groupByStore(offers) {
  const stores = new Map();
  for (const product of offers) {
    const key = `${product.storeId ?? product.storeName}`;
    if (!stores.has(key)) {
      stores.set(key, { name: product.storeName, url: product.url, offers: [], names: new Set() });
    }
    const store = stores.get(key);
    const dedupeKey = `${normalizeName(product.name)}|${sizeKey(product.size) ?? ''}`;
    if (store.names.has(dedupeKey)) continue;
    store.names.add(dedupeKey);
    store.offers.push(product);
  }

  const list = [...stores.values()];
  for (const store of list) store.offers.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
  list.sort((a, b) => (b.offers[0]?.discount ?? 0) - (a.offers[0]?.discount ?? 0) || a.name.localeCompare(b.name));
  return list;
}

/**
 * Arma el mensaje completo: todas las ofertas del umbral, cada supermercado con su lista.
 * `keep` filtra lo ya notificado.
 */
export function buildDigest(ranked, {
  keep = () => true,
  coverages = [],
  thresholds = {},
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

  const byPlatform = {};
  for (const [platform, bucket] of Object.entries(ranked?.byPlatform ?? {})) {
    const stores = groupByStore((bucket.topDiscount ?? []).filter(keep));
    if (stores.length) byPlatform[platform] = stores;
  }

  const rule = Object.entries(thresholds)
    .filter(([, value]) => Number.isFinite(value))
    .map(([platform, value]) => `${PLATFORM_LABEL[platform] ?? platform} ≥${value}%`)
    .join(' · ');

  const lines = [`🛒 OFERTAS SUPER · ${when}${rule ? ` · ${rule}` : ''}`];

  for (const [platform, stores] of Object.entries(byPlatform)) {
    lines.push('');
    lines.push(`<b>${PLATFORM_LABEL[platform] ?? platform.toUpperCase()}</b>`);
    for (const store of stores) {
      lines.push(`${storeLink(store)} · ${store.offers.length}`);
      for (const product of store.offers) lines.push(offerLine(product));
    }
  }

  const broken = coverages.filter(coverage => coverage.health && coverage.health !== 'ok');
  if (broken.length) {
    lines.push('');
    lines.push(broken.map(coverage => `⚠️ ${coverage.platform} ${coverage.health}`).join(' · '));
  }

  const all = Object.values(byPlatform).flatMap(stores => stores.flatMap(store => store.offers));
  return {
    text: all.length ? lines.join('\n') : '',
    count: all.length,
    raw: { offers: all, flash: [] },
  };
}

/** Telegram corta en 4096; se parte por líneas para no romper un producto ni un tag HTML. */
export function chunk(text, limit = 3800) {
  if (!text) return [];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line).length + 1 > limit) {
      if (current.trim()) parts.push(current.trimEnd());
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) parts.push(current.trimEnd());
  return parts;
}
