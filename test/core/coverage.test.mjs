import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoverage, exitCodeFor, health, POINT } from '../../src/core/coverage.js';

const storesOf = (kind, count) => Array.from({ length: count }, () => ({ storeKind: kind }));

test('buildCoverage arma el objeto Â§0 con tiendas por tipo y catÃ¡logo muestreado', () => {
  const coverage = buildCoverage({
    platform: 'PedidosYa',
    stores: [
      { storeKind: 'super' },
      { storeKind: 'super' },
      { storeKind: 'vertical' },
      { storeKind: 'otro' },
      { kind: 'raro' },
    ],
    itemsSeen: 1908,
    aislesAnnounced: 30,
    sampled: true,
    missingChains: ['Coto', 'DÃ­a'],
  });

  assert.equal(coverage.platform, 'PedidosYa');
  assert.deepEqual(coverage.point, POINT);
  assert.match(coverage.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(coverage.storesSeen, 5);
  assert.deepEqual(coverage.storesByKind, { super: 2, vertical: 1, otro: 2 });
  assert.deepEqual(coverage.missingChains, ['Coto', 'DÃ­a']);
  assert.deepEqual(coverage.catalogCoverage, { itemsSeen: 1908, aislesAnnounced: 30, sampled: true, truncated: false });
  assert.equal(coverage.health, 'ok');
});

test('buildCoverage usa defaults honestos', () => {
  const coverage = buildCoverage({ platform: 'UberEats', stores: [] });
  assert.equal(coverage.storesSeen, 0);
  assert.deepEqual(coverage.storesByKind, { super: 0, vertical: 0, otro: 0 });
  assert.deepEqual(coverage.missingChains, []);
  assert.deepEqual(coverage.catalogCoverage, { itemsSeen: 0, aislesAnnounced: null, sampled: false, truncated: false });
  assert.equal(coverage.health, 'dead');
});

test('health: pisos PY 5/23 y UE 10/24 sobre total de tiendas', () => {
  const pyOk = buildCoverage({ platform: 'PedidosYa', stores: storesOf('super', 5), itemsSeen: 10 });
  const pyLow = buildCoverage({ platform: 'PedidosYa', stores: storesOf('super', 4), itemsSeen: 10 });
  const ueOk = buildCoverage({ platform: 'UberEats', stores: storesOf('super', 10), itemsSeen: 10 });
  const ueLow = buildCoverage({ platform: 'UberEats', stores: storesOf('super', 9), itemsSeen: 10 });

  assert.equal(pyOk.health, 'ok');
  assert.equal(pyLow.health, 'degraded');
  assert.equal(ueOk.health, 'ok');
  assert.equal(ueLow.health, 'degraded');
});

test('health: Rappi se mide sobre supers, no sobre el total de tiendas', () => {
  const rappiLow = buildCoverage({
    platform: 'Rappi',
    stores: [...storesOf('super', 2), ...storesOf('vertical', 20)],
    itemsSeen: 100,
  });
  const rappiOk = buildCoverage({
    platform: 'Rappi',
    stores: [...storesOf('super', 3), ...storesOf('vertical', 20)],
    itemsSeen: 100,
  });

  assert.equal(rappiLow.storesSeen, 22);
  assert.equal(rappiLow.health, 'degraded');
  assert.equal(rappiOk.health, 'ok');
});

test('health: dead sin tiendas, sin Ã­tems o con plataforma desconocida', () => {
  const noStores = buildCoverage({ platform: 'PedidosYa', stores: [], itemsSeen: 10 });
  const noItems = buildCoverage({ platform: 'PedidosYa', stores: storesOf('super', 5), itemsSeen: 0 });
  const unknown = buildCoverage({ platform: 'Otra', stores: storesOf('super', 30), itemsSeen: 10 });

  assert.equal(noStores.health, 'dead');
  assert.equal(noItems.health, 'dead');
  assert.equal(unknown.health, 'dead');
});

test('exitCodeFor sÃ³lo devuelve 0 con health ok', () => {
  const ok = buildCoverage({ platform: 'PedidosYa', stores: storesOf('super', 5), itemsSeen: 10 });
  const degraded = buildCoverage({ platform: 'PedidosYa', stores: storesOf('super', 4), itemsSeen: 10 });
  const dead = buildCoverage({ platform: 'PedidosYa', stores: [], itemsSeen: 0 });

  assert.equal(exitCodeFor(ok), 0);
  assert.equal(exitCodeFor(degraded), 1);
  assert.equal(exitCodeFor(dead), 1);
  assert.equal(exitCodeFor(null), 1);
  assert.equal(health(ok), 'ok');
});

