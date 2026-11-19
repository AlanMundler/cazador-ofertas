// Orquestador: corre los adaptadores, rankea intra-plataforma y persiste la corrida.

import 'dotenv/config';

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { collectRappi } from './adapters/rappi.js';
import { collectPedidosYa } from './adapters/pedidosya.js';
import { collectUberEats } from './adapters/ubereats.js';
import { rankByPlatform } from './core/rank.js';
import { candidatePairs } from './core/identity.js';
import { missingChains } from './core/chains.js';
import { buildCoverage, health, exitCodeFor, budgetWarning } from './core/coverage.js';
import { appendRun, loadSeen, pruneRuns, saveSeen, writeDeals } from './core/store.js';
import { PLATFORM_IDS, PEDIDOSYA, RAPPI, UBEREATS } from './core/platforms.js';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const POINT = { lat: -31.412943, lng: -64.1966036 };
const ADDRESS = 'San José de Calasanz 58, Córdoba, Argentina';

function arg(name, fallback) {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const platform = arg('platform', 'all');
const dryRun = flag('dry-run');
const maxStores = Number(arg('max-stores', '25'));
const debug = flag('verbose');
const log = (...args) => console.log(...args);

async function runRappi() {
  return collectRappi({
    point: POINT,
    cacheFile: join(ROOT, 'data', '.cache', 'rappi-auth.json'),
    maxStores,
    maxPages: Number(arg('rappi-pages', '6')),
    log: debug ? log : () => {},
  });
}

async function runPedidosYa() {
  return collectPedidosYa({
    point: { latitude: POINT.lat, longitude: POINT.lng },
    stateFile: join(ROOT, '.py-state.json'),
    maxStores: Number(arg('py-stores', '23')),
    maxCategories: Number(arg('py-categories', '4')),
    maxPages: Number(arg('py-pages', '2')),
    headless: process.env.HEADLESS === 'true',
    log: debug ? log : () => {},
  });
}

async function runUberEats() {
  return collectUberEats({
    address: ADDRESS,
    point: POINT,
    maxStores,
    headless: process.env.HEADLESS === 'true',
    log: debug ? log : () => {},
  });
}

const RUNNERS = { [RAPPI]: runRappi, [PEDIDOSYA]: runPedidosYa, [UBEREATS]: runUberEats };

/** Claves de los productos vistos en las corridas recientes (dedupe entre corridas). */
export function recentKeys(dir, platforms, maxFilesPerPlatform = 2) {
  const keys = new Set();
  if (!existsSync(dir)) return keys;
  for (const platformName of platforms) {
    const files = readdirSync(dir)
      .filter(file => file.startsWith(`${platformName}-`) && file.endsWith('.jsonl'))
      .map(file => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFilesPerPlatform);
    for (const { file } of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const product = JSON.parse(line);
          keys.add(`${product.platform}|${product.storeId}|${product.productId}|${product.price}`);
        } catch {}
      }
    }
  }
  return keys;
}

async function sendPlain(text, chatId, { dryRun = false } = {}) {
  const { token } = config.telegram;
  if (dryRun || !token || !chatId) return { sent: 0, dryRun };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => null);
  return { sent: response && response.ok ? 1 : 0, dryRun: false };
}

/** Aviso explícito cuando una plataforma quedó degradada o caída. */
async function notifyHealth(coverages, failures, dryRun) {
  const broken = coverages.filter(coverage => coverage.health !== 'ok');
  if (broken.length === 0 && failures.length === 0) return null;

  const lines = ['⚠️ CAZADOR — salud de la corrida'];
  for (const coverage of coverages) {
    lines.push(`${coverage.health === 'ok' ? '✅' : coverage.health === 'degraded' ? '⚠️' : '❌'} ${coverage.platform}: ${coverage.storesScanned}/${coverage.storesAvailable ?? '?'} tiendas, ${coverage.catalogCoverage.itemsSeen} productos (${coverage.health})`);
  }
  for (const failure of failures) lines.push(`❌ ${failure.platform}: ${failure.error}`);

  const text = lines.join('\n');
  let chatId = config.telegram.adminChatId || null;
  if (!chatId) {
    const subscribersFile = join(ROOT, 'data', 'subscribers.json');
    if (existsSync(subscribersFile)) {
      chatId = (JSON.parse(readFileSync(subscribersFile, 'utf8'))?.ids ?? [])[0] ?? null;
    }
  }
  await sendPlain(text, chatId, { dryRun });
  return text.split('\n').slice(1).join(' | ');
}

