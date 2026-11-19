// Cadenas de supermercado que esperamos ver. Sirve para declarar ausencias reales.

import { PEDIDOSYA, RAPPI, UBEREATS } from './platforms.js';

export const KNOWN_CHAINS = {
  [PEDIDOSYA]: ['Coto', 'Día', 'La Anónima', 'Jumbo', 'Disco', 'Carrefour', 'Vea', 'Makro'],
  [RAPPI]: ['Coto', 'Día', 'La Anónima', 'Jumbo', 'Disco', 'Carrefour', 'Vea', 'Makro'],
  [UBEREATS]: ['Jumbo', 'Disco', 'Vea', 'Coto', 'La Anónima', 'Makro'],
};

const normalize = value => String(value ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

/** Cadenas conocidas que NO aparecen entre las tiendas efectivamente escaneadas. */
export function missingChains(platformName, scanned = []) {
  const names = scanned.map(store => normalize(store?.name));
  return (KNOWN_CHAINS[platformName] ?? []).filter(chain => !names.some(name => name.includes(normalize(chain))));
}
