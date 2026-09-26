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
app.js                # Entry point para Vercel: reexporta server/server.js
vercel.json           # Rewrite SPA: todo lo que no sea /api, /auth o /health -> /index.html
server/server.js      # Express monolith: rutas API + auth + admin (1327 líneas)
server/db.js          # Pool pg + schema init + todas las queries (555 líneas)
server/auth.js        # Google OAuth + middlewares requireAuth/optionalAuth
server/festivals.json # 58 festivales, 36 con lineup  ← MIGRAR A DB (step 4)
public/               # app.js (3034 líneas), index.html, styles.css, i18n/
migrations/           # SQL de una sola vez  ← CREAR (step 5)
```

---

## ⚠️ Migración a Vercel + Supabase

**Estado:** planeada, sin empezar. Actualizar las casillas al avanzar cada paso.

### Por qué hay que hacerlo (contexto para sesiones futuras)

En Vercel el filesystem es **read-only e inmutable** y las instancias son **efímeras**.
Eso rompe 3 cosas del código actual. Nada más necesita cambiar.

### Pasos

- [ ] **1. Supabase: proyecto + infra** (~30 min)
  Crear proyecto free, sacar la **connection string del pooler (Supavisor, modo transaccional)**,
  correr `migrations/001_init.sql` con el schema actual de `initDatabase()` + seed de las 58 filas de `festivals.json`.

- [x] **2. Vercel: entry point** (~15 min) — *desbloquea el deploy* — **HECHO**
  `app.js` en la raíz reexporta la app. `server/server.js` ahora solo hace `listen`
  cuando se ejecuta directo (`require.main === module`). `vercel.json` rewritea
  todo lo que no sea `/api`, `/auth` o `/health` a `/index.html` para los deep links
  de la SPA (que usa History API, no hash). `package.json` `main` → `app.js`.
  Además: `festivals.json` pasó de `fs.readFileSync` a `require` (para que el
  bundler de Vercel lo rastree e incluya en la función) y se agregó un error
  handler final, que Express 4 no tiene y Vercel recomienda.

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
npm run dev     # node --watch server/server.js, en :8080
npm start       # node server/server.js
vercel dev      # para replicar el entorno de Vercel antes de deployar
```

## Deploy

El proyecto ya está preparado para Vercel sin base de datos (el modo demo anda entero).
Deploy recomendado: **importar el repo de GitHub en vercel.com/new** para tener
auto-deploy en cada push y preview deployments por PR.

Si se prefiere por CLI: `npx vercel` y después `npx vercel --prod`.

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
- Rutas de API en `/api/*`, auth en `/auth/*`. Si agregás una ruta, actualizá el catch-all `app.get('*')` de `server.js:1285`.
- `public/i18n/{es,en,fi}.json`: toda string nueva de UI va en los 3 idiomas.
- Comentá los cambios de arquitectura acá arriba y en el código, con el **por qué** — el objetivo es que el proyecto se lea bien en un portfolio.