/** Mensaje aparte con el mejor precio por producto dentro de cada plataforma. */
async function notifyBestPrice(ranked, { dryRun = false, max = 6, keep = () => true, minDiscount = 30 } = {}) {
  const entries = [];
  for (const [platformName, bucket] of Object.entries(ranked.byPlatform ?? {})) {
    for (const entry of bucket.bestPriceByProduct ?? []) {
      if ((entry.product.discount ?? 0) < minDiscount) continue;
      if (!keep(entry.product)) continue;
      entries.push({ platformName, entry });
    }
  }
  if (entries.length === 0) return 0;

  entries.sort((a, b) => (b.entry.product.discount ?? 0) - (a.entry.product.discount ?? 0));
  const lines = ['💰 MEJOR PRECIO POR PRODUCTO'];
  for (const { platformName, entry } of entries.slice(0, max)) {
    const product = entry.product;
    lines.push(`- ${product.name} — $${product.price.toLocaleString('es-AR')} en ${product.storeName} (${platformName})`);
  }

  const text = lines.join('\n');
  if (dryRun) return entries.length;
  const { token } = config.telegram;
  if (!token) return 0;

  const subscribersFile = join(ROOT, 'data', 'subscribers.json');
  if (!existsSync(subscribersFile)) return 0;
  const ids = JSON.parse(readFileSync(subscribersFile, 'utf8'))?.ids ?? [];
  for (const id of ids) await sendPlain(text, id, { dryRun });
  return entries.length;
}

