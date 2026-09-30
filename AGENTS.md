# Festival Match — AGENTS.md

Instrucciones persistentes para cualquier sesión de AI (o persona) que trabaje en este repo.
**Actualizar el checklist de migración al avanzar.** Es la única fuente de verdad del estado del proyecto.

---

## 🔴 RETOMAR ACÁ — 30/09/2026, sesión 5

**El paso 4 está CERRADO.** Seed aplicado, commiteado, pusheado, deployado, y el panel admin
funcionando en producción (edit de lineup, borrado y aprobación de sugerencia probados a mano).

**Estado del working tree:** limpio al retomar esta sesión.

**El paso 4 hizo esto:** `festivals.json` → tabla `festivals`. Los 4 endpoints del panel admin
dejaron de hacer `fs.writeFileSync` (que en Vercel daba `EROFS` → 500). Se generó
`002_festivals.sql` con un script, se escribieron 5 queries en `db.js`, y se migraron los 4
callers del catálogo en `server.js`. **El matching no necesitó refactor**: `rowToFestival()`
devuelve un objeto deep-equal al del JSON, verificado.

### Estado de producción (29/09/2026)

Un solo usuario (vos, `role = admin,dev`, cuenta de Google con `password_hash` NULL), 1
artista, 1 sesión viva hasta el 03/10. Las 8 rutas de la suite de deploy en 200.

### El keepalive (paso 8) YA ESTÁ CONFIGURADO

El secret `DATABASE_URL` ya existe en GitHub (Settings → Secrets and variables → Actions) y
el workflow corre bien: *"Base de datos activa y con escritura habilitada"*, verificado el
29/09/2026. **No hay nada pendiente acá.** La base no se va a pausar.

El refresh del catálogo a 2027 está aplicado en Supabase: no se borró ningún festival; los
lineups 2026 se limpiaron para no mostrarlos como actuales, y los carteles/fechas 2027 se
cargaron solo con anuncios oficiales confirmados. Ver paso 11.

El demo user (4b) está terminado. El paso **6** (Spotify) queda en pausa: la integración
está preparada en el código, pero Spotify no permite crear la app desde el Dashboard (error
genérico incluso en otro navegador). Retomar cuando Spotify lo resuelva. El paso **9** (GCP/Docker) queda pospuesto: Docker forma parte del caso
práctico de Terraform en `Festival-Match-infra`. **No borrar Dockerfiles ni
`.github/workflows/docker-publish.yml`.** Antes de tocar cualquier otro resto de GCP, mostrar
el inventario y acordar el alcance.

### Estado de tareas siguientes

