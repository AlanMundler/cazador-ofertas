// Mensaje de ofertas: compacto, una línea por producto, link en el nombre del local.
// Formato HTML de Telegram: <a href="...">Local</a>. Sin "antes" ni ahorro: precio final + %.

import { normalizeName, sizeKey } from './core/identity.js';

export function offerKey(product) {
  return `${product.platform}|${product.storeId}|${product.productId}|${product.price}`;
}

function money(value) {
  return `$${Number(value).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function storeLink(product) {
  const name = escapeHtml(product.storeName || product.platform);
  if (product.url && /^https:\/\//.test(product.url)) {
    return `<a href="${product.url}">${name}</a>`;
  }
  return name;
}

function offerLine(product) {
  return `• ${product.discount}% ${escapeHtml(product.name)} — ${money(product.price)} — ${storeLink(product)}`;
}

const PLATFORM_LABEL = { PedidosYa: 'PEDIDOSYA', Rappi: 'RAPPI', UberEats: 'UBER EATS' };

/**
 * Arma el mensaje completo: todas las ofertas que pasan el umbral, una línea cada una.
 * `keep` filtra lo ya notificado; `dedupe` evita repetir el mismo producto en varias sucursales.
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

  const exact = new Map();
  for (const [platform, bucket] of Object.entries(ranked?.byPlatform ?? {})) {
    exact[platform] = (bucket.topDiscount ?? []).filter(keep);
  }

  const seen = new Set();
  const fresh = {};
  for (const [platform, offers] of Object.entries(exact)) {
    const deduped = [];
    for (const product of offers) {
      const key = `${platform}|${normalizeName(product.name)}|${sizeKey(product.size) ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(product);
    }
    if (deduped.length) fresh[platform] = deduped;
  }

  const rule = Object.entries(thresholds)
    .filter(([, value]) => Number.isFinite(value))
    .map(([platform, value]) => `${PLATFORM_LABEL[platform] ?? platform} ≥${value}%`)
    .join(' · ');

  const lines = [`🛒 OFERTAS SUPER · ${when}${rule ? ` · ${rule}` : ''}`];

  for (const [platform, offers] of Object.entries(fresh)) {
    lines.push('');
    lines.push(`<b>${PLATFORM_LABEL[platform] ?? platform.toUpperCase()}</b> · ${offers.length} ≥${thresholds[platform] ?? ''}%`);
    for (const product of offers) lines.push(offerLine(product));
  }

  const broken = coverages.filter(coverage => coverage.health && coverage.health !== 'ok');
  if (broken.length) {
    lines.push('');
    lines.push(broken.map(coverage => `⚠️ ${coverage.platform} ${coverage.health}`).join(' · '));
  }

  const count = Object.values(fresh).reduce((sum, list) => sum + list.length, 0);
  return {
    text: count ? lines.join('\n') : '',
    count,
    raw: { offers: Object.values(fresh).flat(), flash: [] },
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
