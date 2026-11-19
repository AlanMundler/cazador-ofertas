import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPedidosYaStore, productUrl, isChallenged } from '../../src/adapters/pedidosya.js';
import { classifyStore, storeSlug } from '../../src/adapters/rappi.js';
import {
  classifyUberStore,
  buildShopFeedBody,
  feedStores,
  catalogItems,
  locationFromCookie,
  deepLocation,
} from '../../src/adapters/ubereats.js';

test('PedidosYa: marca de super vs vertical', () => {
  assert.equal(classifyPedidosYaStore('Jumbo Córdoba'), 'super');
  assert.equal(classifyPedidosYaStore('Carrefour - Express Córdoba (853)'), 'super');
  assert.equal(classifyPedidosYaStore('La Anónima - Jacinto Rios'), 'super');
  assert.equal(classifyPedidosYaStore('Verdulería Don Tomás - Gral Paz'), 'vertical');
  assert.equal(classifyPedidosYaStore('Carnave Granja - Colón Córdoba'), 'vertical');
});

test('PedidosYa: url https de tienda y detección de challenge', () => {
  assert.equal(productUrl('550495'), 'https://www.pedidosya.com.ar/mi-compra/550495');
  assert.equal(isChallenged('Un momento…'), true);
  assert.equal(isChallenged('PedidosYa'), false);
});

test('Rappi: clasificación por sub_group y exclusiones', () => {
  assert.equal(classifyStore({ parent_name: 'Mercados', sub_group: 'Super', store_type: 'carrefour_express', name: 'Carrefour' }), 'super');
  assert.equal(classifyStore({ parent_name: 'Mercados', sub_group: 'Turbo', store_type: 'turbo_veinticuatro_market_nc', name: 'Turbo' }), 'vertical');
  assert.equal(classifyStore({ parent_name: 'Mercados', sub_group: 'Express', store_type: 'farmacity_mt_nc', name: 'Farmacity' }), 'otro');
  assert.equal(classifyStore({ parent_name: 'Restaurantes', store_type: 'restaurant', name: 'Pizza' }), 'otro');
});

test('Rappi: slug de tienda', () => {
  assert.equal(storeSlug({ store_id: '239951', friendly_url: 'carrefour-express' }), '239951-carrefour-express');
  assert.equal(storeSlug({ store_id: '239951' }), '239951');
});

test('UberEats: clasificación por merchant type y marca', () => {
  assert.equal(classifyUberStore({ title: 'Carrefour Hiper Córdoba Jardin', merchantType: 'MERCHANT_TYPE_GROCERY' }), 'super');
  assert.equal(classifyUberStore({ title: 'Tadicor', merchantType: 'MERCHANT_TYPE_GROCERY' }), 'vertical');
  assert.equal(classifyUberStore({ title: 'Farmacia Estrella', merchantType: 'MERCHANT_TYPE_PHARMACY' }), 'otro');
  assert.equal(classifyUberStore({ title: 'Pizza Place', merchantType: 'MERCHANT_TYPE_RESTAURANT' }), 'otro');
});

test('UberEats: el feed fija la ubicación con MANUAL (no depende de la IP)', () => {
  const body = buildShopFeedBody({ lat: -31.412943, lng: -64.1966036 });
  assert.equal(body.feedID, 'shop_feed');
  assert.deepEqual(body.deliveryLocation, [
    { type: 'MANUAL', location: { latitude: -31.412943, longitude: -64.1966036 } },
  ]);
});

test('UberEats: feedStores extrae MINI_STORE y carruseles sin duplicar', () => {
  const feed = {
    data: {
      feedItems: [
        { type: 'MINI_STORE', store: { storeUuid: 'u1', title: { text: 'Tadicor' }, actionUrl: '/store/tadicor/u1' } },
        { type: 'MINI_STORE', store: { storeUuid: 'u1', title: { text: 'Tadicor' }, actionUrl: '/store/tadicor/u1' } },
        { type: 'REGULAR_CAROUSEL', carousel: { stores: [{ storeUuid: 'u2', title: { text: 'JustMart' }, actionUrl: '/store/justmart/u2' }] } },
      ],
    },
  };
  const stores = feedStores(feed);
  assert.equal(stores.length, 2);
  assert.deepEqual(stores.map(store => store.storeUuid), ['u1', 'u2']);
});

test('UberEats: catalogItems aplana standardItemsPayload', () => {
  const json = {
    data: {
      catalogSectionsMap: {
        u1: [
          { type: 'eaterMessagingPayload' },
          {
            catalogSectionUUID: 's1',
            payload: {
              standardItemsPayload: {
                title: { text: 'Ofertas' },
                catalogItems: [{ uuid: 'i1', title: 'Queso', price: 194940 }, { uuid: 'i2', title: 'Pan', price: 10000 }],
              },
            },
          },
        ],
      },
    },
  };
  const rows = catalogItems(json);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].__sectionTitle, 'Ofertas');
});

test('UberEats: ubicación desde cookie uev2.loc', () => {
  const cookie = encodeURIComponent(JSON.stringify({
    address: { address: 'San José de Calasanz 58, Córdoba' },
    latitude: -31.4130207,
    longitude: -64.1966038,
  }));
  assert.deepEqual(locationFromCookie(cookie), {
    address: 'San José de Calasanz 58, Córdoba',
    lat: -31.4130207,
    lng: -64.1966038,
  });
  assert.equal(locationFromCookie('no-json'), null);
  assert.deepEqual(deepLocation({ a: { b: { latitude: 1, longitude: 2 } } }), { address: null, lat: 1, lng: 2 });
});
