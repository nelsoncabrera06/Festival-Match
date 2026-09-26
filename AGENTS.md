# Festival Match — AGENTS.md

Instrucciones persistentes para cualquier sesión de AI (o persona) que trabaje en este repo.
**Actualizar el checklist de migración al avanzar.** Es la única fuente de verdad del estado del proyecto.

---

## Qué es el proyecto

App web que matchea el gusto musical de un usuario con flexibles europeos /riberyanos / latinoamericanos.
Cada usuario carga sus artistas (a mano, MusicBrainz o Last.fm) y la app calcula un `% match` contra el lineup de cada festival.

- **Autor:** Nelson Cabrera — objetivo actual: revivir el proyecto como pieza de portfolio.
- **Historia:** estuvo hosteado en Google Cloud Run + Cloud SQL (~2024-2026) y se dio de baja por costos.
  Ahora se migra a **Vercel + Supabase** con el objetivo de costo **$0/mes**.
- **Estado:** frontend y lógica completos. Abandonado desde mayo 2026. Última URL: `festival-match-580030276004.europe-north1.run.app` (caída).

---

## Stack (no cambiar)

- **Backend:** Node.js + Express 4 (CommonJS, sin transpilar), `pg`, `bcryptjs`, `google-auth-library`, `axios`
- **Frontend:** vanilla JS + CSS. **Cero build step, cero framework, cero bundler.**
- **i18n:** español / inglés / finlandés, archivos JSON en `public/i18n/`
- **DB:** PostgreSQL (hoy `pg` crudo + SQL en strings, sin ORM)

### Decisiones de arquitectura que ya están tomadas — NO re-litigar

- **El frontend usa rutas relativas** (`fetch('/api/...')`). Está bien y hay que mantenerlo:
  si el front y la API viven en el mismo dominio de Vercel, no hay CORS y las cookies funcionan sin tocar nada.
  **Nunca hardcodear un dominio en `public/`.**
- **La forma de los objetos festival no cambia** al mover los datos a la DB. `{ id, name, city, location, country, dates, website, image, flyer, flyerImages[], lineupStatus, lineup[], description, note }`
  Es la clave de que el matching no requiera refactor.
- **Supabase se usa como Postgres plano** vía `pg`, no el SDK de Supabase. El SQL actual sigue válido.
- **Vercel sirve `public/` como estático por CDN.** `express.static()` está ignorado por Vercel y se puede borrar.

---

## Estructura

```
app.js                # Entry point de Express para Vercel: crea la app y llama registerServer()
vercel.json           # Rewrite SPA: todo lo que no sea /api, /auth o /health -> /index.html
server/server.js      # Rutas API + auth + admin, dentro de registerServer(app) (1374 líneas)
server/db.js          # Pool pg + schema init + todas las queries (555 líneas)
server/auth.js        # Google OAuth + middlewares requireAuth/optionalAuth
server/festivals.json # 58 festivales, 36 con lineup  ← MIGRAR A DB (step 4)
public/               # app.js (3034 líneas), index.html, styles.css, i18n/
migrations/           # SQL de una sola vez  ← CREAR (step 5)
```

---

## ⚠️ Migración a Vercel + Supabase

**Estado:** el entrypoint de Express (step 2) ya está arreglado y verificado en producción.
Falta el paso 1 (Supabase): sin base no hay login ni favoritos. Actualizar las casillas al
avanzar cada paso.

### Por qué hay que hacerlo (contexto para sesiones futuras)

En Vercel el filesystem es **read-only e inmutable** y las instancias son **efímeras**.
Eso rompe 3 cosas del código actual. Nada más necesita cambiar.

### Pasos

- [ ] **1. Supabase: proyecto + infra** (~30 min)
  Crear proyecto free, sacar la **connection string del pooler (Supavisor, modo transaccional)**,
  correr `migrations/001_init.sql` con el schema actual de `initDatabase()` + seed de las 58 filas de `festivals.json`.

