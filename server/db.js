const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// Fechas estructuradas derivadas de `dates` (starts_on / ends_on).
const { parseDateRange } = require('./dateRange');
// Limpieza de nombres al aprobar una propuesta del radar (paso 15).
const { prepareArtists } = require('./lineupApproval');

const SALT_ROUNDS = 10;

const databaseUrl = process.env.DATABASE_URL;
const isVercel = process.env.VERCEL === '1';
let databaseHost = '';
try {
  databaseHost = new URL(databaseUrl).hostname;
} catch {
  // pg emitirá el error de URL habitual cuando intente conectarse.
}

// El .env historico puede apuntar a Supabase. Si se ejecuta desde localhost,
// bloquear esa URL antes de que una ruta del admin pueda escribir en producción.
if (!isVercel && process.env.ALLOW_LOCAL_PRODUCTION_DB !== 'true') {
  if (databaseHost.endsWith('.pooler.supabase.com') || databaseHost.endsWith('.supabase.co')) {
    throw new Error(
      'La configuración local apunta a Supabase. Confirmá esta decisión con ALLOW_LOCAL_PRODUCTION_DB=true en .env.local; se canceló el arranque para proteger producción.'
    );
  }
}

// Configurar pool de conexiones PostgreSQL
const pool = new Pool({
  connectionString: databaseUrl,

  // max: 1 porque esto corre en Vercel serverless. Cada instancia maneja requests
  // concurrentes, pero no necesita mas de una conexion: el pooler de Supabase
  // (Supavisor, transaction mode) multiplexa las conexiones reales. Con el
  // default de 10, un cold start de N instancias abre 10*N conexiones y
  // Supabase free las corta.
  max: 1,

  // Fallar rapido si no se puede conectar, en vez de dejar el request colgado
  // hasta que Vercel mate la funcion.
  connectionTimeoutMillis: 10000,

  // Cerrar las conexiones ociosas antes de que Supabase las cierre por timeout.
  idleTimeoutMillis: 10000,

  // Supabase documenta esto explicitamente para node-postgres.
  //
  // OJO: por que NO esta el `?sslmode=require` en la connection string, que es
  // lo que dice la doc de Supabase. Con pg 8.16.3 ese parametro se traduce a
  // ssl.rejectUnauthorized = true (al reves de lo que significa "require"), y
  // como la connection string se parsea DESPUES del objeto de config, pisa
  // este `ssl` y termina fallando con:
  //   Error: self-signed certificate in certificate chain
  // Verificado con las 4 combinaciones: con sslmode=require falla siempre
  // (con o sin este `ssl` explícito); sin sslmode funciona. Por eso la URL
  //ConnectionString no lleva el parametro y el TLS se configura acá.
  // Supabase requiere TLS; PostgreSQL local normalmente no tiene SSL habilitado.
  ssl: databaseHost.endsWith('.pooler.supabase.com') || databaseHost.endsWith('.supabase.co')
    ? { rejectUnauthorized: false }
    : false
});

// Sin este listener, un 'error' del pool es un throw no capturado que MATA la
// instancia de Vercel. Con Supabase no es hipotetico: el pooler cierra
// conexiones ociosas y el free tier pausa el proyecto, y node-postgres emite
// 'error' en ambos casos. Con el listener el error se loguea, el pool descarta
// esa conexion y el request sigue.
pool.on('error', (err) => {
  console.error('Error del pool de Postgres (conexion descartada):', err.message);
});

// Lista de emails con roles especiales (admins/devs).
//
// Se lee de ADMIN_EMAILS para poder cambiarla sin deploy, con el valor
// original como fallback para que el repo siga funcionando solo.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'nelsoncabrera06@gmail.com')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

