/**
 * Genera migrations/002_festivals.sql a partir de server/festivals.json.
 *
 * Por que el seed es un archivo generado y no se aplica a mano:
 * el catalogo de 58 festivales y 648 artistas se edita en festivals.json, que es
 * comodo para corregir un lineup. Aplicar 58 INSERTs a mano cada vez que cambia un
 * artista seria una fuente de errores; generarlos deja el JSON como unica
 * fuente editable y el .sql commiteado como el registro exacto de lo que se
 * aplico a la base.
 *
 * Uso:
 *   node scripts/generate-festivals-migration.js
 *   node scripts/generate-festivals-migration.js --check   # solo verifica que este al dia
 *
 * El .sql se commitea y se aplica con psql (ver AGENTS.md), en local y en
 * produccion por igual.
 */

const fs = require('fs');
const path = require('path');

const FESTIVALS_JSON = path.join(__dirname, '..', 'server', 'festivals.json');
const OUTPUT_SQL = path.join(__dirname, '..', 'migrations', '002_festivals.sql');

// Un literal de texto de Postgres. El unico caracter que hay que escapar es el
// apostrofe, duplicandolo: el catalogo tiene "Open'er Festival" y
// "Parque O'Higgins, Santiago".
//
// Los acentos (Ben Bohmer, Keaarj, Tiesto) van tal cual: el archivo es UTF-8 y
// Postgres asume UTF8 en el client encoding. No hace falta \uXXXX.
function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Un TEXT[] de Postgres. Se arma con ARRAY[...]::text[] en vez del literal
// '{a,b}' porque es immune a los caracteres que separan elementos dentro de un
// literal de array (comas, llaves, barras invertidas).
function sqlTextArray(values) {
  if (!values || values.length === 0) return `'{}'::text[]`;
  return `ARRAY[${values.map(sqlText).join(', ')}]::text[]`;
}

