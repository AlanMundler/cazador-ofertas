import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToLines, parsePyDeals, campaignLabel } from '../scrapers/pydeals.js';

// Líneas capturadas de un fetch real a Picodi AR (2026-10-23)
const REAL_LINES = [
  'Cupón PedidosYa Argentina - hasta 50% - Verificado Oct. 2026',
  'Buscar',
  'Cupones y ofertas de PedidosYa chequeados por Picodi Argentina',
  '50%',
  'PROMOCIÓN',
  '50% de descuento PedidosYa en Descuentos Hoy',
  '¡Aprovechá esta la oportunidad de ahorrar! Descubrí la lista de restaurantes con hasta 50% de descuento todos los días en PedidosYa.',
  'Ver la oferta',
  'Vence:',
  'En curso',
  '19%',
  'PROMOCIÓN',
  'Oferta PedidosYa: Hasta un 19% de descuento en pedidos de supermercados seleccionados',
  'Aprovechá hasta un 19% de descuento en mercados seleccionados sin necesidad de cupón.',
  'Ver la oferta',
  'Vence:',
  '30/10/26',
  'PROMOCIÓN',
  'Encuentra las mejores promociones de Octubre en PedidosYa',
  'Ahorra a lo grande este Octubre en PedidosYa sin necesidad de utilizar el cupón PedidosYa.',
  'Ver la oferta',
  'Vence:',
  'En curso',
  'PROMOCIÓN',
  'Promoción PedidosYa: Envío Gratis',
  '600',
  'CUPÓN',
  'Vencido • Cupón de descuento',
  'Aprovechá un $600 de descuento con el Cupón PedidosYa',
  'Ver cupón',
];

test('parsePyDeals captura la campaña del 50% con umbral 35', () => {
  const deals = parsePyDeals(REAL_LINES, 35);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].discount, 50);
  assert.equal(deals[0].title, '50% de descuento PedidosYa en Descuentos Hoy');
  assert.equal(deals[0].expiry, ''); // "En curso" = sin fecha
});

test('parsePyDeals filtra campañas bajo el umbral (19% con umbral 35)', () => {
  const deals = parsePyDeals(REAL_LINES, 35);
  assert.ok(!deals.some(d => d.discount === 19));
});

test('parsePyDeals incluye el 19% cuando el umbral es menor', () => {
  const deals = parsePyDeals(REAL_LINES, 15);
  const d19 = deals.find(d => d.discount === 19);
  assert.ok(d19);
  assert.equal(d19.title, 'Oferta PedidosYa: Hasta un 19% de descuento en pedidos de supermercados seleccionados');
  assert.equal(d19.expiry, '30/10/26');
});

test('parsePyDeals ignora bloques de códigos CUPÓN vencidos', () => {
  const deals = parsePyDeals(REAL_LINES, 0);
  assert.ok(!deals.some(d => /Vencido/.test(d.title)));
  assert.ok(!deals.some(d => d.title === 'Aprovechá un $600 de descuento con el Cupón PedidosYa'));
});

test('parsePyDeals ignora ofertas sin porcentaje (Envío Gratis)', () => {
  const deals = parsePyDeals(REAL_LINES, 0);
  assert.ok(!deals.some(d => /Envío Gratis/i.test(d.title)));
});

test('campaignLabel limpia los prefijos de la fuente', () => {
  assert.equal(campaignLabel('50% de descuento PedidosYa en Descuentos Hoy'), 'Descuentos Hoy');
  assert.equal(campaignLabel('Oferta PedidosYa: Hasta un 19% de descuento en supermercados'), 'Hasta un 19% de descuento en supermercados');
  assert.equal(campaignLabel('Promoción PedidosYa: Envío Gratis'), 'Envío Gratis');
  assert.equal(campaignLabel('Cupón PedidosYa Argentina - 25% OFF'), '25% OFF');
  assert.equal(campaignLabel(''), 'PedidosYa');
});

test('htmlToLines extrae líneas limpias de un HTML mínimo', () => {
  const lines = htmlToLines('<html><head><script>var x = "<div>trampa</div>";</script></head><body><h1>50%</h1><p>PROMOCIÓN</p><p>Oferta</p></body></html>');
  assert.deepEqual(lines, ['50%', 'PROMOCIÓN', 'Oferta']);
});