// Inicializar base de datos (crear tablas)
async function initDatabase() {
  // Crear tablas si no existen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      lastfm_username TEXT,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_artists (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      musicbrainz_id TEXT,
      image TEXT,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, artist_name)
    );
    ALTER TABLE user_artists ADD COLUMN IF NOT EXISTS image TEXT;

    CREATE TABLE IF NOT EXISTS user_genres (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      genre TEXT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, genre)
    );

    CREATE TABLE IF NOT EXISTS user_festivals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      festival_id TEXT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, festival_id)
    );

    CREATE TABLE IF NOT EXISTS spotify_connections (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_encrypted TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE spotify_connections ENABLE ROW LEVEL SECURITY;
    -- Mismo revoke que aplica migrations/005_spotify_connections.sql. Allá es
    -- donde corre en produccion (initDatabase() no se ejecuta en Vercel); dejar
    -- la linea tambien aca mantiene el schema local alineado con el de Supabase.
    REVOKE ALL PRIVILEGES ON TABLE spotify_connections FROM anon, authenticated;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tour_cache (
      id SERIAL PRIMARY KEY,
      artist_name TEXT NOT NULL,
      region TEXT NOT NULL,
      data TEXT NOT NULL,
      fetched_at BIGINT NOT NULL,
      UNIQUE(artist_name, region)
    );

    CREATE TABLE IF NOT EXISTS festivals (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      city          TEXT NOT NULL,
      location      TEXT NOT NULL,
      country       TEXT NOT NULL,
      dates         TEXT NOT NULL,
      website       TEXT NOT NULL DEFAULT '',
      image         TEXT,
      flyer         TEXT,
      flyer_images  TEXT[] NOT NULL DEFAULT '{}',
      description   TEXT,
      lineup_status TEXT NOT NULL DEFAULT 'unannounced',
      lineup        TEXT[] NOT NULL DEFAULT '{}',
      note          TEXT,
      sort_order    INTEGER NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS festival_suggestions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      festival_name TEXT NOT NULL,
      country TEXT NOT NULL,
      city TEXT NOT NULL,
      dates_info TEXT,
      website TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Asignar roles a admins existentes
  for (const email of ADMIN_EMAILS) {
    await pool.query(
      "UPDATE users SET role = 'admin,dev' WHERE email = $1 AND (role IS NULL OR role = 'user')",
      [email]
    );
  }

  // Migraciones para tablas existentes
  // Agregar columna password_hash si no existe
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  } catch (err) {
    // Ignorar si ya existe
  }

  // Hacer google_id nullable si no lo es
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL');
  } catch (err) {
    // Ignorar si ya es nullable
  }

  // Hacer email único si no lo es
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email)');
  } catch (err) {
    // Ignorar si ya existe
  }

  // Fechas estructuradas del catalogo (migrations/012_festival_dates.sql).
  // Son DERIVADAS de `dates` por server/dateRange.js: no se editan a mano ni se
  // devuelven en rowToFestival(), porque verify-festivals-roundtrip.js hace
  // deep-equal contra festivals.json y una clave nueva rompe ese contrato.
  // Aca solo se crean para que el dev local tenga el mismo schema que Supabase.
  await pool.query('ALTER TABLE festivals ADD COLUMN IF NOT EXISTS starts_on DATE');
  await pool.query('ALTER TABLE festivals ADD COLUMN IF NOT EXISTS ends_on DATE');
  await pool.query('ALTER TABLE festivals ADD COLUMN IF NOT EXISTS lineup_source_url TEXT');

  // Estado operativo del radar de lineups (migrations/017_festival_source_checks.sql).
  // Es una tabla companion: no se expone en rowToFestival() ni en el endpoint
  // admin, y el frontend nunca la consulta. `next_check_at = NULL` = en pausa.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS festival_source_checks (
      festival_id          TEXT PRIMARY KEY REFERENCES festivals(id) ON DELETE CASCADE,
      last_checked_at      TIMESTAMPTZ,
      next_check_at        TIMESTAMPTZ,
      last_seen_hash       TEXT,
      last_processed_hash  TEXT,
      etag                 TEXT,
      last_modified        TEXT,
      last_http_status     INTEGER,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS festival_source_checks_next_check_idx ON festival_source_checks (next_check_at)');
  // Versión del algoritmo de hash (migrations/018): el scanner la usa para
  // distinguir un cambio real de una línea base tras cambiar de versión.
  await pool.query('ALTER TABLE festival_source_checks ADD COLUMN IF NOT EXISTS hash_version INTEGER');
  // Cambios detectados pendientes de extracción/aprobación (paso 13-14).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineup_source_observations (
      id            BIGSERIAL PRIMARY KEY,
      festival_id   TEXT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
      source_url    TEXT NOT NULL,
      previous_hash TEXT,
      seen_hash     TEXT NOT NULL,
      hash_version  INTEGER NOT NULL,
      title         TEXT,
      excerpt       TEXT,
      detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at  TIMESTAMPTZ,
      UNIQUE (festival_id, seen_hash)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS lineup_source_observations_pending_idx ON lineup_source_observations (festival_id, detected_at DESC) WHERE processed_at IS NULL');
  // Propuestas extraídas con IA (migrations/019_lineup_proposals.sql). El dev
  // local necesita la tabla para probar el panel admin; en producción la crea
  // la migración y esta función no corre (Vercel no llama initDatabase).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineup_proposals (
      id               BIGSERIAL PRIMARY KEY,
      festival_id      TEXT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
      observation_id   BIGINT REFERENCES lineup_source_observations(id) ON DELETE SET NULL,
      source_url       TEXT NOT NULL,
      seen_hash        TEXT NOT NULL,
      hash_version     INTEGER NOT NULL,
      model            TEXT NOT NULL,
      schema_version   INTEGER NOT NULL,
      lineup_status    TEXT CHECK (lineup_status IS NULL OR lineup_status IN ('confirmed', 'partial', 'unannounced')),
      artists_count    INTEGER NOT NULL DEFAULT 0 CHECK (artists_count >= 0),
      confidence       NUMERIC(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      payload          JSONB NOT NULL,
      extraction_error TEXT,
      review_status    TEXT NOT NULL DEFAULT 'pending'
                         CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded')),
      reviewed_at      TIMESTAMPTZ,
      reviewed_by      TEXT,
      first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (festival_id, seen_hash),
      CONSTRAINT lineup_proposals_outcome_check CHECK (
        (extraction_error IS NULL AND lineup_status IS NOT NULL)
        OR (extraction_error IS NOT NULL)
      )
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS lineup_proposals_pending_idx ON lineup_proposals (first_seen_at DESC) WHERE review_status = \'pending\'');
  await pool.query('CREATE INDEX IF NOT EXISTS lineup_proposals_festival_idx ON lineup_proposals (festival_id, first_seen_at DESC)');
  // Propuestas de datos de festival (migrations/021): fechas/estado detectados
  // en la web oficial. Solo las revisa/aprueba el admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS festival_fact_proposals (
      id                       BIGSERIAL PRIMARY KEY,
      festival_id              TEXT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
      source_url               TEXT NOT NULL,
      page_url                 TEXT,
      seen_hash                TEXT NOT NULL,
      model                    TEXT NOT NULL,
      schema_version           INTEGER NOT NULL,
      proposed_dates           TEXT,
      proposed_lineup_status   TEXT CHECK (
        proposed_lineup_status IS NULL
        OR proposed_lineup_status IN ('confirmed', 'partial', 'unannounced', 'hiatus')
      ),
      proposed_starts_on       DATE,
      proposed_ends_on         DATE,
      evidence                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence               NUMERIC(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      payload                  JSONB NOT NULL,
      review_status            TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded')),
      reviewed_at              TIMESTAMPTZ,
      reviewed_by              TEXT,
      first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (festival_id, seen_hash),
      CONSTRAINT festival_fact_proposals_has_change CHECK (
        proposed_lineup_status IS NOT NULL
        OR proposed_dates IS NOT NULL
        OR proposed_starts_on IS NOT NULL
        OR proposed_ends_on IS NOT NULL
      )
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS festival_fact_proposals_pending_idx ON festival_fact_proposals (first_seen_at DESC) WHERE review_status = \'pending\'');
  await pool.query('CREATE INDEX IF NOT EXISTS festival_fact_proposals_festival_idx ON festival_fact_proposals (festival_id, first_seen_at DESC)');

  console.log('Base de datos PostgreSQL inicializada');
}

// ==========================================
// Funciones de Usuario
// ==========================================

// La foto de perfil no se guarda. Google la manda en el scope userinfo.profile
// (el mismo que trae `name`) y antes se almacenaba como texto en users.picture.
// Se dejo de hacer por dos razones: la app no la muestra, y el link de
// lh3.googleusercontent.com es de Google, no nuestro: se invalida solo cuando el
// usuario cambia su foto y queda un <img> roto. La columna se elimino en
// migrations/006_drop_user_picture.sql.
async function findOrCreateUser(googleProfile) {
  const { sub: googleId, email, name } = googleProfile;

  // Buscar usuario existente
  const result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  let user = result.rows[0];

  if (user) {
    // Actualizar datos si cambiaron
    await pool.query(
      'UPDATE users SET email = $1, name = $2 WHERE id = $3',
      [email, name, user.id]
    );
  } else {
    // Crear nuevo usuario.
    //
    // El rol se resuelve acá y no en la migracion. La migracion 001 hacia el
    // UPDATE cuando la base todavia estaba vacia, asi que no le toco a ninguna
    // fila: el primer admin que se registra con Google queda con 'user' y el
    // panel de admin le responde 403, sin forma de arreglarlo desde la app.
    // Resolviendolo en el INSERT el rol queda correcto siempre, y no hay que
    // acordarse de correr un UPDATE a mano.
    const role = ADMIN_EMAILS.includes(email.toLowerCase().trim()) ? 'admin,dev' : 'user';
    const insertResult = await pool.query(
      'INSERT INTO users (google_id, email, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [googleId, email, name, role]
    );
    user = insertResult.rows[0];
  }

  return user;
}

