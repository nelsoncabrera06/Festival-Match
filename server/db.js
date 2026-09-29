const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SALT_ROUNDS = 10;

// Configurar pool de conexiones PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/festival_match',

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
  ssl: { rejectUnauthorized: false }
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
      picture TEXT,
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

  console.log('Base de datos PostgreSQL inicializada');
}

// ==========================================
// Funciones de Usuario
// ==========================================

async function findOrCreateUser(googleProfile) {
  const { sub: googleId, email, name, picture } = googleProfile;

  // Buscar usuario existente
  const result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  let user = result.rows[0];

  if (user) {
    // Actualizar datos si cambiaron
    await pool.query(
      'UPDATE users SET email = $1, name = $2, picture = $3 WHERE id = $4',
      [email, name, picture, user.id]
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
      'INSERT INTO users (google_id, email, name, picture, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [googleId, email, name, picture, role]
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
    SELECT s.*, u.id as user_id, u.email, u.name, u.picture
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
  const result = await pool.query(
    `INSERT INTO festivals
       (id, name, city, location, country, dates, website, image, flyer,
        flyer_images, description, lineup_status, lineup, note, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
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
  getFestivalById,
  createFestival,
  updateFestival,
  deleteFestival,
  // Campos que PUT /api/admin/festivals/:id puede escribir. Exportado para que
  // un test pueda verificar que el SET de la query sale de acá y de otro lugar.
  UPDATABLE_FESTIVAL_FIELDS,
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
