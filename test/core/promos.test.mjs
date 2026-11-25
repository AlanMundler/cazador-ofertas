import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { normalizeProduct } from '../../src/core/normalize.js';
import { rankByPlatform } from '../../src/core/rank.js';
import { buildDigest } from '../../src/report.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const py = fixture('py-items.json');
const PY_META = {
  platform: 'PedidosYa',
  storeId: '550495',
  storeName: 'Jumbo Córdoba',
  storeKind: 'super',
  sampled: false,
  fetchedAt: '2026-11-19T12:00:00.000Z',
};

const promoItem = (overrides = {}) => ({
  platform: 'PedidosYa',
  storeId: 's1',
  storeName: 'Jumbo',
  storeKind: 'super',
  productId: 'x1',
  name: 'Gomitas Mogul',
  rawName: 'Gomitas Mogul',
  brand: 'Mogul',
  size: { value: 80, unit: 'g' },
  price: 1000,
  beforePrice: null,
  discount: 25,
  advertisedDiscount: 25,
  effectivePrice: 750,
  requiresQty: 2,
  promoType: 'multibuy',
  promoDetail: '1 ud. al 50% dto',
  available: true,
  deliverability: 'verified',
  url: 'https://x',
  sampled: false,
  ...overrides,
});

test('2da unidad al 50% se cuenta como 25% sobre el par, no 50%', () => {
  const base = py.find(item => item.name === 'Gomitas Mogul Moras 80 g');
  const product = normalizeProduct(base, PY_META).product;
  assert.equal(product.requiresQty, 2);
  assert.equal(product.effectivePrice, 1356.75);
  assert.equal(product.discount, 25);
  assert.equal(product.advertisedDiscount, 25);
});

test('2x1 real sigue siendo 50% sobre el par', () => {
  const base = py.find(item => item.name === 'Gomitas Mogul Moras 80 g');
  const raw = {
    ...base,
    pricing: { ...base.pricing, beforePrice: null },
    campaigns: [{ type: 'sameItemBundle', tag: '2 x 1', configuration: { pay: 1, take: 2, value: 100 } }],
  };
  const product = normalizeProduct(raw, PY_META).product;
  assert.equal(product.discount, 50);
  assert.equal(product.requiresQty, 2);
});

test('con umbral 50% la promo de 2da unidad al 50% (25% real) no entra', () => {
  const { byPlatform } = rankByPlatform([promoItem()], { minDiscount: { PedidosYa: 50 } });
  assert.equal(byPlatform.PedidosYa.topDiscount.length, 0);
});

test('el mensaje muestra el precio del par y el unitario', () => {
  const ranked = { byPlatform: { PedidosYa: { topDiscount: [promoItem()], flash: [], bestPriceByProduct: [] } } };
  const digest = buildDigest(ranked, { thresholds: { PedidosYa: 50 } });
  assert.ok(digest.text.includes('25% Gomitas Mogul — $1.500 las 2 ($750 c/u) —'));
  assert.ok(digest.text.includes('(1 ud. al 50% dto)'));
});

test('sin promo de cantidad muestra el precio simple', () => {
  const simple = promoItem({ promoType: null, requiresQty: 1, promoDetail: null, discount: 60, advertisedDiscount: 60, price: 1000, effectivePrice: 1000 });
  const ranked = { byPlatform: { PedidosYa: { topDiscount: [simple], flash: [], bestPriceByProduct: [] } } };
  const digest = buildDigest(ranked, { thresholds: { PedidosYa: 50 } });
  assert.ok(digest.text.includes('60% Gomitas Mogul — $1.000 —'));
});
