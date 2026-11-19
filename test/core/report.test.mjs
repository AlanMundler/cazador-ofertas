import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, chunk } from '../../src/report.js';

const product = (overrides = {}) => ({
  platform: 'PedidosYa',
  storeId: '550495',
  storeName: 'Jumbo Córdoba',
  storeKind: 'super',
  productId: 'p1',
  name: 'Cerveza Stella Artois 473 ml',
  price: 2865.85,
  beforePrice: 4409,
  discount: 35,
  available: true,
  deliverability: 'verified',
  url: 'https://www.pedidosya.com.ar/mi-compra/550495',
  ...overrides,
});

const ranked = {
  byPlatform: {
    PedidosYa: { topDiscount: [product({ discount: 57, price: 1490, beforePrice: 3505, name: 'Pelador Krea' })], flash: [], bestPriceByProduct: [] },
    Rappi: { topDiscount: [product({ platform: 'Rappi', discount: 53, price: 1349, beforePrice: 2890, name: 'Salchichas Cuisine' })], flash: [], bestPriceByProduct: [] },
    UberEats: { topDiscount: [product({ platform: 'UberEats', discount: 40, price: 975, beforePrice: 1625, name: 'Chocolate Nestlé' })], flash: [], bestPriceByProduct: [] },
  },
};

const coverages = [
  { platform: 'PedidosYa', storesScanned: 23, storesAvailable: 24 },
  { platform: 'Rappi', storesScanned: 50, storesAvailable: 50 },
  { platform: 'UberEats', storesScanned: 22, storesAvailable: 22 },
];

const thresholds = { PedidosYa: 50, Rappi: 50, UberEats: 35 };

test('buildDigest arma un mensaje legible con umbrales y cobertura', () => {
  const digest = buildDigest(ranked, { coverages, thresholds, now: new Date('2026-11-19T14:35:00Z') });
  assert.ok(digest.text.includes('OFERTAS SUPER'));
  assert.ok(digest.text.includes('PEDIDOSYA ≥50%'));
  assert.ok(digest.text.includes('UBER EATS ≥35%'));
  assert.ok(digest.text.includes('57% Pelador Krea'));
  assert.ok(digest.text.includes('$1.490'));
  assert.ok(digest.text.includes('antes $3.505'));
  assert.ok(digest.text.includes('Jumbo Córdoba'));
  assert.ok(digest.text.includes('Cobertura: PedidosYa 23/24 · Rappi 50/50 · UberEats 22/22'));
  assert.equal(digest.count, 3);
});

test('buildDigest no publica links que no sean https', () => {
  const withDeepLink = {
    byPlatform: {
      PedidosYa: { topDiscount: [product({ url: 'pedidosya://pharma/product?sku=1' })], flash: [], bestPriceByProduct: [] },
    },
  };
  const digest = buildDigest(withDeepLink, { coverages: [], thresholds });
  assert.ok(!digest.text.includes('pedidosya://'));
});

test('buildDigest respeta keep y devuelve lista vacía si todo fue notificado', () => {
  const digest = buildDigest(ranked, { coverages, thresholds, keep: () => false });
  assert.equal(digest.text, '');
  assert.equal(digest.count, 0);
});

test('chunk parte el mensaje sin superar el límite', () => {
  const text = Array.from({ length: 200 }, (_, i) => `linea ${i} ${'x'.repeat(60)}`).join('\n');
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 1000, `parte de ${part.length}`);
  assert.equal(parts.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
});
