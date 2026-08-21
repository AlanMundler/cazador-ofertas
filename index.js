import 'dotenv/config';
import { scrapeRappi } from './scrapers/rappi.js';
import { scrapePedidosYa } from './scrapers/pedidosya.js';
import { scrapeUberEats } from './scrapers/ubereats.js';
import { sendMessage } from './notifier/telegram.js';
import { filterNewOffers, deduplicateOffers } from './utils/filter.js';

async function main() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CAZADOR DE OFERTAS - ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  console.log(`Córdoba, Argentina`);
  console.log(`Super/market: >60% OFF | Restaurantes: >70% OFF`);
  console.log(`${'='.repeat(50)}\n`);

  const allOffers = [];

  const rappiOffers = await scrapeRappi();
  allOffers.push(...rappiOffers);

  const pedidosYaOffers = await scrapePedidosYa();
  allOffers.push(...pedidosYaOffers);

  const uberEatsOffers = await scrapeUberEats();
  allOffers.push(...uberEatsOffers);

  const superCount = allOffers.filter(o => o.category === 'supermercado').length;
  const restCount = allOffers.filter(o => o.category === 'restaurante').length;
  console.log(`\nTotal bruto: ${allOffers.length} ofertas (${superCount} super, ${restCount} restaurantes)`);

  const deduplicated = deduplicateOffers(allOffers);
  console.log(`Después de dedup: ${deduplicated.length} ofertas`);

  const newOffers = filterNewOffers(deduplicated);
  console.log(`Ofertas nuevas (no vistas en últimos 30min): ${newOffers.length}`);

  if (newOffers.length > 0) {
    await sendMessage(newOffers);
    console.log(`\n¡Notificación enviada!`);
  } else {
    console.log(`\nSin ofertas nuevas, no se envía notificación.`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTiempo total: ${elapsed}s`);
  console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
