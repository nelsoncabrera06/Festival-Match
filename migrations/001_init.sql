-- =============================================================================
-- 001_init.sql — Schema de Festival Match
-- =============================================================================
--
-- Por que este archivo existe: en GCP el schema lo creaba initDatabase() en
-- server/db.js cada vez que el server arrancaba. En Vercel eso no puede pasar
-- (el filesystem es read-only, las instancias son efimeras y ademas
-- initServices() solo corre bajo `require.main === module`, o sea nunca en
-- produccion). El schema pasa a ser esta migracion de una sola vez.
--
-- Idempotente a proposito: se puede correr mas de una vez sin romper nada, que
-- es lo que necesita alguien pegandolo en el SQL editor de Supabase.
--
-- El schema es identico al de initDatabase() y al del dump de Cloud SQL
-- (festival_match_backup_20260505.dump), asi que el restore de los datos viejos
-- encaja sin transformaciones.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
-- google_id queda nullable y sin valor por defecto: las cuentas de Google lo
-- tienen, las de email/password no. El UNIQUE sobre una columna nullable
-- permite N filas con NULL, que es justo lo que necesitamos para el registro
-- con email.
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  google_id       TEXT UNIQUE,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  name            TEXT,
  picture         TEXT,
  lastfm_username TEXT,
  role            TEXT DEFAULT 'user',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- Biblioteca del usuario
-- -----------------------------------------------------------------------------
-- Los tres UNIQUE(user_id, X) serving como indice: las queries de la app
-- filtran siempre por user_id, asi que el indice del UNIQUE ya las cubre y no
-- hace falta un indice adicional.
CREATE TABLE IF NOT EXISTS user_artists (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_name    TEXT NOT NULL,
  musicbrainz_id TEXT,
  added_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, artist_name)
);

CREATE TABLE IF NOT EXISTS user_genres (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre     TEXT NOT NULL,
  added_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, genre)
);

CREATE TABLE IF NOT EXISTS user_festivals (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  festival_id TEXT NOT NULL,
  added_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, festival_id)
);

-- -----------------------------------------------------------------------------
-- Sesiones
-- -----------------------------------------------------------------------------
-- id es TEXT (no SERIAL) porque el id de sesion lo genera la app, no la base.
-- En serverless no hay sesiones en memoria: esta tabla es la unica fuente de
-- verdad, y se limpian solas por expires_at > NOW() en cada lectura.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- -----------------------------------------------------------------------------
-- Cache de tour dates
-- -----------------------------------------------------------------------------
-- invalidacion por timestamp: getTourCache() compara fetched_at contra
-- TOUR_CACHE_DURATION y devuelve null si expiro. No hace falta cron.
--
-- fetched_at es BIGINT (Date.now() en ms) y no TIMESTAMP porque asi lo escribe
-- setTourCache(). Si alguna vez se migra a timestamp, hay que tocar las dos.
CREATE TABLE IF NOT EXISTS tour_cache (
  id          SERIAL PRIMARY KEY,
  artist_name TEXT NOT NULL,
  region      TEXT NOT NULL,
  data        TEXT NOT NULL,
  fetched_at  BIGINT NOT NULL,
  UNIQUE(artist_name, region)
);

-- -----------------------------------------------------------------------------
-- Sugerencias de festivales (admin panel)
-- -----------------------------------------------------------------------------
-- user_id es ON DELETE SET NULL y no CASCADE a proposito: si se borra un
-- usuario, la sugerencia queda huerfana pero se conserva para que el admin la
-- pueda revisar igual.
CREATE TABLE IF NOT EXISTS festival_suggestions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  festival_name TEXT NOT NULL,
  country       TEXT NOT NULL,
  city          TEXT NOT NULL,
  dates_info    TEXT,
  website       TEXT,
  status        TEXT DEFAULT 'pending',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- Seed: rol de admin
-- -----------------------------------------------------------------------------
-- El rol se asignaba dentro de initDatabase(), que ya no corre en produccion.
-- Si esta linea no esta, el primer login entra sin permisos y el panel de admin
-- responde 403.
--
-- Reejecutar esta sentencia despues de importar los datos viejos: el restore
-- pisa el rol con el valor que.traia la base de Cloud SQL.
--
-- NOTA: el email esta hardcodeado igual que ADMIN_EMAILS en server/db.js. La
-- idea es moverlo a una env var (ADMIN_EMAILS) para que no haya que hacer un
-- deploy para cambiar la lista de admins.
UPDATE users
SET role = 'admin,dev'
WHERE email = 'nelsoncabrera06@gmail.com'
  AND (role IS NULL OR role = 'user');

COMMIT;

-- =============================================================================
-- Notas de la migracion
-- =============================================================================
--
-- Lo que initDatabase() hacia y aqui NO hace, a proposito:
--
--   ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT
--   ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL
--   CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email)
--
-- Los tres son migraciones defensivas para tablas que ya existian. Esta
-- migracion corre contra una base nueva, donde password_hash ya esta en el
-- CREATE TABLE, google_id ya es nullable, y email ya es UNIQUE NOT NULL (el
-- indice users_email_unique seria redundante).
--
-- El catalogo de festivales sigue en server/festivals.json y todavia NO esta
-- en la base. Se migra aparte, en 002_festivals.sql, junto con el cambio de
-- los 4 endpoints de admin que hoy escriben el JSON con fs.writeFileSync
-- (que en Vercel falla con EROFS por el filesystem read-only).
