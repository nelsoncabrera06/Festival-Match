const Database = require('better-sqlite3');
const path = require('path');

// Inicializar base de datos SQLite
const dbPath = path.join(__dirname, 'festival-match.db');
const db = new Database(dbPath);

// Habilitar foreign keys
db.pragma('foreign_keys = ON');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    artist_name TEXT NOT NULL,
    musicbrainz_id TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, artist_name COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS user_genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    genre TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, genre COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS user_festivals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    festival_id TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, festival_id)
  );

  -- Agregar columna lastfm_username si no existe (para DBs existentes)
  -- SQLite no soporta ADD COLUMN IF NOT EXISTS, lo manejamos con try/catch abajo

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tour_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_name TEXT NOT NULL,
    region TEXT NOT NULL,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    UNIQUE(artist_name, region)
  );

  CREATE TABLE IF NOT EXISTS festival_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    festival_name TEXT NOT NULL,
    country TEXT NOT NULL,
    city TEXT NOT NULL,
    dates_info TEXT,
    website TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Agregar columna lastfm_username a users si no existe (migracion)
try {
  db.exec('ALTER TABLE users ADD COLUMN lastfm_username TEXT');
} catch (err) {
  // La columna ya existe, ignorar el error
}

// Agregar columna role a users si no existe (migracion)
// Roles: 'user' (default), 'admin', 'dev', o combinaciones separadas por coma: 'admin,dev'
try {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
} catch (err) {
  // La columna ya existe, ignorar el error
}

// Lista de emails con roles especiales (admins/devs)
const ADMIN_EMAILS = [
  'nelsoncabrera06@gmail.com', // Nelson Cabrera - admin,dev
];

// Asignar roles a admins existentes
ADMIN_EMAILS.forEach(email => {
  db.prepare("UPDATE users SET role = 'admin,dev' WHERE email = ? AND (role IS NULL OR role = 'user')").run(email);
});

// ==========================================
// Funciones de Usuario
// ==========================================

function findOrCreateUser(googleProfile) {
  const { sub: googleId, email, name, picture } = googleProfile;

  // Buscar usuario existente
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

  if (user) {
    // Actualizar datos si cambiaron
    db.prepare(`
      UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?
    `).run(email, name, picture, user.id);
  } else {
    // Crear nuevo usuario
    const result = db.prepare(`
      INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)
    `).run(googleId, email, name, picture);
    user = { id: result.lastInsertRowid, google_id: googleId, email, name, picture };
  }

  return user;
}

