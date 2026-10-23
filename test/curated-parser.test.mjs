import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parsePrice,
  parseOfferCommand,
  normalizeCuratedOffer,
  takeCuratedOffers,
  readCuratedQueue,
} from '../scrapers/curated.js';
import { detectFlashDeals } from '../utils/filter.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cazador-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parsePrice entiende precios argentinos', () => {
  assert.equal(parsePrice('$1.700'), 1700);
  assert.equal(parsePrice('$1.700,50'), 1700.5);
  assert.equal(parsePrice('1700'), 1700);
  assert.equal(parsePrice('$ 2.000,00'), 2000);
  assert.equal(parsePrice('1700.50'), 1700.5);
  assert.equal(parsePrice('no es un precio'), null);
});

test('/oferta con URL parsea y calcula discount', () => {
  const result = parseOfferCommand(
    '/oferta PedidosYa | Market 25 de Mayo | Coca-Cola 2.25L | $1.700 | $1.200 | https://example.com/oferta'
  );

  assert.equal(result.ok, true);
  assert.equal(result.offer.platform, 'PedidosYa');
  assert.equal(result.offer.restaurant, 'Market 25 de Mayo');
  assert.equal(result.offer.name, 'Coca-Cola 2.25L');
  assert.equal(result.offer.originalPrice, 1700);
  assert.equal(result.offer.currentPrice, 1200);
  assert.equal(result.offer.discount, 29);
  assert.equal(result.offer.url, 'https://example.com/oferta');
  assert.deepEqual(result.offer.tags, []);
});

test('/oferta con #barato marca isCheapProduct', () => {
  const result = parseOfferCommand(
    '/oferta Rappi | Jumbo | Pan lactal | $1.000 | $700 | #barato'
  );
  assert.equal(result.ok, true);

  const normalized = normalizeCuratedOffer(result.offer);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.offer.isCheapProduct, true);
  assert.equal(normalized.offer.discount, 30);
  assert.equal(normalized.offer.currentPrice, '$700');
});

test('/oferta con precio decimal argentino', () => {
  const result = parseOfferCommand(
    '/oferta PedidosYa | Carrefour | Café | $1.700,50 | $1.000,25 | #barato'
  );
  assert.equal(result.ok, true);
  assert.equal(result.offer.originalPrice, 1700.5);
  assert.equal(result.offer.currentPrice, 1000.25);
});

test('/oferta inválida reporta error', () => {
  assert.equal(parseOfferCommand('/oferta Solo | Dos').ok, false);
  assert.equal(
    parseOfferCommand('/oferta PedidosYa | Market | Producto | $1.000 | $1.500').ok,
    false
  );
  assert.equal(
    parseOfferCommand('/oferta PedidosYa | Market | Producto | abc | $500').ok,
    false
  );
  assert.equal(parseOfferCommand('texto cualquiera').ok, false);
});

test('normalizeCuratedOffer calcula discount si falta', () => {
  const normalized = normalizeCuratedOffer({
    platform: 'PedidosYa',
    restaurant: 'Market 25 de Mayo',
    name: 'Producto',
    originalPrice: '$2.000',
    currentPrice: '$500',
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.offer.discount, 75);
  assert.equal(normalized.offer.originalPrice, '$2.000');
  assert.equal(normalized.offer.currentPrice, '$500');
  assert.equal(normalized.offer.isCheapProduct, false);
  assert.equal(normalized.offer.promoType, 'campaign');
});

test('normalizeCuratedOffer ignora isCheapProduct sin tag #barato', () => {
  const normalized = normalizeCuratedOffer({
    platform: 'PedidosYa',
    restaurant: 'Market',
    name: 'Producto',
    originalPrice: 1000,
    currentPrice: 800,
    isCheapProduct: true,
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.offer.isCheapProduct, false);
});

test('discount >= 75 se detecta como flash', () => withTempDir(dir => {
  const normalized = normalizeCuratedOffer({
    platform: 'PedidosYa',
    restaurant: 'Market',
    name: 'Producto flash',
    originalPrice: '$2.000',
    currentPrice: '$500',
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.offer.discount, 75);

  const historyFile = join(dir, 'history.json');
  const flash = detectFlashDeals([normalized.offer], historyFile);
  assert.equal(flash.length, 1);
  assert.equal(flash[0].isFlash, true);
}));

test('takeCuratedOffers consume válidas y conserva inválidas', () => withTempDir(dir => {
  const queueFile = join(dir, 'curated-pending.json');
  const valid = {
    platform: 'PedidosYa',
    restaurant: 'Market',
    name: 'Producto válido',
    originalPrice: '$1.000',
    currentPrice: '$700',
  };
  const invalid = { platform: 'PedidosYa', name: 'Sin tienda ni precios' };
  writeFileSync(queueFile, JSON.stringify([valid, invalid]));

  const result = takeCuratedOffers(queueFile);
  assert.equal(result.offers.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.remaining, 1);

  const remaining = readCuratedQueue(queueFile);
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0], invalid);
}));

test('takeCuratedOffers tolera BOM al inicio del JSON', () => withTempDir(dir => {
  const queueFile = join(dir, 'curated-pending.json');
  writeFileSync(queueFile, '\uFEFF' + JSON.stringify([{
    platform: 'PedidosYa',
    restaurant: 'Market',
    name: 'Producto con BOM',
    originalPrice: '$1.000',
    currentPrice: '$700',
  }]));

  const result = takeCuratedOffers(queueFile);
  assert.equal(result.errors.length, 0);
  assert.equal(result.offers.length, 1);
  assert.equal(result.remaining, 0);
}));
