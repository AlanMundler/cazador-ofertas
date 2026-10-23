import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CURATED_QUEUE_FILE = process.env.CURATED_QUEUE_FILE
  || join(__dirname, '..', 'data', 'curated-pending.json');

export const OFFER_COMMAND_HELP = [
  'Formato:',
  '/oferta <Plataforma> | <Tienda> | <Producto> | <precio original> | <precio actual> | [URL] [| #barato]',
  '',
  'Ejemplo:',
  '/oferta PedidosYa | Market 25 de Mayo | Coca-Cola 2.25L | $1.700 | $1.200 | https://www.pedidosya.com.ar/... | #barato',
  '',
  'Precios aceptados: $1.700, $1.700,50, 1700',
].join('\n');

function clean(value) {
  return String(value ?? '').trim();
}

function tagsFrom(raw) {
  const source = raw?.tags ?? raw?.hashtags ?? raw?.tag ?? [];
  const values = Array.isArray(source)
    ? source
    : String(source).split(/[\s,]+/);

  return values
    .map(tag => clean(tag).replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * Acepta precios argentinos y también números:
 *   $1.700 -> 1700
 *   $1.700,50 -> 1700.5
 *   1700 -> 1700
 *   1700.50 -> 1700.5
 * Devuelve null si no puede interpretarlo.
 */
export function parsePrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  let text = value.trim().replace(/[^\d.,]/g, '');
  if (!text) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // 1.700,50 -> 1700.50
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,700.50 -> 1700.50
      text = text.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      text = `${parts[0].replace(/\./g, '')}.${parts[1]}`;
    } else {
      // 1,700 se interpreta como separador de miles.
      text = text.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    const parts = text.split('.');
    if (parts.length > 2) {
      // 1.700.000
      text = parts.join('');
    } else if (parts[1].length === 3) {
      // 1.700 -> 1700
      text = parts.join('');
    }
    // 1700.50 queda como decimal.
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPrice(value) {
  const parsed = typeof value === 'number' ? value : parsePrice(value);
  if (!Number.isFinite(parsed)) return '';

  const hasDecimals = Math.abs(parsed - Math.round(parsed)) > 1e-9;
  return `$${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(parsed)}`;
}

export function computeDiscount(originalPrice, currentPrice) {
  const original = typeof originalPrice === 'number' ? originalPrice : parsePrice(originalPrice);
  const current = typeof currentPrice === 'number' ? currentPrice : parsePrice(currentPrice);

  if (!Number.isFinite(original) || !Number.isFinite(current) || original <= 0) {
    return null;
  }

  return Math.round(((original - current) / original) * 100);
}

/**
 * Normaliza una oferta cruda de la cola al schema que consume telegram.js.
 */
export function normalizeCuratedOffer(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'La oferta no es un objeto válido.' };
  }

  const platform = clean(raw.platform);
  const restaurant = clean(raw.restaurant ?? raw.store ?? raw.tienda);
  const name = clean(raw.name ?? raw.product ?? raw.producto);

  if (!platform) return { ok: false, error: 'Falta la plataforma.' };
  if (!restaurant) return { ok: false, error: 'Falta la tienda.' };
  if (!name) return { ok: false, error: 'Falta el producto.' };

  const tags = tagsFrom(raw);
  const isCheapProduct = tags.includes('barato');

  const original = parsePrice(raw.originalPrice ?? raw.precioOriginal);
  const current = parsePrice(raw.currentPrice ?? raw.precioActual);

  if (!Number.isFinite(current) || current <= 0) {
    return { ok: false, error: 'El precio actual no es válido.' };
  }
  if (!Number.isFinite(original) || original <= 0) {
    if (!isCheapProduct) {
      return { ok: false, error: 'El precio original no es válido.' };
    }
  } else if (current > original) {
    return { ok: false, error: 'El precio actual no puede ser mayor al original.' };
  }

  let discount = Number(raw.discount);
  if (raw.discount === undefined || raw.discount === null || raw.discount === '' || !Number.isFinite(discount)) {
    discount = Number.isFinite(original) && original > 0
      ? computeDiscount(original, current)
      : 0;
  }
  discount = Math.max(0, Math.min(100, Math.round(discount)));

  const formattedCurrent = formatPrice(current);
  const formattedOriginal = Number.isFinite(original) && original > 0 ? formatPrice(original) : null;
  const promoTag = tags.find(tag => /^\d+x\d+$/i.test(tag));

  return {
    ok: true,
    offer: {
      platform,
      category: raw.category === 'restaurante' ? 'restaurante' : 'supermercado',
      restaurant,
      slug: raw.slug || '',
      discount,
      name,
      description: isCheapProduct ? `${formattedCurrent} - ${name}` : `${discount}% OFF ${name}`,
      originalPrice: formattedOriginal,
      currentPrice: formattedCurrent,
      url: raw.url || '',
      deliveryTime: raw.deliveryTime || '',
      rating: raw.rating || '',
      imageUrl: raw.imageUrl || '',
      promoType: raw.promoType || promoTag || 'campaign',
      isCheapProduct,
      source: 'curated',
    },
  };
}

export function formatOfferSummary(offer) {
  if (!offer) return '';
  const price = typeof offer.currentPrice === 'string'
    ? offer.currentPrice
    : formatPrice(offer.currentPrice);
  const discount = Number(offer.discount) > 0 ? ` (-${offer.discount}%)` : '';
  const cheap = offer.isCheapProduct ? ' | #barato' : '';

  return `${offer.platform} | ${offer.restaurant} | ${offer.name} | ${price}${discount}${cheap}`;
}