async function getUserById(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0];
}

async function getLastfmUsername(userId) {
  const result = await pool.query('SELECT lastfm_username FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.lastfm_username || null;
}

async function setLastfmUsername(userId, username) {
  await pool.query('UPDATE users SET lastfm_username = $1 WHERE id = $2', [username || null, userId]);
  return true;
}

async function getSpotifyConnection(userId) {
  const result = await pool.query(
    'SELECT refresh_token_encrypted FROM spotify_connections WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function setSpotifyConnection(userId, encryptedRefreshToken) {
  await pool.query(`
    INSERT INTO spotify_connections (user_id, refresh_token_encrypted)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE
    SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        updated_at = CURRENT_TIMESTAMP
  `, [userId, encryptedRefreshToken]);
}

async function deleteSpotifyConnection(userId) {
  await pool.query('DELETE FROM spotify_connections WHERE user_id = $1', [userId]);
}

async function deleteUser(userId) {
  const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id, email, name', [userId]);
  return result.rows[0] || null;
}

async function getUserRole(userId) {
  const result = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.role || 'user';
}

async function isAdmin(userId) {
  const role = await getUserRole(userId);
  return role.includes('admin');
}

async function isDev(userId) {
  const role = await getUserRole(userId);
  return role.includes('dev');
}

// ==========================================
// Autenticacion con Email/Password
// ==========================================

async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return result.rows[0];
}

async function registerUser(email, password, name = null) {
  // Verificar si el email ya existe
  const existingUser = await getUserByEmail(email);
  if (existingUser) {
    return { error: 'El email ya está registrado' };
  }

  // Hashear password
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Crear usuario
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *',
    [email.toLowerCase(), passwordHash, name]
  );

  return { user: result.rows[0] };
}

async function loginUser(email, password) {
  // Buscar usuario por email
  const user = await getUserByEmail(email);

  if (!user) {
    return { error: 'Email o contraseña incorrectos' };
  }

  // Si el usuario no tiene password (solo Google), no puede hacer login con password
  if (!user.password_hash) {
    return { error: 'Esta cuenta usa Google para iniciar sesión' };
  }

  // Verificar password
  const validPassword = await bcrypt.compare(password, user.password_hash);

  if (!validPassword) {
    return { error: 'Email o contraseña incorrectos' };
  }

  return { user };
}

// ==========================================
// Funciones de Sesion
// ==========================================

async function createSession(userId) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, userId, expiresAt.toISOString()]
  );

  return sessionId;
}

async function getSession(sessionId) {
  const result = await pool.query(`
    SELECT s.*, u.id as user_id, u.email, u.name
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = $1 AND s.expires_at > NOW()
  `, [sessionId]);

  return result.rows[0];
}

async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

