import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStorePromos } from '../scrapers/ubereats.js';

test('parseStorePromos detecta porcentaje off', () => {
  assert.deepEqual(
    parseStorePromos(['30% off en artículos seleccionados'], 0),
    { discount: 30, promoText: '30% off en artículos seleccionados' }
  );
});

test('parseStorePromos detecta "hasta X%"', () => {
  assert.deepEqual(
    parseStorePromos(['hasta 40% de descuento'], 0),
    { discount: 40, promoText: 'hasta 40% de descuento' }
  );
});

test('parseStorePromos interpreta 2x1 como 50%', () => {
  assert.deepEqual(
    parseStorePromos(['2x1 en gaseosas'], 0),
    { discount: 50, promoText: '2x1 en gaseosas' }
  );
});

test('parseStorePromos prioriza 2x1 sobre un porcentaje menor en la misma línea', () => {
  assert.deepEqual(
    parseStorePromos(['30% off + 2x1 en gaseosas'], 0),
    { discount: 50, promoText: '30% off + 2x1 en gaseosas' }
  );
});

test('parseStorePromos ignora líneas sin promo', () => {
  assert.equal(parseStorePromos(['Envío gratis', 'Abierto hasta las 22:00'], 0), null);
});

test('parseStorePromos aplica el umbral 35', () => {
  assert.equal(parseStorePromos(['30% off en artículos seleccionados'], 35), null);
  assert.equal(parseStorePromos(['hasta 40% de descuento'], 35).discount, 40);
});

test('parseStorePromos elige la mejor promo de la lista', () => {
  assert.deepEqual(
    parseStorePromos(['10% off', 'hasta 25% de descuento', '2x1 en bebidas'], 0),
    { discount: 50, promoText: '2x1 en bebidas' }
  );
});