function generate(festivals) {
  const rows = festivals.map((f, index) => {
    // sort_order conserva el orden del array en el JSON. Ese orden es curado a
    // mano (los festivals Twins como Hurricane/Southside, o los que comparten
    // lineup, estan juntos), asi que perderlo seria una regresion visible en el
    // panel admin. Con ORDER BY sort_order la query devuelve exactamente el
    // mismo orden que el archivo.
    return `  (
    ${sqlText(f.id)},
    ${sqlText(f.name)},
    ${sqlText(f.city)},
    ${sqlText(f.location)},
    ${sqlText(f.country)},
    ${sqlText(f.dates)},
    ${sqlText(f.website)},
    ${sqlText(f.image)},
    ${sqlText(f.flyer)},
    ${sqlTextArray(f.flyerImages)},
    ${sqlText(f.description)},
    ${sqlText(f.lineupStatus)},
    ${sqlTextArray(f.lineup)},
    ${sqlText(f.note)},
    ${index + 1}
  )`;
  });

  const totalArtists = festivals.reduce((sum, f) => sum + (f.lineup || []).length, 0);
  const withLineup = festivals.filter((f) => (f.lineup || []).length > 0).length;

  return `-- =============================================================================
-- Migracion 002: catalogo de festivales
-- =============================================================================
--
-- QUE HACE ESTA MIGRACION
--
-- Mueve el catalogo de 58 festivales de server/festivals.json a una tabla
-- \`festivals\`. Es la ultima parte del catalogo en el repo, y la unica que
-- estaba rota: el panel de admin escribia el catalogo con fs.writeFileSync
-- sobre festivals.json, y en Vercel el filesystem es read-only, asi que
-- PUT /api/admin/festivals/:id, DELETE /api/admin/festivals/:id y
-- POST /api/admin/suggestions/:id/approve devuelven 500 con EROFS.
--
-- GENERADO, NO EDITAR A MANO
--
-- Este archivo lo produce scripts/generate-festivals-migration.js a partir de
-- server/festivals.json. Para cambiar un lineup se edita el JSON y se regenera:
--
--   node scripts/generate-festivals-migration.js
--   psql "$DATABASE_URL" -f migrations/002_festivals.sql
--
-- Editar el .sql a mano se pierde en la proxima regeneracion.
--
-- =============================================================================
-- Schema
-- =============================================================================
--
-- TEXT PRIMARY KEY y no SERIAL: el id es un slug legible (primavera-sound,
-- rock-am-ring) que ya se usaba en el JSON, aparece en las URLs del frontend
-- y es la columna por la que user_festivals.festival_id hace referencia cruzada.
-- Cambiarlo ahora seria una migracion de datos sin ganancia.
--
-- lineup y flyer_images son TEXT[] y no jsonb: son listas de strings planos, y
-- un array de Postgres las maneja el matching sin parsear JSON por artista.
-- El codigo de matching (server/server.js) sigue recibiendo \`lineup\` como un
-- array de JS, o sea que la forma del objeto festival no cambia y el matching
-- no necesita refactor.
--
-- \`country\` NO tiene indice a proposito. El filtro por region (REGIONS en
-- server/server.js) es un \`country = ANY($1)\` con ~25 codigos sobre 58 filas:
-- un seq scan sobre 58 filas es mas rapido que un indice, y el indice solo
-- empezaria a justificar si el catalogo llegara a miles de filas.
--
-- \`region\` tampoco es columna: se deriva de \`country\` en cada request. Si fuera
-- columna habria dos definiciones de region peleandose en el codigo.
--
-- El CHECK de lineup_status protege los datos: lineup_status lo escribe el
-- panel de admin (PUT /api/admin/festivals/:id) desde un select, y sin el
-- CHECK un valor mal escrito entraria al matching y el frontend caeria al
-- default 'unannounced' en silencio (public/app.js usa
-- statusConfig[festival.lineupStatus] || statusConfig['unannounced']).
-- Los 4 valores son los de public/i18n/*.json.

BEGIN;

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

  -- Orden curado del archivo original. Ver comentario en el INSERT.
  sort_order    INTEGER NOT NULL,

  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT festivals_lineup_status_check
    CHECK (lineup_status IN ('confirmed', 'partial', 'unannounced', 'hiatus'))
);

-- =============================================================================
-- Seed: los 58 festivales de festivals.json
-- =============================================================================
--
-- ${festivals.length} festivales, ${totalArtists} artistas en lineups, ${withLineup} con lineup publicado.
--
-- ON CONFLICT (id) DO UPDATE: hace que re-correrla no duplique las 58 filas.
--
-- OJO CON LO QUE HACE: el DO UPDATE sobrescribe TODAS las columnas que trae el
-- INSERT, incluyendo \`lineup\` y \`lineup_status\`. O sea que re-correr esta
-- migracion DESHACE los cambios hechos desde el panel admin. No es un "upsert
-- que preserva lo editado": es "el JSON manda".
--
-- Es la semantica que quiero, pero hay que saberlo antes de correrla dos veces:
-- si editaste un lineup desde el panel, regenerar y re-aplicar el seed te
-- devuelve el lineup al estado del JSON. Para cambios puntuales, editar en el
-- panel. Para cambiar el catalogo de verdad, editar el JSON y regenerar.
--
-- updated_at se actualiza siempre en cada re-aplicacion, incluso si el lineup
-- no cambio, asi que no sirve para saber que toco el catalogo.

INSERT INTO festivals (
  id, name, city, location, country, dates, website, image, flyer,
  flyer_images, description, lineup_status, lineup, note, sort_order
) VALUES
${rows.join(',\n')}
ON CONFLICT (id) DO UPDATE SET
  name          = EXCLUDED.name,
  city          = EXCLUDED.city,
  location      = EXCLUDED.location,
  country       = EXCLUDED.country,
  dates         = EXCLUDED.dates,
  website       = EXCLUDED.website,
  image         = EXCLUDED.image,
  flyer         = EXCLUDED.flyer,
  flyer_images  = EXCLUDED.flyer_images,
  description   = EXCLUDED.description,
  lineup_status = EXCLUDED.lineup_status,
  lineup        = EXCLUDED.lineup,
  note          = EXCLUDED.note,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = NOW();

COMMIT;

-- =============================================================================
-- Notas de la migracion
-- =============================================================================
--
-- Lo que initDatabase() sigue haciendo por su cuenta: initDatabase() tambien
-- crea esta tabla (ver server/db.js), asi que en dev local \`npm run dev\` levanta
-- con el schema listo. Lo que NO hace es el seed: las 58 filas se aplican con
-- psql, en local y en produccion por igual. Es el mismo criterio que
-- migrations/001_init.sql, y por el mismo motivo: en Vercel initDatabase()
-- nunca corre, asi que el schema de produccion existe unicamente por
-- migraciones.
--
-- Para levantar el catalogo en una base local nueva:
--
--   node scripts/generate-festivals-migration.js
--   createdb festival_match
--   psql festival_match -f migrations/001_init.sql
--   psql festival_match -f migrations/002_festivals.sql
`;
}

function main() {
  const festivals = JSON.parse(fs.readFileSync(FESTIVALS_JSON, 'utf8'));
  const sql = generate(festivals);

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT_SQL)) {
      console.error('Falta migrations/002_festivals.sql. Correlo sin --check.');
      process.exit(1);
    }
    const current = fs.readFileSync(OUTPUT_SQL, 'utf8');
    if (current !== sql) {
      console.error('migrations/002_festivals.sql esta desactualizado respecto de festivals.json.');
      console.error('Corré: node scripts/generate-festivals-migration.js');
      process.exit(1);
    }
    console.log('002_festivals.sql esta al dia con festivals.json');
    return;
  }

  fs.writeFileSync(OUTPUT_SQL, sql, 'utf8');
  const totalArtists = festivals.reduce((sum, f) => sum + (f.lineup || []).length, 0);
  console.log(`migrations/002_festivals.sql generado: ${festivals.length} festivales, ${totalArtists} artistas en lineups.`);
}

main();
