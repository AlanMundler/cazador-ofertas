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
  console.log(`Cordoba, Argentina | Min discount: ${process.env.MIN_DISCOUNT || '60'}%`);
  console.log(`${'='.repeat(50)}\n`);

  const allOffers = [];

  const rappiOffers = await scrapeRappi();
  allOffers.push(...rappiOffers);

  const pedidosYaOffers = await scrapePedidosYa();
  allOffers.push(...pedidosYaOffers);

  const uberEatsOffers = await scrapeUberEats();
  allOffers.push(...uberEatsOffers);

  console.log(`\nTotal bruto: ${allOffers.length} ofertas`);

  const deduplicated = deduplicateOffers(allOffers);
  console.log(`Despues de dedup: ${deduplicated.length} ofertas`);

  const newOffers = filterNewOffers(deduplicated);
  console.log(`Ofertas nuevas (no vistas en ultimos 30min): ${newOffers.length}`);

  if (newOffers.length > 0) {
    await sendMessage(newOffers);
    console.log(`\nNotificacion enviada!`);
  } else {
    console.log(`\nSin ofertas nuevas, no se envia notificacion.`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTiempo total: ${elapsed}s`);
  console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