async function cleanExpiredSessions() {
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

// ==========================================
// Funciones de Artistas
// ==========================================

async function getUserArtists(userId) {
  const result = await pool.query(`
    SELECT id, artist_name, musicbrainz_id, image, added_at
    FROM user_artists
    WHERE user_id = $1
    ORDER BY added_at DESC
  `, [userId]);
  return result.rows;
}

async function getDemoProfile() {
  const user = await pool.query("SELECT id FROM users WHERE email = 'demo@festival-match.invalid'");
  if (!user.rows[0]) return null;
  const userId = user.rows[0].id;
  const [artists, favorites] = await Promise.all([
    getUserArtists(userId),
    getUserFavoriteFestivals(userId),
  ]);
  return {
    artists: artists.map(({ artist_name, image }) => ({ name: artist_name, image, genres: [] })),
    favoriteFestivalIds: favorites.map(({ festival_id }) => festival_id),
  };
}

async function addUserArtist(userId, artistName, musicbrainzId = null) {
  try {
    const result = await pool.query(
      'INSERT INTO user_artists (user_id, artist_name, musicbrainz_id) VALUES ($1, $2, $3) RETURNING *',
      [userId, artistName.trim(), musicbrainzId]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return null; // Ya existe
    }
    throw err;
  }
}

async function removeUserArtist(userId, artistId) {
  const result = await pool.query(
    'DELETE FROM user_artists WHERE id = $1 AND user_id = $2',
    [artistId, userId]
  );
  return result.rowCount > 0;
}

// ==========================================
// Funciones de Generos
// ==========================================

const AVAILABLE_GENRES = [
  'Rock', 'Pop', 'Electronic', 'Hip Hop', 'R&B', 'Jazz', 'Classical',
  'Metal', 'Punk', 'Indie', 'Alternative', 'Folk', 'Country', 'Blues',
  'Reggae', 'Soul', 'Funk', 'House', 'Techno', 'Drum and Bass',
  'Dubstep', 'Trance', 'Ambient', 'Disco', 'Latin', 'World',
  'Experimental', 'Post-Punk', 'Shoegaze', 'Dream Pop', 'Synthwave',
  'Art Pop', 'Indie Rock', 'Garage Rock', 'Psychedelic', 'Grunge'
];

function getAvailableGenres() {
  return AVAILABLE_GENRES;
}

async function getUserGenres(userId) {
  const result = await pool.query(`
    SELECT id, genre, added_at
    FROM user_genres
    WHERE user_id = $1
    ORDER BY added_at DESC
  `, [userId]);
  return result.rows;
}

async function addUserGenre(userId, genre) {
  try {
    const result = await pool.query(
      'INSERT INTO user_genres (user_id, genre) VALUES ($1, $2) RETURNING *',
      [userId, genre.trim()]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return null; // Ya existe
    }
    throw err;
  }
}

async function removeUserGenre(userId, genreId) {
  const result = await pool.query(
    'DELETE FROM user_genres WHERE id = $1 AND user_id = $2',
    [genreId, userId]
  );
  return result.rowCount > 0;
}

// ==========================================
// Catalogo de Festivales
// ==========================================
//
// Estas 4 funciones reemplazan a leer/escribir server/festivals.json con
// fs.readFileSync / fs.writeFileSync. El motivo del cambio esta en
// migrations/002_festivals.sql: en Vercel el filesystem es read-only, asi que el
// panel de admin (PUT/DELETE /api/admin/festivals/:id y el approve de
// sugerencias) fallaba con EROFS -> 500 "Error al guardar".
//
// Ademas elimina una segunda fuente de verdad: antes getFestivals() devolvia el
// array en memoria del require() mientras GET /api/admin/festivals releia el
// archivo, asi que una edicion se veia en el panel y no en el matching hasta
// reiniciar. Ahora hay una sola fuente.

// Fila de la tabla -> objeto con la misma forma que tenia en festivals.json.
//
// El mapeo es explicito y no `SELECT *` por dos razones:
//  1. El frontend (public/app.js) consume claves camelCase: lineup_status ->
//     lineupStatus, flyer_images -> flyerImages.
//  2. Las claves opcionales se OMITEN, no se devuelven como undefined. En el
//     JSON original un festival sin flyer no tenia la clave `flyer`; 3 de los 58
//     no tienen `image`. Devolverlas en undefined daria el mismo JSON en la
//     respuesta (JSON.stringify las dropea) pero un objeto distinto: aparecerian
//     en Object.keys(). Omitirlas deja el round-trip exacto.
function rowToFestival(row) {
  const festival = {
    id: row.id,
    name: row.name,
    city: row.city,
    location: row.location,
    country: row.country,
    dates: row.dates,
    website: row.website,
  };

  // Orden de las claves opcionales: el que tenian en el JSON, no el de la tabla.
  if (row.image) festival.image = row.image;
  if (row.flyer) festival.flyer = row.flyer;
  if (row.flyer_images.length > 0) festival.flyerImages = row.flyer_images;

  festival.lineupStatus = row.lineup_status;
  festival.lineup = row.lineup;

  if (row.description) festival.description = row.description;
  if (row.note) festival.note = row.note;

  return festival;
}

const FESTIVAL_COLUMNS = `
  id, name, city, location, country, dates, website,
  image, flyer, flyer_images, description, lineup_status, lineup, note,
  sort_order
`;

async function getFestivals() {
  const result = await pool.query(
    `SELECT ${FESTIVAL_COLUMNS} FROM festivals ORDER BY sort_order`
  );
  return result.rows.map(rowToFestival);
}

// El enlace de la fuente solo se expone en el endpoint admin. rowToFestival()
// y FESTIVAL_COLUMNS conservan el contrato público del catálogo.
async function getAdminFestivals() {
  const result = await pool.query(
    `SELECT ${FESTIVAL_COLUMNS}, lineup_source_url FROM festivals ORDER BY sort_order`
  );
  return result.rows.map((row) => ({
    ...rowToFestival(row),
    lineupSourceUrl: row.lineup_source_url,
  }));
}

async function getFestivalById(id) {
  const result = await pool.query(
    `SELECT ${FESTIVAL_COLUMNS} FROM festivals WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? rowToFestival(result.rows[0]) : null;
}

// Crear un festival. Lo usa POST /api/admin/suggestions/:id/approve cuando una
// sugerencia se aprueba y el festival todavia no existe.
//
// sort_order se calcula con MAX(sort_order) + 1 en vez de venir del caller: es
// NOT NULL y la idea es que un festival nuevo vaya al final de la lista, que es
// donde uno esperaria ver un festival recien sugerido. La alternativa (mandarlo
// desde el caller) obliga a que cada endpoint que cree un festival se acuerde de
// calcularlo.
async function createFestival(festival) {
  // starts_on / ends_on son DERIVADAS de `dates` (ver server/dateRange.js).
  // Se calculan aca y no en el caller para que cualquier alta, incluida la
  // aprobacion de una sugerencia, quede con las fechas coherentes.
  const rango = parseDateRange(festival.dates);

  const result = await pool.query(
    `INSERT INTO festivals
       (id, name, city, location, country, dates, website, image, flyer,
        flyer_images, description, lineup_status, lineup, note,
        starts_on, ends_on, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM festivals))
     RETURNING ${FESTIVAL_COLUMNS}`,
    [
      festival.id,
      festival.name,
      festival.city,
      festival.location,
      festival.country,
      festival.dates,
      festival.website || '',
      festival.image || null,
      festival.flyer || null,
      festival.flyerImages || [],
      festival.description || null,
      festival.lineupStatus || 'unannounced',
      festival.lineup || [],
      festival.note || null,
      rango.startsOn,
      rango.endsOn,
    ]
  );

  // El guard no es decorativo: si el id colisiona con uno existente el INSERT
  // revienta con 23505 y nunca llega aca, pero un RETURNING vacio por lo que
  // fuera no debe dejar rowToFestival leyendo result.rows[0].undefined.
  if (!result.rows[0]) return null;
  return rowToFestival(result.rows[0]);
}

// Actualizar un festival (panel admin).
//
// whitelist de campos, no "UPDATE lo que venga en el body": el body viene de un
// formulario y tambien de cualquiera que haga un PUT a mano. `id` y `sort_order`
// quedan fuera a proposito (el id es la identidad y el sort_order es el orden
// curado del seed). Los campos ausentes del body no se tocan, que es lo que
// permitia el forEach sobre el JSON.
const UPDATABLE_FESTIVAL_FIELDS = {
  name: 'name',
  city: 'city',
  location: 'location',
  country: 'country',
  dates: 'dates',
  website: 'website',
  lineupSourceUrl: 'lineup_source_url',
  image: 'image',
  flyer: 'flyer',
  flyerImages: 'flyer_images',
  description: 'description',
  lineupStatus: 'lineup_status',
  lineup: 'lineup',
  note: 'note',
};

async function updateFestival(id, updates) {
  const sets = [];
  const values = [];

  for (const [key, column] of Object.entries(UPDATABLE_FESTIVAL_FIELDS)) {
    if (updates[key] === undefined) continue;
    values.push(updates[key] === null ? null : updates[key]);
    sets.push(`${column} = $${values.length}`);
  }

  // Si el body trae `dates`, se recalculan las columnas derivadas en el MISMO
  // UPDATE. Si no viene, se dejan como estan: el backfill de la 012 y el
  // rollover ya las mantienen, y recalcularlas desde un `dates` viejo las
  // pisaria con valores que no corresponden a la edicion actual.
  //
  // Esto es lo que evita el "festival congelado": si el admin corrige las
  // fechas de texto, ends_on cambia con ellas y el rollover vuelve a saber
  // cuando termina la edicion.
  if (updates.dates !== undefined) {
    const rango = parseDateRange(updates.dates);
    values.push(rango.startsOn);
    sets.push(`starts_on = $${values.length}`);
    values.push(rango.endsOn);
    sets.push(`ends_on = $${values.length}`);
  }

  if (sets.length === 0) {
    // Nada que actualizar: se devuelve el estado actual en vez de un error, que
    // es lo que hacia el forEach sobre el JSON (escribia el archivo sin cambios).
    return getFestivalById(id);
  }

  values.push(id);
  const result = await pool.query(
    `UPDATE festivals
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${FESTIVAL_COLUMNS}`,
    values
  );

  return result.rows[0] ? rowToFestival(result.rows[0]) : null;
}

async function deleteFestival(id) {
  const result = await pool.query(
    `DELETE FROM festivals WHERE id = $1 RETURNING ${FESTIVAL_COLUMNS}`,
    [id]
  );
  return result.rows[0] ? rowToFestival(result.rows[0]) : null;
}

// ==========================================
// Rollover de ediciones (radar de lineups)
// ==========================================
//
// Cuando una edicion ya paso, la fila NO se borra: se resetea para la edicion
// siguiente. Asi se conservan los favoritos (user_festivals.festival_id), la URL
// y el id del festival, que es lo que referencia el resto del sistema.
//
// ends_on sale como ::text a proposito: node-postgres parsea DATE a un Date en
// hora local y eso puede correrse un dia segun el TZ del proceso. El reporte
// solo necesita el string ISO.

function rowToReportItem(row) {
  return {
    id: row.id,
    name: row.name,
    dates: row.dates,
    endsOn: row.ends_on,
    lineupStatus: row.lineup_status,
    artistCount: row.artist_count,
  };
}

async function getFestivalsEndedBefore(fecha) {
  const result = await pool.query(
    `SELECT id, name, dates, ends_on::text AS ends_on, lineup_status,
            COALESCE(array_length(lineup, 1), 0) AS artist_count
       FROM festivals
      WHERE ends_on IS NOT NULL
        AND ends_on < $1::date
        AND lineup_status <> 'hiatus'
      ORDER BY ends_on, sort_order`,
    [fecha]
  );

  return result.rows.map(rowToReportItem);
}

// Filas que necesita el reporte del radar. Trae TODO el catalogo (incluidos
// hiatus y los que no tienen fecha) porque el reporte tiene que poder explicar
// por que algo no se rota, no solo listar lo que si.
async function getFestivalsReportRows() {
  const result = await pool.query(
    `SELECT id, name, dates, ends_on::text AS ends_on, lineup_status,
            COALESCE(array_length(lineup, 1), 0) AS artist_count
       FROM festivals
      ORDER BY sort_order`
  );

  return result.rows.map(rowToReportItem);
}

// Rotar un festival a la edicion siguiente.
//
// El WHERE repite las condiciones del dry run a proposito: si alguien aprieta
// dos veces el boton, o si el cron corre mientras el admin aplica, la segunda
// ejecucion no encuentra nada (ends_on ya es NULL) y devuelve null. Es
// idempotente por construccion, no por confiar en el caller.
async function rolloverFestival(id, nextYear) {
  if (!Number.isInteger(nextYear)) {
    throw new Error('rolloverFestival: nextYear debe ser un entero');
  }

  const result = await pool.query(
    `UPDATE festivals
        SET lineup        = '{}',
            lineup_status = 'unannounced',
            -- Los flyers son la portada de la edicion que termino. Si no se
            -- limpian, el festival rolado sigue mostrando el poster viejo.
            flyer         = NULL,
            flyer_images  = '{}',
            starts_on     = NULL,
            ends_on       = NULL,
            dates         = $2,
            updated_at    = NOW()
      WHERE id            = $1
        AND ends_on       IS NOT NULL
        AND ends_on       < CURRENT_DATE
        AND lineup_status <> 'hiatus'
      RETURNING id, name, dates`,
    [id, `${nextYear} (fecha por anunciar)`]
  );

  return result.rows[0] || null;
}

// ==========================================
// Propuestas del radar de lineups (fase 4, paso 15)
// ==========================================
//
// `lineup_proposals` la escribe el extractor (paso 14) y la lee/revisa el panel
// admin. Esta capa es deliberadamente la única que toca `festivals` al aprobar:
// el extractor nunca publica. Las consultas de lectura exponen el catálogo
// actual junto a la propuesta para que el admin compare antes de decidir.

const PROPOSAL_COLUMNS = `
  p.id, p.festival_id, p.source_url, p.seen_hash, p.model, p.schema_version,
  p.lineup_status, p.artists_count, p.confidence, p.payload, p.extraction_error,
  p.review_status, p.reviewed_at, p.reviewed_by,
  p.first_seen_at, p.created_at, p.updated_at,
  f.name AS festival_name, f.lineup AS current_lineup,
  f.lineup_status AS current_lineup_status, f.dates AS festival_dates
`;

function proposalReviewError(code, message, statusCode) {
  const error = new Error(message);
  error.proposalCode = code;
  error.statusCode = statusCode;
  return error;
}

function rowToProposal(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const proposalDates = typeof payload.datesText === 'string' && payload.datesText.trim()
    ? { text: payload.datesText.trim(), ...parseDateRange(payload.datesText.trim()) }
    : null;

  return {
    id: Number(row.id),
    festivalId: row.festival_id,
    festivalName: row.festival_name,
    sourceUrl: row.source_url,
    seenHash: row.seen_hash,
    model: row.model,
    schemaVersion: row.schema_version,
    lineupStatus: row.lineup_status,
    artistsCount: row.artists_count,
    confidence: row.confidence === null ? null : Number(row.confidence),
    currentLineup: Array.isArray(row.current_lineup) ? row.current_lineup : [],
    currentLineupStatus: row.current_lineup_status,
    festivalDates: row.festival_dates,
    proposedArtists: prepareArtists(payload.artists || []),
    proposalDates,
    lineupAnnouncement: payload.lineupAnnouncement || null,
    tickets: payload.tickets || null,
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
    uncertainty: Array.isArray(payload.uncertainty) ? payload.uncertainty : [],
    pageEditionYear: payload.pageEditionYear ?? null,
    editionMatchesTarget: payload.editionMatchesTarget ?? null,
    extractionError: row.extraction_error,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    firstSeenAt: row.first_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getLineupProposals(status = 'pending') {
  const result = await pool.query(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM public.lineup_proposals p
       JOIN public.festivals f ON f.id = p.festival_id
      WHERE ($1::text IS NULL OR p.review_status = $1)
      ORDER BY p.first_seen_at DESC, p.id DESC
      LIMIT 200`,
    [status || null]
  );
  return result.rows.map(rowToProposal);
}

