const CITY = process.env.CITY || 'Córdoba';
const COUNTRY = process.env.COUNTRY || 'Argentina';
const LAT = process.env.LATITUDE || '-31.412943';
const LNG = process.env.LONGITUDE || '-64.1966036';
const UBEREATS_DIRECT_PL = 'JTdCJTIyYWRkcmVzcyUyMiUzQSUyMlNhbiUyMEpvcyVDMyVBOSUyMGRlJTIwQ2FsYXNhbnolMjIlMkMlMjJyZWZlcmVuY2UlMjIlM0ElMjJFakJUWVc0Z1NtOXp3NmtnWkdVZ1EyRnNZWE5oYm5vc0lGZzFNREF3SUVQRHMzSmtiMkpoTENCQmNtZGxiblJwYm1FaUxpb3NDaFFLRWdsTFBOMkVmNkl5bEJHNEJDOWw0SlZoUFJJVUNoSUphVnVQUjEtWU1wUVJrckJtVTVwUG9yQSUyMiUyQyUyMnJlZmVyZW5jZVR5cGUlMjIlM0ElMjJnb29nbGVfcGxhY2VzJTIyJTJDJTIybGF0aXR1ZGUlMjIlM0EtMzEuNDE1ODcxNyUyQyUyMmxvbmdpdHVkZSUyMiUzQS02NC4xOTczNDMyJTdE';

const config = {
  city: CITY,
  country: COUNTRY,
  lat: LAT,
  lng: LNG,

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.BOT_USERNAME || '',
    adminChatId: Number(process.env.TELEGRAM_CHAT_ID) || 0,
  },

  discounts: {
    super: parseInt(process.env.MIN_DISCOUNT_SUPER || '50'),
    restaurant: parseInt(process.env.MIN_DISCOUNT || '50'),
    uberEats: parseInt(process.env.MIN_DISCOUNT_UE || '50'),
    flashThreshold: parseInt(process.env.FLASH_THRESHOLD || '75'),
  },

  maxPriceCheap: parseInt(process.env.MAX_PRICE_CHEAP || '500'),

  pedidosya: {
    stores: [
      { name: 'PedidosYa Market 25 de Mayo', vendorId: '169481', minDiscount: 50, priority: true, url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-25-de-mayo-bb184a2a-707c-4e62-86e8-0003e06e57af-menu?origin=shop_list' },
      { name: 'PedidosYa Market Crisol', vendorId: '290812', minDiscount: 50, priority: true, url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/pedidosya-market-crisol-047c172b-2380-4da9-901b-2f29711032db-menu?origin=shop_list' },
      { name: 'Carrefour Express', vendorId: '398683', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/carrefour-express-blvd-san-juan-785-93a8196b-9665-4322-8f7e-31b7af23c22f-menu?origin=shop_list' },
      { name: 'Jumbo Córdoba', vendorId: '550495', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/jumbo-cordoba-791c33b2-6317-4717-8b90-6bee5a9554fa-menu' },
      { name: 'La Anónima Jacinto Ríos', vendorId: '620891', url: 'https://www.pedidosya.com.ar/restaurantes/cordoba/la-anonima-jacinto-rios-f6d50a50-cb1d-40d8-b8a4-7aba60e16270-menu' },
    ],
    storeScanCooldownMs: 15 * 60 * 1000,
    storesPerRun: 2,          // cuántas tiendas se escanean por corrida
    rotationFile: 'py-rotation.json', // archivo de cursor en data/
  },

  rappi: {
    restaurantsUrl: `https://www.rappi.com.ar/restaurantes?lat=${LAT}&lng=${LNG}`,
    stores: [
      { slug: '214965-jumbo', name: 'Jumbo' },
      { slug: '247115-disco', name: 'Disco' },
      { slug: '248079-vea', name: 'Vea' },
      { slug: '262682-turbo-veinticuatro-market-nc', name: 'Turbo Market' },
      { slug: '126292-carrefour-express', name: 'Carrefour Express' },
      { slug: '258919-turbo-express-nc', name: 'La Despensa' },
      { slug: '115860-punto-sur', name: 'Punto Sur Multimercado' },
      { slug: '188551-minishoppritty-mt-nc', name: 'Maxikiosco Pritty' },
    ],
  },

  ubereats: {
    directStores: [
      { slug: 'supermercado-justmart', storeId: 'wvymqlJBWVikLAVxmURagQ', name: 'JustMart', category: 'supermercado', minDiscount: 35, pl: UBEREATS_DIRECT_PL },
      { slug: 'carrefour-express-santiago-derqui', storeId: '-0bSYWbrW8CowiVVbD6K0g', name: 'Carrefour Express Santiago Derqui', category: 'supermercado', minDiscount: 35, pl: UBEREATS_DIRECT_PL },
      { slug: 'tadicor-cordoba', storeId: 'f1zid1uSUZuf000t2Tjmyw', name: 'Tadicor', category: 'supermercado', minDiscount: 35, pl: UBEREATS_DIRECT_PL },
    ],
  },

  history: {
    dedupWindowMs: 45 * 60 * 1000,
    maxEntries: 5000,
    pruneKeep: 3000,
  },
};

export default config;
