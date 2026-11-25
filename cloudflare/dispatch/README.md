# Dispatcher en Cloudflare Workers

GitHub Actions ejecuta el cron `*/30` de forma best-effort: en la práctica corrió cada 6–11 h
(runs 45552354494, 45503142568, 45389896232…). Este Worker dispara el workflow **cada 30 minutos**
con un Cron Trigger de Cloudflare, que sí es puntual.

## Puesta en marcha (una sola vez)

1. Crear un token de GitHub (fine-grained) con permiso **Actions: write** sobre el repo.
2. Desplegar:

```bash
cd cloudflare/dispatch
npx wrangler login
npx wrangler secret put GITHUB_TOKEN      # pegar el token
npx wrangler deploy
```

3. Verificar:

```bash
curl https://cazador-dispatch.<tu-subdominio>.workers.dev   # dispara y devuelve JSON
npx wrangler tail                                          # logs del cron
```

## Variables

Se editan en `wrangler.toml` (`[vars]`): `GITHUB_REPO`, `WORKFLOW_FILE`, `GITHUB_REF`.
El token va siempre como secret, nunca en el repo.

## Notas

- Si el workflow ya está corriendo, GitHub encola o ignora según `concurrency` (single-writer).
- El cron propio del workflow queda como respaldo si el Worker falla.
- Costo: Workers free tier incluye 100k requests/día; esto usa 48/día.