async function getLineupProposalCounts() {
  const result = await pool.query(
    `SELECT review_status, COUNT(*)::int AS count
       FROM public.lineup_proposals
      GROUP BY review_status`
  );
  return result.rows.reduce((counts, row) => {
    counts[row.review_status] = row.count;
    return counts;
  }, { pending: 0, approved: 0, rejected: 0, superseded: 0 });
}

// Aprueba una propuesta en una transacción: o se publica el lineup y se marca
// la revisión, o no se toca nada. `artists` permite que el admin edite la lista
// antes de publicar (por ejemplo, para corregir una limpieza de sufijos que no
// le gustó). `applyDates` es explícito: no se pisan fechas del catálogo por el
// solo hecho de aprobar artistas.
async function approveLineupProposal(id, { reviewedBy, applyDates = false, artists = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT ${PROPOSAL_COLUMNS}
         FROM public.lineup_proposals p
         JOIN public.festivals f ON f.id = p.festival_id
        WHERE p.id = $1
        FOR UPDATE OF p, f`,
      [id]
    );
    const row = selected.rows[0];
    if (!row) throw proposalReviewError('NOT_FOUND', 'Propuesta no encontrada.', 404);
    if (row.review_status !== 'pending') {
      throw proposalReviewError('ALREADY_REVIEWED', 'La propuesta ya fue revisada.', 409);
    }
    if (row.extraction_error) {
      throw proposalReviewError('EXTRACTION_ERROR', 'La propuesta tiene un error de extracción y no se puede aprobar.', 409);
    }

    const lineupStatus = row.lineup_status;
    if (!['confirmed', 'partial', 'unannounced'].includes(lineupStatus)) {
      throw proposalReviewError('INVALID_STATUS', 'La propuesta no tiene un estado de lineup válido.', 409);
    }

    // Si hay otra propuesta más nueva pendiente para el mismo festival, esta
    // quedó vieja. No se aprueba a ciegas: el admin puede rechazar la nueva y
    // volver, pero no publicar una grilla que ya fue reemplazada.
    const newer = await client.query(
      `SELECT id
         FROM public.lineup_proposals
        WHERE festival_id = $1
          AND review_status = 'pending'
          AND id <> $2
          AND (first_seen_at > $3 OR (first_seen_at = $3 AND id > $2))
        LIMIT 1`,
      [row.festival_id, row.id, row.first_seen_at]
    );
    if (newer.rows.length > 0) {
      throw proposalReviewError(
        'SUPERSEDED_BY_NEWER',
        `Hay una propuesta más nueva pendiente (id ${newer.rows[0].id}). Revisala en lugar de aprobar esta.`,
        409
      );
    }

    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const finalArtists = Array.isArray(artists)
      ? prepareArtists(artists)
      : prepareArtists(payload.artists || []);
    const currentLineup = Array.isArray(row.current_lineup) ? row.current_lineup : [];

    if (lineupStatus === 'unannounced' && finalArtists.length > 0) {
      throw proposalReviewError('INVALID_ARTISTS', 'Una propuesta "unannounced" no puede publicar artistas.', 400);
    }
    if (lineupStatus !== 'unannounced' && finalArtists.length === 0) {
      throw proposalReviewError('EMPTY_LINEUP', 'La propuesta no tiene artistas para publicar.', 409);
    }
    if (lineupStatus === 'unannounced' && currentLineup.length > 0) {
      throw proposalReviewError(
        'WOULD_CLEAR_LINEUP',
        'La propuesta no trae artistas y el catálogo ya tiene un lineup. No se aprueba para no borrarlo.',
        409
      );
    }

    const sets = ['lineup = $2', 'lineup_status = $3', 'updated_at = NOW()'];
    const values = [row.festival_id, finalArtists, lineupStatus];

    const datesText = typeof payload.datesText === 'string' ? payload.datesText.trim() : '';
    if (applyDates && datesText) {
      const range = parseDateRange(datesText);
      values.push(datesText);
      sets.push(`dates = $${values.length}`);
      values.push(range.startsOn);
      sets.push(`starts_on = $${values.length}`);
      values.push(range.endsOn);
      sets.push(`ends_on = $${values.length}`);
    }

    await client.query(
      `UPDATE public.festivals SET ${sets.join(', ')} WHERE id = $1`,
      values
    );

    // Las propuestas viejas del mismo festival que seguían pendientes quedan
    // superseded: ya no representan la versión más reciente del contenido.
    await client.query(
      `UPDATE public.lineup_proposals
          SET review_status = 'superseded', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE festival_id = $1 AND id <> $3 AND review_status = 'pending'`,
      [row.festival_id, reviewedBy || null, row.id]
    );

    const approved = await client.query(
      `UPDATE public.lineup_proposals
          SET review_status = 'approved', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, review_status, reviewed_at, reviewed_by`,
      [row.id, reviewedBy || null]
    );

    await client.query('COMMIT');

    return {
      proposal: approved.rows[0],
      festival: {
        id: row.festival_id,
        name: row.festival_name,
        lineup: finalArtists,
        lineupStatus,
        dates: applyDates && datesText ? datesText : row.festival_dates,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectLineupProposal(id, { reviewedBy } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT id, review_status FROM public.lineup_proposals WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const row = selected.rows[0];
    if (!row) throw proposalReviewError('NOT_FOUND', 'Propuesta no encontrada.', 404);
    if (row.review_status !== 'pending') {
      throw proposalReviewError('ALREADY_REVIEWED', 'La propuesta ya fue revisada.', 409);
    }

    const rejected = await client.query(
      `UPDATE public.lineup_proposals
          SET review_status = 'rejected', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, review_status, reviewed_at, reviewed_by`,
      [row.id, reviewedBy || null]
    );
    await client.query('COMMIT');
    return rejected.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// Propuestas de datos de festival (fase 4, paso 18/19)
// ==========================================
//
// El radar de datos detecta fechas/estado en la web oficial. Guarda la
// propuesta acá y el admin la confirma o rechaza. Aprobar es la única vía por
// la que estos cambios llegan a `festivals`.

const FACT_PROPOSAL_COLUMNS = `
  p.id, p.festival_id, p.source_url, p.page_url, p.seen_hash, p.model,
  p.schema_version, p.proposed_dates, p.proposed_lineup_status,
  p.proposed_starts_on::text AS proposed_starts_on,
  p.proposed_ends_on::text AS proposed_ends_on,
  p.evidence, p.confidence, p.payload, p.review_status,
  p.reviewed_at, p.reviewed_by, p.first_seen_at, p.created_at, p.updated_at,
  f.name AS festival_name, f.dates AS current_dates,
  f.lineup_status AS current_lineup_status,
  f.starts_on::text AS current_starts_on, f.ends_on::text AS current_ends_on
`;

function rowToFactProposal(row) {
  return {
    id: Number(row.id),
    festivalId: row.festival_id,
    festivalName: row.festival_name,
    sourceUrl: row.source_url,
    pageUrl: row.page_url,
    seenHash: row.seen_hash,
    model: row.model,
    schemaVersion: row.schema_version,
    proposedDates: row.proposed_dates,
    proposedLineupStatus: row.proposed_lineup_status,
    proposedStartsOn: row.proposed_starts_on,
    proposedEndsOn: row.proposed_ends_on,
    currentDates: row.current_dates,
    currentLineupStatus: row.current_lineup_status,
    currentStartsOn: row.current_starts_on,
    currentEndsOn: row.current_ends_on,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    confidence: row.confidence === null ? null : Number(row.confidence),
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    firstSeenAt: row.first_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getFestivalFactProposals(status = 'pending') {
  const result = await pool.query(
    `SELECT ${FACT_PROPOSAL_COLUMNS}
       FROM public.festival_fact_proposals p
       JOIN public.festivals f ON f.id = p.festival_id
      WHERE ($1::text IS NULL OR p.review_status = $1)
      ORDER BY p.first_seen_at DESC, p.id DESC
      LIMIT 200`,
    [status || null]
  );
  return result.rows.map(rowToFactProposal);
}

async function getFestivalFactProposalCounts() {
  const result = await pool.query(
    `SELECT review_status, COUNT(*)::int AS count
       FROM public.festival_fact_proposals
      GROUP BY review_status`
  );
  return result.rows.reduce((counts, row) => {
    counts[row.review_status] = row.count;
    return counts;
  }, { pending: 0, approved: 0, rejected: 0, superseded: 0 });
}

async function approveFestivalFactProposal(id, { reviewedBy, dates = null, lineupStatus = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT ${FACT_PROPOSAL_COLUMNS}
         FROM public.festival_fact_proposals p
         JOIN public.festivals f ON f.id = p.festival_id
        WHERE p.id = $1
        FOR UPDATE OF p, f`,
      [id]
    );
    const row = selected.rows[0];
    if (!row) throw proposalReviewError('NOT_FOUND', 'Propuesta de datos no encontrada.', 404);
    if (row.review_status !== 'pending') {
      throw proposalReviewError('ALREADY_REVIEWED', 'La propuesta de datos ya fue revisada.', 409);
    }

    const newer = await client.query(
      `SELECT id
         FROM public.festival_fact_proposals
        WHERE festival_id = $1
          AND review_status = 'pending'
          AND id <> $2
          AND (first_seen_at > $3 OR (first_seen_at = $3 AND id > $2))
        LIMIT 1`,
      [row.festival_id, row.id, row.first_seen_at]
    );
    if (newer.rows.length > 0) {
      throw proposalReviewError(
        'SUPERSEDED_BY_NEWER',
        `Hay una propuesta de datos más nueva pendiente (id ${newer.rows[0].id}). Revisala en lugar de aprobar esta.`,
        409
      );
    }

    const allowedStatuses = ['confirmed', 'partial', 'unannounced', 'hiatus'];
    const finalStatus = lineupStatus || row.proposed_lineup_status || row.current_lineup_status;
    if (!allowedStatuses.includes(finalStatus)) {
      throw proposalReviewError('INVALID_STATUS', 'La propuesta de datos no tiene un estado válido.', 400);
    }

    const finalDates = (typeof dates === 'string' && dates.trim())
      ? dates.trim()
      : (row.proposed_dates || row.current_dates);
    if (!finalDates) {
      throw proposalReviewError('MISSING_DATES', 'La propuesta de datos no tiene fechas para aplicar.', 409);
    }

    let startsOn = row.proposed_starts_on;
    let endsOn = row.proposed_ends_on;
    if (!startsOn || !endsOn || finalDates !== row.proposed_dates) {
      const range = parseDateRange(finalDates);
      startsOn = range.startsOn;
      endsOn = range.endsOn;
    }

    await client.query(
      `UPDATE public.festivals
          SET lineup_status = $2,
              dates = $3,
              starts_on = $4,
              ends_on = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [row.festival_id, finalStatus, finalDates, startsOn, endsOn]
    );

    await client.query(
      `UPDATE public.festival_fact_proposals
          SET review_status = 'superseded', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE festival_id = $1 AND id <> $3 AND review_status = 'pending'`,
      [row.festival_id, reviewedBy || null, row.id]
    );

    const approved = await client.query(
      `UPDATE public.festival_fact_proposals
          SET review_status = 'approved', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, review_status, reviewed_at, reviewed_by`,
      [row.id, reviewedBy || null]
    );

    await client.query('COMMIT');
    return {
      proposal: approved.rows[0],
      festival: {
        id: row.festival_id,
        name: row.festival_name,
        dates: finalDates,
        lineupStatus: finalStatus,
        startsOn,
        endsOn,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectFestivalFactProposal(id, { reviewedBy } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT id, review_status FROM public.festival_fact_proposals WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const row = selected.rows[0];
    if (!row) throw proposalReviewError('NOT_FOUND', 'Propuesta de datos no encontrada.', 404);
    if (row.review_status !== 'pending') {
      throw proposalReviewError('ALREADY_REVIEWED', 'La propuesta de datos ya fue revisada.', 409);
    }

    const rejected = await client.query(
      `UPDATE public.festival_fact_proposals
          SET review_status = 'rejected', reviewed_at = NOW(),
              reviewed_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, review_status, reviewed_at, reviewed_by`,
      [row.id, reviewedBy || null]
    );
    await client.query('COMMIT');
    return rejected.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================
// Funciones de Festivales Favoritos
// ==========================================

async function getUserFavoriteFestivals(userId) {
  const result = await pool.query(`
    SELECT id, festival_id, added_at
    FROM user_festivals
    WHERE user_id = $1
    ORDER BY added_at DESC
  `, [userId]);
  return result.rows;
}

async function addUserFestival(userId, festivalId) {
  try {
    const result = await pool.query(
      'INSERT INTO user_festivals (user_id, festival_id) VALUES ($1, $2) RETURNING *',
      [userId, festivalId]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return null; // Ya existe
    }
    throw err;
  }
}

async function removeUserFestival(userId, festivalId) {
  const result = await pool.query(
    'DELETE FROM user_festivals WHERE user_id = $1 AND festival_id = $2',
    [userId, festivalId]
  );
  return result.rowCount > 0;
}

async function isUserFestival(userId, festivalId) {
  const result = await pool.query(
    'SELECT id FROM user_festivals WHERE user_id = $1 AND festival_id = $2',
    [userId, festivalId]
  );
  return result.rows.length > 0;
}

// ==========================================
// Cache de Tour Dates
// ==========================================

const TOUR_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 horas en ms

async function getTourCache(artistName, region) {
  const result = await pool.query(`
    SELECT data, fetched_at FROM tour_cache
    WHERE LOWER(artist_name) = LOWER($1) AND region = $2
  `, [artistName, region]);

  const row = result.rows[0];
  if (!row) return null;

  // Verificar si el cache expiro
  const now = Date.now();
  if (now - parseInt(row.fetched_at) > TOUR_CACHE_DURATION) {
    return null; // Cache expirado
  }

  return JSON.parse(row.data);
}

async function setTourCache(artistName, region, data) {
  const now = Date.now();
  const jsonData = JSON.stringify(data);

  await pool.query(`
    INSERT INTO tour_cache (artist_name, region, data, fetched_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(artist_name, region) DO UPDATE SET
      data = EXCLUDED.data,
      fetched_at = EXCLUDED.fetched_at
  `, [artistName, region, jsonData, now]);
}

async function cleanExpiredTourCache() {
  const expiredBefore = Date.now() - TOUR_CACHE_DURATION;
  await pool.query('DELETE FROM tour_cache WHERE fetched_at < $1', [expiredBefore]);
}

// ==========================================
// Sugerencias de Festivales
// ==========================================

async function createFestivalSuggestion({ userId, festivalName, country, city, datesInfo, website }) {
  const result = await pool.query(`
    INSERT INTO festival_suggestions (user_id, festival_name, country, city, dates_info, website)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [userId || null, festivalName.trim(), country, city.trim(), datesInfo?.trim() || null, website?.trim() || null]);

  return result.rows[0];
}

async function getFestivalSuggestions(status = null) {
  let result;
  if (status) {
    result = await pool.query(`
      SELECT fs.*, u.name as user_name, u.email as user_email
      FROM festival_suggestions fs
      LEFT JOIN users u ON fs.user_id = u.id
      WHERE fs.status = $1
      ORDER BY fs.created_at DESC
    `, [status]);
  } else {
    result = await pool.query(`
      SELECT fs.*, u.name as user_name, u.email as user_email
      FROM festival_suggestions fs
      LEFT JOIN users u ON fs.user_id = u.id
      ORDER BY fs.created_at DESC
    `);
  }
  return result.rows;
}

async function updateSuggestionStatus(suggestionId, status) {
  const result = await pool.query(
    'UPDATE festival_suggestions SET status = $1 WHERE id = $2',
    [status, suggestionId]
  );
  return result.rowCount > 0;
}

async function getSuggestionById(suggestionId) {
  const result = await pool.query(`
    SELECT fs.*, u.name as user_name, u.email as user_email
    FROM festival_suggestions fs
    LEFT JOIN users u ON fs.user_id = u.id
    WHERE fs.id = $1
  `, [suggestionId]);
  return result.rows[0];
}

async function deleteSuggestion(suggestionId) {
  const result = await pool.query('DELETE FROM festival_suggestions WHERE id = $1', [suggestionId]);
  return result.rowCount > 0;
}

// ==========================================
// Utilidades
// ==========================================

function generateSessionId() {
  // crypto, no Math.random: los ids de sesion son credenciales bearer (con la
  // cookie httpOnly, quien tenga el string puede pedir un festival con los
  // datos del usuario). Math.random() no es CSPRNG y con 7 dias de vida el
  // espacio de adivinar es innecesariamente grande.
  return crypto.randomBytes(32).toString('base64url');
}

// Limpiar sesiones expiradas cada hora, y el cache de tours cada 6 horas.
//
// Solo en dev local (`node app.js`). En Vercel los setInterval no se ejecutan de
// forma confiable: la funcion se congela entre requests. Y ademas son
// redundantes, porque ambos datos se limpian solos al leer: las sesiones con
// `expires_at > NOW()` y el tour cache comparando `fetched_at` contra
// TOUR_CACHE_DURATION.
if (require.main === module) {
  setInterval(() => cleanExpiredSessions().catch(console.error), 60 * 60 * 1000);
  setInterval(() => cleanExpiredTourCache().catch(console.error), 6 * 60 * 60 * 1000);
}

module.exports = {
  pool,
  initDatabase,
  findOrCreateUser,
  getUserById,
  getUserByEmail,
  getLastfmUsername,
  setLastfmUsername,
  getSpotifyConnection,
  setSpotifyConnection,
  deleteSpotifyConnection,
  // Auth con email/password
  registerUser,
  loginUser,
  deleteUser,
  // Roles
  getUserRole,
  isAdmin,
  isDev,
  createSession,
  getSession,
  deleteSession,
  getUserArtists,
  getDemoProfile,
  addUserArtist,
  removeUserArtist,
  getUserGenres,
  addUserGenre,
  removeUserGenre,
  getAvailableGenres,
  // Catalogo de festivales (tabla festivals, antes server/festivals.json)
  getFestivals,
  getAdminFestivals,
  getFestivalById,
  createFestival,
  updateFestival,
  deleteFestival,
  // Rollover de ediciones (fechas derivadas + reset de la edicion siguiente)
  getFestivalsEndedBefore,
  getFestivalsReportRows,
  rolloverFestival,
  // Campos que PUT /api/admin/festivals/:id puede escribir. Exportado para que
  // un test pueda verificar que el SET de la query sale de acá y de otro lugar.
  UPDATABLE_FESTIVAL_FIELDS,
  // Propuestas del radar de lineups (paso 15)
  getLineupProposals,
  getLineupProposalCounts,
  approveLineupProposal,
  rejectLineupProposal,
  // Propuestas de datos de festival (fase 4, paso 18/19)
  getFestivalFactProposals,
  getFestivalFactProposalCounts,
  approveFestivalFactProposal,
  rejectFestivalFactProposal,
  // Festivales favoritos
  getUserFavoriteFestivals,
  addUserFestival,
  removeUserFestival,
  isUserFestival,
  // Tour cache
  getTourCache,
  setTourCache,
  cleanExpiredTourCache,
  // Sugerencias de festivales
  createFestivalSuggestion,
  getFestivalSuggestions,
  updateSuggestionStatus,
  getSuggestionById,
  deleteSuggestion,
};
