// Orquestador: corre los adaptadores, rankea intra-plataforma y persiste la corrida.

import 'dotenv/config';

import { createHash } from 'crypto';
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
const ADDRESS = 'San JosÃ© de Calasanz 58, CÃ³rdoba, Argentina';

function arg(name, fallback) {
  const found = process.argv.find(value => value.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const platform = arg('platform', 'all');
const platforms = platform === 'all'
  ? PLATFORM_IDS
  : platform.split(',').map(name => name.trim()).filter(Boolean);
const dryRun = flag('dry-run');
const maxStores = Number(arg('max-stores', '0'));
const debug = flag('verbose');
const log = (...args) => console.log(...args);

async function runRappi() {
  return collectRappi({
    point: POINT,
    cacheFile: join(ROOT, 'data', '.cache', 'rappi-auth.json'),
    maxStores,
    maxPages: Number(arg('rappi-pages', '25')),
    log: debug ? log : () => {},
  });
}

async function runPedidosYa() {
  return collectPedidosYa({
    point: { latitude: POINT.lat, longitude: POINT.lng },
    stateFile: join(ROOT, '.py-state.json'),
    maxStores: Number(arg('py-stores', '0')),
    maxCategories: Number(arg('py-categories', '0')),
    maxPages: Number(arg('py-pages', '0')),
    concurrency: Number(arg('py-concurrency', '6')),
    cacheDir: join(ROOT, 'data', 'cache', 'py'),
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

async function sendPlain(text, chatId, { dryRun = false, html = false } = {}) {
  const { token } = config.telegram;
  if (dryRun || !token || !chatId) return { sent: 0, dryRun };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) }),
  }).catch(() => null);
  return { sent: response && response.ok ? 1 : 0, dryRun: false };
}

