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

  const entries = Object.entries(history);
  if (entries.length > 5000) {
    const sorted = entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    const trimmed = Object.fromEntries(sorted.slice(0, 3000));
    writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } else {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  }
}

function offerKey(offer) {
  return `${offer.platform}:${offer.restaurant}:${offer.discount}`;
}

export function filterNewOffers(offers) {
  const history = loadHistory();
  const newOffers = [];
  const now = Date.now();

  for (const offer of offers) {
    const key = offerKey(offer);
    const seen = history[key];

    if (!seen || (now - seen.lastSeen) > 30 * 60 * 1000) {
      newOffers.push(offer);
      history[key] = { lastSeen: now, count: (seen?.count || 0) + 1 };
    }
  }

  saveHistory(history);
  return newOffers;
}

export function filterByDiscount(offers, minDiscount) {
  const min = minDiscount || parseFloat(process.env.MIN_DISCOUNT || '60');
  return offers.filter(o => o.discount >= min);
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
