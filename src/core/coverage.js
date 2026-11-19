// Declaración de cobertura por plataforma y pisos de salud de corrida.

import { PEDIDOSYA, RAPPI, UBEREATS } from './platforms.js';

export const POINT = { lat: -31.412943, lng: -64.1966036 };

export const FLOORS = {
  [PEDIDOSYA]: { min: 5, of: 23, basis: 'stores' },
  [RAPPI]: { min: 3, of: 5, basis: 'super' },
  [UBEREATS]: { min: 10, of: 24, basis: 'stores' },
};

const KINDS = ['super', 'vertical', 'otro'];

/** Coverage §0: universo vs escaneado, tiendas por tipo, cadenas ausentes y muestreo. */
export function buildCoverage({
  platform,
  stores = [],
  storesAvailable = null,
  itemsSeen = 0,
  aislesAnnounced = null,
  sampled = false,
  truncated = false,
  missingChains = [],
}) {
  const list = Array.isArray(stores) ? stores : [];
  const storesByKind = { super: 0, vertical: 0, otro: 0 };

  for (const store of list) {
    const kind = store?.storeKind ?? store?.kind;
    storesByKind[KINDS.includes(kind) ? kind : 'otro'] += 1;
  }

  const coverage = {
    platform,
    point: { ...POINT },
    fetchedAt: new Date().toISOString(),
    storesAvailable: storesAvailable ?? null,
    storesScanned: list.length,
    storesSeen: list.length,
    storesByKind,
    missingChains: [...missingChains],
    catalogCoverage: {
      itemsSeen,
      aislesAnnounced,
      sampled: Boolean(sampled || truncated),
      truncated: Boolean(truncated),
    },
  };

  coverage.health = health(coverage);
  return coverage;
}

/**
 * ok: alcanza el piso de la plataforma.
 * degraded: vio tiendas pero no llegó al piso.
 * dead: cero tiendas o cero ítems (scraper roto / catálogo vacío).
 * Rappi se mide sólo sobre supers; PY y UE sobre el total de tiendas escaneadas.
 */
export function health(coverage) {
  const floor = FLOORS[coverage?.platform];
  if (!floor) return 'dead';

  const seen = floor.basis === 'super'
    ? coverage.storesByKind?.super ?? 0
    : coverage.storesScanned ?? coverage.storesSeen ?? 0;
  const items = coverage.catalogCoverage?.itemsSeen ?? 0;

  if (seen === 0 || items === 0) return 'dead';
  return seen >= floor.min ? 'ok' : 'degraded';
}

/** Aviso cuando el presupuesto de tiendas no alcanza para evaluar el piso. */
export function budgetWarning(coverage) {
  const floor = FLOORS[coverage?.platform];
  if (!floor) return null;
  const seen = floor.basis === 'super'
    ? coverage.storesByKind?.super ?? 0
    : coverage.storesScanned ?? 0;
  if (seen < floor.min) {
    return `${coverage.platform}: ${seen} tiendas escaneadas < piso ${floor.min}/${floor.of} (¿--max-stores bajo?)`;
  }
  return null;
}

/** 0 sólo si la corrida está sana. */
export function exitCodeFor(coverage) {
  return coverage?.health === 'ok' ? 0 : 1;
}
