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
  advertisedDiscount: 50,
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

test('descuento anunciado: "1 ud. al 50%" entra como 50% aunque el efectivo sea 25%', () => {
  const base = py.find(item => item.name === 'Gomitas Mogul Moras 80 g');
  const product = normalizeProduct(base, PY_META).product;
  assert.equal(product.discount, 25);
  assert.equal(product.advertisedDiscount, 50);
});

test('el umbral usa el descuento anunciado', () => {
  const { byPlatform } = rankByPlatform([promoItem()], { minDiscount: { PedidosYa: 50 } });
  assert.equal(byPlatform.PedidosYa.topDiscount.length, 1);
});

test('un descuento real menor al umbral sigue afuera', () => {
  const { byPlatform } = rankByPlatform([promoItem({ advertisedDiscount: 30, discount: 30, promoDetail: null, promoType: null })], { minDiscount: { PedidosYa: 50 } });
  assert.equal(byPlatform.PedidosYa.topDiscount.length, 0);
});

test('el mensaje muestra el % anunciado y la condición del multibuy', () => {
  const ranked = { byPlatform: { PedidosYa: { topDiscount: [promoItem()], flash: [], bestPriceByProduct: [] } } };
  const digest = buildDigest(ranked, { thresholds: { PedidosYa: 50 } });
  assert.ok(digest.text.includes('50% Gomitas Mogul — $1.000 —'));
  assert.ok(digest.text.includes('(1 ud. al 50% dto)'));
});
