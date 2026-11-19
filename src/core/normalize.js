// Normalización de precios, tamaños y productos crudos de las tres plataformas.

const UNIT_ALIASES = new Map(Object.entries({
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  ml: 'ml', cc: 'ml',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  un: 'un', und: 'un', unds: 'un', unidad: 'un', unidades: 'un', u: 'un',
  m: 'm', metro: 'm', metros: 'm',
}));

const UNIT_PATTERN = 'kg|kgs|kilos?|kilogramos?|g|grs?|gramos?|ml|cc|l|lt|lts|litros?|unds?|unidades?|un|u|metros?|m';

export function canonicalUnit(unit) {
  if (unit == null) return null;
  const key = String(unit).trim().toLowerCase();
  return UNIT_ALIASES.get(key) ?? null;
}

function toNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Parsea montos ARS: "$ 1.174,50", "1390", 1174.5. Devuelve null si no es numérico. */
export function parseArs(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;

  let raw = input.trim().replace(/[^\d.,-]/g, '');
  if (!raw) return null;
  const negative = raw.startsWith('-');
  raw = raw.replace(/-/g, '');
  if (!raw) return null;

  const commas = (raw.match(/,/g) || []).length;
  const dots = (raw.match(/\./g) || []).length;
  let normalized = raw;

  if (commas > 0 && dots > 0) {
    const decimal = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    normalized = raw.split(thousands).join('').replace(decimal, '.');
  } else if (commas > 0) {
    const i = raw.lastIndexOf(',');
    normalized = commas === 1 ? raw.replace(',', '.') : `${raw.slice(0, i).replace(/,/g, '')}.${raw.slice(i + 1)}`;
  } else if (dots > 0) {
    if (dots > 1) {
      const i = raw.lastIndexOf('.');
      normalized = `${raw.slice(0, i).replace(/\./g, '')}.${raw.slice(i + 1)}`;
    } else {
      const [int, dec] = raw.split('.');
      // "1.174" es miles; "1174.5" es decimal.
      normalized = dec.length === 3 && int.length <= 3 ? `${int}${dec}` : raw;
    }
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Extrae tamaño de textos como "2.25L", "1 x 18 g", "6 unidades", "30 metros".
 * Mantiene la unidad tal como se escribió (normalizada a su alias).
 */
export function parseSize(text) {
  if (text == null) return null;
  const source = String(text).toLowerCase().replace(/\u00a0/g, ' ').trim();
  if (!source) return null;

  const multiplier = source.match(
    new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`)
  );
  if (multiplier) {
    const value = toNumber(multiplier[1]) * toNumber(multiplier[2]);
    const unit = canonicalUnit(multiplier[3]);
    if (Number.isFinite(value) && unit) return { value: round(value, 3), unit };
  }

  const plain = source.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`));
  if (plain) {
    const value = toNumber(plain[1]);
    const unit = canonicalUnit(plain[2]);
    if (Number.isFinite(value) && unit) return { value, unit };
  }

  return null;
}

/** Unidad base para comparar: g, ml, un, m. */
export function baseSize(size) {
  if (!size || !Number.isFinite(Number(size.value))) return null;
  const value = Number(size.value);
  const unit = canonicalUnit(size.unit) ?? String(size.unit ?? '').toLowerCase();
  if (!unit) return null;
  if (unit === 'kg') return { value: round(value * 1000, 3), unit: 'g' };
  if (unit === 'l') return { value: round(value * 1000, 3), unit: 'ml' };
  return { value, unit };
}

function sizeFromRaw(rawSize) {
  if (!rawSize || typeof rawSize !== 'object') return null;
  const value = Number(rawSize.content ?? rawSize.value);
  const unit = canonicalUnit(rawSize.unit);
  if (!Number.isFinite(value) || !unit) return null;
  return { value, unit };
}

function unitPriceFor(price, size) {
  const base = baseSize(size);
  if (!base || base.value <= 0) return { unitPrice: null, unitLabel: null };

  if (base.unit === 'g') return { unitPrice: round(price / (base.value / 1000)), unitLabel: '$/kg' };
  if (base.unit === 'ml') return { unitPrice: round(price / (base.value / 1000)), unitLabel: '$/l' };
  if (base.unit === 'un') return { unitPrice: round(price / base.value), unitLabel: '$/u' };
  if (base.unit === 'm') return { unitPrice: round(price / base.value), unitLabel: '$/m' };
  return { unitPrice: null, unitLabel: null };
}

function brandFromTitle(title) {
  if (!title) return null;
  const parts = String(title).split('·');
  if (parts.length < 2) return null;
  const brand = parts[0].trim();
  return brand || null;
}

function pyPromo(campaigns, price) {
  let best = null;

  for (const campaign of campaigns || []) {
    const config = campaign?.configuration ?? {};
    const pay = toNumber(config.pay);
    const take = toNumber(config.take);
    const isBundle = campaign?.type === 'sameItemBundle'
      || campaign?.type === 'multi-buy'
      || (pay != null && take != null && take > 1 && pay < take);

    if (isBundle && take > 1 && pay != null && pay >= 0 && pay < take) {
      // `value` es el descuento sobre las unidades de regalo (100 = gratis).
      // 2x1 con value 100 → 50%; "1 ud. al 50%" (pay 1, take 2, value 50) → 25%.
      const bonusUnits = take - pay;
      const rawValue = toNumber(config.value);
      const bonusDiscount = rawValue == null ? 100 : Math.max(0, Math.min(100, rawValue));
      const total = price * (pay + bonusUnits * (1 - bonusDiscount / 100));
      const candidate = {
        promoType: 'multibuy',
        promoDetail: campaign.tag ?? `${take}x${pay}`,
        effectivePrice: round(total / take),
        requiresQty: take,
      };
      if (!best || candidate.effectivePrice < best.effectivePrice) best = candidate;
      continue;
    }

    const percent = String(config.type ?? '').toUpperCase() === 'PERCENTAGE'
      || campaign?.type === 'percentageDiscount';
    if (percent && !best) {
      best = {
        promoType: 'percentage',
        promoDetail: campaign.tag ?? null,
        effectivePrice: price,
        requiresQty: 1,
      };
    }
  }

  return best ?? { promoType: null, promoDetail: null, effectivePrice: price, requiresQty: 1 };
}

function extractRaw(raw, platform) {
  const p = String(platform ?? '').toLowerCase();

  if (p === 'pedidosya') {
    const size = sizeFromRaw(raw.size) ?? parseSize(raw.name);
    return {
      productId: raw.id ?? raw.productId,
      rawName: raw.name ?? '',
      brand: raw.defaultBrandName && raw.defaultBrandName !== 'unbranded' ? raw.defaultBrandName : null,
      size,
      ean: typeof raw.gtin === 'string' && raw.gtin.trim() ? raw.gtin.trim() : null,
      price: parseArs(raw.pricing?.price ?? raw.price),
      beforePrice: parseArs(raw.pricing?.beforePrice ?? raw.beforePrice),
      available: raw.active !== false && raw.status?.enabled !== false,
      deliverability: 'unverified',
      promo: pyPromo(raw.campaigns, parseArs(raw.pricing?.price ?? raw.price) ?? 0),
      url: raw.deeplinks?.productDetail ?? raw.url ?? null,
    };
  }

  if (p === 'rappi') {
    const size = sizeFromRaw(raw.size) ?? parseSize(raw.presentation) ?? parseSize(raw.name);
    return {
      productId: raw.productId ?? raw.id,
      rawName: raw.name ?? raw.title ?? '',
      brand: raw.brand ?? null,
      size,
      ean: raw.ean ?? null,
      price: parseArs(raw.price),
      beforePrice: parseArs(raw.real_price ?? raw.beforePrice),
      // En Rappi `stock:0` puede convivir con `inStock:true` (frutas por peso).
      available: raw.inStock !== false,
      deliverability: 'verified',
      promo: { promoType: null, promoDetail: null, effectivePrice: null, requiresQty: 1 },
      url: raw.url ?? null,
    };
  }

  if (p === 'ubereats') {
    const option = raw.purchaseInfo?.purchaseOptions?.[0];
    const purchaseV2 = option?.purchasePriceV2;
    const purchasePrice = purchaseV2
      ? Number(purchaseV2.base?.low) * 10 ** Number(purchaseV2.exponent)
      : null;
    const price = raw.price != null ? Number(raw.price) / 100 : purchasePrice;

    let size = sizeFromRaw(raw.size) ?? null;
    if (!size) {
      for (const element of raw.itemThumbnailElements || []) {
        const label = element?.payload?.labelPayload?.label?.accessibilityText;
        if (!label || /^ARS\s/i.test(label) || /previous price/i.test(label)) continue;
        size = parseSize(label);
        if (size) break;
      }
    }
    if (!size) size = parseSize(raw.title);

    return {
      productId: raw.productInfo?.productUuid ?? raw.uuid ?? raw.productId,
      rawName: raw.title ?? raw.name ?? '',
      brand: raw.brand ?? brandFromTitle(raw.title),
      size,
      ean: raw.ean ?? null,
      price: Number.isFinite(price) ? price : null,
      beforePrice: Number.isFinite(purchasePrice) ? purchasePrice : null,
      available: raw.isSoldOut !== true
        && raw.isAvailable !== false
        && raw.itemAvailabilityState !== 'UNAVAILABLE',
      deliverability: 'verified',
      promo: { promoType: null, promoDetail: null, effectivePrice: null, requiresQty: 1 },
      url: raw.url ?? null,
    };
  }

  const size = sizeFromRaw(raw.size) ?? parseSize(raw.presentation ?? raw.name);
  return {
    productId: raw.productId ?? raw.id,
    rawName: raw.name ?? raw.title ?? '',
    brand: raw.brand ?? null,
    size,
    ean: raw.ean ?? raw.gtin ?? null,
    price: parseArs(raw.price ?? raw.pricing?.price),
    beforePrice: parseArs(raw.beforePrice ?? raw.real_price ?? raw.pricing?.beforePrice),
    available: raw.available !== false && raw.inStock !== false,
    deliverability: 'verified',
    promo: { promoType: null, promoDetail: null, effectivePrice: null, requiresQty: 1 },
    url: raw.url ?? null,
  };
}

/**
 * Producto crudo de plataforma -> objeto normalizado (spec §1).
 * Devuelve {ok:true, product} o {ok:false, reason}.
 */
export function normalizeProduct(raw, meta = {}) {
  const { platform, storeId = null, storeName = null, sampled = false } = meta;
  const storeKind = ['super', 'vertical', 'otro'].includes(meta.storeKind) ? meta.storeKind : 'otro';

  if (!platform) return { ok: false, reason: 'missing_platform' };
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'missing_raw' };

  const data = extractRaw(raw, platform);
  if (data.productId == null) return { ok: false, reason: 'missing_product_id' };

  const price = data.price;
  if (!Number.isFinite(price)) return { ok: false, reason: 'invalid_price' };
  if (price < 100) return { ok: false, reason: 'price_too_low' };
  if (price > 10_000_000) return { ok: false, reason: 'price_too_high' };

  // beforePrice sólo cuenta si supera el 5% del precio actual.
  const beforePrice = Number.isFinite(data.beforePrice) && data.beforePrice > price * 1.05
    ? data.beforePrice
    : null;

  const promo = data.promo ?? {};
  const effectivePrice = Number.isFinite(promo.effectivePrice) ? promo.effectivePrice : price;
  const requiresQty = Number.isInteger(promo.requiresQty) && promo.requiresQty > 0 ? promo.requiresQty : 1;

  // Un multibuy se mide contra el precio de lista (price), nunca contra beforePrice:
  // apilar markdown + bundle fabricaría un flash falso.
  const reference = promo.promoType === 'multibuy'
    ? (effectivePrice < price ? price : null)
    : beforePrice;
  const discount = reference
    ? Math.max(0, Math.min(100, Math.round((1 - effectivePrice / reference) * 100)))
    : 0;

  const { unitPrice, unitLabel } = unitPriceFor(price, data.size);
  const rawName = String(data.rawName ?? '').trim();

  const product = {
    platform,
    storeId,
    storeName,
    storeKind,
    productId: String(data.productId),
    rawName,
    brand: data.brand ?? null,
    name: rawName.replace(/\s+/g, ' '),
    size: data.size ?? null,
    ean: data.ean ?? null,
    price,
    beforePrice,
    discount,
    unitPrice,
    unitLabel,
    promoType: promo.promoType ?? null,
    promoDetail: promo.promoDetail ?? null,
    effectivePrice,
    requiresQty,
    available: data.available !== false,
    deliverability: meta.deliverability ?? data.deliverability,
    url: meta.url ?? data.url ?? null,
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    sampled: Boolean(sampled),
  };

  return { ok: true, product };
}