- [x] **2. Vercel: entry point** — **HECHO Y VERIFICADO EN PROD el 25/09/2026** (`c0d2699`)
  Después del push, `/api/demo/artists` pasó de 404 a 200 y las 10 rutas de la suite dan 200
  con JSON real. El frontend lo sigue sirviendo el CDN (`x-vercel-cache: HIT`), o sea que
  el rewrite de `vercel.json` sigue ganándole al catch-all de la función, como se esperaba.

  **Causa del deploy sin backend:** `app.js` no cumplía el contrato de entry de Express
  que exige Vercel. La doc ([Express on Vercel](https://vercel.com/docs/frameworks/backend/express))
  pide dos cosas: que el archivo **importe `express`** y que **exporte la app** (en CommonJS,
  `module.exports = app`) o use un port listener. El `app.js` viejo solo hacía
  `module.exports = require('./server/server')`: técnicamente exportaba una app de Express,
  pero no importaba `express` ni creaba ninguna app, así que la detección —que es estática—
  no lo reconocía y no armaba la función. Por eso `Framework Preset = Express` en el dashboard
  no alcanzó: el preset estaba bien, el entry no.

  **Lo que quedó (no revertir):**
  - `app.js` (raíz, 62 líneas) es el entry: `require('express')`, `const app = express()`,
    los middlewares globales (`cors`, `express.json`, `cookieParser`, `express.static`),
    `registerServer(app)` y `module.exports = app`. Ese es el patrón que la doc marca
    como "default export". Importado sin abrir puerto: verificado que `require('./app.js')`
    registra 42 rutas + 7 middlewares y **no** llama `listen`.
  - `server/server.js` exporta `{ registerServer, initServices, PORT }`. Las ~40 rutas
    viven dentro de `registerServer(app)`; ya no crea su propia app ni importa
    `express`/`cors`/`cookie-parser` (todo eso se mudó a `app.js`).
  - `initServices()` (ex `startServer()`) hace `initDatabase` + `fetchCurrentYear` + logs,
    ya **sin** el `listen`: el puerto lo abre `app.js` detrás de
    `if (require.main === module)`, y se llama después de escuchar para que un fallo de DB
    no tumbe el arranque.
  - `npm start` / `npm run dev` → `node app.js` (antes `node server/server.js`).
  - El catch-all `app.get('*')` ahora pasa callback a `res.sendFile`: en Vercel
    `express.static()` se ignora y `public/` no viaja en el bundle, así que si una ruta de
    la SPA llegara a la función devuelve 404 con un log claro en vez de un 500 opaco.
  - `vercel.json` (sin cambios, verificado en prod): rewritea todo lo que no sea `/api`,
    `/auth` o `/health` a `/index.html` para los deep links de la SPA (History API, no hash).
  - `festivals.json` vía `require` y no `fs.readFileSync`, para que el bundler lo rastree.
  - Error handler final al cierre de `registerServer` (Express 4 no captura rechazos async).
  - Cache de tour dates tolerante a fallos de DB, para que el modo demo funcione sin base.

  **Verificado localmente** (suite completa en "Cómo verificar un deploy"): las 11 rutas
  dan 200, los deep links devuelven el HTML de la SPA, los 404 de `/api/*` son JSON, y sin
  `DATABASE_URL` el server levanta igual (demo + MusicBrainz funcionan).

  **Lo único que no se puede verificar sin deployar:** que la detección de Vercel acepte
  el entry. ~~Si `/api/demo/artists` sigue dando 404 con `x-vercel-error: NOT_FOUND`:~~
  ~~ya no aplica: el 25/09/2026 aceptó el entry y la función está andando.~~ Si algún día
  vuelve a pasar, el orden de abajo es el que funcionó:
  - Dashboard → Project → Settings → General → **Framework Preset = Express**
    (ya se hizo una vez y no alcanzó *porque el entry no cumplía el contrato*; ahora sí).
  - Build logs: Vercel reporta el framework que detectó.
  - Alternativa si sigue sin detectarse: `"framework": "express"` explícito en `vercel.json`.

- [ ] **3. Pool de Postgres serverless** (~15 min)
  Usar la URL del **pooler**, no la conexión directa. `max: 1` por instancia, `sslmode=require`,
  y `pool.on('error')` para que un drop de conexión no deje la instancia en estado indefinido.

- [ ] **4. `festivals.json` → tabla `festivals`** (~1.5 h)
  Reemplazar `getFestivals()` por una query. Reescribir los 4 endpoints que tocan el filesystem:
  `GET /api/admin/festivals`, `PUT /api/admin/festivals/:id`, `DELETE /api/admin/festivals/:id`
  y el approve de `POST /api/admin/suggestions/:id/approve` (que hoy hace `fs.writeFileSync`).
  Borrar el `setInterval` de cleanup (líneas 510-513 de `db.js`): en serverless no corren y
  además son redundantes (`tour_cache` se invalida por timestamp al leer, las sesiones por `expires_at > NOW()`).

- [ ] **5. `initDatabase()` fuera del arranque** (~10 min)
  En Vercel correría en cada cold start. Dejarlo solo para dev local; el schema pasa a ser una migración de una vez.

- [ ] **6. APIs externas muertas** (~20 min)
  - **Bandsintown está muerta:** `rest.bandsintown.com` devuelve **403** (API partner-only desde 2025).
    `/api/artist-events` siempre cae al fallback. La UI ya tiene fallback a búsqueda de Google, así que no rompe.
  - **worldtimeapi.org no responde.** `currentYear` puede ser `new Date().getFullYear()`; borrar `fetchCurrentYear()`.

- [ ] **7. Google OAuth** (~10 min)
  Credenciales nuevas con el dominio de Vercel + actualizar `GOOGLE_REDIRECT_URI`.
  El consent screen va a mostrar "app no verificada" (se acepta el warning, o se pide verificación).

- [ ] **8. Supabase Free pausa el proyecto a los 7 días sin actividad** (~10 min)
  Si nadie entra a la app por una semana, Supabase **pausa** la base y el primer visitante ve la app
  rota, no lenta. Resolver con un **GitHub Actions cron** diario que haga un `SELECT 1` a la DB
  (gratis). Alternativa: Vercel Cron diario contra un endpoint `/api/heartbeat`. Pro = $25/mes, fuera de presupuesto.

- [ ] **9. Limpieza GCP/Docker**
  Borrar `Dockerfile` (raíz), `server/Dockerfile`, `public/Dockerfile` y `.github/workflows/docker-publish.yml`
  (publicaban imágenes a GHCR para GCP). O moverlos a una rama `archive/gcp`.

### Lo que NO hay que tocar

`public/` completo (app.js, index.html, styles.css, i18n), `auth.js`, toda la lógica de matching,
el panel admin (solo cambia la fuente de datos de los festivales), el sistema de sesiones en cookie.

---

## Variables de entorno

`.env.example` está incompleto: **le faltan `DATABASE_URL` y `LASTFM_API_KEY`**. Agregarlas al tocar esto.

| Var | Notas |
|---|---|
| `DATABASE_URL` | **Del pooler de Supabase**, con `?sslmode=require`. Es la que falta. |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `GOOGLE_REDIRECT_URI` | Redirect URI apunta al dominio de Vercel |
| `LASTFM_API_KEY` | Falta en `.env.example` |
| `SPOTIFY_*` | Deshabilitado, se puede borrar junto con el código muerto de Spotify |
| `ADMIN_EMAILS` | Hoy hardcodeado en `db.js:12` → mover a env var |

Nunca commitear `.env`. Ya está en `.gitignore`.

---

## Comandos

```bash
npm run dev     # node --watch app.js, en :8080
npm start       # node app.js
vercel dev      # para replicar el entorno de Vercel antes de deployar
```

`app.js` es el entry de Express **y** el script de arranque. `server/server.js` ya no se
ejecuta directo: exporta `registerServer` / `initServices` / `PORT` y no abre ningún puerto.

## Deploy

- **URL en producción:** https://festivalmatch.vercel.app/
- Deploy desde el **dashboard de Vercel** importando el repo de GitHub. El usuario **no puede
  usar el CLI de Vercel** (escribe a ciegas), así que no intentar eso como sugerencia.
- **Estado al 25/09/2026:** la app **tiene backend funcionando en producción**. El commit
  `c0d2699` arregló el entrypoint de Express y `/api/demo/artists` pasó de 404 a 200.
  Lo que no anda todavía es lo que necesita base: sin `DATABASE_URL` no hay login, registro,
  favoritos ni preferencias (el resto, incluido el modo demo, responde normal).
  Siguiente paso del plan: el 1 (Supabase).
- Commits: `c0d2699` (entrypoint de Express) ← `54b5dcd "I will host this in Vercel"`.

### Cómo verificar un deploy (corré esto, no asumas)

```bash
B=https://festivalmatch.vercel.app
# 1. ¿Hay función de backend? Tiene que dar 200. Si da 404, no hay backend.
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/demo/artists"
# 2. Si lo anterior da 200, chequeá el resto:
for p in "/" "/festivals" "/i18n/es.json" "/health" "/api/current-year" "/api/genres" \
         "/api/demo/festivals?region=europe" "/api/artist-events/Coldplay" "/auth/me"; do
  printf "%-38s -> %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$B$p" --max-time 20)"
done
```

Distinguir el 404 de Vercel del 404 de la app (importante, se confunden fácil):

```bash
curl -s -D - -o /dev/null "$B/api/demo/artists" | grep -i "x-vercel-error\|content-type"
```

- `x-vercel-error: NOT_FOUND` + `content-type: text/plain` → **no hay función**, el routing
  de Vercel no encontró handler. Es el síntoma del problema de detección de Express.
- `content-type: application/json` → la función **sí** está corriendo y es la app la que 404.

Ojo con un detalle del sitio estático viejo: el rewrite de `vercel.json` hace que
`/cualquier/cosa` (incluso `/server/db.js` o `/package.json`) devuelva **200 con el HTML de
`index.html`**. Por eso un 200 en una ruta rara no prueba nada: mirá el `content-type`.

**Si el frontend se rompe después del deploy** (la función existe pero `/` da error), lo más
probable es que una ruta de la SPA esté llegando a la función en vez de al CDN. En los logs
aparece `Catch-all: no se pudo servir public/index.html`. Es el orden de routing de Vercel
(filesystem → rewrite → función): si el rewrite de `vercel.json` no está, se arregla
poniéndolo de vuelta, no tocando Express.

**Sin `DATABASE_URL` la app levanta igual.** `initDatabase()` falla y se captura, el
server sigue andando, y solo se cae lo que necesita DB: login, registro, favoritos y
preferencias. Todo lo demás responde normal, incluido el modo demo
(`/api/demo/artists`, `/api/demo/festivals`) y la búsqueda de artistas en MusicBrainz.
El cache de tour dates quedó tolerante a fallos de DB (un cache miss no rompe el request).
Los endpoints `/api/admin/*` requieren sesión, así que sin DB devuelven 401 y no llegan a tocar la base.

---

## Convenciones

- Español en comentarios, nombres de variables y mensajes de error hacia el usuario (es un producto en español).
- Las queries van en `db.js` como SQL en strings con parámetros `$1, $2`. **Siempre parametrizadas**, nunca interpoladas.
- Rutas de API en `/api/*`, auth en `/auth/*`. Si agregás una ruta, va **dentro de
  `registerServer(app)`** en `server/server.js` (el catch-all `app.get('*')` está al final
  de esa función, ~línea 1307). Ninguna ruta se registra a nivel de módulo.
- `public/i18n/{es,en,fi}.json`: toda string nueva de UI va en los 3 idiomas.
- Comentá los cambios de arquitectura acá arriba y en el código, con el **por qué** — el objetivo es que el proyecto se lea bien en un portfolio.