export function summarizeCuratedOffer(raw) {
  const normalized = normalizeCuratedOffer(raw);
  return normalized.ok
    ? formatOfferSummary(normalized.offer)
    : `⚠️ inválida: ${normalized.error}`;
}

/**
 * Parsea el comando /oferta. Devuelve { ok, offer } o { ok:false, error }.
 */
export function parseOfferCommand(text) {
  const match = String(text ?? '').trim().match(/^\/oferta(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return { ok: false, error: 'Comando inválido. Esperaba /oferta ...' };
  }

  const body = clean(match[1]);
  if (!body) {
    return { ok: false, error: 'Falta el contenido de la oferta.' };
  }

  const fields = body.split('|').map(part => part.trim());
  if (fields.length < 5) {
    return { ok: false, error: 'Faltan campos. Se esperan al menos 5 separados por "|".' };
  }

  const [platform, restaurant, name, originalRaw, currentRaw, ...extras] = fields;
  if (!platform) return { ok: false, error: 'Falta la plataforma.' };
  if (!restaurant) return { ok: false, error: 'Falta la tienda.' };
  if (!name) return { ok: false, error: 'Falta el producto.' };

  const original = parsePrice(originalRaw);
  const current = parsePrice(currentRaw);
  if (!Number.isFinite(original) || original <= 0) {
    return { ok: false, error: `Precio original inválido: "${originalRaw}".` };
  }
  if (!Number.isFinite(current) || current <= 0) {
    return { ok: false, error: `Precio actual inválido: "${currentRaw}".` };
  }
  if (current >= original) {
    return { ok: false, error: 'El precio actual debe ser menor al original.' };
  }

  const tags = [];
  let url = '';

  for (const extra of extras) {
    if (!extra) continue;

    const urlMatch = extra.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      url = urlMatch[0];
      const rest = extra.replace(urlMatch[0], '').trim();
      if (rest) {
        if (!rest.startsWith('#')) {
          return { ok: false, error: `Campo extra no reconocido: "${rest}".` };
        }
        tags.push(...rest.split(/\s+/).map(tag => tag.replace(/^#/, '').toLowerCase()).filter(Boolean));
      }
      continue;
    }

    if (!extra.startsWith('#')) {
      return { ok: false, error: `Campo extra no reconocido: "${extra}".` };
    }
    tags.push(...extra.split(/\s+/).map(tag => tag.replace(/^#/, '').toLowerCase()).filter(Boolean));
  }

  const discount = computeDiscount(original, current);

  return {
    ok: true,
    offer: {
      platform,
      restaurant,
      name,
      originalPrice: original,
      currentPrice: current,
      discount,
      url,
      tags,
      createdAt: new Date().toISOString(),
    },
  };
}

function loadQueue(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) {
    throw new Error('La cola curada debe ser un array JSON.');
  }
  return raw;
}

function writeQueue(queue, file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(queue, null, 2) + '\n');
}

export function readCuratedQueue(file = CURATED_QUEUE_FILE) {
  try {
    return loadQueue(file);
  } catch (e) {
    console.error(`[Curado] No se pudo leer la cola: ${e.message}`);
    return [];
  }
}

export function enqueueCuratedOffer(raw, file = CURATED_QUEUE_FILE) {
  const normalized = normalizeCuratedOffer(raw);
  if (!normalized.ok) return normalized;

  let queue;
  try {
    queue = loadQueue(file);
  } catch (e) {
    return { ok: false, error: `No se pudo leer la cola: ${e.message}` };
  }

  queue.push(raw);
  try {
    writeQueue(queue, file);
  } catch (e) {
    return { ok: false, error: `No se pudo guardar la cola: ${e.message}` };
  }

  return { ok: true, offer: normalized.offer, pending: queue.length };
}

export function clearCuratedQueue(file = CURATED_QUEUE_FILE) {
  let count = 0;
  try {
    count = loadQueue(file).length;
  } catch {
    count = 0;
  }
  writeQueue([], file);
  return count;
}

/**
 * Toma la cola y normaliza las ofertas válidas.
 * Con consume=true (default) las ofertas válidas se eliminan de la cola de inmediato.
 * Con consume=false se devuelve commit() para vaciarlas recién después de procesarlas
 * (por ejemplo, después de enviar). Las ofertas inválidas siempre se conservan.
 */
export function takeCuratedOffers(file = CURATED_QUEUE_FILE, { consume = true } = {}) {
  let rawQueue;
  try {
    rawQueue = loadQueue(file);
  } catch (e) {
    return {
      offers: [],
      errors: [{ error: `No se pudo leer la cola: ${e.message}` }],
      remaining: 0,
      commit: () => ({ ok: true }),
    };
  }

  const offers = [];
  const errors = [];
  const keep = [];

  rawQueue.forEach((raw, index) => {
    const normalized = normalizeCuratedOffer(raw);
    if (normalized.ok) {
      offers.push(normalized.offer);
    } else {
      errors.push({ index, error: normalized.error, raw });
      keep.push(raw);
    }
  });

  const commit = () => {
    try {
      writeQueue(keep, file);
      return { ok: true, remaining: keep.length };
    } catch (e) {
      const error = `No se pudo actualizar la cola: ${e.message}`;
      errors.push({ error });
      return { ok: false, error };
    }
  };

  if (consume) commit();

  return { offers, errors, remaining: keep.length, commit };
}
