const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// Configurar pool de conexiones PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/festival_match'
});

// Lista de emails con roles especiales (admins/devs)
const ADMIN_EMAILS = [
  'nelsoncabrera06@gmail.com', // Nelson Cabrera - admin,dev
];

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
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, artist_name)
    );

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
    // Crear nuevo usuario
    const insertResult = await pool.query(
      'INSERT INTO users (google_id, email, name, picture) VALUES ($1, $2, $3, $4) RETURNING *',
      [googleId, email, name, picture]
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
    SELECT id, artist_name, musicbrainz_id, added_at
    FROM user_artists
    WHERE user_id = $1
    ORDER BY added_at DESC
  `, [userId]);
  return result.rows;
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 64; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Limpiar sesiones expiradas cada hora
setInterval(() => cleanExpiredSessions().catch(console.error), 60 * 60 * 1000);

// Limpiar cache de tours expirado cada 6 horas
setInterval(() => cleanExpiredTourCache().catch(console.error), 6 * 60 * 60 * 1000);

module.exports = {
  pool,
  initDatabase,
  findOrCreateUser,
  getUserById,
  getUserByEmail,
  getLastfmUsername,
  setLastfmUsername,
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
  addUserArtist,
  removeUserArtist,
  getUserGenres,
  addUserGenre,
  removeUserGenre,
  getAvailableGenres,
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
