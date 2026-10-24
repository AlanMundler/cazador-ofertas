import config from '../config.js';

// Lane de campañas vigentes de PedidosYa (promos de sitio/banco, sin códigos).
// Fuente: Picodi Argentina (HTML estático, robots permite /ar/pedidosya, sin Cloudflare).
// Fetch plano cada corrida: sin browser, sin anti-detección, funciona desde cualquier IP.
// Alternativa evaluada y descartada con evidencia: RadarCupón (CF 403 a clientes
// no-browser), Kekunda (Chile + catálogo tras login), Prex (CF), PY /promociones (JS-only).

const SOURCE_URL = 'https://www.picodi.com/ar/pedidosya';

/** HTML -> líneas de texto (lo necesario para parsear el listado de ofertas). */
export function htmlToLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/** Etiqueta limpia de campaña para el campo restaurant del mensaje. */
export function campaignLabel(title) {
  return String(title || '')
    .replace(/^oferta\s+pedidosya\s*:\s*/i, '')
    .replace(/^promoci[oó]n\s+pedidosya\s*:\s*/i, '')
    .replace(/^cup[oó]n\s+pedidosya(\s+argentina)?\s*[-–]\s*/i, '')
    .replace(/^\d{1,3}\s*%\s*de\s*descuento\s*(?:en\s*)?pedidosya\s*(?:en)?\s*/i, '')
    .trim() || 'PedidosYa';
}

/**
 * Parsea el listado de Picodi AR. Estructura evidenciada (fetch real 2026-10-23):
 *   N% | PROMOCIÓN | título | descripción | Ver la oferta | Vence: | En curso | dd/mm/aa
 * Bloques "CUPÓN" (códigos, mayormente vencidos) y promos sin % se ignoran.
 */
export function parsePyDeals(lines, minDiscount) {
  const deals = [];
  for (let i = 0; i < (lines || []).length; i++) {
    const m = /^(\d{1,3})\s*%$/.exec(lines[i]);
    if (!m) continue;
    if (lines[i + 1] !== 'PROMOCIÓN') continue;

    const discount = parseInt(m[1], 10);
    if (!(discount >= 1 && discount <= 99)) continue;

    const title = lines[i + 2] || '';
    const description = lines[i + 3] || '';
    if (!title) continue;

    // vigencia dentro del bloque (antes de la próxima oferta)
    let expiry = '';
    for (let j = i + 4; j < Math.min(i + 10, lines.length); j++) {
      if (lines[j] === 'Vence:') {
        const next = lines[j + 1] || '';
        if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(next)) expiry = next;
        break;
      }
      if (/^\d{1,3}\s*%$/.test(lines[j]) && lines[j + 1] === 'PROMOCIÓN') break;
    }

    if (discount < minDiscount) continue;
    deals.push({ discount, title, description, expiry });
  }
  return deals;
}

export async function scrapePyDeals() {
  const offers = [];
  const minDiscount = config.pedidosya.campaigns?.minDiscount ?? 35;
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      console.log(`[PY Campañas] Fuente respondió ${resp.status}, se salta`);
      return offers;
    }
    const html = await resp.text();
    const lines = htmlToLines(html);
    const deals = parsePyDeals(lines, minDiscount);
    console.log(`[PY Campañas] ${deals.length} campañas >=${minDiscount}% (fuente: Picodi AR)`);

    for (const d of deals) {
      const label = campaignLabel(d.title);
      const category = /supermercado|mercado|market/i.test(d.title) ? 'supermercado' : 'restaurante';
      const vigencia = d.expiry ? ` (vence ${d.expiry})` : '';
      offers.push({
        platform: 'PedidosYa', category,
        restaurant: label, slug: '', discount: d.discount,
        name: d.title,
        description: `${d.discount}% OFF — ${label}${vigencia}`,
        originalPrice: null, currentPrice: null,
        url: SOURCE_URL, deliveryTime: '', rating: '', imageUrl: '',
      });
    }
  } catch (e) {
    console.log(`[PY Campañas] Error: ${e.message.substring(0, 120)}`);
  }
  return offers;
}
