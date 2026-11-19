# Cazador de Ofertas

Bot de Telegram que busca ofertas en apps de delivery y las envía a los suscriptores.

## Targets

```bash
node index.js --target=rappi
node index.js --target=ubereats
node index.js --target=pedidosya   # usa la cola curada manual, no scrapea PedidosYa
node index.js --target=all
```

Para probar sin enviar mensajes ni modificar suscriptores:

```bash
node index.js --target=pedidosya --dry-run
```

En dry-run la cola curada sí se consume (las ofertas válidas salen de `data/curated-pending.json`),
pero no se hace POST a Telegram ni se toca `data/subscribers.json`. Tampoco se consultan los
updates del bot (no se procesan comandos nuevos) ni se escribe el histórico.

## Modo curado

El target `pedidosya` toma las ofertas de `data/curated-pending.json`. El admin las carga
por Telegram; solo se aceptan comandos del chat configurado en `TELEGRAM_CHAT_ID`.

### Encolar una oferta

```text
/oferta <Plataforma> | <Tienda> | <Producto> | <precio original> | <precio actual> | [URL] [| #barato]
```

Ejemplos:

```text
/oferta PedidosYa | Market 25 de Mayo | Coca-Cola 2.25L | $1.700 | $1.200
/oferta PedidosYa | Market Crisol | Pan lactal | $1.000 | $700 | https://www.pedidosya.com.ar/... | #barato
```

Precios aceptados: `$1.700`, `$1.700,50`, `1700`. El descuento se calcula solo.
Una oferta con `#barato` se publica en la sección de productos baratos; el resto va a ofertas.

### Otros comandos

```text
/ofertas          # lista la cola pendiente
/oferta clear     # vacía la cola
/publicar         # procesa y envía la cola ahora mismo
```

El flujo normal de una corrida es: procesar updates del bot → tomar la cola curada →
deduplicar contra el histórico → enviar → vaciar las ofertas válidas de la cola.
Las ofertas inválidas se conservan en la cola para corregirlas.

## Tests

```bash
npm test
```

## Pipeline nuevo: todos los markets (v2)

Scrapea **todas las tiendas de mercado que entregan en San José de Calasanz 58, Córdoba**
(lat -31.412943, lng -64.1966036), no una lista hardcodeada.

```bash
node src/run.js                        # las 3 plataformas, escribe data/
node src/run.js --dry-run              # no escribe deals.json ni envía Telegram
node src/run.js --send                 # envía el digest a los suscriptores
node src/run.js --platform=Rappi --max-stores=3 --verbose
node src/run.js --py-stores=23 --py-categories=4 --py-pages=2   # presupuesto de PedidosYa
```

Salidas:
- `data/deals.json` — ofertas rankeadas por plataforma (top descuento, mejor precio, flash).
- `data/coverage.json` — declaración de cobertura: tiendas por tipo, ítems vistos, `sampled`.
- `data/cross-platform-review.json` — pares "¿mismo producto?" para revisión humana (no es ranking).
- `data/runs/<Plataforma>-<ISO>.jsonl` — snapshot crudo por corrida (poda 7 días).

Cómo obtiene los datos cada plataforma:
- **Rappi**: HTTP puro con guest token (`passport` → `x-guest-api-key` → Bearer). Cobertura por
  `stores-router/available/principal`; catálogo por `dynamic/context/content` (`store_home` + `sub_aisles`).
- **PedidosYa**: Chromium (patchright) sólo por las cookies; cobertura por `v4/shoplist/vendors`
  con `businessTypes:["GROCERIES"]`; catálogo por `groceries/web/v1/vendors/{id}/categories|products`.
  No usa el flujo de dirección: la API es por tienda.
- **Uber Eats**: Chromium headed (headless = reCAPTCHA); cookie `uev2.loc` fija el punto;
  `getFeedByIdV1` con `feedID:"shop_feed"` da el directorio y `getStoreV1` el catálogo.

Salud por corrida: si una plataforma no alcanza el piso de tiendas, se marca `degraded`/`dead`,
se imprime en el resumen y el proceso termina con código distinto de 0 (nunca "sin ofertas" silencioso).

Notas operativas:
- Uber Eats y PedidosYa necesitan `xvfb-run` en CI (browser headed).
- PedidosYa tolera ráfagas cortas: si devuelve "Acceso ha sido denegado", esperar ~90 s y reintentar.
- Dedupe entre corridas: sólo se envía lo que cambió de precio o es nuevo; el resto se omite.
- Tests: `npm test` (100 tests, sin red).

### Dónde conviene correrlo

| Entorno | Resultado verificado |
|---|---|
| **Tu PC (IP residencial)** | 10.245 productos / 2.093 ofertas; PY 22/22, Rappi 50/50, UE 23/23 |
| **GitHub Actions + WARP** | **Rappi 50/50** (6.093) y **PedidosYa 23/24** (1.031) OK, run 44536566017. **Uber Eats NO**: el feed GEOIP resuelve a EE.UU. y la guardia lo rechaza |
| **GitHub Actions sin WARP** | Rappi `passport 403`, UberEats sin `uev2.loc`, PedidosYa 403 |

Cloudflare WARP es la única opción de Cloudflare que cambia la IP de salida (Workers/Browser Rendering salen por rangos datacenter y no destraban nada).
Estado por plataforma en la nube: Rappi ✅, PedidosYa ✅, Uber Eats ❌ (necesita egress argentino).
Uber Eats sin cookie usa `GEOIP`; con WARP eso apunta a EE.UU., por eso el adaptador exige marcas AR y falla explícito en vez de publicar tiendas de otro país.

Opciones:
1. **Local programado (recomendado hoy)**: `scripts/run-local.ps1` + Programador de tareas.
   ```powershell
   schtasks /Create /TN "Cazador Markets" /SC MINUTE /MO 30 /TR "powershell -ExecutionPolicy Bypass -File E:\Proyectos\PEDIDOYA\cazador-ofertas\scripts\run-local.ps1" /F
   ```
2. **Nube con proxy residencial AR**: cargar `UE_PROXY_URL` (y opcionalmente `PY_PROXY_URL`) con formato
   `http://usuario:clave@host:puerto`. Con `UE_PROXY_URL` el cron corre las tres plataformas.
3. **Self-hosted runner** en tu PC: mismo efecto que (1) pero con la UI de Actions.

Variables por plataforma (los adapters no comparten proxy para no romperse entre sí):
- `UE_PROXY_URL` → sólo Uber Eats (necesita egress AR).
- `PY_PROXY_URL` → sólo PedidosYa (por defecto usa WARP).
- Rappi no usa proxy (WARP alcanza).
