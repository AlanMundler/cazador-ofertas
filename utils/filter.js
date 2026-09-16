import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY_FILE = join(__dirname, '..', 'data', 'history.json');

function loadHistory(historyFile = DEFAULT_HISTORY_FILE) {
  try {
    if (!existsSync(historyFile)) return {};
    return JSON.parse(readFileSync(historyFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveHistory(history, historyFile = DEFAULT_HISTORY_FILE) {
  const dir = dirname(historyFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  let entries = Object.entries(history).filter(([, v]) => (now - v.lastSeen) < DAY);

  if (entries.length > config.history.maxEntries) {
    entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    entries = entries.slice(0, config.history.pruneKeep);
  }

  writeFileSync(historyFile, JSON.stringify(Object.fromEntries(entries), null, 2));
}

function offerKey(offer) {
  if (offer.isCheapProduct) {
    return `${offer.platform}:${offer.restaurant}:cheap:${offer.currentPrice}:${offer.description}`;
  }
  if (offer.discount > 0 && offer.description && /off/i.test(offer.description)) {
    return `${offer.platform}:${offer.restaurant}:${offer.discount}:${offer.description}`;
  }
  return `${offer.platform}:${offer.restaurant}:${offer.discount}`;
}

export function filterNewOffers(offers, historyFile) {
  const history = loadHistory(historyFile);
  const newOffers = [];
  const now = Date.now();

  for (const offer of offers) {
    const key = offerKey(offer);
    const seen = history[key];

    if (!seen || (now - seen.lastSeen) > config.history.dedupWindowMs) {
      newOffers.push(offer);
      history[key] = { lastSeen: now, count: (seen?.count || 0) + 1 };
    }
  }

  saveHistory(history, historyFile);
  return newOffers;
}

export function deduplicateOffers(offers) {
  const seen = new Set();
  return offers.filter(offer => {
    const key = offerKey(offer);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectFlashDeals(offers, historyFile) {
  const history = loadHistory(historyFile);
  const flashDeals = [];
  const now = Date.now();

  for (const offer of offers) {
    if (offer.isCheapProduct) continue;
    if (offer.discount < config.discounts.flashThreshold) continue;

    const priceKey = `${offer.platform}:${offer.restaurant}:price`;
    const priceHistory = history[priceKey];

    if (!priceHistory || (now - priceHistory.lastSeen) > config.history.dedupWindowMs) {
      flashDeals.push({
        ...offer,
        isFlash: true,
        message: `⚡ FLASH: ${offer.discount}% en ${offer.restaurant} (${offer.platform})`,
      });
    }

    history[priceKey] = {
      lastSeen: now,
      price: offer.currentPrice || offer.originalPrice || '',
      discount: offer.discount,
      count: (priceHistory?.count || 0) + 1,
    };
  }

  saveHistory(history, historyFile);
  return flashDeals;
}
