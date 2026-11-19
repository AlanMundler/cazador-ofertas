// Pool de proxies gratuitos con salida AR, con test real contra Uber Eats.
// Los proxies públicos mueren en minutos: se validan antes de usarse y se cachean poco tiempo.

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CACHE_TTL_MS = 15 * 60 * 1000;

const SOURCES = [
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/AR/data.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=ar&protocol=http&proxy_format=protocolipport&format=text',
];

async function curl(args, timeoutMs = 6000) {
  try {
    const { stdout } = await run('curl.exe', ['-s', '--max-time', String(Math.ceil(timeoutMs / 1000)), ...args], { timeout: timeoutMs + 1500 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function fetchCandidates() {
  const found = new Set();
  for (const source of SOURCES) {
    try {
      const response = await fetch(source, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/((?:https?|socks[45]):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/);
        if (match) found.add(`${match[1] ?? 'http://'}${match[2]}:${match[3]}`);
      }
    } catch {}
  }
  return [...found];
}

/** Un proxy sirve si sale por AR, responde el feed de Uber Eats y acepta CONNECT (HTTPS). */
async function validate(proxy) {
  const geo = await curl(['-x', proxy, 'http://ip-api.com/json/?fields=status,countryCode']);
  let info = null;
  try { info = JSON.parse(geo); } catch {}
  if (!info || info.status !== 'success' || info.countryCode !== 'AR') return false;

  const feed = await curl([
    '-x', proxy, '-o', 'NUL', '-w', '%{http_code}', '-A', UA, '-X', 'POST',
    '-H', 'content-type: application/json', '-H', 'x-csrf-token: x',
    '-d', '{"feedID":"shop_feed","deliveryLocation":[{"type":"GEOIP"}],"feedmakerCtx":"","cacheKey":""}',
    'https://www.ubereats.com/_p/api/getFeedByIdV1?localeCode=ar',
  ], 12000);
  if (feed !== '200') return false;

  const httpsOk = await curl(['-x', proxy, '-o', 'NUL', '-w', '%{http_code}', '-A', UA, 'https://www.ubereats.com/robots.txt'], 12000);
  return httpsOk === '200';
}

function loadCache(cacheFile) {
  if (!cacheFile || !existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!cached?.checkedAt || Date.now() - cached.checkedAt > CACHE_TTL_MS) return null;
    return Array.isArray(cached.proxies) && cached.proxies.length ? cached.proxies : null;
  } catch {
    return null;
  }
}

function saveCache(cacheFile, proxies) {
  if (!cacheFile) return;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify({ checkedAt: Date.now(), proxies }, null, 2)}\n`, 'utf8');
  } catch {}
}

/** ¿La IP actual ya es argentina? Si sí, no hace falta proxy. */
export async function isArgentina() {
  try {
    const response = await fetch('http://ip-api.com/json/?fields=status,countryCode', { signal: AbortSignal.timeout(6000) });
    const info = await response.json();
    return info?.status === 'success' && info.countryCode === 'AR';
  } catch {
    return false;
  }
}

/**
 * Devuelve un proxy AR vivo para Uber Eats, o null si no hay ninguno.
 * `limit` acota cuántos candidatos se prueban (los proxies públicos son lentos).
 */
export async function getFreeProxy({ cacheFile = 'data/proxies.json', limit = 80, concurrency = 12, log = () => {} } = {}) {
  const cached = loadCache(cacheFile);
  if (cached) {
    for (const proxy of cached) {
      if (await validate(proxy)) return proxy;
    }
  }

  const candidates = (await fetchCandidates()).slice(0, limit);
  log(`proxies: ${candidates.length} candidatos AR a validar`);
  const working = [];
  let index = 0;

  async function worker() {
    while (index < candidates.length && working.length < 3) {
      const proxy = candidates[index++];
      if (await validate(proxy).catch(() => false)) {
        working.push(proxy);
        log(`proxies: OK ${proxy}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  saveCache(cacheFile, working);
  return working[0] ?? null;
}
