// Persistencia: JSONL por corrida, deals.json atómico y poda de corridas viejas.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

function runsDir(dir) {
  return join(dir, 'runs');
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function platformSlug(platform) {
  return String(platform).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** Crea/agrega data/runs/<platform>-<ISO>.jsonl. Devuelve la ruta del archivo. */
export function appendRun(dir, platform, products = []) {
  const target = runsDir(dir);
  mkdirSync(target, { recursive: true });

  const file = join(target, `${platformSlug(platform)}-${safeTimestamp()}.jsonl`);
  const lines = (Array.isArray(products) ? products : []).map(product => JSON.stringify(product));
  appendFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return file;
}

/** Escribe data/deals.json con tmp + rename para no dejar archivos a medias. */
export function writeDeals(dir, deals) {
  mkdirSync(dir, { recursive: true });

  const file = join(dir, 'deals.json');
  const tmp = join(dir, `.deals.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(deals, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch {}
  }
  return file;
}

function timestampFromName(name) {
  const match = name.match(/-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Índice compacto de ofertas ya notificadas (para dedupe en CI, sin JSONL gigante). */
export function loadSeen(dir, days = 7) {
  const file = join(dir, 'seen.json');
  if (!existsSync(file)) return new Map();
  const cutoff = Date.now() - Number(days) * DAY_MS;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    return new Map(Object.entries(raw).filter(([, timestamp]) => Number(timestamp) >= cutoff));
  } catch {
    return new Map();
  }
}

export function saveSeen(dir, entries, days = 7) {
  mkdirSync(dir, { recursive: true });
  const cutoff = Date.now() - Number(days) * DAY_MS;
  const merged = new Map();
  for (const [key, timestamp] of entries ?? []) {
    const value = Number(timestamp);
    if (Number.isFinite(value) && value >= cutoff) merged.set(key, value);
  }
  const file = join(dir, 'seen.json');
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(merged))}\n`, 'utf8');
  return file;
}

/** Borra corridas más viejas que `days` y devuelve las rutas eliminadas. */
export function pruneRuns(dir, days = 7) {
  const target = runsDir(dir);
  if (!existsSync(target)) return [];

  const cutoff = Date.now() - Number(days) * DAY_MS;
  const deleted = [];

  for (const name of readdirSync(target)) {
    if (!name.endsWith('.jsonl')) continue;

    const file = join(target, name);
    const timestamp = timestampFromName(name) ?? statSync(file).mtimeMs;

    if (timestamp < cutoff) {
      unlinkSync(file);
      deleted.push(file);
    }
  }

  return deleted.sort();
}
