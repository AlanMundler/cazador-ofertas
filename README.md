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
