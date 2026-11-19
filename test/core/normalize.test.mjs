import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { normalizeProduct, parseArs, parseSize } from '../../src/core/normalize.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const py = fixture('py-items.json');
const rappi = fixture('rappi-items.json');
const ue = fixture('ue-items.json');

const byName = (list, name) => list.find(item => (item.name ?? item.title) === name);

const PY_META = {
  platform: 'PedidosYa',
  storeId: '550495',
  storeName: 'Jumbo Córdoba',
  storeKind: 'super',
  sampled: false,
  fetchedAt: '2026-11-18T12:00:00.000Z',
};

test('parseArs entiende formato ARS, número y string sin separadores', () => {
  assert.equal(parseArs('$ 1.174,50'), 1174.5);
  assert.equal(parseArs(1174.5), 1174.5);
  assert.equal(parseArs('1390'), 1390);
  assert.equal(parseArs('ARS 43.070,00'), 43070);
  assert.equal(parseArs('1,234.56'), 1234.56);
  assert.equal(parseArs('sin precio'), null);
});

test('parseSize cubre formatos reales de las tres plataformas', () => {
  assert.deepEqual(parseSize('2.25L'), { value: 2.25, unit: 'l' });
  assert.deepEqual(parseSize('1 kg'), { value: 1, unit: 'kg' });
  assert.deepEqual(parseSize('500 g'), { value: 500, unit: 'g' });
  assert.deepEqual(parseSize('190G'), { value: 190, unit: 'g' });
  assert.deepEqual(parseSize('1 x 18 g'), { value: 18, unit: 'g' });
  assert.deepEqual(parseSize('6 unidades'), { value: 6, unit: 'un' });
  assert.deepEqual(parseSize('30 metros'), { value: 30, unit: 'm' });
  assert.deepEqual(parseSize('1 X 900.0 mL'), { value: 900, unit: 'ml' });
  assert.equal(parseSize('Sin tamaño'), null);
});

test('normalizeProduct devuelve el objeto §1 exacto y la promo porcentual PY real', () => {
  const result = normalizeProduct(byName(py, 'Cerveza Stella Artois Pure Gold Lata 473 ml'), PY_META);
  assert.equal(result.ok, true);

  assert.deepEqual(Object.keys(result.product), [
    'platform', 'storeId', 'storeName', 'storeKind', 'productId', 'rawName', 'brand', 'name',
    'size', 'ean', 'price', 'beforePrice', 'discount', 'unitPrice', 'unitLabel', 'promoType',
    'promoDetail', 'effectivePrice', 'requiresQty', 'available', 'deliverability', 'url',
    'fetchedAt', 'sampled',
  ]);

  assert.equal(result.product.productId, '214524998');
  assert.equal(result.product.brand, 'Stella Artois');
  assert.deepEqual(result.product.size, { value: 473, unit: 'ml' });
  assert.equal(result.product.ean, '07792798015474');
  assert.equal(result.product.price, 2865.85);
  assert.equal(result.product.beforePrice, 4409);
  assert.equal(result.product.discount, 35);
  assert.equal(result.product.unitPrice, 6058.88);
  assert.equal(result.product.unitLabel, '$/l');
  assert.equal(result.product.promoType, 'percentage');
  assert.equal(result.product.promoDetail, '35%');
  assert.equal(result.product.effectivePrice, 2865.85);
  assert.equal(result.product.requiresQty, 1);
  assert.equal(result.product.available, true);
  assert.equal(result.product.deliverability, 'unverified');
  assert.equal(result.product.url, 'pedidosya://pharma/productConfiguration?productSku=214524998&vendorId=112970');
  assert.equal(result.product.fetchedAt, PY_META.fetchedAt);
  assert.equal(result.product.sampled, false);
});

test('normalizeProduct aplica el descuento del bundle sobre la unidad de regalo (1 ud. al 50% ≠ 2x1)', () => {
  const { ok, product } = normalizeProduct(byName(py, 'Gomitas Mogul Moras 80 g'), PY_META);
  assert.equal(ok, true);
  assert.equal(product.beforePrice, null);
  assert.equal(product.promoType, 'multibuy');
  assert.equal(product.promoDetail, '1 ud. al 50% dto');
  assert.equal(product.effectivePrice, 1356.75);
  assert.equal(product.requiresQty, 2);
  assert.equal(product.discount, 25);
  assert.equal(product.unitPrice, 22612.5);
  assert.equal(product.unitLabel, '$/kg');
});

