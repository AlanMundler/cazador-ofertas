import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, chunk, escapeHtml } from '../../src/report.js';

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

const rankedOf = offersByPlatform => ({
  byPlatform: Object.fromEntries(Object.entries(offersByPlatform).map(([platform, list]) => [
    platform,
    { topDiscount: list, flash: [], bestPriceByProduct: [] },
  ])),
});

const thresholds = { PedidosYa: 50, Rappi: 50, UberEats: 40 };

test('cada super tiene su encabezado con link y su lista de ofertas', () => {
  const jumbo = [
    product({ productId: 'a', name: 'Pelador Krea', discount: 57, price: 1490 }),
    product({ productId: 'b', name: 'Harina Blancaflor 1 kg', discount: 50, price: 1175 }),
  ];
  const disco = [product({ productId: 'c', name: 'Yerba Cruz de Malta', discount: 50, price: 1444.5, storeId: '574761', storeName: 'Disco Alta Córdoba', url: 'https://www.pedidosya.com.ar/mi-compra/574761' })];

  const digest = buildDigest(rankedOf({ PedidosYa: [...jumbo, ...disco] }), { thresholds, now: new Date('2026-11-25T15:40:00Z') });

  assert.ok(digest.text.includes('<b>PEDIDOSYA</b>'));
  assert.ok(digest.text.includes('<a href="https://www.pedidosya.com.ar/mi-compra/550495">Jumbo Córdoba</a> · 2'));
  assert.ok(digest.text.includes('<a href="https://www.pedidosya.com.ar/mi-compra/574761">Disco Alta Córdoba</a> · 1'));
  assert.ok(digest.text.includes('   • 57% Pelador Krea — $1.490'));
  assert.ok(digest.text.includes('   • 50% Harina Blancaflor 1 kg — $1.175'));
  assert.ok(digest.text.includes('   • 50% Yerba Cruz de Malta — $1.444,5'));
  assert.equal(digest.count, 3);
});

test('ordena supers por mejor descuento y ofertas de mayor a menor', () => {
  const a = product({ storeId: 'a', storeName: 'Super A', name: 'A1', discount: 50 });
  const b = product({ storeId: 'b', storeName: 'Super B', name: 'B1', discount: 60 });
  const digest = buildDigest(rankedOf({ Rappi: [a, b] }), { thresholds });
  assert.ok(digest.text.indexOf('Super B') < digest.text.indexOf('Super A'), digest.text);
});

test('publica TODAS las ofertas del umbral', () => {
  const names = ['alfa', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
    'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
    'phi', 'chi', 'psi', 'omega', 'extra'];
  const many = names.map((name, index) => product({ productId: `p${index}`, name: `Producto ${name} especial`, discount: 50 + (index % 5) }));
  const digest = buildDigest(rankedOf({ Rappi: many }), { thresholds });
  assert.equal(digest.count, 25);
  assert.ok(digest.text.includes('Producto extra especial'));
});

test('el mismo producto en otro super aparece en la lista de ese super', () => {
  const a = product({ storeId: 'a', storeName: 'Turbo A', name: 'Garnier Serum facial' });
  const b = product({ storeId: 'b', storeName: 'Turbo B', name: 'GARNIER SERUM FACIAL' });
  const digest = buildDigest(rankedOf({ Rappi: [a, b] }), { thresholds });
  assert.equal(digest.count, 2);
  assert.ok(digest.text.includes('Turbo A'));
  assert.ok(digest.text.includes('Turbo B'));
});

test('dentro del mismo super no repite el producto', () => {
  const a = product({ productId: 'a', name: 'Garnier Serum facial' });
  const b = product({ productId: 'b', name: 'GARNIER SERUM FACIAL' });
  const digest = buildDigest(rankedOf({ Rappi: [a, b] }), { thresholds });
  assert.equal(digest.count, 1);
});

test('no mezcla tamanos distintos del mismo producto', () => {
  const chico = product({ productId: 'a', name: 'Coca Cola 500 ml', size: { value: 500, unit: 'ml' } });
  const grande = product({ productId: 'b', name: 'Coca Cola 2 L', size: { value: 2, unit: 'l' } });
  const digest = buildDigest(rankedOf({ Rappi: [chico, grande] }), { thresholds });
  assert.equal(digest.count, 2);
});

test('escapa HTML de nombres y locales', () => {
  const weird = product({ name: 'Gaseosa <3 & "cola"', storeName: 'Market <Centro>' });
  const digest = buildDigest(rankedOf({ PedidosYa: [weird] }), { thresholds });
  assert.ok(digest.text.includes('Gaseosa &lt;3 &amp; &quot;cola&quot;'));
  assert.ok(digest.text.includes('Market &lt;Centro&gt;'));
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('sin ofertas devuelve texto vacio', () => {
  const digest = buildDigest(rankedOf({ PedidosYa: [] }), { thresholds });
  assert.equal(digest.text, '');
  assert.equal(digest.count, 0);
});

test('chunk parte sin superar el limite y sin cortar tags', () => {
  const text = Array.from({ length: 200 }, (_, i) => `   • 50% producto ${i} — $1.000`).join('\n');
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 1000);
  assert.equal(parts.join('\n'), text);
});
