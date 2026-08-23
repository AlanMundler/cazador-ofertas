import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = join(__dirname, '..', 'data', 'history.json');

function loadHistory() {
  try {
    if (!existsSync(HISTORY_FILE)) return {};
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveHistory(history) {
  const dir = join(__dirname, '..', 'data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const WINDOW = 2 * 60 * 60 * 1000;
  let entries = Object.entries(history).filter(([, v]) => (now - v.lastSeen) < DAY);

  if (entries.length > 5000) {
    entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    entries = entries.slice(0, 3000);
  }

  writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
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

export function filterNewOffers(offers) {
  const history = loadHistory();
  const newOffers = [];
  const now = Date.now();

  for (const offer of offers) {
    const key = offerKey(offer);
    const seen = history[key];

    if (!seen || (now - seen.lastSeen) > 2 * 60 * 60 * 1000) {
      newOffers.push(offer);
      history[key] = { lastSeen: now, count: (seen?.count || 0) + 1 };
    }
  }

  saveHistory(history);
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

export function detectFlashDeals(offers) {
  const history = loadHistory();
  const flashDeals = [];
  const now = Date.now();
  const FLASH_THRESHOLD = 75;

  for (const offer of offers) {
    if (offer.isCheapProduct || offer.type === 'coupon') continue;
    if (offer.discount < FLASH_THRESHOLD) continue;

    const priceKey = `${offer.platform}:${offer.restaurant}:price`;
    const priceHistory = history[priceKey];

    if (!priceHistory || (now - priceHistory.lastSeen) > 2 * 60 * 60 * 1000) {
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

  saveHistory(history);
  return flashDeals;
}