test('normalizeProduct convierte 3x2 real de PedidosYa con pay/take', () => {
  const { ok, product } = normalizeProduct(byName(py, 'Gaseosa Pepsi Black 2 L'), PY_META);
  assert.equal(ok, true);
  assert.equal(product.promoType, 'multibuy');
  assert.equal(product.promoDetail, '3 x 2');
  assert.equal(product.effectivePrice, 3033.33);
  assert.equal(product.requiresQty, 3);
  assert.equal(product.discount, 33);
});

test('PedidosYa: stock 0 no marca unavailable; active/status sí', () => {
  for (const item of py) {
    const { ok, product } = normalizeProduct(item, PY_META);
    assert.equal(ok, true, item.name);
    assert.equal(product.available, true, `${item.name} (stock ${item.stock})`);
  }

  const inactive = structuredClone(byName(py, 'Cerveza Stella Artois Pure Gold Lata 473 ml'));
  inactive.active = false;
  assert.equal(normalizeProduct(inactive, PY_META).product.available, false);

  const disabled = structuredClone(byName(py, 'Cerveza Stella Artois Pure Gold Lata 473 ml'));
  disabled.status = { enabled: false };
  assert.equal(normalizeProduct(disabled, PY_META).product.available, false);
});

test('PedidosYa: gtin vacío queda ean null y el ítem por unidad usa $/u', () => {
  const { ok, product } = normalizeProduct(byName(py, 'Palta Inmadura 1 Unidad'), PY_META);
  assert.equal(ok, true);
  assert.equal(product.ean, null);
  assert.equal(product.brand, null);
  assert.deepEqual(product.size, { value: 1, unit: 'un' });
  assert.equal(product.unitPrice, 999);
  assert.equal(product.unitLabel, '$/u');
});

test('normalizeProduct Rappi usa price/beforePrice/presentation reales', () => {
  const meta = { platform: 'Rappi', storeId: '248121', storeName: 'Vea', storeKind: 'super', sampled: true };
  const { ok, product } = normalizeProduct(byName(rappi, 'Cocinero Aceite de Girasol'), meta);

  assert.equal(ok, true);
  assert.equal(product.price, 3326.25);
  assert.equal(product.beforePrice, 4435);
  assert.equal(product.discount, 25);
  assert.deepEqual(product.size, { value: 900, unit: 'ml' });
  assert.equal(product.unitPrice, 3695.83);
  assert.equal(product.unitLabel, '$/l');
  assert.equal(product.ean, null);
  assert.equal(product.deliverability, 'verified');
  assert.equal(product.sampled, true);
});

test('Rappi: inStock false gana sobre stock (y stock 0 no invalida)', () => {
  const meta = { platform: 'Rappi', storeId: '248121', storeName: 'Vea', storeKind: 'super' };
  const soldOut = byName(rappi, 'Ramen Sabor a Carne Arcor 70g');
  assert.equal(soldOut.inStock, false);
  assert.equal(normalizeProduct(soldOut, meta).product.available, false);

  const banana = byName(rappi, 'Banana Ecuador');
  assert.equal(banana.stock, 0);
  assert.equal(banana.inStock, true);
  assert.equal(normalizeProduct(banana, meta).product.available, true);
});

test('normalizeProduct UberEats toma price y purchasePriceV2 reales', () => {
  const meta = { platform: 'UberEats', storeId: 'store-1', storeName: 'Carrefour', storeKind: 'super' };
  const { ok, product } = normalizeProduct(byName(ue, 'Paty · Salchichas viena clásica (6 un)'), meta);

  assert.equal(ok, true);
  assert.equal(product.price, 2321.25);
  assert.equal(product.beforePrice, 3095);
  assert.equal(product.discount, 25);
  assert.deepEqual(product.size, { value: 230, unit: 'g' });
  assert.equal(product.unitPrice, 10092.39);
  assert.equal(product.unitLabel, '$/kg');
  assert.equal(product.brand, 'Paty');
  assert.equal(product.ean, null);
  assert.equal(product.deliverability, 'verified');
  assert.equal(product.available, true);
});

test('UberEats sin descuento: beforePrice no se inventa', () => {
  const meta = { platform: 'UberEats', storeId: 'store-1', storeName: 'Carrefour', storeKind: 'super' };
  const { ok, product } = normalizeProduct(byName(ue, "Swift · Kid's salchichas cocidas sin piel (6 un)"), meta);
  assert.equal(ok, true);
  assert.equal(product.price, 2619);
  assert.equal(product.beforePrice, null);
  assert.equal(product.discount, 0);
  assert.deepEqual(product.size, { value: 190, unit: 'g' });
});

test('UberEats isSoldOut marca available false', () => {
  const raw = structuredClone(byName(ue, 'Paty · Salchichas viena clásica (6 un)'));
  raw.isSoldOut = true;
  const meta = { platform: 'UberEats', storeId: 'store-1', storeName: 'Carrefour', storeKind: 'super' };
  assert.equal(normalizeProduct(raw, meta).product.available, false);
});

