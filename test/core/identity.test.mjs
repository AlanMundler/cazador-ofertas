import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brandKey,
  candidatePairs,
  jaccard,
  normalizeName,
  productKey,
  sizeKey,
  sizeUnit,
} from '../../src/core/identity.js';

const product = (overrides = {}) => {
  const merged = {
    platform: 'PedidosYa',
    storeId: 's1',
    productId: 'p1',
    name: 'Producto',
    brand: 'Marca',
    size: { value: 1, unit: 'l' },
    price: 1000,
    ...overrides,
  };
  return { ...merged, rawName: overrides.rawName ?? merged.name };
};

test('normalizeName quita acentos, puntuación, stopwords y tokens de tamaño', () => {
  assert.equal(
    normalizeName('La Serenísima Leche Entera Clásica 3%'),
    'serenisima leche entera clasica'
  );
  assert.equal(
    normalizeName('Coca-Cola · Gaseosa sabor original (1.25 L)'),
    'coca cola gaseosa sabor original'
  );
  assert.equal(normalizeName('Yogur La Serenísima Con Probióticos 300 g'), 'yogur serenisima probioticos');
});

test('brandKey normaliza marca y descarta genéricas', () => {
  assert.equal(brandKey('La Serenísima'), 'serenisima');
  assert.equal(brandKey('la serenisima'), 'serenisima');
  assert.equal(brandKey('Coca-Cola'), 'cocacola');
  assert.equal(brandKey('Coca Cola'), 'cocacola');
  assert.equal(brandKey('unbranded'), null);
  assert.equal(brandKey(''), null);
  assert.equal(brandKey(null), null);
});

test('sizeKey compara en unidad base: kg=g, l=ml y unidades aparte', () => {
  assert.equal(sizeKey({ value: 1, unit: 'kg' }), '1000g');
  assert.equal(sizeKey({ value: 1000, unit: 'g' }), '1000g');
  assert.equal(sizeKey({ value: 2.25, unit: 'l' }), '2250ml');
  assert.equal(sizeKey({ value: 2250, unit: 'ml' }), '2250ml');
  assert.equal(sizeKey({ value: 6, unit: 'unidades' }), '6un');
  assert.equal(sizeKey('1 x 18 g'), '18g');
  assert.equal(sizeKey(null), null);
});

test('sizeUnit distingue familias de unidad', () => {
  assert.equal(sizeUnit({ value: 500, unit: 'g' }), 'g');
  assert.equal(sizeUnit({ value: 1, unit: 'kg' }), 'g');
  assert.equal(sizeUnit({ value: 1, unit: 'l' }), 'ml');
  assert.equal(sizeUnit({ value: 6, unit: 'un' }), 'un');
  assert.equal(sizeUnit(null), null);
});

test('jaccard cuenta intersección sobre unión', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 0.3333);
  assert.equal(jaccard('Leche Entera', 'entera leche'), 1);
  assert.equal(jaccard('', 'algo'), 0);
});

test('candidatePairs cruza plataformas con misma marca y unidad y nombre similar', () => {
  const ue = product({
    platform: 'UberEats',
    storeId: 'ue1',
    productId: 'ue1p',
    name: 'Coca-Cola · Gaseosa sabor original (1.25 L)',
    rawName: 'Coca-Cola · Gaseosa sabor original (1.25 L)',
    brand: 'Coca-Cola',
    size: { value: 1250, unit: 'ml' },
    price: 4100,
  });
  const pyName = product({
    productId: 'py1',
    name: 'Gaseosa Coca-Cola Sabor Original 1.25 L',
    rawName: 'Gaseosa Coca-Cola Sabor Original 1.25 L',
    brand: 'Coca-Cola',
    size: { value: 1.25, unit: 'l' },
    price: 3490,
  });

  const pairs = candidatePairs([pyName, ue]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, 1);
  assert.equal(pairs[0].brand, 'cocacola');
  assert.equal(pairs[0].unit, 'ml');
  assert.deepEqual(pairs[0].priceDiff, { abs: 610, pct: 14.88, cheaper: 'a' });
  assert.equal(pairs[0].a.productId, 'py1');
  assert.equal(pairs[0].b.productId, 'ue1p');
  assert.equal(pairs[0].a, pyName);
  assert.equal(pairs[0].b, ue);
});