function getUserById(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getLastfmUsername(userId) {
  const row = db.prepare('SELECT lastfm_username FROM users WHERE id = ?').get(userId);
  return row?.lastfm_username || null;
}

function setLastfmUsername(userId, username) {
  db.prepare('UPDATE users SET lastfm_username = ? WHERE id = ?').run(username || null, userId);
  return true;
}

function getUserRole(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return row?.role || 'user';
}

function isAdmin(userId) {
  const role = getUserRole(userId);
  return role.includes('admin');
}

function isDev(userId) {
  const role = getUserRole(userId);
  return role.includes('dev');
}

// ==========================================
// Funciones de Sesion
// ==========================================

function createSession(userId) {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)
  `).run(sessionId, userId, expiresAt.toISOString());

  return sessionId;
}

function getSession(sessionId) {
  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.email, u.name, u.picture
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).get(sessionId);

  return session;
}

function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// ==========================================
// Funciones de Artistas
// ==========================================

function getUserArtists(userId) {
  return db.prepare(`
    SELECT id, artist_name, musicbrainz_id, added_at
    FROM user_artists
    WHERE user_id = ?
    ORDER BY added_at DESC
  `).all(userId);
}

function addUserArtist(userId, artistName, musicbrainzId = null) {
  try {
    const result = db.prepare(`
      INSERT INTO user_artists (user_id, artist_name, musicbrainz_id)
      VALUES (?, ?, ?)
    `).run(userId, artistName.trim(), musicbrainzId);
    return { id: result.lastInsertRowid, artist_name: artistName.trim(), musicbrainz_id: musicbrainzId };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return null; // Ya existe
    }
    throw err;
  }
}

function removeUserArtist(userId, artistId) {
  const result = db.prepare(`
    DELETE FROM user_artists WHERE id = ? AND user_id = ?
  `).run(artistId, userId);
  return result.changes > 0;
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

function getUserGenres(userId) {
  return db.prepare(`
    SELECT id, genre, added_at
    FROM user_genres
    WHERE user_id = ?
    ORDER BY added_at DESC
  `).all(userId);
}

function addUserGenre(userId, genre) {
  try {
    const result = db.prepare(`
      INSERT INTO user_genres (user_id, genre)
      VALUES (?, ?)
    `).run(userId, genre.trim());
    return { id: result.lastInsertRowid, genre: genre.trim() };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return null; // Ya existe
    }
    throw err;
  }
}

function removeUserGenre(userId, genreId) {
  const result = db.prepare(`
    DELETE FROM user_genres WHERE id = ? AND user_id = ?
  `).run(genreId, userId);
  return result.changes > 0;
}

// ==========================================
// Funciones de Festivales Favoritos
// ==========================================

function getUserFavoriteFestivals(userId) {
  return db.prepare(`
    SELECT id, festival_id, added_at
    FROM user_festivals
    WHERE user_id = ?
    ORDER BY added_at DESC
  `).all(userId);
}

function addUserFestival(userId, festivalId) {
  try {
    const result = db.prepare(`
      INSERT INTO user_festivals (user_id, festival_id)
      VALUES (?, ?)
    `).run(userId, festivalId);
    return { id: result.lastInsertRowid, festival_id: festivalId };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return null; // Ya existe
    }
    throw err;
  }
}

function removeUserFestival(userId, festivalId) {
  const result = db.prepare(`
    DELETE FROM user_festivals WHERE user_id = ? AND festival_id = ?
  `).run(userId, festivalId);
  return result.changes > 0;
}

function isUserFestival(userId, festivalId) {
  const row = db.prepare(`
    SELECT id FROM user_festivals WHERE user_id = ? AND festival_id = ?
  `).get(userId, festivalId);
  return !!row;
}

// ==========================================
// Cache de Tour Dates
// ==========================================

const TOUR_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 horas en ms

function getTourCache(artistName, region) {
  const row = db.prepare(`
    SELECT data, fetched_at FROM tour_cache
    WHERE artist_name = ? COLLATE NOCASE AND region = ?
  `).get(artistName, region);

  if (!row) return null;

  // Verificar si el cache expiró
  const now = Date.now();
  if (now - row.fetched_at > TOUR_CACHE_DURATION) {
    return null; // Cache expirado
  }

  return JSON.parse(row.data);
}

function setTourCache(artistName, region, data) {
  const now = Date.now();
  const jsonData = JSON.stringify(data);

  db.prepare(`
    INSERT INTO tour_cache (artist_name, region, data, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(artist_name, region) DO UPDATE SET
      data = excluded.data,
      fetched_at = excluded.fetched_at
  `).run(artistName, region, jsonData, now);
}

function cleanExpiredTourCache() {
  const expiredBefore = Date.now() - TOUR_CACHE_DURATION;
  db.prepare('DELETE FROM tour_cache WHERE fetched_at < ?').run(expiredBefore);
}

// ==========================================
// Sugerencias de Festivales
// ==========================================

function createFestivalSuggestion({ userId, festivalName, country, city, datesInfo, website }) {
  const result = db.prepare(`
    INSERT INTO festival_suggestions (user_id, festival_name, country, city, dates_info, website)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId || null, festivalName.trim(), country, city.trim(), datesInfo?.trim() || null, website?.trim() || null);

  return {
    id: result.lastInsertRowid,
    festival_name: festivalName.trim(),
    country,
    city: city.trim(),
    dates_info: datesInfo?.trim() || null,
    website: website?.trim() || null,
    status: 'pending'
  };
}

function getFestivalSuggestions(status = null) {
  if (status) {
    return db.prepare(`
      SELECT fs.*, u.name as user_name, u.email as user_email
      FROM festival_suggestions fs
      LEFT JOIN users u ON fs.user_id = u.id
      WHERE fs.status = ?
      ORDER BY fs.created_at DESC
    `).all(status);
  }

  return db.prepare(`
    SELECT fs.*, u.name as user_name, u.email as user_email
    FROM festival_suggestions fs
    LEFT JOIN users u ON fs.user_id = u.id
    ORDER BY fs.created_at DESC
  `).all();
}

function updateSuggestionStatus(suggestionId, status) {
  const result = db.prepare(`
    UPDATE festival_suggestions SET status = ? WHERE id = ?
  `).run(status, suggestionId);
  return result.changes > 0;
}

function getSuggestionById(suggestionId) {
  return db.prepare(`
    SELECT fs.*, u.name as user_name, u.email as user_email
    FROM festival_suggestions fs
    LEFT JOIN users u ON fs.user_id = u.id
    WHERE fs.id = ?
  `).get(suggestionId);
}

function deleteSuggestion(suggestionId) {
  const result = db.prepare('DELETE FROM festival_suggestions WHERE id = ?').run(suggestionId);
  return result.changes > 0;
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
setInterval(cleanExpiredSessions, 60 * 60 * 1000);

// Limpiar cache de tours expirado cada 6 horas
setInterval(cleanExpiredTourCache, 6 * 60 * 60 * 1000);

module.exports = {
  db,
  findOrCreateUser,
  getUserById,
  getLastfmUsername,
  setLastfmUsername,
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