async function main() {
  const started = Date.now();
  const platforms = platform === 'all' ? PLATFORM_IDS : [platform];
  const products = [];
  const coverages = [];
  const failures = [];

  for (const name of platforms) {
    const runner = RUNNERS[name];
    if (!runner) {
      failures.push({ platform: name, error: 'unknown platform' });
      continue;
    }
    log(`\n=== ${name} ===`);
    try {
      const result = await runner();
      products.push(...result.products);
      const coverage = buildCoverage({
        platform: name,
        point: result.coverage.point ?? POINT,
        stores: result.coverage.scanned ?? [],
        storesAvailable: result.coverage.storesAvailable ?? null,
        itemsSeen: result.products.length,
        aislesAnnounced: result.coverage.catalogCoverage?.aislesAnnounced ?? null,
        sampled: result.coverage.catalogCoverage?.sampled ?? true,
        truncated: result.coverage.truncated === true,
        missingChains: missingChains(name, result.coverage.scanned ?? []),
      });
      coverages.push(coverage);
      log(`${name}: ${coverage.storesScanned}/${coverage.storesAvailable ?? '?'} tiendas (${JSON.stringify(coverage.storesByKind)}), ${result.products.length} productos, health=${health(coverage)}`);
      const warning = budgetWarning(coverage);
      if (warning) console.log(`AVISO ${warning}`);
    } catch (error) {
      failures.push({ platform: name, error: error.message });
      coverages.push(buildCoverage({
        platform: name,
        point: POINT,
        stores: [],
        itemsSeen: 0,
        aislesAnnounced: null,
        sampled: true,
        missingChains: missingChains(name, []),
      }));
      log(`${name}: FALLÓ — ${error.message}`);
    }
  }

  const ranked = rankByPlatform(products, { minDiscount: 30, flash: 75, maxPerStore: 3 });
  const deck = {
    generatedAt: new Date().toISOString(),
    point: POINT,
    address: ADDRESS,
    elapsedMs: Date.now() - started,
    coverages,
    failures,
    totals: {
      products: products.length,
      discounted: products.filter(product => product.discount > 0).length,
      byPlatform: Object.fromEntries(coverages.map(coverage => [coverage.platform, coverage.catalogCoverage.itemsSeen])),
    },
    deals: ranked,
  };

  const dataDir = join(ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });

  const previousKeys = new Set([...recentKeys(join(dataDir, 'runs'), platforms).keys(), ...loadSeen(dataDir).keys()]);

  if (flag('send')) {
    const alert = await notifyHealth(coverages, failures, dryRun);
    if (alert) console.log(`[Telegram] aviso de salud: ${alert}`);
  }

  if (!dryRun) {
    for (const name of platforms) {
      const list = products.filter(product => product.platform === name);
      if (list.length) appendRun(dataDir, name, list);
    }
    writeDeals(dataDir, deck);
    pruneRuns(dataDir, 7);
    writeFileSync(join(dataDir, 'coverage.json'), `${JSON.stringify(coverages, null, 2)}\n`, 'utf8');
    const pairs = candidatePairs(products).slice(0, 200).map(pair => ({
      score: pair.score,
      brand: pair.brand,
      size: pair.size,
      priceDiff: pair.priceDiff,
      a: { platform: pair.a.platform, store: pair.a.storeName, name: pair.a.name, price: pair.a.price, url: pair.a.url },
      b: { platform: pair.b.platform, store: pair.b.storeName, name: pair.b.name, price: pair.b.price, url: pair.b.url },
    }));
    writeFileSync(join(dataDir, 'cross-platform-review.json'), `${JSON.stringify({ generatedAt: deck.generatedAt, pairs }, null, 2)}\n`, 'utf8');
    console.log(`Cross-platform candidatos: ${pairs.length}`);
  } else {
    writeFileSync(join(dataDir, 'deals.dry-run.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
  }

  console.log('\n=== RESUMEN ===');
  for (const coverage of coverages) {
    console.log(`${coverage.platform.padEnd(10)} tiendas=${String(coverage.storesScanned).padStart(2)}/${coverage.storesAvailable ?? '?'} kinds=${JSON.stringify(coverage.storesByKind)} items=${coverage.catalogCoverage.itemsSeen} sampled=${coverage.catalogCoverage.sampled} health=${health(coverage)}`);
  }
  for (const failure of failures) console.log(`FALLA ${failure.platform}: ${failure.error}`);

  const { buildDigest, offerKey } = await import('./report.js');
  const isNew = product => !previousKeys.has(`${product.platform}|${product.storeId}|${product.productId}|${product.price}`);
  const digest = buildDigest(ranked, { keep: isNew });
  if (flag('send')) {
    if (digest.offers.length === 0 && digest.flash.length === 0) {
      console.log('[Telegram] sin ofertas nuevas desde la corrida anterior');
    } else {
      const { sendMessage } = await import('../notifier/telegram.js');
      await sendMessage(digest.offers, [], digest.flash, { dryRun });
      console.log(dryRun
        ? `[Telegram] digest generado (dry-run): ${digest.offers.length} nuevas + ${digest.flash.length} flash`
        : `[Telegram] digest enviado: ${digest.offers.length} nuevas + ${digest.flash.length} flash`);
    }
    const bestPriceCount = await notifyBestPrice(ranked, { dryRun, keep: isNew });
    if (bestPriceCount) console.log(`[Telegram] mejor precio por producto: ${bestPriceCount} grupos`);
  }

  if (!dryRun) {
    const seen = loadSeen(dataDir);
    const now = Date.now();
    for (const product of [...digest.raw.offers, ...digest.raw.flash, ...digest.raw.bestPrice]) {
      seen.set(offerKey(product), now);
    }
    saveSeen(dataDir, seen);
  }

  for (const [name, bucket] of Object.entries(ranked.byPlatform)) {
    const top = bucket.topDiscount.slice(0, 3).map(product => `  ${product.discount}% ${product.name} $${product.price} @ ${product.storeName}`);
    if (top.length) console.log(`\n${name} top:\n${top.join('\n')}`);
  }
  console.log(`\nProductos=${products.length} con descuento=${deck.totals.discounted} en ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (dryRun) console.log('(dry-run: no se escribió data/deals.json)');

  const worst = coverages
    .map(coverage => exitCodeFor(coverage))
    .reduce((max, code) => Math.max(max, code), 0);
  process.exitCode = worst || (failures.length ? 1 : 0);
}

main().catch(error => {
  console.error('Error fatal:', error);
  process.exitCode = 1;
});