test('beforePrice sólo se conserva si supera price * 1.05', () => {
  const raw = structuredClone(byName(py, 'Cerveza Stella Artois Pure Gold Lata 473 ml'));
  raw.pricing.beforePrice = Math.round(raw.pricing.price * 1.04 * 100) / 100;
  const { ok, product } = normalizeProduct(raw, PY_META);
  assert.equal(ok, true);
  assert.equal(product.beforePrice, null);
  assert.equal(product.discount, 0);
});

test('todos los ítems reales de los tres fixtures normalizan', () => {
  const cases = [
    ...py.map(raw => [raw, PY_META]),
    ...rappi.map(raw => [raw, { platform: 'Rappi', storeId: '248121', storeName: 'Vea', storeKind: 'super' }]),
    ...ue.map(raw => [raw, { platform: 'UberEats', storeId: 'store-1', storeName: 'Carrefour', storeKind: 'super' }]),
  ];

  for (const [raw, meta] of cases) {
    const result = normalizeProduct(raw, meta);
    assert.equal(result.ok, true, raw.name ?? raw.title);
    assert.ok(Number.isFinite(result.product.price));
    assert.ok(result.product.price >= 100 && result.product.price <= 10_000_000);
  }
});

test('rechaza precios fuera de rango y datos incompletos', () => {
  const meta = { platform: 'Rappi', storeId: 's', storeName: 'S', storeKind: 'super' };
  const base = { productId: 'x', name: 'Producto', presentation: '500 g' };

  assert.deepEqual(normalizeProduct({ ...base, price: 99 }, meta), { ok: false, reason: 'price_too_low' });
  assert.deepEqual(normalizeProduct({ ...base, price: 10_000_001 }, meta), { ok: false, reason: 'price_too_high' });
  assert.deepEqual(normalizeProduct({ ...base, price: null }, meta), { ok: false, reason: 'invalid_price' });
  assert.deepEqual(normalizeProduct({ ...base, price: 500 }, {}), { ok: false, reason: 'missing_platform' });
  assert.deepEqual(normalizeProduct(null, meta), { ok: false, reason: 'missing_raw' });
  assert.deepEqual(normalizeProduct({ price: 500 }, meta), { ok: false, reason: 'missing_product_id' });
});

test('bundle 2x1 con value 100 (o ausente) da 50%, no 33%', () => {
  const base = byName(py, 'Gomitas Mogul Moras 80 g');
  const raw = {
    ...base,
    pricing: { ...base.pricing, beforePrice: null },
    campaigns: [{ type: 'sameItemBundle', tag: '2x1', configuration: { pay: 1, take: 2, value: 100 } }],
  };
  const withValue = normalizeProduct(raw, PY_META).product;
  assert.equal(withValue.effectivePrice, 904.5);
  assert.equal(withValue.discount, 50);
  assert.equal(withValue.requiresQty, 2);

  const noValue = normalizeProduct(
    { ...raw, campaigns: [{ type: 'sameItemBundle', configuration: { pay: 1, take: 2 } }] },
    PY_META,
  ).product;
  assert.equal(noValue.effectivePrice, 904.5);
  assert.equal(noValue.discount, 50);
});

test('un multibuy no apila el beforePrice (no fabrica flash falso)', () => {
  const base = byName(py, 'Gomitas Mogul Moras 80 g');
  const raw = {
    ...base,
    pricing: { ...base.pricing, price: 1000, beforePrice: 2000 },
    campaigns: [{ type: 'sameItemBundle', tag: '2x1', configuration: { pay: 1, take: 2, value: 100 } }],
  };
  const product = normalizeProduct(raw, PY_META).product;
  assert.equal(product.effectivePrice, 500);
  assert.equal(product.discount, 50);
});

test('parseArs acepta decimal con punto y parseSize/unitPrice cubren metros', () => {
  assert.equal(parseArs('1390.50'), 1390.5);

  const base = byName(py, 'Gomitas Mogul Moras 80 g');
  const raw = {
    ...base,
    name: 'Papel Higienico Test 30 metros',
    size: '30 metros',
    pricing: { price: 3000, beforePrice: null, pricePerMeasurementUnit: 100, pricePerMeasurementUnitStruct: { content: 30, price: 100, unit: 'm' } },
    campaigns: [],
  };
  const product = normalizeProduct(raw, PY_META).product;
  assert.deepEqual(product.size, { value: 30, unit: 'm' });
  assert.equal(product.unitPrice, 100);
  assert.equal(product.unitLabel, '$/m');
});
