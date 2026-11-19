// Adaptador Rappi: HTTP puro con guest token. Cobertura por punto de entrega.
// Contrato verificado en spike/rappi/out/discover.log (2026-11-18).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { RAPPI } from '../core/platforms.js';
import { normalizeProduct } from '../core/normalize.js';

const BASE = 'https://services.rappi.com.ar';
const ORIGIN = 'https://www.rappi.com.ar';
const APP_ID = 'web_v1.225.2';
const APP_VERSION = '1.157.2';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pick(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

const SUPER_TYPES = /^(jumbo|disco|vea|carrefour|makro|coto|dia|la_anonima|anonima|pedidosya_market|sumo|walmart|changomas)/;

export function classifyStore(store = {}) {
  const parent = String(pick(store, 'parent_name', 'parentName', 'parent_group', 'parentGroup') ?? '').toLowerCase();
  const sub = String(pick(store, 'sub_group', 'subGroup') ?? '').toLowerCase();
  const type = String(pick(store, 'store_type', 'storeType') ?? '').toLowerCase();
  const name = String(pick(store, 'name', 'description') ?? '').toLowerCase();

  // Verticales que no son supermercado ni market: no entran al ranking.
  if (/farmacia|farmacity|drugstore|droguer|pets|mascota|veterinaria|vinoteca|licorer|club bebidas|bebidas club|tabaco|get the look|tipsy|feel fit|beauty|perfum|moda|tienda de ropa/.test(`${type} ${name}`)) {
    return 'otro';
  }

  const marketSignal = /mercado|cpgs|cpg/.test(parent)
    || /turbo|express|market|super|minishop|minimercado|almacen/.test(type)
    || /super|market|mercado|hiper|minimercado|almacen/.test(name);
  if (!marketSignal) return 'otro';

  if (sub === 'super' || SUPER_TYPES.test(type)) return 'super';
  return 'vertical';
}

export function storeSlug(store) {
  const id = pick(store, 'store_id', 'storeId', 'id');
  const slug = pick(store, 'friendly_url', 'friendlyUrl', 'slug', 'store_type', 'storeType');
  return slug ? `${id}-${slug}` : String(id);
}

async function jsonFetch(url, { method = 'GET', body, headers = {}, timeout = 25000 } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text };
}

/** Guest token cacheado ~7 días. Devuelve {accessToken, deviceId}. */
export async function rappiAuth(cacheFile, { force = false } = {}) {
  if (!force && cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached?.accessToken && cached?.expiresAt > Date.now() + 60_000) return cached;
    } catch {}
  }

  const deviceId = crypto.randomUUID();
  const passport = await jsonFetch(`${BASE}/api/rocket/v2/guest/passport/`, {
    headers: { deviceid: deviceId, 'user-agent': 'Mozilla/5.0' },
  });
  const guestKey = passport.data?.token;
  if (!guestKey) throw new Error(`rappi passport failed: ${passport.status}`);

  const guest = await jsonFetch(`${BASE}/api/rocket/v2/guest`, {
    method: 'POST',
    headers: {
      deviceid: deviceId,
      'x-guest-api-key': guestKey,
      'content-type': 'application/json',
      accept: 'application/json',
      origin: ORIGIN,
    },
    body: {},
  });
  const accessToken = guest.data?.access_token;
  if (!accessToken) throw new Error(`rappi guest failed: ${guest.status}`);

  const auth = {
    accessToken,
    deviceId,
    expiresAt: Date.now() + (Number(guest.data?.expires_in) || 604_800) * 1000,
  };
  if (cacheFile) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  }
  return auth;
}

function baseHeaders(auth) {
  return {
    authorization: `Bearer ${auth.accessToken}`,
    deviceid: auth.deviceId,
    'x-application-id': APP_ID,
    'app-version': APP_VERSION,
    vendor: 'rappi',
    language: 'es',
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0',
  };
}

