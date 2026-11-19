import test from 'node:test';
import assert from 'node:assert/strict';

import { rankByPlatform } from '../../src/core/rank.js';

const item = overrides => ({
  platform: 'PedidosYa',
  storeId: 's1',
  storeName: 'Sucursal 1',
  productId: 'p1',
  name: 'Producto',
  brand: 'Marca',
  size: { value: 1, unit: 'l' },
  price: 1000,
  beforePrice: 2000,
  discount: 50,
  effectivePrice: 500,
  available: true,
  deliverability: 'verified',
  ...overrides,
});

test('el ranking nunca mezcla plataformas', () => {
  const py = item({ platform: 'PedidosYa', storeId: 'py-s1', productId: 'py-1', name: 'Leche Entera', discount: 40 });
  const rappi = item({ platform: 'Rappi', storeId: 'ra-s1', productId: 'ra-1', name: 'Leche Entera', discount: 60, price: 800 });

  const { byPlatform } = rankByPlatform([py, rappi]);

  assert.deepEqual(Object.keys(byPlatform), ['PedidosYa', 'Rappi', 'UberEats']);
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(product => product.productId), ['py-1']);
  assert.deepEqual(byPlatform.Rappi.topDiscount.map(product => product.productId), ['ra-1']);
  assert.deepEqual(byPlatform.UberEats.topDiscount, []);

  assert.ok(byPlatform.PedidosYa.topDiscount.every(product => product.platform === 'PedidosYa'));
  assert.ok(byPlatform.Rappi.topDiscount.every(product => product.platform === 'Rappi'));
});

test('topDiscount aplica minDiscount y máximo 3 por tienda', () => {
  const products = [
    item({ storeId: 's1', productId: 'a', name: 'A', discount: 50 }),
    item({ storeId: 's1', productId: 'b', name: 'B', discount: 45 }),
    item({ storeId: 's1', productId: 'c', name: 'C', discount: 40 }),
    item({ storeId: 's1', productId: 'd', name: 'D', discount: 35 }),
    item({ storeId: 's2', productId: 'e', name: 'E', discount: 33 }),
    item({ storeId: 's1', productId: 'f', name: 'F', discount: 29 }),
  ];

  const { byPlatform } = rankByPlatform(products, { maxPerStore: 3 });
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(product => product.productId), ['a', 'b', 'c', 'e']);
});

test('por defecto devuelve todas las ofertas sobre el umbral (sin tope por tienda)', () => {
  const products = Array.from({ length: 8 }, (_, i) => item({ storeId: 's1', productId: `p${i}`, name: `P${i}`, discount: 50 + i }));
  const { byPlatform } = rankByPlatform(products, { minDiscount: 50 });
  assert.equal(byPlatform.PedidosYa.topDiscount.length, 8);
});

test('flash usa su propio umbral y no se limita por tienda', () => {
  const products = [
    item({ storeId: 's1', productId: 'a', name: 'A', discount: 80 }),
    item({ storeId: 's1', productId: 'b', name: 'B', discount: 75 }),
    item({ storeId: 's1', productId: 'c', name: 'C', discount: 74 }),
  ];

  const { byPlatform } = rankByPlatform(products);
  assert.deepEqual(byPlatform.PedidosYa.flash.map(product => product.productId), ['a', 'b']);
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(product => product.productId), ['a', 'b', 'c']);
});