/** Aviso de salud: solo cuando una plataforma cambia de estado (evita spam cada 30 min). */
async function notifyHealth(coverages, failures, dryRun, dataDir) {
  const current = {};
  for (const coverage of coverages) current[coverage.platform] = coverage.health;

  const healthFile = join(dataDir, 'health.json');
  let previous = {};
  if (existsSync(healthFile)) {
    try { previous = JSON.parse(readFileSync(healthFile, 'utf8')) ?? {}; } catch {}
  }

  const firstRun = Object.keys(previous).length === 0;
  const changed = failures.length > 0 || firstRun
    || coverages.some(coverage => previous[coverage.platform] !== coverage.health);

  if (!dryRun) {
    try { writeFileSync(healthFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8'); } catch {}
  }

  const broken = coverages.filter(coverage => coverage.health !== 'ok');
  if (!changed || (broken.length === 0 && failures.length === 0)) return null;

  const icon = status => (status === 'ok' ? '\u2705' : status === 'degraded' ? '\u26A0\uFE0F' : '\u274C');
  const lines = ['\u26A0\uFE0F CAZADOR \u00B7 salud de la corrida'];
  for (const coverage of coverages) {
    lines.push(`${icon(coverage.health)} ${coverage.platform}: ${coverage.storesScanned}/${coverage.storesAvailable ?? '?'} tiendas, ${coverage.catalogCoverage.itemsSeen} productos (${coverage.health})`);
  }
  for (const failure of failures) lines.push(`\u274C ${failure.platform}: ${failure.error}`);

  const text = lines.join('\n');
  let chatId = config.telegram.adminChatId || null;
  if (!chatId) {
    const subscribersFile = join(dataDir, 'subscribers.json');
    if (existsSync(subscribersFile)) {
      chatId = (JSON.parse(readFileSync(subscribersFile, 'utf8'))?.ids ?? [])[0] ?? null;
    }
  }
  await sendPlain(text, chatId, { dryRun });
  return text.split('\n').slice(1).join(' | ');
}

async function main() {
  const started = Date.now();
  const products = [];
  const coverages = [];
  const failures = [];

  // Mantiene altas/bajas de suscriptores sin depender del pipeline viejo.
  if (!dryRun && config.telegram.token) {
    try {
      const { pollUpdates } = await import('../notifier/telegram.js');
      const subscribers = await pollUpdates(config.telegram.token);
      console.log(`[Telegram] suscriptores activos: ${subscribers.length}`);
    } catch (error) {
      console.log(`[Telegram] poll de suscriptores falló: ${error.message}`);
    }
  }

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
      log(`${name}: FALLÃ“ â€” ${error.message}`);
    }
  }

  const thresholds = { [PEDIDOSYA]: 50, [RAPPI]: 50, [UBEREATS]: 40 };
  // Sólo supermercados/markets: 'otro' son farmacias, licorerías, veterinarias, etc.
  const marketProducts = products.filter(product => product.storeKind !== 'otro');
  const skipped = products.length - marketProducts.length;
  if (skipped) console.log(`Descartados por no ser supermercado/market: ${skipped}`);
  const ranked = rankByPlatform(marketProducts, { minDiscount: thresholds, flash: 75 });
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
    const alert = await notifyHealth(coverages, failures, dryRun, dataDir);
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

  const { buildDigest, chunk, offerKey } = await import('./report.js');
  const sendAll = flag('all-offers');
  const onlyNew = flag('only-new') && !sendAll;
  const isNew = onlyNew
    ? product => !previousKeys.has(`${product.platform}|${product.storeId}|${product.productId}|${product.price}`)
    : () => true;
  const digest = buildDigest(ranked, { keep: isNew, coverages, thresholds, maxPerPlatform: Number(arg('max-per-platform', '0')) });

  // El listado es completo (todas las ofertas del umbral). Sólo se reenvía si el conjunto cambió.
  const signature = digest.count
    ? createHash('sha1').update(digest.raw.offers
      .map(product => `${product.platform}|${product.productId}|${Math.max(product.discount ?? 0, product.advertisedDiscount ?? 0)}`)
      .sort().join(',')).digest('hex')
    : 'empty';
  const digestFile = join(dataDir, 'digest.json');
  let previousSignature = null;
  if (existsSync(digestFile)) {
    try { previousSignature = JSON.parse(readFileSync(digestFile, 'utf8'))?.signature ?? null; } catch {}
  }

  if (flag('send')) {
    if (!digest.text) {
      console.log('[Telegram] sin ofertas sobre el umbral');
    } else if (!sendAll && signature === previousSignature) {
      console.log(`[Telegram] sin cambios en las ofertas (${digest.count}); no se reenvía`);
    } else {
      const parts = chunk(digest.text);
      const subscribersFile = join(dataDir, 'subscribers.json');
      const ids = existsSync(subscribersFile)
        ? (JSON.parse(readFileSync(subscribersFile, 'utf8'))?.ids ?? [])
        : [];
      if (dryRun) {
        console.log('\n[DRY-RUN] mensaje que se enviaría:\n');
        console.log(digest.text);
      } else {
        for (const part of parts) {
          for (const id of ids) await sendPlain(part, id, { dryRun, html: true });
        }
      }
      console.log(dryRun
        ? `[Telegram] digest generado (dry-run): ${digest.count} ofertas, ${parts.length} parte(s)`
        : `[Telegram] digest enviado: ${digest.count} ofertas a ${ids.length} suscriptores`);
    }
  }

  if (!dryRun) {
    writeFileSync(digestFile, `${JSON.stringify({ signature, count: digest.count, sentAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    const seen = loadSeen(dataDir);
    const now = Date.now();
    for (const product of [...digest.raw.offers, ...digest.raw.flash]) {
      seen.set(offerKey(product), now);
    }
    saveSeen(dataDir, seen);
  }

  for (const [name, bucket] of Object.entries(ranked.byPlatform)) {
    const top = bucket.topDiscount.slice(0, 3).map(product => `  ${product.discount}% ${product.name} $${product.price} @ ${product.storeName}`);
    if (top.length) console.log(`\n${name} top:\n${top.join('\n')}`);
  }
  console.log(`\nProductos=${products.length} con descuento=${deck.totals.discounted} en ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (dryRun) console.log('(dry-run: no se escribiÃ³ data/deals.json)');

  const worst = coverages
    .map(coverage => exitCodeFor(coverage))
    .reduce((max, code) => Math.max(max, code), 0);
  process.exitCode = worst || (failures.length ? 1 : 0);
}

main().catch(error => {
  console.error('Error fatal:', error);
  process.exitCode = 1;
});