/** Tiendas que entregan en el punto, con su vertical. */
export async function rappiCoverage(point, auth) {
  const url = `${BASE}/api/web-gateway/web/stores-router/available/principal/?lng=${point.lng}&lat=${point.lat}&view=web`;
  const { status, data } = await jsonFetch(url, { headers: baseHeaders(auth) });
  if (status !== 200 || !data) throw new Error(`rappi coverage failed: ${status}`);

  // La respuesta es un array de grupos; los locales viven en group.suboptions[].stores[].
  const groups = Array.isArray(data) ? data : (data.groups ?? data.data ?? []);
  const stores = [];
  for (const group of groups) {
    const parentName = pick(group, 'parent_name', 'name') ?? '';
    for (const sub of group.suboptions ?? []) {
      const subParent = pick(sub, 'parent_name', 'group') ?? parentName;
      const storeType = pick(sub, 'store_type', 'storeType') ?? '';
      const friendly = pick(sub, 'friendly_url', 'friendlyUrl') ?? null;
      const kind = classifyStore({
        parent_name: parentName === 'Mercados' ? parentName : subParent,
        sub_group: pick(sub, 'sub_group', 'subGroup'),
        store_type: storeType,
        name: pick(sub, 'name', 'description'),
      });
      for (const store of sub.stores ?? []) {
        const id = String(pick(store, 'store_id', 'storeId', 'id'));
        stores.push({
          id,
          name: pick(sub, 'name', 'description') ?? pick(store, 'name') ?? `Tienda ${id}`,
          storeType: storeType || pick(store, 'store_type') || '',
          kind,
          isOpen: pick(store, 'is_open', 'isOpen') !== false,
          slug: friendly ? `${id}-${friendly}` : id,
          lat: pick(store, 'lat', 'latitude'),
          lng: pick(store, 'lng', 'longitude'),
          raw: store,
        });
      }
    }
    for (const store of group.stores ?? []) {
      const id = String(pick(store, 'store_id', 'storeId', 'id'));
      stores.push({
        id,
        name: pick(group, 'name') ?? `Tienda ${id}`,
        storeType: pick(store, 'store_type') ?? '',
        kind: classifyStore({ parent_name: pick(group, 'parent_name', 'name'), sub_group: pick(group, 'sub_group') }),
        isOpen: pick(store, 'is_open', 'isOpen') !== false,
        slug: id,
        lat: pick(store, 'lat'),
        lng: pick(store, 'lng'),
        raw: store,
      });
    }
  }
  return stores;
}

function productsFromComponents(data) {
  const out = [];
  for (const component of data?.components ?? []) {
    const products = component?.resource?.products;
    if (Array.isArray(products)) out.push(...products);
  }
  return out;
}

/** Productos de una tienda (store_home + sub_aisles paginado). */
export async function rappiStoreProducts(store, { auth, maxPages = 8, log = () => {} } = {}) {
  const headers = baseHeaders(auth);
  const state = {
    lat: String(store.point?.lat ?? store.lat),
    lng: String(store.point?.lng ?? store.lng),
    store_type: store.storeType,
    parent_store_type: 'market',
  };
  const url = `${BASE}/api/web-gateway/web/dynamic/context/content/`;

  const seen = new Map();
  let requests = 0;

  const call = async (body) => {
    requests += 1;
    const { status, data } = await jsonFetch(url, { method: 'POST', headers, body });
    if (status === 401 || status === 403) throw new Error(`rappi auth/blocked: ${status}`);
    if (status !== 200 || !data) return [];
    const root = data.data ?? data;
    const found = productsFromComponents(root);
    for (const product of found) {
      const id = String(pick(product, 'product_id', 'productId', 'id') ?? '');
      if (id && !seen.has(id)) seen.set(id, product);
    }
    return found;
  };

  await call({
    limit: 12, offset: 0, state,
    stores: [Number(store.id)],
    context: 'store_home',
  });

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await call({
      limit: 15, offset: page * 15, state,
      stores: [Number(store.id)],
      context: 'sub_aisles',
    });
    if (batch.length === 0) break;
    await sleep(250);
  }

  log(`rappi ${store.name}: ${seen.size} productos (${requests} requests)`);
  return [...seen.values()];
}

/**
 * Recolecta ofertas de Rappi para un punto de entrega.
 * Devuelve productos normalizados + declaración de cobertura.
 */
export async function collectRappi({
  point,
  cacheFile,
  onlyKinds = ['super', 'vertical'],
  maxStores = 15,
  maxPages = 8,
  log = () => {},
} = {}) {
  const auth = await rappiAuth(cacheFile);
  const stores = await rappiCoverage(point, auth);
  const eligible = stores.filter(store => store.isOpen && onlyKinds.includes(store.kind))
    .sort((a, b) => (a.kind === 'super' ? 0 : 1) - (b.kind === 'super' ? 0 : 1));
  const byKind = eligible.reduce((acc, store) => ({ ...acc, [store.kind]: (acc[store.kind] ?? 0) + 1 }), {});

  const products = [];
  const scanned = [];
  for (const store of eligible.slice(0, maxStores)) {
    try {
      const raw = await rappiStoreProducts({ ...store, point }, { auth, maxPages, log });
      const url = `https://www.rappi.com.ar/tiendas/${store.slug}`;
      for (const item of raw) {
        const result = normalizeProduct({ ...item, url }, {
          platform: RAPPI,
          storeId: store.id,
          storeName: store.name,
          storeKind: store.kind,
          sampled: true,
          fetchedAt: new Date().toISOString(),
        });
        if (result.ok) products.push(result.product);
      }
      scanned.push({ id: store.id, name: store.name, kind: store.kind, items: raw.length });
    } catch (error) {
      log(`rappi ${store.name}: ${error.message}`);
      scanned.push({ id: store.id, name: store.name, kind: store.kind, items: 0, error: error.message });
    }
    await sleep(400);
  }

  return {
    products,
    coverage: {
      platform: RAPPI,
      point,
      fetchedAt: new Date().toISOString(),
      storesSeen: scanned.length,
      storesAvailable: eligible.length,
      truncated: eligible.length > maxStores,
      storesByKind: byKind,
      missingChains: [],
      catalogCoverage: {
        itemsSeen: products.length,
        aislesAnnounced: null,
        sampled: true,
      },
      scanned,
    },
  };
}
