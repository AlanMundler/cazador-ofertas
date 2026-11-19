import test from 'node:test';
import assert from 'node:assert/strict';

import { missingChains, KNOWN_CHAINS } from '../../src/core/chains.js';
import { buildCoverage, budgetWarning } from '../../src/core/coverage.js';

const store = (name, kind = 'super') => ({ name, kind });

test('missingChains descuenta las cadenas realmente escaneadas', () => {
  const missing = missingChains('PedidosYa', [store('Jumbo Córdoba'), store('Carrefour - Express Córdoba (853)')]);
  assert.ok(!missing.includes('Jumbo'));
  assert.ok(!missing.includes('Carrefour'));
  assert.ok(missing.includes('Coto'));
  assert.ok(missing.includes('Día'));
});

test('missingChains no se confunde con acentos ni mayúsculas', () => {
  const missing = missingChains('Rappi', [store('LA ANONIMA - Jacinto Rios')]);
  assert.ok(!missing.includes('La Anónima'));
});

test('missingChains sin tiendas devuelve el universo conocido', () => {
  assert.deepEqual(missingChains('UberEats', []), KNOWN_CHAINS.UberEats);
  assert.deepEqual(missingChains('Otra', [store('X')]), []);
});

test('budgetWarning avisa cuando el presupuesto no alcanza el piso', () => {
  const low = buildCoverage({ platform: 'UberEats', stores: Array.from({ length: 8 }, (_, i) => store(`S${i}`)), itemsSeen: 100 });
  assert.equal(low.health, 'degraded');
  assert.match(budgetWarning(low), /8 tiendas escaneadas < piso 10\/24/);

  const ok = buildCoverage({ platform: 'UberEats', stores: Array.from({ length: 12 }, (_, i) => store(`S${i}`)), itemsSeen: 100 });
  assert.equal(ok.health, 'ok');
  assert.equal(budgetWarning(ok), null);
});