test('candidatePairs no cruza marca distinta, unidad distinta ni misma plataforma', () => {
  const base = product({
    productId: 'a',
    name: 'Gaseosa Coca-Cola Sabor Original',
    brand: 'Coca-Cola',
    size: { value: 1.25, unit: 'l' },
  });

  const otherBrand = product({
    platform: 'UberEats', storeId: 'u', productId: 'b',
    name: 'Gaseosa Coca-Cola Sabor Original', brand: 'Pepsi',
  });
  assert.equal(candidatePairs([base, otherBrand]).length, 0);

  const otherUnit = product({
    platform: 'UberEats', storeId: 'u', productId: 'c',
    name: 'Gaseosa Coca-Cola Sabor Original', brand: 'Coca-Cola',
    size: { value: 1250, unit: 'g' },
  });
  assert.equal(candidatePairs([base, otherUnit]).length, 0);

  const samePlatform = product({
    platform: 'PedidosYa', storeId: 's2', productId: 'd',
    name: 'Gaseosa Coca-Cola Sabor Original', brand: 'Coca-Cola',
  });
  assert.equal(candidatePairs([base, samePlatform]).length, 0);
});

test('candidatePairs respeta minScore (Jaccard no es ranking)', () => {
  const a = product({
    productId: 'a', name: 'Gaseosa Coca-Cola Sabor Original', brand: 'Coca-Cola',
    size: { value: 1.25, unit: 'l' },
  });
  const b = product({
    platform: 'UberEats', storeId: 'u', productId: 'b', name: 'Coca-Cola Zero', brand: 'Coca-Cola',
    size: { value: 1.25, unit: 'l' },
  });

  assert.equal(candidatePairs([a, b]).length, 0);
  assert.equal(candidatePairs([a, b], { minScore: 0.3 }).length, 1);
});

test('productKey identifica dedupe intra-plataforma', () => {
  assert.equal(productKey(product()), 'PedidosYa:s1:p1');
  assert.equal(productKey(product({ storeId: 's2' })), 'PedidosYa:s2:p1');
  assert.equal(productKey(product({ platform: 'Rappi' })), 'Rappi:s1:p1');
});

test('candidatePairs no empareja 500 ml con 2 L de la misma marca', () => {
  const a = { platform: 'PedidosYa', productId: '1', storeId: 'a', name: 'Coca Cola 500 ml', brand: 'Coca-Cola', size: { value: 500, unit: 'ml' }, price: 1000, unitPrice: 2000 };
  const b = { platform: 'Rappi', productId: '2', storeId: 'b', name: 'Coca Cola 2 L', brand: 'Coca-Cola', size: { value: 2, unit: 'l' }, price: 3000, unitPrice: 1500 };
  assert.deepEqual(candidatePairs([a, b]), []);
});

test('candidatePairs empareja mismo tamano y difiere por unitPrice', () => {
  const a = { platform: 'PedidosYa', productId: '1', storeId: 'a', name: 'Coca Cola 2 L', brand: 'Coca-Cola', size: { value: 2, unit: 'l' }, price: 3000, unitPrice: 1500 };
  const b = { platform: 'Rappi', productId: '2', storeId: 'b', name: 'Coca Cola 2 L', brand: 'Coca-Cola', size: { value: 2000, unit: 'ml' }, price: 2600, unitPrice: 1300 };
  const pairs = candidatePairs([a, b]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].priceDiff.cheaper, 'b');
  assert.equal(pairs[0].priceDiff.abs, 200);
});
