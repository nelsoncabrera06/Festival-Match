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
server/db.js          # Pool pg serverless + schema init + todas las queries
server/auth.js        # Google OAuth + middlewares requireAuth/optionalAuth
server/festivals.json # 58 festivales, 36 con lineup  ← MIGRAR A DB (step 4)
public/               # app.js (3034 líneas), index.html, styles.css, i18n/
migrations/           # Schema, aplicado una vez. 001_init.sql YA CORRIÓ en Supabase
.github/workflows/    # keepalive.yml (cron diario contra Supabase) + docker-publish.yml (muerto, step 9)
festival_match_backup_20260505.dump  # Backup de Cloud SQL, ignorado por git. Datos viejos, opcional
README.md             # Inglés (default en GitHub) — es el que se ve primero
README_es.md          # Español, espejo de README.md
```

**Los dos README van en paralelo:** si tocás uno, tocá el otro. Están en inglés y español
a propósito (portfolio: el que llega a un recruiter es el inglés). Son cortos a propósito —
~75 líneas, escaneables de un pantallazo. No convertirlos en documentación técnica.

Números que aparecen en los README y hay que mantener al día si cambian: **58**
festivales, **648 artistas en lineups**, **3 regiones** (europe / usa / latam),
**3 idiomas** (es/en/fi), `npm start` en el **:8080**.

---

## ⚠️ Migración a Vercel + Supabase

**Estado: la app está VIVA con base de datos en producción.** Login con Google, registro,
sesiones, artistas, géneros, favoritos y el panel de admin funcionan contra Supabase.
Verificado el 26/09/2026 con la suite de "Cómo verificar un deploy" (12 rutas en 200) y
con el flujo de auth probado localmente contra la base real.

Hechos: pasos 1, 2, 3, 5, 7 y 8. Falta el 4 (`festivals.json` → tabla), el 6 (código muerto
de Spotify) y el 9 (limpieza de GCP/Docker).

### Por qué hay que hacerlo (contexto para sesiones futuras)

En Vercel el filesystem es **read-only e inmutable** y las instancias son **efímeras**.
Eso rompe 3 cosas del código actual. Nada más necesita cambiar.

### Pasos

- [x] **1. Supabase: proyecto + infra** — **HECHO 26/09/2026** (`c32d202`)
  Proyecto `festival-match`, ref `ujtkurimrtonnqeizucr`, región **us-east-2** (Ohio).
  `migrations/001_init.sql` aplicado: las 7 tablas, verificadas **columna por columna contra
  el dump de Cloud SQL** para que el restore de datos viejos no necesite transformaciones.
  El seed de los 58 festivales quedó fuera de esta migración: va en `002_festivals.sql` junto con
  el paso 4, para que el historial de migraciones cuente la historia.

  **Lo que hay que saber para tocar la conexión (las dos trampas, ver "Trampas"):**
  - Pooler **transaccional, puerto 6543**, host `aws-0-us-east-2.pooler.supabase.com`.
    El "Direct connection" (`db.<ref>.supabase.co`) es **IPv6-only en free tier**: no sirve.
  - La string **NO lleva `?sslmode=require`**, contra lo que dice la doc de Supabase.

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

- [x] **3. Pool de Postgres serverless** — **HECHO 26/09/2026** (`c32d202`)
  En `server/db.js`: `max: 1` (el pooler multiplexa), `connectionTimeoutMillis: 10000`,
  `idleTimeoutMillis: 10000`, `ssl: { rejectUnauthorized: false }` explícito, y
  `pool.on('error')`. **El handler de error no es opcional:** sin listener, un `'error'`
  del pool es un `throw` no capturado que **mata la instancia** de Vercel. Pasa de verdad
  con Supabase (corta conexiones ociosas, y el free tier pausa el proyecto).
  Los `setInterval` de cleanup (sesiones y tour cache) quedaron detrás de
  `if (require.main === module)`: en serverless no corren y son redundantes.
  Además `generateSessionId()` pasó de `Math.random()` a `crypto.randomBytes()`: los ids
  de sesión son credenciales bearer con 7 días de vida, no un string cualquiera.

- [ ] **4. `festivals.json` → tabla `festivals`** (~1.5 h) — **es un BUG, no solo limpieza**
  Los 4 endpoints que tocan el filesystem **están rotos en producción ahora mismo**:
  `PUT /api/admin/festivals/:id`, `DELETE /api/admin/festivals/:id` y el approve de
  `POST /api/admin/suggestions/:id/approve` hacen `fs.writeFileSync`, y en Vercel el
  filesystem es read-only → `EROFS` → 500 "Error al guardar".
  Reemplazar `getFestivals()` por una query, y crear `002_festivals.sql` con la tabla
  `festivals` + seed de las 58 filas desde `festivals.json`. La forma del objeto festival
  **no cambia** (`{ id, name, city, location, country, dates, website, image, flyer,
  flyerImages[], lineupStatus, lineup[], description, note }`), así que el matching no
  necesita refactor.
  El `setInterval` de cleanup ya se borró de `db.js` (ver paso 3).

- [x] **5. `initDatabase()` fuera del arranque** — **HECHO, pero por accidente y mejor así**
  No hubo que tocar nada: `initServices()` (y por lo tanto `initDatabase()`) solo corre
  dentro de `if (require.main === module)` en `app.js`, y en Vercel eso nunca es cierto.
  O sea que el schema en producción existe **únicamente** por `migrations/001_init.sql`.
  `initDatabase()` sigue existiendo y se usa en dev local.

  **Consecuencia que hay que tener presente:** como el seed de admin vivía adentro de
  `initDatabase()`, en producción nunca se iba a aplicar. La migración corrió con la base
  vacía (`UPDATE 0`) y el primer admin que se registró con Google quedó con `role = 'user'`,
  sin poder entrar al panel. **Arreglado en `findOrCreateUser()`** (`a13c62f`): el rol se
  resuelve en el INSERT contra `ADMIN_EMAILS`, así no depende de acordarse de un UPDATE.
  `ADMIN_EMAILS` también pasó a ser env var, con el valor original como fallback.

- [ ] **6. APIs externas muertas** (~20 min) — **parcial: worldtimeapi HECHO, falta Spotify**
  - **worldtimeapi.org: HECHO** (`c32d202`). `fetchCurrentYear()` borrado; `currentYear`
    quedó como `new Date().getFullYear()` a nivel de módulo.
  - **Bandsintown está muerta:** `rest.bandsintown.com` devuelve **403** (partner-only desde 2025).
    `/api/artist-events` siempre cae al fallback de búsqueda. La UI ya lo maneja, no rompe.
  - **Spotify: código muerto, borrar.** `/api/top-artists` y `/api/spotify/*` guardan los
    tokens en `spotifyTokenStore`, **un objeto en memoria**: en serverless cada instancia
    tiene el suyo, así que el callback redirige a una instancia y el request siguiente
    puede caer en otra que no conoce la sesión. Nunca funcionó en Vercel (funcionaba en GCP).
    El `redirect('/?session=' + sessionId)` además tiraría el id de sesión en la URL.

- [x] **7. Google OAuth** — **HECHO 26/09/2026**
  El proyecto de GCP viejo estaba **borrado** (lo eliminó para cortar costos), así que hubo
  que crear credenciales nuevas: proyecto `festival-match`, consent screen **External /
  In production**, redirect URI `https://festivalmatch.vercel.app/auth/google/callback`.
  Se eligió In production a propósito: en *Testing* un recruiter no puede ni entrar
  (le da "access blocked"). Se acepta el cartel de "app no verificada" y se documentó en
  el README el click *Advanced → Go to Festival Match*.
  Ojo: al crear el client, Google descarga un `client_secret_*.json` a la raíz del repo.
  Ya está en `.gitignore` (este repo es público).
  Verificado en producción: login con Google funcionando contra la base real.

- [x] **8. Pausa de Supabase a los 7 días** — **HECHO 26/09/2026** (`.github/workflows/keepalive.yml`)
  Es el fallo más silencioso del proyecto: no es que la app quede lenta, es que el primer
  visitante la ve **rota**. Para un portfolio es lo peor, porque el link que mandás en una
  postulación deja de abrir justo cuando alguien lo mira.
  Cron diario `SELECT 1` a las **11:17 UTC** (no a las 11:00: en la punta de la hora se
  acumulan todos los cron de GitHub y se retrasan). Falla con código ≠ 0 si la base no
  responde, y chequea `transaction_read_only` para distinguir "pausado" de "caído", así
  GitHub avisa por mail. Se probó a mano con *Run workflow* desde la pestaña Actions.
  **Pendiente: crear el secret `DATABASE_URL` en GitHub** (Settings → Secrets and
  variables → Actions). Sin eso el workflow no conecta. Ojo: es la misma string que en
  Vercel, **terminada en `/postgres` y sin `?sslmode=require`**.
  La alternativa con Vercel Cron quedó descartada: requiere el plan Pro ($25/mes).

- [ ] **9. Limpieza GCP/Docker**
  Borrar `Dockerfile` (raíz), `server/Dockerfile`, `public/Dockerfile` y `.github/workflows/docker-publish.yml`
  (publicaban imágenes a GHCR para GCP). O moverlos a una rama `archive/gcp`.

### Lo que NO hay que tocar

`public/` completo (app.js, index.html, styles.css, i18n), `auth.js`, toda la lógica de matching,
el panel admin (solo cambia la fuente de datos de los festivales), el sistema de sesiones en cookie.

---

## ⚠️ Trampas (costaron tiempo el 26/09/2026, no repetir)

### 1. `?sslmode=require` ROMPE la conexión con node-postgres 8.16

La doc de Supabase dice ponerlo. **Con `pg` 8.16.3 ese parámetro resuelve a
`ssl.rejectUnauthorized = true`**, y como la connection string se parsea **después** del
objeto de config, pisa el `ssl` del pool. Toda query falla con:

```
Error: self-signed certificate in certificate chain
```

Verificado con las 4 combinaciones: con `?sslmode=require` falla siempre (con o sin `ssl`
explícito en el código); sin el parámetro funciona. **La string no lleva el parámetro y el
TLS se configura en `server/db.js`.** Esto está documentado en el README también, porque es
el tipo de cosa que cualquiera va a intentar y se va a romper.

### 2. La cuál de las 3 connection strings de Supabase

| | Host | Sirve |
|---|---|---|
| **Pooler transaccional** | `aws-0-us-east-2.pooler.supabase.com:6543` | ✅ **esta** |
| Session pooler | mismo host, puerto 5432 | ✅ también sirve |
| Direct connection | `db.ujtkurimrtonnqeizucr.supabase.co:5432` | ❌ **IPv6-only en free tier** |

Regla para no equivocarse: **mirá el host**. Si dice `pooler.supabase.com` sirve; si dice
`db.`, no.

### 3. `pool.on('error')` no es opcional

Sin listener, un `'error'` del pool es un `throw` no capturado que **mata la instancia** de
Vercel. Con Supabase ocurre de verdad: el pooler corta conexiones ociosas y el free tier pausa
el proyecto.

### 4. Los secretos en el `.env` local y las copias duplicadas

El `.env` de la raíz tiene **varias líneas `DB_PASSWORD` comentadas** y solo una es la válida
(la de la sección `# Supabase`, con el project ref `ujtkurimrtonnqeizucr`).
Además, la `DATABASE_URL` de **Vercel es una copia independiente**: cambiarla en `.env` no la
cambia allá. Si divergen, el error es `password authentication failed` en prod con un `.env`
que parece correcto.

Al tocar la conexión, **probá siempre con `psql` antes de deployar.** La diferencia entre un
error de DNS/TLS y uno de auth es lo que dice si el problema es la string o la password.

### 5. `db.js` no carga `dotenv` por su cuenta

`require('dotenv').config()` está en `app.js` y en `server/server.js`, **no** en `db.js`.
Si probás `db.js` desde un script suelto, `DATABASE_URL` queda `undefined` y el pool cae al
fallback `postgresql://localhost/festival_match`. Cargá dotenv vos en el script de test.

### 6. `.gitignore` tenía dos problemas

- `*.sql` (de la época de los backups de base) **se comía `migrations/`**, dejando el schema
  sin versionar. Resuelto con `!migrations/*.sql`.
- El `client_secret_*.json` que descarga el Google Cloud Console **no estaba ignorado** y el
  repo es público. Resuelto.

### 7. El proyecto de GCP viejo estaba borrado

Lo eliminó para cortar costos, así que las credenciales de Google hubo que rehacerse desde
cero. Si algún día se borra un proyecto de GCP, asumí que **todas** sus credenciales
(client IDs, secrets, service accounts) mueren con él.

---

## Datos de la base vieja (opcional)

Hay un backup en la raíz: **`festival_match_backup_20260505.dump`** (22k, `pg_dump` custom
de Cloud SQL, 10/05/2026). Está en `.gitignore` (`*.dump`).

Contenido (contado desde los `setval` del propio dump):

| Tabla | Filas |
|---|---|
| `users` | 6 |
| `user_artists` | ~30 |
| `user_genres` | ~22 |
| `user_festivals` | ~16 |
| `festival_suggestions` | 6 |
| `sessions` | 0 |
| `tour_cache` | 0 |

**El schema del dump es idéntico al de `migrations/001_init.sql`** (verificado columna por
columna), así que el restore entra sin transformaciones.

Si algún día se importa:

- **Usar `pg_restore --data-only`**, nunca un restore completo. El DDL del dump tiene
  `CREATE DATABASE ... LOCALE_PROVIDER = libc` y `GRANT ... TO cloudsqlsuperuser`, que no
  existen en Supabase y hacen fallar el restore a mitad.
- **No importar `sessions` ni `tour_cache`** (vacías y/o basura).
- **El orden de restore puede chocar con los FKs**: en el dump las tablas salen
  alfabéticamente, o sea `users` al final, pero `user_artists` referencia a `users`. Si
  `pg_restore --data-only` se queja, hacer dos pasadas: `users` primero, después el resto.
- **Las secuencias ya vienen en el dump** (`SEQUENCE SET` con `setval`), así que no hay que
  arreglarlas a mano. Esto no es un problema con este backup, pero sí lo es con un
  `pg_dump --data-only` común.
- **Decisión tomada: importar `users` con `password_hash` en NULL.** No existe flujo de UI
  para que un usuario logueado se cree su propia contraseña: `/auth/register` rechaza emails
  existentes, `/auth/login` dice "Esta cuenta usa Google", y el único que puede poner una
  contraseña es el panel admin. Así que NULL es lo único limpio, y de paso no se arrastran
  hashes bcrypt de 2024 a un dominio público. **Conservar `google_id`**, que es lo que hace
  que esas personas recuperen sus artistas al entrar con Google.

---

## Flujo de trabajo con git (regla del usuario)

**`git add`, `git commit` y `git push` los hace Nelson, no el agente.** Preparar los cambios
y darle el comando exacto sí es parte del trabajo.

Está aplicado con `permissions` en `~/.config/opencode/opencode.jsonc` (`deny` en add, commit,
push, pull, reset, checkout, switch, rebase, merge, stash, restore; `allow` en status, diff,
log, show, blame; y `git *` cae en `ask`). Ojo: **la config se carga al arrancar la sesión**,
así que recién en la sesión siguiente empieza a aplicar.

AGENTS.md no sirve para esto: es instrucción que el agente lee pero nada la impone. La
`permissions` del harness sí bloquean la operación.

---

## Variables de entorno

`.env.example` sigue incompleto: **le faltan `DATABASE_URL`, `LASTFM_API_KEY` y
`ADMIN_EMAILS`**. Agregarlas al tocar esto.

| Var | Notas |
|---|---|
| `DATABASE_URL` | Del **pooler transaccional, puerto 6543**, **sin `?sslmode=require`** (ver Trampa 1) |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `GOOGLE_REDIRECT_URI` | Redirect URI apunta al dominio de Vercel. El `_SECRET` es el mismo en `.env` local y en Vercel |
| `LASTFM_API_KEY` | Falta en `.env.example`. Sin ella no funciona la importación desde Last.fm |
| `ADMIN_EMAILS` | Opcional, lista separada por comas. Sin la var, el fallback hardcodeado es `nelsoncabrera06@gmail.com` |
| `SPOTIFY_*` | Deshabilitado, se puede borrar junto con el código muerto de Spotify |

Nunca commitear `.env`. Ya está en `.gitignore`. El repo es **público**: auditar el historial
con `git log --all -p -S '<secreto>'` antes dedadeclarar que está limpio.

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
- **Estado al 26/09/2026:** la app **está viva con base de datos**. `DATABASE_URL` está en
  Vercel (pooler transaccional, sin `?sslmode=require`), Supabase tiene el schema aplicado,
  y el login con Google funciona contra la base real. Verificado con la suite de abajo y
  probando el flujo completo: registro, login, cookie de sesión, CRUD de artistas con el
  UNIQUE (409 en duplicado), géneros, favoritos, sugerencia con FK a `users`, matching contra
  lineups reales y búsqueda en MusicBrainz.
- **Env vars en Vercel:** `DATABASE_URL`, `LASTFM_API_KEY`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (las 3, en Production/Preview/Development).
- **Pendiente de configurar:** el secret `DATABASE_URL` en GitHub para el keepalive.
- Commits: `a13c62f` (keepalive + rol admin + READMEs) ← `c32d202` (migración Supabase,
  pool serverless, fixes de arranque) ← `e558f40` (READMEs) ← `c0d2699` (entrypoint).

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
