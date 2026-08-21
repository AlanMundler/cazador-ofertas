import 'dotenv/config';
import { scrapeRappi } from './scrapers/rappi.js';
import { scrapePedidosYa } from './scrapers/pedidosya.js';
import { scrapeUberEats } from './scrapers/ubereats.js';
import { sendMessage, pollUpdates } from './notifier/telegram.js';
import { filterNewOffers, deduplicateOffers } from './utils/filter.js';

async function main() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CAZADOR DE OFERTAS - ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  console.log(`Córdoba, Argentina`);
  console.log(`Super/market: >50% OFF | Restaurantes: >60% OFF | Baratos: <$100 ARS`);
  console.log(`${'='.repeat(50)}\n`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const subs = await pollUpdates(token);
    console.log(`[Telegram] Suscriptores activos: ${subs.filter(id => typeof id === 'number').length}`);
  }

  const allOffers = [];

  const rappiOffers = await scrapeRappi();
  allOffers.push(...rappiOffers);

  const pedidosYaOffers = await scrapePedidosYa();
  allOffers.push(...pedidosYaOffers);

  const uberEatsOffers = await scrapeUberEats();
  allOffers.push(...uberEatsOffers);

  const discountOffers = allOffers.filter(o => !o.isCheapProduct);
  const cheapProducts = allOffers.filter(o => o.isCheapProduct);

  const superCount = discountOffers.filter(o => o.category === 'supermercado').length;
  const restCount = discountOffers.filter(o => o.category === 'restaurante').length;
  console.log(`\nTotal bruto: ${discountOffers.length} ofertas (${superCount} super, ${restCount} restaurantes) + ${cheapProducts.length} productos baratos`);

  const deduplicatedDiscounts = deduplicateOffers(discountOffers);
  const deduplicatedCheap = deduplicateOffers(cheapProducts);
  console.log(`Después de dedup: ${deduplicatedDiscounts.length} ofertas + ${deduplicatedCheap.length} baratos`);

  const newDiscounts = filterNewOffers(deduplicatedDiscounts);
  const newCheap = filterNewOffers(deduplicatedCheap);
  console.log(`Nuevos (30min): ${newDiscounts.length} ofertas + ${newCheap.length} baratos`);

  const hasNewContent = newDiscounts.length > 0 || newCheap.length > 0;

  if (hasNewContent) {
    await sendMessage(newDiscounts, newCheap);
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