test('bestPriceByProduct agrupa misma identidad dentro de plataforma y tamaño', () => {
  const milk = (platform, storeId, productId, price, size = { value: 1, unit: 'l' }) => item({
    platform,
    storeId,
    productId,
    name: 'Leche La Serenísima Entera',
    brand: 'La Serenísima',
    size,
    price,
    discount: 10,
  });

  const products = [
    milk('PedidosYa', 'py-s1', 'py-1', 2190),
    milk('PedidosYa', 'py-s2', 'py-2', 1990),
    milk('PedidosYa', 'py-s3', 'py-3', 1200, { value: 500, unit: 'ml' }),
    milk('Rappi', 'ra-s1', 'ra-1', 1790),
    milk('Rappi', 'ra-s2', 'ra-2', 1750),
  ];

  const { byPlatform } = rankByPlatform(products);

  assert.equal(byPlatform.PedidosYa.bestPriceByProduct.length, 1);
  assert.equal(byPlatform.PedidosYa.bestPriceByProduct[0].product.storeId, 'py-s2');
  assert.equal(byPlatform.PedidosYa.bestPriceByProduct[0].product.price, 1990);
  assert.equal(byPlatform.PedidosYa.bestPriceByProduct[0].offerCount, 2);
  assert.equal(byPlatform.PedidosYa.bestPriceByProduct[0].storeCount, 2);

  assert.equal(byPlatform.Rappi.bestPriceByProduct.length, 1);
  assert.equal(byPlatform.Rappi.bestPriceByProduct[0].product.price, 1750);

  // El tamaño de 500 ml no se mezcla con el de 1 L: queda como grupo de una sola tienda.
  assert.ok(byPlatform.PedidosYa.bestPriceByProduct.every(entry => entry.product.productId !== 'py-3'));
});

test('rechaza unavailable y deliverability unverified, con conteos', () => {
  const products = [
    item({ productId: 'ok' }),
    item({ productId: 'off', available: false }),
    item({ productId: 'u1', deliverability: 'unverified' }),
    item({ productId: 'u2', deliverability: 'unverified' }),
  ];

  const { byPlatform, rejected } = rankByPlatform(products);

  assert.deepEqual(rejected, [
    { reason: 'deliverability_unverified', count: 2 },
    { reason: 'unavailable', count: 1 },
  ]);
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(product => product.productId), ['ok']);
});

test('dedupe por plataforma+tienda+producto+precio', () => {
  const products = [
    item({ productId: 'dup', price: 1000 }),
    item({ productId: 'dup', price: 1000 }),
    item({ productId: 'dup', price: 1200 }),
  ];

  const { rejected } = rankByPlatform(products);
  assert.deepEqual(rejected, [{ reason: 'duplicate', count: 1 }]);
});

test('rechaza precios fuera de rango o inválidos', () => {
  const products = [
    item({ productId: 'low', price: 99 }),
    item({ productId: 'high', price: 10_000_001 }),
    item({ productId: 'nan', price: Number.NaN }),
    item({ productId: 'none', price: null }),
  ];

  const { rejected } = rankByPlatform(products);
  assert.deepEqual(rejected, [{ reason: 'price_out_of_range', count: 4 }]);
});

test('minDiscount es configurable', () => {
  const products = [
    item({ productId: 'a', name: 'A', discount: 40 }),
    item({ productId: 'b', name: 'B', discount: 50 }),
  ];

  const { byPlatform } = rankByPlatform(products, { minDiscount: 50 });
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(product => product.productId), ['b']);
});

test('minDiscount por plataforma: PY/Rappi 50, UE 35', () => {
  const thresholds = { PedidosYa: 50, Rappi: 50, UberEats: 35 };
  const make = (platform, discount) => ({
    platform, storeId: 's', storeName: 'S', storeKind: 'super', productId: `${platform}-${discount}`,
    name: `${platform} ${discount}`, rawName: `${platform} ${discount}`, brand: 'Marca',
    size: { value: 1, unit: 'kg' }, price: 1000, beforePrice: 1000 / (1 - discount / 100),
    discount, effectivePrice: 1000, requiresQty: 1, available: true,
    deliverability: 'verified', url: 'https://x.test/p', sampled: false,
  });
  const { byPlatform } = rankByPlatform(
    [make('PedidosYa', 45), make('PedidosYa', 55), make('Rappi', 40), make('Rappi', 60), make('UberEats', 30), make('UberEats', 40)],
    { minDiscount: thresholds },
  );
  assert.deepEqual(byPlatform.PedidosYa.topDiscount.map(p => p.discount), [55]);
  assert.deepEqual(byPlatform.Rappi.topDiscount.map(p => p.discount), [60]);
  assert.deepEqual(byPlatform.UberEats.topDiscount.map(p => p.discount), [40]);
});
