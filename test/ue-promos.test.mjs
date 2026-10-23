import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStoreItems, parseStorePromos } from '../scrapers/ubereats.js';

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

test('parseStoreItems parsea un ítem con tamaño y precio actual/original', () => {
  assert.deepEqual(
    parseStoreItems(
      ['Dove · Original antitranspirante en aerosol (150 ml) | 150 ml | - 40% | $ 5.525,40 $ 9.209,00'],
      35
    ),
    [{
      name: 'Dove · Original antitranspirante en aerosol (150 ml)',
      discount: 40,
      currentPrice: 5525.4,
      originalPrice: 9209,
    }]
  );
});

test('parseStoreItems parsea un ítem sin segmento de tamaño', () => {
  assert.deepEqual(
    parseStoreItems(
      ['Rexona M Clin Desodorante Aero Clean 55Ml-Nc | - 37% | $ 975,00 $ 1.559,00'],
      35
    ),
    [{
      name: 'Rexona M Clin Desodorante Aero Clean 55Ml-Nc',
      discount: 37,
      currentPrice: 975,
      originalPrice: 1559,
    }]
  );
});

test('parseStoreItems acepta un ítem con un solo precio', () => {
  assert.deepEqual(
    parseStoreItems(
      ['Mayonesa Cada Dia Liviana X 125 Cc | - 15% | $ 3.100,00'],
      0
    ),
    [{
      name: 'Mayonesa Cada Dia Liviana X 125 Cc',
      discount: 15,
      currentPrice: 3100,
      originalPrice: null,
    }]
  );
});

test('parseStoreItems ignora banners de descuento sin precios', () => {
  assert.deepEqual(
    parseStoreItems(
      [
        'Aprovecha los mejores descuentos - 50%',
        'Supermercado | Ofertas | - 40%',
        'Envío gratis',
      ],
      0
    ),
    []
  );
});

test('parseStoreItems aplica el umbral 35 a líneas reales de Carrefour', () => {
  const items = parseStoreItems(
    [
      'Dove · Original antitranspirante en aerosol (150 ml) | 150 ml | - 40% | $ 5.525,40 $ 9.209,00',
      'Rexona · Clinical antitranspirante (55 ml) | 55 ml | - 40% | $ 6.000,00 $ 10.000,00',
      'Dove · Nutrición shampoo (400 ml) | 400 ml | - 35% | $ 1.166,75 $ 1.795,00',
      'Suave · Shampoo (250 ml) | 250 ml | - 35% | $ 900,00 $ 1.384,00',
      'Colgate · Triple acción crema dental (90 g) | 90 g | - 25% | $ 1.941,75 $ 2.589,00',
      'Mayonesa Cada Dia Liviana X 125 Cc | - 15% | $ 3.100,00 $ 3.639,00',
    ],
    35
  );

  assert.deepEqual(
    items.map(item => ({ name: item.name, discount: item.discount })),
    [
      { name: 'Dove · Original antitranspirante en aerosol (150 ml)', discount: 40 },
      { name: 'Rexona · Clinical antitranspirante (55 ml)', discount: 40 },
      { name: 'Dove · Nutrición shampoo (400 ml)', discount: 35 },
      { name: 'Suave · Shampoo (250 ml)', discount: 35 },
    ]
  );
});

test('parseStoreItems descarta ítems donde el precio actual supera al original', () => {
  assert.deepEqual(
    parseStoreItems(
      ['Producto raro (500 ml) | 500 ml | - 50% | $ 2.000,00 $ 1.500,00'],
      0
    ),
    []
  );
});