El 30/09/2026 se preparó el refresh del catálogo para las temporadas 2026 y 2027 (paso 11). El
JSON conserva los 58 festivales; ediciones ya pasadas quedaron para 2027 o por anunciar, y se
preservaron AMF, Austin City Limits y Corona Capital con sus fechas/carteles de fin de 2026.
Se cargaron seis carteles parciales 2027. El seed inicial con 34 entradas se aplicó a Supabase
el 30/09/2026; luego se regeneró y reaplicó con 120 entradas al restaurar los festivales de fin
de año. También se quitó el año del título visible y del nombre de la pestaña. El calendario ahora abre
en el mes siguiente al mes local del navegador. Fuentes oficiales consultadas: [Primavera Sound](https://www.primaverasound.com/en/barcelona/tickets-barcelona), [Rock am Ring](https://www.rock-am-ring.com/en/info), [Rock im Park](https://www.rock-im-park.com/en/info), [Sziget](https://szigetfestival.com/en/festival-info), [Roskilde](https://www.roskilde-festival.dk/nyheder/tak-for-i-aar-vi-ses-i-2027), [Flow](https://www.flowfestival.com/en/program/music/), [Rock Werchter](https://www.rockwerchter.be/en/about-rock-werchter), [Tuska](https://tuska.fi/info/info/), [Provinssi](https://www.provinssi.fi/en/), [Ilosaarirock](https://ilosaarirock.fi/), [Lollapalooza Argentina](https://www.lollapaloozaar.com/informacion), [Lollapalooza Chile](https://sitiospublicos.bancochile.cl/bch-stage/cartelera/detalle/lollapalooza-chile-2027), [NOS Alive](https://nosalive.com/en/festival/tame-impala-2/), [EDC Las Vegas](https://www.edc.com/), [Ultra Worldwide](https://umfworldwide.com/ww/).

`Cosquín Rock` se identificó como posible incorporación regional (6–7 febrero 2027, [FAQ oficial](https://cosquinrock.net/preguntas-frecuentes/)), pero no se agregó al catálogo porque esta actualización solo cubre festivales existentes.

El demo user (4b) ya está en Supabase y probado por Nelson. La migración **004** para RLS y
revocar permisos Data API se ejecutó correctamente en Supabase (29/09/2026); Security
Advisor quedó en 0 errores y muestra 8 sugerencias informativas de “RLS enabled, no policy”,
esperadas porque ninguna tabla de la app se expone por la Data API. La conexión directa con
Spotify queda pausada por un fallo del Developer Dashboard; Last.fm ya está integrada y
probada. La migración **005** de conexiones Spotify también fue aplicada manualmente en
Supabase, aunque la conexión no se puede completar hasta crear una app de Spotify. Docker
se conserva.

En esta sesión se agregó un buscador de festivales a `/festivals`, con filtros por nombre,
ciudad, ubicación y país, compatible con grilla/lista/calendario e idiomas es/en/fi. Nelson
lo probó en producción y confirmó que funciona; quiere pulir el diseño más adelante.
También se quitó `prompt: 'consent'` del OAuth de Google: Nelson confirmó que ahora el login
va más directo. Si se necesita probar localmente Google OAuth, agregar
`http://localhost:8080/auth/google/callback` a las URI autorizadas de Google y usarlo en
`GOOGLE_REDIRECT_URI` del `.env`.

El perfil demo tiene **20 artistas en DB**. `public/app.js` también mantiene una lista de
nombres para la sección de fechas de gira. `npm start` local sigue conectando a
**producción**: toda operación de escritura desde local afecta Supabase.

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
server/server.js      # Rutas API + auth + admin, dentro de registerServer(app)
server/db.js          # Pool pg serverless + schema init + todas las queries
server/auth.js        # Google OAuth + middlewares requireAuth/optionalAuth
server/festivals.json # 58 festivales, 36 con lineup. YA NO SE LEE EN RUNTIME: es la
                      # fuente editable del seed que genera scripts/ (step 4)
public/               # app.js (3034 líneas), index.html, styles.css, i18n/
scripts/              # generate-festivals-migration.js (genera 002_festivals.sql)
migrations/           # Schema versionado. 001_init.sql, 002_festivals.sql y
                      # 003_demo_user.sql, 004_secure_public_tables.sql y 005 aplicados.
.github/workflows/    # keepalive.yml (cron Supabase) + docker-publish.yml (GHCR para Terraform)
migrations/festival_match_backup_20260505.dump  # Backup de Cloud SQL (20260505). Ignorado por
                      # git vía `*.dump`. Datos viejos de 2026, opcional. NO confundir con
                      # los .sql de al lado: esos SÍ están versionados (ver Trampa 6)
README.md             # Inglés (default en GitHub) — es el que se ve primero
README_es.md          # Español, espejo de README.md
```

**Los dos README van en paralelo:** si tocás uno, tocá el otro. Están en inglés y español
a propósito (portfolio: el que llega a un recruiter es el inglés). Son cortos a propósito —
~75 líneas, escaneables de un pantallazo. No convertirlos en documentación técnica.

Números que aparecen en los README y hay que mantener al día si cambian: **58**
festivales, **120 entradas de artistas anunciados en lineups 2026/2027**, **3 regiones** (europe / usa / latam),
**3 idiomas** (es/en/fi), `npm start` en el **:8080**.

---

## ⚠️ Migración a Vercel + Supabase

**Estado: la app está VIVA con base de datos en producción.** Login con Google, registro,
sesiones, artistas, géneros, favoritos y el panel de admin funcionan contra Supabase.
Verificado el 26/09/2026 con la suite de "Cómo verificar un deploy" (12 rutas en 200) y
con el flujo de auth probado localmente contra la base real.

Hechos: pasos 1, 2, 3, 4, 5, 7 y 8, y 4b (demo read-only). El paso 6 está parcialmente
implementado y pausado por Spotify; el paso 9 queda pospuesto. El 10 (RLS) también está
completo. El 4 está **completo y con el seed aplicado en Supabase**.

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
  - ~~`festivals.json` vía `require` y no `fs.readFileSync`, para que el bundler lo rastree.~~
    **Reemplazado el 29/09/2026 por el paso 4**: el catálogo vive en la tabla `festivals`.
    Este require ya no está; el seed lo genera `scripts/generate-festivals-migration.js`.
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

- [x] **4. `festivals.json` → tabla `festivals`** — **CERRADO 29/09/2026** (commiteado, pusheado, seed aplicado, admin probado a mano en producción)
  Arregla el bug: los 4 endpoints que tocaban el filesystem dejaron de hacerlo. En Vercel
  `fs.writeFileSync` daba `EROFS` → 500 "Error al guardar".

  **Lo que quedó:**
  - `migrations/002_festivals.sql` — tabla `festivals` + seed de las 58 filas.
    **GENERADO** por `scripts/generate-festivals-migration.js` desde `server/festivals.json`.
    Editar el `.sql` a mano se pierde en la próxima regeneración; para cambiar un lineup se
    edita el JSON, se regenera y se aplica con psql. Tiene `--check` para verificar que esté
    al día (usable en CI o antes de un deploy).
  - `db.js`: `getFestivals` / `getFestivalById` / `createFestival` / `updateFestival` /
    `deleteFestival`, más `rowToFestival()` que mapea la fila a **exactamente** el objeto que
    tenía en el JSON. `initDatabase()` también crea la tabla, así que el dev local levanta
    con el schema listo (el seed no: eso va con psql, como `001_init.sql`).
  - `server.js`: los 4 callers de `getFestivals()` ahora usan `await db.getFestivals()`.
    **Ojo, son 4 y no 3**: el cuarto es `findArtistInFestivals()`, que usa
    `/api/artist-events/:artistName` y era fácil no ver. Le cambié la firma para que reciba
    el catálogo ya cargado en vez de hacer una segunda query con un pool de `max: 1`.
    **Ese cuarto endpoint no tenía try/catch**, y como el catálogo ahora es una query, un
    fallo de base le daba un 500. Se degrada a `festivalAppearances: []` con un `console.warn`,
    igual que el NIVEL 2 ya hacía con su cache. Recordar esto al tocar cualquier endpoint que
    ahora lea de la DB: las queries nuevas pueden fallar y el try/catch tiene que existir.

  **Lo que se gana:** una sola fuente de verdad. Antes `getFestivals()` devolvía el array del
  `require()` mientras `GET /api/admin/festivals` releía el archivo, así que una edición se
  veía en el panel y no en el matching hasta reiniciar. Eso desapareció por construcción.

  **Lo que se pierde:** editar el catálogo editando un archivo ya no cambia la app. Hace
  falta regenerar el seed y aplicarlo. Es el costo de que el admin pueda escribir.

  **Decisiones de schema, y por qué:**
  - `id TEXT PRIMARY KEY`, no `SERIAL`: el id es un slug legible que ya se usaba, sale en
    las URLs del frontend y es la referencia de `user_festivals.festival_id`.
  - `lineup` / `flyer_images` como `TEXT[]`, no `jsonb`: son listas de strings planos, y el
    matching los recibe como array de JS sin parsear nada.
  - **Sin columna `region`**: se deriva de `country` con `REGIONS[region].countryCodes`.
    Con columna habría dos definiciones de región peleándose.
  - `sort_order INTEGER NOT NULL`: preserva el orden curado del JSON (los festivals gemelos
    están juntos, y el orden es del autor). `ORDER BY sort_order` devuelve el mismo orden.
  - `CHECK (lineup_status IN ('confirmed','partial','unannounced','hiatus'))`: lo escribe el
    admin desde un select. Sin el CHECK entraría garbage y el frontend caería en silencio al
    default `unannounced`.
  - `updateFestival` usa un **whitelist** (`UPDATABLE_FESTIVAL_FIELDS`) armado en el
    mismo archivo que la query, no `SELECT *` ni "lo que venga en el body". `id` y
    `sort_order` quedan fuera a propósito.

  **Cómo verificar (29/09/2026):** los tests quedaron en el repo y **no necesitan base de
  datos**: interceptan el módulo `pg` y simulan lo que Postgres respondería.
  ```bash
  npm run test:festivals          # los dos tests
  npm run seed:festivals:check    # el .sql está al día con el JSON
  ```
  - `scripts/verify-festivals-roundtrip.js` — **deep-equal de los 58 objetos** DB contra el
    JSON. Es lo que garantiza que el matching no cambia: mismas claves, mismos valores. Las
    claves opcionales se **omiten** en vez de volver `undefined`, así que ni siquiera
    aparecen en `Object.keys()`. También checkea invariantes: `lineup` siempre array,
    `lineupStatus` siempre uno de los 4, orden preservado.
  - `scripts/verify-festivals-queries.js` — que ningún valor de usuario quede interpolado en
    el SQL (usa valores marcador que no pueden aparecer por casualidad), que la cantidad de
    `$N` coincida con los parámetros, que las columnas del `SET` salgan del whitelist, y que
    `id`/`sort_order` no sean escribibles.
  - El seed en sí se verificó parseando el `.sql`: 58 filas × 15 valores, 648 artistas,
    3 `image` NULL, 55 `flyer` NULL, 2 `hiatus`, `sort_order` 1..58, apostrophes escapados
    (`Open''er`, `Parque O''Higgins`).
  - **Y después contra la base real**: seed aplicado con `psql` (ver "Seed APLICADO" arriba),
    los 6 números verificados con `SELECT` directo contra Supabase.

  ### ⚠️ `psql` en esta máquina: existe, pero NO está en el PATH

  Costó media sesión de la sesión 1. **`libpq` 18.6 ya estaba instalada** (del 11/08), pero
  Homebrew la instala como *keg-only* (no la linkea en `/opt/homebrew`) porque conflictúa
  con `postgresql`. Por eso `which psql` no da nada y `brew info libpq` dice "Installed":
  **es el chequeo que hay que hacer antes de concluir que falta.**

  ```bash
  ls /opt/homebrew/opt/libpq/bin/psql        # el binario, aunque which no lo encuentre
  brew info libpq                            # "Installed (on request)"?
  ```

  El 29/09/2026 se agregó al final de `~/.zshrc` (con backup en `~/.zshrc.bak`):
  ```bash
  export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
  ```
  Si en algún momento `psql` vuelve a faltar del PATH, es que esa línea se perdió: repetir
  esto. **No hace falta `brew install` ni Docker.** Docker no se usa para nada en este
  proyecto, y en una máquina de 8 GB es una carga que no vale la pena.

  ### ⚠️ El `.env` local apunta a PRODUCCIÓN

  `app.js:23` hace `dotenv.config()`, así que **`npm start` local se conecta a la Supabase de
  producción**, no a un Postgres local. Y como `initServices()` → `initDatabase()` corre
  dentro de `if (require.main === module)`, al levantar el server local **se crean tablas en
  producción** (el `CREATE TABLE IF NOT EXISTS` de `initDatabase()`). Fue exactamente así
  como la tabla `festivals` apareció vacía en Supabase.

  Para probar contra otra base hay que **exportar** `DATABASE_URL`, no hacer
  `env -u DATABASE_URL` (dotenv no pisa variables ya seteadas, pero sí llena las que faltan).

  El orden del deploy fue obligatorio y por un motivo concreto: con la tabla vacía,
  `/api/demo/festivals` devuelve **200 con lista vacía**, no un error. Si se hubiera
  deployado el código sin sembrar primero, la app habría mostrado 0 festivales en
  producción sin decir nada — el peor tipo de falla para un portfolio: silenciosa.
  **Resuelto: el seed ya está aplicado, el orden se respetó.** La lección, para que no se
  repita: **`initDatabase()` no es inocuo contra la base real.**

- [x] **4b. Usuario demo read-only en la DB** — **HECHO** (29/09/2026)
  Goal: que `/api/demo/*` deje de servir un array hardcodeado y lea de un usuario real de la
  DB, para que el demo no se desincronice del matching ni de los artistas reales.

  **Decisiones de Nelson (29/09/2026):** el demo entra al hacer click, sin iniciar sesión;
  el usuario de DB es una cuenta técnica sin contraseña ni acceso OAuth. El perfil es
  compartido y de solo lectura para visitantes. Nelson cargará a mano algunos artistas
  favoritos y festivales favoritos en DB una vez creada la cuenta.

  **Implementado, migración aplicada por Nelson y demo probado:**
  - `migrations/003_demo_user.sql` crea `demo@festival-match.invalid` sin credenciales y
    siembra los 20 artistas actuales. `user_artists.image` queda disponible para cargar
    imágenes. La migración no agrega favoritos; se cargarán manualmente después.
  - `db.getDemoProfile()` busca esa cuenta y devuelve artistas y favoritos.
  - `/api/demo/artists` y `/api/demo/festivals` leen el perfil de DB. Los festivales marcan
    `isFavorite` desde `user_festivals`.
  - Las rutas de escritura existentes requieren sesión; las rutas demo son solo GET.
  - `public/app.js` registra los listeners antes de esperar `/auth/me` y ahora muestra el
    error que devuelve la API si la configuración DB del demo todavía falta.
  - El menú superior también aparece en modo demo como “Demo user”; el logout del demo
    vuelve a inicio sin llamar a `/auth/logout` ni afectar sesiones reales.
  - El badge “Modo Demo - Artistas de ejemplo” ya tiene traducciones es/en/fi y se actualiza
    al cambiar el idioma mientras el demo está abierto.
  - Las imágenes y los festivales favoritos se pueden ajustar manualmente en DB cuando
    Nelson quiera curar el perfil; esto no bloquea el funcionamiento del demo.

  **Investigación previa del 29/09/2026:**

  **Cómo funciona hoy el demo (verificado en el código):**
  - `server/server.js:1043` — `demoArtists`, un array de **20** artistas (no 22, como decía
    antes este doc) con `{ name, image, genres }`. Las `image` son URLs de CDN de Spotify.
  - `server/server.js:1066` — `/api/demo/artists` devuelve el array tal cual, sin tocar la DB.
  - `server/server.js:1070` — `/api/demo/festivals` lee los festivales de la región desde
    `db.getFestivals()`, calcula el match con `normalizeString()` sobre los nombres del array,
    y devuelve `isFavorite: false` hardcodeado.
  - `public/app.js:1316` — `startDemo()` setea `isDemo = true` y hace `fetch` de los dos
    endpoints en paralelo. `renderUserArtists()` (línea 1811) muestra un badge "Modo Demo".
    **Los endpoints devuelven `isDemo: true` y el frontend se apoya en eso para pintar el
    badge y para decidir si manda `credentials: 'include'` (línea 1801).**
  - O sea: el frontend ya está preparado para el modo demo. **No hace falta tocar `public/`**
    salvo que se quiera cambiar el texto del badge.

  **El bloqueo de diseño, ya resuelto por decisión:**
  - **Read-only, con reset por sesión DESCARTADO**: con N visitantes compartiendo un `user_id`,
    el que entra borra los artistas del que está mirando. En un portfolio dos personas a la
    vez es el caso normal. O sea que el usuario demo **se comparte y nunca se escribe**.

  **Schema:**
  - `user_artists` **no tiene columna `image`** (`migrations/001_init.sql:46`), y el demo
    actual muestra fotos de Spotify. Hay que agregar `image TEXT` nullable → migración
    `003_demo_user.sql`.
  - `user_artists` tampoco tiene géneros: viven en `user_genres (user_id, genre)`. Si el demo
    tiene que seguir mostrando los `genres` del array, hay que sembrarlos también.
  - Los 20 artistas del array se siembran con un `INSERT` del `user_id` del demo, con
    `image` y con sus géneros. **Comparar contra `server/festivals.json`**: ese archivo
    ya es la fuente del seed y `scripts/generate-festivals-migration.js` es el patrón a
    seguir para generar la migración en vez de escribir el SQL a mano.

  **Verificación:** `npm run test:festivals` y la suite de deploy (abajo) tienen que seguir
  dando lo mismo. Y probar el demo a mano, que es el único path que no usa sesión.

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

- [ ] **6. APIs externas** — **Spotify pausado; Last.fm funciona** (29/09/2026)
  - **worldtimeapi.org: HECHO** (`c32d202`). `fetchCurrentYear()` borrado; `currentYear`
    quedó como `new Date().getFullYear()` a nivel de módulo.
  - **Bandsintown está muerta:** `rest.bandsintown.com` devuelve **403** (partner-only desde 2025).
    `/api/artist-events` siempre cae al fallback de búsqueda. La UI ya lo maneja, no rompe.
  - **Spotify:** OAuth y UI reescritos para Vercel. La nueva tabla de tokens es
    `spotify_connections` (migración 005); los refresh tokens se cifran con AES-256-GCM.
    Usa `SPOTIFY_REDIRECT_URI` y `SPOTIFY_TOKEN_ENCRYPTION_KEY`; ver `.env.example`.
    Rutas bajo `/auth/spotify/*` y `/api/spotify/*`, protegidas por la sesión de Festival
    Match. Nelson ya aplicó `005_spotify_connections.sql` en Supabase. La app de Spotify no
    se pudo crear: el Dashboard muestra errores genéricos al guardar y al cargar la página,
    incluso desde otro navegador. Por eso siguen pendientes las credenciales, las env vars
    de Vercel, la allowlist y la prueba end-to-end. No seguir investigando ahora; retomar
    cuando el Dashboard permita crear la app. Last.fm ya está integrada y Nelson confirmó
    que funciona. Spotify queda cerrado por ahora; no investigar hasta que Nelson lo retome.

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
  **Secret `DATABASE_URL` en GitHub: YA CREADO y verificado** (29/09/2026). Corriendo el
  workflow a mano responde *"Base de datos activa y con escritura habilitada"*. Ojo si se
  regenera alguna vez: tiene que ser la misma string que en Vercel, **terminada en `/postgres`
  y sin `?sslmode=require`**.
  La alternativa con Vercel Cron quedó descartada: requiere el plan Pro ($25/mes).

- [ ] **9. Restos de GCP / Docker** — **NO BORRAR Docker (decisión de Nelson, 29/09/2026)**
  Docker es parte del proyecto relacionado `Festival-Match-infra`, usado para aprender
  Terraform y desplegar esta app. Conservar los 3 Dockerfiles y
  `.github/workflows/docker-publish.yml` (publica las imágenes a GHCR que puede consumir
  esa infraestructura). Inventario actual de referencias GCP en este repo:
  En `server/server.js` ya se quitaron los dos comentarios obsoletos: el que atribuía el
  puerto 8080 a Google Cloud y la etiqueta de Cloud Run en `/health` (29/09/2026). La ruta
  sigue siendo útil para verificar la app. `migrations/001_init.sql` y este archivo mencionan
  GCP/Cloud SQL como contexto histórico; `package-lock.json` trae `gcp-metadata` como
  dependencia transitiva de `google-auth-library`. No hay configuración `gcloud` ni archivos
  de despliegue de Cloud Run/Cloud SQL. Las referencias históricas se conservan.
  **Google OAuth sigue activo y no es basura.**

- [x] **10. Seguridad Supabase: RLS en tablas de `public`** — **HECHO** (29/09/2026)
  El Security Advisor muestra las 8 tablas de la app (`festival_suggestions`, `festivals`,
  `sessions`, `tour_cache`, `user_artists`, `user_festivals`, `user_genres`, `users`) con RLS
  desactivado; la consulta de Nelson confirmó permisos SELECT/INSERT/UPDATE/DELETE para
  `anon` en todas. `migrations/004_secure_public_tables.sql` activa RLS sin políticas y
  revoca privilegios a `anon`/`authenticated` en tablas y secuencias. Nelson la ejecutó en
  Supabase y SQL Editor respondió `Success. No rows returned`. La app no usa la Data
  API desde el navegador; Express conecta por `DATABASE_URL` con el usuario pooler
  `postgres.<project-ref>`, por lo que las consultas backend siguen como owner. Verificado
  en Advisor: 0 errores y 8 sugerencias informativas por no tener políticas. Son esperadas:
  con RLS activado y sin políticas, `anon`/`authenticated` no acceden; el backend usa la
  conexión PostgreSQL propia. No agregar políticas salvo que en el futuro se exponga una
  tabla deliberadamente por la Data API.

- [x] **11. Refresh de temporadas y lineups 2026/2027** — **HECHO** (30/09/2026)
  Se conservaron las 58 entradas. Las fechas ya pasadas se movieron al ciclo 2027 (fecha exacta
  por anunciar si no está confirmada). Los festivales que todavía faltan en 2026 permanecen con
  sus fechas y lineups: AMF (24 octubre), Austin City Limits (2–4 y 9–11 octubre) y Corona
  Capital (20–22 noviembre). Lineups parciales oficiales disponibles para Rock am Ring, Rock im
  Park, Tuska, Provinssi, Rock Werchter, NOS Alive, AMF, Austin City Limits y Corona Capital.
  `migrations/002_festivals.sql` se regeneró con 120 entradas y se aplicó a Supabase con éxito
  (`INSERT 0 58`, `COMMIT`). `Cosquín Rock` quedó como posible agregado futuro.

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

### 8. `which psql` no prueba que `psql` falte (29/09/2026)

Homebrew instala `libpq` como **keg-only**, sin linkearla en `/opt/homebrew`, porque
conflictúa con `postgresql`. En esta máquina `libpq` 18.6 estaba instalada desde el 11/08 y
`which psql` no encontraba nada. La sesión anterior concluyó de ahí que faltaba y
planteó un bloqueo de entorno que no existía (y propuso instalar Docker, que no hacía falta).

Antes de instalar nada: `brew info libpq` (dice "Installed (on request)") y
`ls /opt/homebrew/opt/libpq/bin/psql`. El chequeo cuesta un segundo y evita instalar
35 MB que ya estaban ahí. Ya está agregado al PATH en `~/.zshrc`; si desaparece, es que se
perdió esa línea, no que falte el paquete.

---

## Datos de la base vieja (opcional)

Hay un backup en `migrations/`: **`festival_match_backup_20260505.dump`** (22k, `pg_dump`
custom de Cloud SQL, 10/05/2026). Está en `.gitignore` (`*.dump`), **y sigue ignorado aunque
esté dentro de `migrations/`**: la excepción `!migrations/*.sql` solo levanta los `.sql`, y el
`*.dump` global gana igual. Verificado con `git check-ignore` después de moverlo (29/09/2026).

Vive junto a los `.sql` a propósito: todo lo que habla de la base en un solo lugar. La
diferencia es que los `.sql` están versionados y el `.dump` no.

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
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Credenciales de la app Spotify; secretos solo en `.env`/Vercel |
| `SPOTIFY_REDIRECT_URI` | Debe coincidir exactamente con el URI permitido en Spotify Dashboard |
| `SPOTIFY_TOKEN_ENCRYPTION_KEY` | 32 bytes codificados en base64; `openssl rand -base64 32` |

Nunca commitear `.env`. Ya está en `.gitignore`. El repo es **público**: auditar el historial
con `git log --all -p -S '<secreto>'` antes dedadeclarar que está limpio.

---

## Comandos

```bash
npm run dev     # node --watch app.js, en :8080
npm start       # node app.js
vercel dev      # para replicar el entorno de Vercel antes de deployar
```

**Ojo:** `npm start` local se conecta a la **Supabase de producción** (ver la trampa del
`.env`). Para levantar contra otra base, exportar `DATABASE_URL` explícitamente.

Para las migraciones, `psql` (ya está en el PATH, ver la nota del paso 4):

```bash
# aplicar una migración
set -a; source ./.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_festivals.sql

# verificar que la URL es la del pooler transaccional, SIN imprimir la password
echo "$DATABASE_URL" | sed -E 's#://[^@]*@#://***:***@#'
```

`-v ON_ERROR_STOP=1` es lo que hace que `psql` aborte en el primer error en vez de seguir y
commitear la transacción a medias. Con el `BEGIN`/`COMMIT` del `.sql` es seguro igual, pero
con `ON_ERROR_STOP` el fallo es ruidoso en vez de silencioso.

`app.js` es el entry de Express **y** el script de arranque. `server/server.js` ya no se
ejecuta directo: exporta `registerServer` / `initServices` / `PORT` y no abre ningún puerto.

## Deploy

- **URL en producción:** https://festivalmatch.vercel.app/
- Deploy desde el **dashboard de Vercel** importando el repo de GitHub. El usuario **no puede
  usar el CLI de Vercel** (escribe a ciegas), así que no intentar eso como sugerencia.
- **Estado al 29/09/2026:** la app **está viva con base de datos**. `DATABASE_URL` está en
  Vercel (pooler transaccional, sin `?sslmode=require`), Supabase tiene el schema aplicado
  (001 + 002, 58 festivales verificados con `SELECT`), el login con Google funciona contra
  la base real y **el panel admin anda**
  (el `EROFS` → 500 está resuelto). Verificado con la suite de abajo y probando el flujo
  completo: registro, login, cookie de sesión, CRUD de artistas con el UNIQUE (409 en
  duplicado), géneros, favoritos, sugerencia con FK a `users`, matching contra lineups
  reales, búsqueda en MusicBrainz y edición/borrado/aprobación desde el panel admin.
- **Env vars en Vercel:** `DATABASE_URL`, `LASTFM_API_KEY`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (las 3, en Production/Preview/Development).
- **🔜 Pendiente de configurar:** nada. El secret `DATABASE_URL` del keepalive ya está en
  GitHub y verificado; las env vars de Vercel están completas.
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
