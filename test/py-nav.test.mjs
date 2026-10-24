import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStoreToken, isCordobaSuggestion, addressIsCordoba, isChallenged } from '../scrapers/pedidosya.js';

test('extractStoreToken extrae el uuid de una URL de tienda PY', () => {
  assert.equal(
    extractStoreToken('https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-25-de-mayo-bb184a2a-707c-4e62-86e8-0003e06e57af-menu?origin=shop_list'),
    'bb184a2a-707c-4e62-86e8-0003e06e57af'
  );
  assert.equal(
    extractStoreToken('https://www.pedidosya.com.ar/restaurantes/cordoba/carrefour-express-blvd-san-juan-785-93a8196b-9665-4322-8f7e-31b7af23c22f-menu'),
    '93a8196b-9665-4322-8f7e-31b7af23c22f'
  );
});

test('extractStoreToken devuelve null para URLs sin uuid', () => {
  assert.equal(extractStoreToken('https://www.pedidosya.com.ar/restaurantes/cordoba'), null);
  assert.equal(extractStoreToken(''), null);
  assert.equal(extractStoreToken(undefined), null);
});

test('isCordobaSuggestion acepta solo la sugerencia de Ciudad de Córdoba', () => {
  assert.equal(
    isCordobaSuggestion('San José de Calasanz 50, Ciudad de Córdoba, Provincia de Córdoba, Argentina'),
    true
  );
  // la sugerencia idéntica de Buenos Aires NO debe elegirse
  assert.equal(
    isCordobaSuggestion('San José de Calasanz 50, Ciudad Autónoma de Buenos Aires, Argentina'),
    false
  );
  assert.equal(isCordobaSuggestion('Otra cosa'), false);
  assert.equal(isCordobaSuggestion(''), false);
});

test('addressIsCordoba detecta la dirección activa en el botón Enviar a', () => {
  assert.equal(addressIsCordoba('Enviar a\n\nSan José de Calasanz 50'), true);
  assert.equal(addressIsCordoba('Enviar a\n\nBuenos Aires'), false);
  assert.equal(addressIsCordoba(''), false);
});

test('isChallenged detecta títulos de challenge de Cloudflare', () => {
  assert.equal(isChallenged('Un momento…'), true);
  assert.equal(isChallenged('Acceso denegado'), true);
  assert.equal(isChallenged('PedidosYa'), false);
  assert.equal(isChallenged(''), false);
});
