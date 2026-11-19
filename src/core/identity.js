// Identidad de producto: gates duros (marca + unidad) y Jaccard sólo como sugeridor.

import { baseSize, parseSize } from './normalize.js';

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'con', 'para', 'por', 'en', 'al', 'y', 'o', 'e', 'pack',
  'the', 'and', 'with', 'of', 'a',
]);

const EMPTY_BRANDS = new Set(['', 'unbranded', 'generico', 'generic', 'sin marca', 's/m', 'n/a', 'none', 'null']);

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Minúsculas, sin acentos ni puntuación, sin stopwords ni tokens de tamaño. */
export function normalizeName(name) {
  if (name == null) return '';
  const tokens = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);

  return tokens
    .filter(token => token.length > 1)
    .filter(token => !STOPWORDS.has(token))
    .filter(token => !/^\d+(?:[.,]\d+)?$/.test(token))
    .filter(token => !['g', 'gr', 'kg', 'ml', 'cc', 'l', 'lt', 'un', 'und', 'u', 'm', 'cm', 'x'].includes(token))
    .join(' ');
}

/** Clave de marca; null para marcas vacías o genéricas. */
export function brandKey(brand) {
  if (brand == null) return null;
  const normalized = normalizeName(brand);
  if (!normalized) return null;
  const compact = normalized.replace(/\s+/g, '');
  return EMPTY_BRANDS.has(compact) ? null : compact;
}

/** Unidad base (g, ml, un, m) más valor redondeado. */
export function sizeKey(size) {
  if (!size) return null;
  if (typeof size === 'string') {
    const parsed = parseSize(size);
    if (!parsed) return null;
    size = parsed;
  }
  const base = baseSize(size);
  if (!base) return null;
  return `${round(base.value, 3)}${base.unit}`;
}

/** Unidad base de tamaño, para el gate "misma unidad". */
export function sizeUnit(size) {
  if (typeof size === 'string') size = parseSize(size);
  return baseSize(size)?.unit ?? null;
}

function tokenSet(value) {
  if (Array.isArray(value)) {
    return new Set(value.map(token => String(token).toLowerCase()).filter(Boolean));
  }
  const normalized = normalizeName(value);
  return new Set(normalized ? normalized.split(' ') : []);
}

/** Jaccard sobre tokens normalizados. 0 si ambos conjuntos están vacíos. */
export function jaccard(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : round(intersection / union, 4);
}

export function productKey(product) {
  return `${product.platform}:${product.storeId}:${product.productId}`;
}

function nameOf(product) {
  return product.rawName ?? product.name ?? '';
}

function priceDiff(a, b) {
  const left = Number.isFinite(a.unitPrice) ? a.unitPrice : a.price;
  const right = Number.isFinite(b.unitPrice) ? b.unitPrice : b.price;
  const abs = round(Math.abs(left - right));
  const max = Math.max(left, right);
  return {
    abs,
    pct: max > 0 ? round((abs / max) * 100) : 0,
    cheaper: left < right ? 'a' : right < left ? 'b' : null,
  };
}

/**
 * Pares candidatos cross-platform para cola de revisión humana.
 * Gates duros: marca normalizada igual + misma unidad de tamaño.
 * Jaccard >= minScore sobre el nombre normalizado. Nunca ranking.
 */
export function candidatePairs(products, { minScore = 0.82 } = {}) {
  const groups = new Map();

  for (const product of products || []) {
    if (!product || !Number.isFinite(product.price)) continue;
    const brand = brandKey(product.brand);
    const size = sizeKey(product.size);
    if (!brand || !size || size === '0') continue;

    const key = `${brand}|${size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  const pairs = [];
  for (const [key, items] of groups) {
    const [brand, size] = key.split('|');
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        if (a.platform === b.platform) continue;
        if (a.productId === b.productId && a.storeId === b.storeId) continue;

        const score = jaccard(nameOf(a), nameOf(b));
        if (score < minScore) continue;

        pairs.push({ a, b, score, brand, size, unit: sizeUnit(a.size), priceDiff: priceDiff(a, b) });
      }
    }
  }

  return pairs.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftKey = `${left.a.platform}:${left.a.productId}`;
    const rightKey = `${right.a.platform}:${right.a.productId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}
