# Cazador de Ofertas

Bot de Telegram que busca ofertas en PedidosYa, Rappi y Uber Eats y las envía a los suscriptores.
Corre **en GitHub Actions** (cron cada 30 min), sin depender de ninguna PC.

Punto de entrega: **San José de Calasanz 58, Córdoba** (lat -31.412943, lng -64.1966036).
Sólo se publican tiendas de supermercado/market que entregan en ese domicilio.

## Pipeline v2 (markets)

```bash
node src/run.js                          # las 3 plataformas, escribe data/
node src/run.js --dry-run                # no escribe deals.json ni envía Telegram
node src/run.js --send                   # envía el digest a los suscriptores
node src/run.js --platform=Rappi,UberEats --max-stores=5
node src/run.js --py-stores=23 --py-categories=4 --py-pages=2
node src/run.js --max-per-platform=20    # 0 (default) = todas las ofertas del umbral
```

Salidas:
- `data/deals.json` — ofertas rankeadas por plataforma.
- `data/coverage.json` — cobertura: tiendas escaneadas/disponibles, ítems, `sampled`.
- `data/seen.json` — dedupe entre corridas (producto + tamaño + precio).
- `data/health.json` — último estado por plataforma (evita avisos repetidos).
- `data/cross-platform-review.json` — pares "¿mismo producto?" para revisión humana.
- `data/runs/*.jsonl` — snapshot crudo por corrida (poda 7 días).

### Umbrales y alcance
- **PedidosYa y Rappi: ≥50%.** **Uber Eats: ≥40%.** Flash: ≥75%.
- Sólo supermercados y markets; no hay restaurantes en el pipeline.
- Se publican **todas** las ofertas sobre el umbral, sin tope por tienda.
- Los precios son de **sesión anónima**: los descuentos exclusivos de Uber One / membresías
  no aparecen en la API pública (ej. H2O: la etiqueta de Uber dice −35%, no −50%).

### Mensaje
Agrupado por plataforma y por supermercado; el nombre del local es el link (HTML de Telegram):

```
🛒 OFERTAS SUPER · 25/11, 12:50 · PEDIDOSYA ≥50% · RAPPI ≥50% · UBER EATS ≥40%

<b>PEDIDOSYA</b>
<a href="https://...">Disco Alta Córdoba</a> · 2
   • 50% Gomitas Mogul Colmillos — $1.050 las 2 ($525 c/u) (2 x 1)
   • 50% Yerba Mate Cruz de Malta 500 g — $1.444,5
```

En promos de cantidad el descuento se calcula **sobre el conjunto** (2x1 → 50%, "2da al 50%" → 25%)
y se muestra el precio del par con el unitario. Se parte en mensajes de ≤3800 caracteres.

## Cómo obtiene los datos

- **Rappi**: HTTP puro con guest token (`passport` → `x-guest-api-key` → Bearer).
  Cobertura por `stores-router/available/principal`; catálogo por `dynamic/context/content`.
- **PedidosYa**: Chromium (patchright) sólo por cookies; cobertura por `v4/shoplist/vendors`
  con `businessTypes:["GROCERIES"]`; catálogo por `groceries/web/v1/vendors/{id}/categories|products`.
  No usa el flujo de dirección.
- **Uber Eats**: Chromium headed (headless = reCAPTCHA). La ubicación se fija en el body:
  `deliveryLocation:[{type:"MANUAL", location:{latitude,longitude}}]`, que manda sobre la IP.
  Después `getFeedByIdV1` da el directorio y `getStoreV1` el catálogo.

## Dónde corre

| Entorno | Resultado verificado |
|---|---|
| **GitHub Actions + Cloudflare WARP** | **3/3**: Rappi 50/50, PedidosYa 23/24, Uber Eats 21/21 (2.029 productos) |
| **GitHub Actions sin WARP** | Rappi `passport 403`, PedidosYa 403 |

El workflow `.github/workflows/scrape-markets.yml` instala WARP (3 reintentos), corre el pipeline
con las tres plataformas y commitea `data/seen.json`, `data/coverage.json`, `data/health.json`.

Salud por corrida: si una plataforma no alcanza el piso de tiendas queda `degraded`/`dead`,
se avisa **sólo cuando cambia el estado** y el proceso sale con código distinto de 0.

Variables opcionales: `UE_PROXY_URL` / `PY_PROXY_URL` si querés forzar un proxy por plataforma;
con WARP no son necesarias. `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` son obligatorias.

## Bot de Telegram (comandos)

Sólo el chat configurado en `TELEGRAM_CHAT_ID` puede usarlos:

```text
/oferta <Plataforma> | <Tienda> | <Producto> | <precio original> | <precio actual> | [URL] [| #barato]
/ofertas          # lista la cola pendiente
/oferta clear     # vacía la cola
/publicar         # procesa y envía la cola ahora mismo
```

## Tests

```bash
npm test
```
