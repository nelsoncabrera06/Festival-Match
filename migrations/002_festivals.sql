-- =============================================================================
-- Migracion 002: catalogo de festivales
-- =============================================================================
--
-- QUE HACE ESTA MIGRACION
--
-- Mueve el catalogo de 58 festivales de server/festivals.json a una tabla
-- `festivals`. Es la ultima parte del catalogo en el repo, y la unica que
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
-- El codigo de matching (server/server.js) sigue recibiendo `lineup` como un
-- array de JS, o sea que la forma del objeto festival no cambia y el matching
-- no necesita refactor.
--
-- `country` NO tiene indice a proposito. El filtro por region (REGIONS en
-- server/server.js) es un `country = ANY($1)` con ~25 codigos sobre 58 filas:
-- un seq scan sobre 58 filas es mas rapido que un indice, y el indice solo
-- empezaria a justificar si el catalogo llegara a miles de filas.
--
-- `region` tampoco es columna: se deriva de `country` en cada request. Si fuera
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
-- 58 festivales, 648 artistas en lineups, 36 con lineup publicado.
--
-- ON CONFLICT (id) DO UPDATE: hace que re-correrla no duplique las 58 filas.
--
-- OJO CON LO QUE HACE: el DO UPDATE sobrescribe TODAS las columnas que trae el
-- INSERT, incluyendo `lineup` y `lineup_status`. O sea que re-correr esta
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
  (
    'primavera-sound',
    'Primavera Sound',
    'Barcelona',
    'Barcelona, España',
    'ES',
    '3-7 Junio 2026',
    'https://www.primaverasound.com',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    '/images/primavera sound 2026.webp',
    ARRAY['/images/primavera-sound/primavera sound 2026.png']::text[],
    NULL,
    'confirmed',
    ARRAY['The Cure', 'Doja Cat', 'The xx', 'Massive Attack', 'Gorillaz', 'Charli XCX', 'LCD Soundsystem', 'Jamie xx', 'FKA Twigs', 'Bicep', 'Fontaines D.C.', 'Clairo', 'Disclosure', 'JPEGMAFIA', 'Caribou', 'Floating Points', 'Four Tet', 'Peggy Gou', 'Arca', 'Yves Tumor', 'Kim Gordon', 'Wet Leg', 'Slowdive', 'Parcels', 'Glass Animals']::text[],
    NULL,
    1
  ),
  (
    'tomorrowland',
    'Tomorrowland',
    'Boom',
    'Boom, Bélgica',
    'BE',
    '17-19 & 24-26 Julio 2026',
    'https://www.tomorrowland.com',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    2
  ),
  (
    'rock-am-ring',
    'Rock am Ring',
    'Nürburg',
    'Nürburg, Alemania',
    'DE',
    '5-7 Junio 2026',
    'https://www.rock-am-ring.com',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Linkin Park', 'Iron Maiden', 'Limp Bizkit', 'Volbeat', 'A Perfect Circle', 'Alter Bridge', 'Architects', 'BABYMETAL', 'Bad Omens', 'Electric Callboy', 'Ice Nine Kills', 'Mastodon', 'Papa Roach', 'Sabaton', 'The Offspring', 'Bullet For My Valentine', 'Parkway Drive', 'Spiritbox', 'Sleep Token', 'Polaris', 'As I Lay Dying', 'Asking Alexandria', 'Wage War', 'Beartooth', 'Knocked Loose']::text[],
    NULL,
    3
  ),
  (
    'sziget',
    'Sziget Festival',
    'Budapest',
    'Budapest, Hungría',
    'HU',
    '11-15 Agosto 2026',
    'https://szigetfestival.com',
    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800',
    '/images/szigetfestival.png',
    ARRAY['/images/sziget/szigetfestival.png']::text[],
    NULL,
    'partial',
    ARRAY['Twenty One Pilots', 'Florence + The Machine', 'Lewis Capaldi', 'Biffy Clyro', 'Tash Sultana', 'Ashnikko', 'bbno$', 'Paris Paloma']::text[],
    NULL,
    4
  ),
  (
    'mad-cool',
    'Mad Cool Festival',
    'Madrid',
    'Madrid, España',
    'ES',
    '8-11 Julio 2026',
    'https://madcoolfestival.es',
    'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=800',
    '/images/madcoolfestival.jpg',
    ARRAY['/images/mad-cool/madcoolfestival.jpg']::text[],
    NULL,
    'confirmed',
    ARRAY['Foo Fighters', 'Florence + The Machine', 'Twenty One Pilots', 'Lorde', 'Pulp', 'Wolf Alice', 'Nick Cave & The Bad Seeds', 'Jennie', 'Moby', 'The Last Dinner Party', 'Kings Of Leon', 'The War On Drugs', 'Halsey', 'Teddy Swims', 'Pixies', 'The Black Crowes', 'David Byrne', 'St. Vincent', 'Phoenix', 'Vampire Weekend', 'Beach House', 'Father John Misty', 'Interpol', 'Sampha', 'Sudan Archives']::text[],
    NULL,
    5
  ),
  (
    'lollapalooza-berlin',
    'Lollapalooza Berlin',
    'Berlín',
    'Berlín, Alemania',
    'DE',
    '18-19 Julio 2026',
    'https://www.lollapaloozade.com',
    'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'partial',
    ARRAY['Pitbull', 'Lewis Capaldi', 'Lorde', 'Teddy Swims', 'Lily Allen', 'Zara Larsson']::text[],
    NULL,
    6
  ),
  (
    'roskilde',
    'Roskilde Festival',
    'Roskilde',
    'Roskilde, Dinamarca',
    'DK',
    '27 Junio - 4 Julio 2026',
    'https://www.roskilde-festival.dk',
    'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['The Cure', 'Gorillaz', 'David Byrne', 'Little Simz', 'Ethel Cain', 'Zara Larsson', 'Kneecap', 'Yung Lean & Bladee', 'PJ Harvey', 'Tyler, The Creator', 'Nick Cave & The Bad Seeds', 'Massive Attack', 'Bon Iver', 'Fleet Foxes', 'Angel Olsen', 'Big Thief', 'DIIV', 'King Krule', 'Weyes Blood', 'Black Midi', 'Squid', 'Black Country, New Road', 'Shame', 'Dry Cleaning']::text[],
    NULL,
    7
  ),
  (
    'sonar',
    'Sónar Barcelona',
    'Barcelona',
    'Barcelona, España',
    'ES',
    '18-20 Junio 2026',
    'https://sonar.es',
    'https://images.unsplash.com/photo-1571266028243-e4733b0f0bb0?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'partial',
    ARRAY['Amelie Lens', 'Skepta', 'Charlotte de Witte', 'Cabaret Voltaire', 'Boys Noize', 'Nia Archives']::text[],
    NULL,
    8
  ),
  (
    'lowlands',
    'Lowlands Festival',
    'Biddinghuizen',
    'Biddinghuizen, Países Bajos',
    'NL',
    '21-23 Agosto 2026',
    'https://lowlands.nl',
    'https://images.unsplash.com/photo-1563841930606-67e2bce48b78?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    9
  ),
  (
    'nos-alive',
    'NOS Alive',
    'Lisboa',
    'Lisboa, Portugal',
    'PT',
    '9-11 Julio 2026',
    'https://nosalive.com',
    'https://images.unsplash.com/photo-1484972759836-b93f9ef2b293?w=800',
    NULL,
    ARRAY['/images/nos-alive/Nos alive 2026.jpg']::text[],
    NULL,
    'confirmed',
    ARRAY['Twenty One Pilots', 'Nick Cave & The Bad Seeds', 'A Perfect Circle', 'Alabama Shakes', 'Matt Berninger', 'Dogstar', 'Foo Fighters', 'Skunk Anansie', 'The Warning', 'Wolf Alice', 'The War On Drugs', 'Jehnny Beth', 'Zara Larsson', 'Florence + The Machine', 'Lorde', 'Buraka Som Sistema', 'Pixies', 'Phoebe Bridgers', 'Soccer Mommy', 'Snail Mail', 'Japanese Breakfast', 'Mitski', 'Big Thief', 'Angel Olsen', 'Sharon Van Etten']::text[],
    NULL,
    10
  ),
  (
    'flow-festival',
    'Flow Festival',
    'Helsinki',
    'Helsinki, Finlandia',
    'FI',
    '14-16 Agosto 2026',
    'https://www.flowfestival.com',
    'https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?w=800',
    NULL,
    ARRAY['/images/flow-festival/flow festival 2026_1.png', '/images/flow-festival/flow festival 2026_2.png', '/images/flow-festival/flow festival 2026_3.png', '/images/flow-festival/flow festival 2026_4.png']::text[],
    NULL,
    'partial',
    ARRAY['Florence + The Machine', 'Zara Larsson', 'Nick Cave & The Bad Seeds', 'Turnstile', 'SOMBR', 'PinkPantheress', 'Clipse', 'Oklou', 'Kettama', 'Honey Dijon']::text[],
    NULL,
    11
  ),
  (
    'rock-werchter',
    'Rock Werchter',
    'Werchter',
    'Werchter, Bélgica',
    'BE',
    '2-5 Julio 2026',
    'https://www.rockwerchter.be',
    'https://images.unsplash.com/photo-1468359601543-843bfaef291a?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    12
  ),
  (
    'open-er',
    'Open''er Festival',
    'Gdynia',
    'Gdynia, Polonia',
    'PL',
    '1-4 Julio 2026',
    'https://opener.pl',
    'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['The xx', 'Calvin Harris', 'Nick Cave & The Bad Seeds', 'The Cure', 'David Byrne', 'Halsey', 'IDLES', 'JADE', 'Zara Larsson', 'PinkPantheress', 'Reneé Rapp', 'Addison Rae', 'Sofi Tukker', 'Teddy Swims', 'Ethel Cain', 'Massive Attack', 'The Chemical Brothers', 'Orbital', 'Faithless', 'Leftfield', 'Groove Armada', 'LCD Soundsystem', 'Hot Chip', 'Metronomy', 'Caribou']::text[],
    NULL,
    13
  ),
  (
    'sea-star',
    'Sea Star Festival',
    'Umag',
    'Umag, Croacia',
    'HR',
    '28-31 Mayo 2026',
    'https://www.seastarfestival.com',
    'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=800',
    NULL,
    '{}'::text[],
    'Parte del EXIT Global Tour 2026',
    'partial',
    ARRAY['Boris Brejcha', 'Xzibit', 'Layla Benitez', 'Emergency EXIT', 'Lanna', 'DJ Labud', 'Herya', 'INKA', 'Kim Ono', 'Lottie', 'Marcel', 'Marin Biočić', 'Sunny Sun']::text[],
    NULL,
    14
  ),
  (
    'tuska',
    'Tuska Festival',
    'Helsinki',
    'Helsinki, Finlandia',
    'FI',
    '26-28 Junio 2026',
    'https://tuska.fi',
    'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800',
    NULL,
    ARRAY['/images/tuska/TUSKA26.jpg']::text[],
    NULL,
    'partial',
    ARRAY['Megadeth', 'Bring Me The Horizon', 'Bad Omens', 'Trivium', 'Queensrÿche', 'P.O.D.', 'Ensiferum', 'Stam1na', 'Pain', 'D-A-D', 'Soilwork', 'Blood Incantation', 'Kublai Khan TX', 'Paleface Swiss', 'Rivers of Nihil', 'Swallow The Sun', 'Lost Society', 'Gatecreeper', 'Malevolence', 'The Plot In You', 'The Browning', 'Bloodred Hourglass', 'Majestica', 'The Callous Daoboys']::text[],
    NULL,
    15
  ),
  (
    'glastonbury',
    'Glastonbury Festival',
    'Somerset',
    'Worthy Farm, Somerset, Inglaterra',
    'GB',
    '2027 (confirmado)',
    'https://www.glastonburyfestivals.co.uk',
    'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'hiatus',
    '{}'::text[],
    'No hay edición en 2026 - el festival descansa este año. Próxima edición: 2027',
    16
  ),
  (
    'amf',
    'Amsterdam Music Festival',
    'Amsterdam',
    'Johan Cruijff Arena, Amsterdam, Países Bajos',
    'NL',
    'Octubre 2026 (fecha exacta TBA)',
    'https://amf-festival.com',
    'https://images.unsplash.com/photo-1574391884720-bbc3740c59d1?w=800',
    NULL,
    '{}'::text[],
    'Cierre del Amsterdam Dance Event. Aquí se anuncia el DJ Mag Top 100',
    'unannounced',
    '{}'::text[],
    NULL,
    17
  ),
  (
    'mysteryland',
    'Mysteryland',
    'Haarlemmermeer',
    'Haarlemmermeer, Países Bajos',
    'NL',
    '2027 (confirmado)',
    'https://www.mysteryland.nl',
    'https://images.unsplash.com/photo-1571266028243-e4733b0f0bb0?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'hiatus',
    '{}'::text[],
    'No hay edición en 2026 - el festival más antiguo de música electrónica descansa para renovar su concepto. Vuelve en 2027',
    18
  ),
  (
    'coachella',
    'Coachella',
    'Indio',
    'Indio, California',
    'US',
    '11-13 & 18-20 Abril 2026',
    'https://www.coachella.com',
    'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    19
  ),
  (
    'lollapalooza-chicago',
    'Lollapalooza Chicago',
    'Chicago',
    'Chicago, Illinois',
    'US',
    '30 Julio - 2 Agosto 2026',
    'https://www.lollapalooza.com',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    20
  ),
  (
    'bonnaroo',
    'Bonnaroo',
    'Manchester',
    'Manchester, Tennessee',
    'US',
    '11-14 Junio 2026',
    'https://www.bonnaroo.com',
    'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    21
  ),
  (
    'austin-city-limits',
    'Austin City Limits',
    'Austin',
    'Austin, Texas',
    'US',
    '2-4 & 9-11 Octubre 2026',
    'https://www.aclfestival.com',
    'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    22
  ),
  (
    'edc-las-vegas',
    'Electric Daisy Carnival',
    'Las Vegas',
    'Las Vegas, Nevada',
    'US',
    '15-17 Mayo 2026',
    'https://lasvegas.electricdaisycarnival.com',
    'https://images.unsplash.com/photo-1574391884720-bbc3740c59d1?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    23
  ),
  (
    'lollapalooza-argentina',
    'Lollapalooza Argentina',
    'Buenos Aires',
    'Hipódromo de San Isidro, Buenos Aires',
    'AR',
    '13-15 Marzo 2026',
    'https://www.lollapaloozaar.com',
    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Sabrina Carpenter', 'Tyler, The Creator', 'Chappell Roan', 'Deftones', 'Skrillex', 'Lorde', 'Doechii', 'Turnstile', 'Lewis Capaldi', 'Paulo Londra', 'Interpol', 'Kygo', 'Peggy Gou', 'Brutalismus 3000', 'Addison Rae', 'Katseye', 'Marina', 'Djo', 'TV Girl', 'Royel Otis', 'RIIZE', 'Blood Orange', 'Ben Böhmer', 'Lola Young', 'Aitana', 'Danny Ocean', 'D4VD', 'Soledad', 'BUNT.', 'The Dare', 'Six Sex', 'HorsegiirL', '2Hollis', 'Men I Trust', 'Viagra Boys', 'Massacre', 'Judeline', 'Balu Brigada', 'Guitarricadelafuente', 'Lany', 'The Warning', 'Zell', 'Róz']::text[],
    NULL,
    24
  ),
  (
    'lollapalooza-chile',
    'Lollapalooza Chile',
    'Santiago',
    'Parque O''Higgins, Santiago',
    'CL',
    '13-15 Marzo 2026',
    'https://www.lollapaloozacl.com',
    'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Sabrina Carpenter', 'Tyler, The Creator', 'Chappell Roan', 'Deftones', 'Skrillex', 'Lorde', 'Doechii', 'Turnstile', 'Lewis Capaldi', 'Tom Morello', 'Interpol', 'Kygo', 'Peggy Gou', 'Danny Ocean', 'Orishas', 'Mau y Ricky', 'Yami Safdie', 'The Warning', 'Joaquina', '3BallMTY', 'Marina', 'TV Girl', 'Royel Otis', 'Men I Trust', 'Viagra Boys']::text[],
    NULL,
    25
  ),
  (
    'lollapalooza-brasil',
    'Lollapalooza Brasil',
    'São Paulo',
    'Autódromo de Interlagos, São Paulo',
    'BR',
    '20-22 Marzo 2026',
    'https://www.lollapaloozabr.com',
    'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Sabrina Carpenter', 'Tyler, The Creator', 'Chappell Roan', 'Deftones', 'Skrillex', 'Lorde', 'Doechii', 'Turnstile', 'Lewis Capaldi', 'Cypress Hill', 'Interpol', 'Kygo', 'Peggy Gou', 'Ben Böhmer', 'Addison Rae', 'Katseye', 'Marina', 'Djo', 'Lola Young', 'Men I Trust', '2Hollis', 'Viagra Boys', 'HorsegiirL', 'TV Girl', 'Royel Otis']::text[],
    NULL,
    26
  ),
  (
    'rock-in-rio',
    'Rock in Rio',
    'Rio de Janeiro',
    'Rio de Janeiro, Brasil',
    'BR',
    '18-20 & 25-27 Septiembre 2026',
    'https://rockinrio.com',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    27
  ),
  (
    'vive-latino',
    'Vive Latino',
    'Ciudad de México',
    'Ciudad de México, México',
    'MX',
    '14-15 Marzo 2026',
    'https://www.vivelatino.com.mx',
    'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    28
  ),
  (
    'estereo-picnic',
    'Festival Estéreo Picnic',
    'Bogotá',
    'Bogotá, Colombia',
    'CO',
    '26-29 Marzo 2026',
    'https://www.festivalestereopicnic.com',
    'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    29
  ),
  (
    'corona-capital',
    'Corona Capital',
    'Ciudad de México',
    'Ciudad de México, México',
    'MX',
    '14-15 Noviembre 2026',
    'https://www.coronacapital.com.mx',
    'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    30
  ),
  (
    'ultra-miami',
    'Ultra Music Festival',
    'Miami',
    'Miami, Estados Unidos',
    'US',
    '27-29 Marzo 2026',
    'https://ultramusicfestival.com',
    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    31
  ),
  (
    'ultra-buenos-aires',
    'Ultra Buenos Aires',
    'Buenos Aires',
    'Buenos Aires, Argentina',
    'AR',
    'Octubre 2026',
    'https://ultrabuenosaires.com',
    'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    32
  ),
  (
    'ultra-europe',
    'Ultra Europe',
    'Split',
    'Split, Croacia',
    'HR',
    '10-12 Julio 2026',
    'https://ultraeurope.com',
    NULL,
    NULL,
    ARRAY['/images/ultra-europe/ULTRA-EUROPE-2026.png']::text[],
    NULL,
    'partial',
    ARRAY['Alesso', 'Axwell', 'DJ Snake', 'Oliver Heldens', 'Tchami', 'Adam Beyer', 'Peggy Gou', 'Eric Prydz', 'HI-LO', 'Eli Brown', 'Armin van Buuren', 'Afrojack', 'Steve Aoki', 'Tiësto', 'Hardwell']::text[],
    NULL,
    33
  ),
  (
    'weekend-festival',
    'Weekend Festival',
    'Espoo',
    'Espoo, Finlandia',
    'FI',
    '31 Jul - 1 Ago 2026',
    'https://www.wknd.fi/',
    NULL,
    NULL,
    '{}'::text[],
    NULL,
    'partial',
    ARRAY['Martin Garrix', 'R3HAB', 'Pendulum', 'Timmy Trumpet', 'Darude', 'Coone', 'D-Block & S-te-Fan', 'Wildstylez', 'Salvatore Ganacci', 'Holy Priest', 'Lil Texas', 'Sound Rush', 'Bassjackers', 'Tungevaag']::text[],
    NULL,
    34
  ),
  (
    'festival-buena-vibra',
    'Festival Buena Vibra',
    'Buenos Aires',
    'Buenos Aires, Argentina',
    'AR',
    '21 Febrero 2026',
    'https://www.instagram.com/festivalbuenavibra',
    NULL,
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    35
  ),
  (
    'rock-im-park',
    'Rock im Park',
    'Nürnberg',
    'Zeppelinfeld, Nürnberg, Alemania',
    'DE',
    '5-7 Junio 2026',
    'https://www.rock-im-park.com',
    'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800',
    NULL,
    '{}'::text[],
    'Festival hermano de Rock am Ring. Ambos comparten el mismo lineup - los artistas tocan un día en cada festival. Capacidad: ~60,000 personas.',
    'confirmed',
    ARRAY['Linkin Park', 'Iron Maiden', 'Limp Bizkit', 'Volbeat', 'A Perfect Circle', 'Alter Bridge', 'Architects', 'BABYMETAL', 'Bad Omens', 'Electric Callboy', 'Ice Nine Kills', 'Mastodon', 'Papa Roach', 'Sabaton', 'The Offspring', 'Bullet For My Valentine', 'Parkway Drive', 'Spiritbox', 'Sleep Token', 'Polaris', 'As I Lay Dying', 'Asking Alexandria', 'Wage War', 'Beartooth', 'Knocked Loose']::text[],
    NULL,
    36
  ),
  (
    'exit-festival',
    'Exit Festival',
    'Novi Sad',
    'Petrovaradin Fortress, Novi Sad, Serbia',
    'RS',
    '9-12 Julio 2026',
    'https://www.exitfest.org',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    37
  ),
  (
    'reading-festival',
    'Reading Festival',
    'Reading',
    'Richfield Avenue, Reading, Inglaterra',
    'GB',
    '27-30 Agosto 2026',
    'https://www.readingfestival.com',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Charli XCX', 'Chase & Status', 'Dave', 'Florence + The Machine', 'Fontaines D.C.', 'Raye', 'Skepta', 'Kneecap', 'Kettama', 'Jade', 'Role Model', 'Geese', 'Skye Newman', 'Adéla', 'Keo', 'Josh Baker', 'Chris Stussy', 'Sombr']::text[],
    NULL,
    38
  ),
  (
    'leeds-festival',
    'Leeds Festival',
    'Leeds',
    'Bramham Park, Leeds, Inglaterra',
    'GB',
    '27-30 Agosto 2026',
    'https://www.leedsfestival.com',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Charli XCX', 'Chase & Status', 'Dave', 'Florence + The Machine', 'Fontaines D.C.', 'Raye', 'Kasabian', 'Skepta', 'Kneecap', 'Kettama', 'Jade', 'Role Model', 'Geese', 'Skye Newman', 'Adéla', 'Keo', 'Josh Baker', 'Sombr']::text[],
    NULL,
    39
  ),
  (
    'pukkelpop',
    'Pukkelpop',
    'Hasselt',
    'Kiewit, Hasselt, Bélgica',
    'BE',
    '20-23 Agosto 2026',
    'https://www.pukkelpop.be',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'unannounced',
    '{}'::text[],
    NULL,
    40
  ),
  (
    'hurricane-festival',
    'Hurricane Festival',
    'Scheeßel',
    'Eichenring, Scheeßel, Alemania',
    'DE',
    '19-21 Junio 2026',
    'https://www.hurricane.de',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    'Twin festival de Southside. Ambos comparten el mismo lineup.',
    'confirmed',
    ARRAY['Twenty One Pilots', 'Florence + The Machine', 'Billy Talent', 'Kraftklub', 'Papa Roach', 'The Offspring', 'YUNGBLUD', 'A Day To Remember', 'Nothing But Thieves', 'Wolf Alice', 'Alexisonfire', 'All Time Low', 'Empire of the Sun', 'Provinz', 'Donots', 'Bosse', 'Natasha Bedingfield', 'Pennywise', 'Skindred', 'Boys Noize', 'Modeselektor']::text[],
    NULL,
    41
  ),
  (
    'southside-festival',
    'Southside Festival',
    'Neuhausen ob Eck',
    'Take-Off Park, Neuhausen ob Eck, Alemania',
    'DE',
    '19-21 Junio 2026',
    'https://www.southside.de',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    'Twin festival de Hurricane. Ambos comparten el mismo lineup.',
    'confirmed',
    ARRAY['Twenty One Pilots', 'Florence + The Machine', 'Billy Talent', 'Kraftklub', 'Papa Roach', 'The Offspring', 'YUNGBLUD', 'A Day To Remember', 'Nothing But Thieves', 'Wolf Alice', 'Alexisonfire', 'All Time Low', 'Empire of the Sun', 'Provinz', 'Donots', 'Bosse', 'Natasha Bedingfield', 'Pennywise', 'Skindred', 'Boys Noize', 'Modeselektor']::text[],
    NULL,
    42
  ),
  (
    'nos-primavera-sound-porto',
    'NOS Primavera Sound Porto',
    'Porto',
    'Parque da Cidade, Porto, Portugal',
    'PT',
    '11-14 Junio 2026',
    'https://www.nosprimaverasound.com',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['The xx', 'Gorillaz', 'Massive Attack', 'Big Thief', 'Slowdive', 'IDLES', 'Ethel Cain', 'JADE', 'Kneecap', 'Viagra Boys', 'Bad Gyal', 'Peggy Gou', 'Dixon', 'Panda Bear', 'Black Country, New Road', 'Dijon', 'Amaarae', 'Oklou', 'Sudan Archives', 'Melt-Banana', 'Gisela João']::text[],
    NULL,
    43
  ),
  (
    'awakenings-festival',
    'Awakenings Festival',
    'Hilvarenbeek',
    'Beekse Bergen, Hilvarenbeek, Países Bajos',
    'NL',
    '10-12 Julio 2026',
    'https://www.awakeningsfestival.nl',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'partial',
    ARRAY['Adam Beyer', 'Amelie Lens', 'Charlotte de Witte', 'Nina Kraviz', 'I Hate Models', 'Adriatique', '999999999', 'Rødhåd', 'Joris Voorn', 'Kevin de Vries', 'Kettama', 'Fatima Hajji', 'Freddy K', 'Cloudy', 'DJ Heartstring', 'Pegassi', 'Odymel']::text[],
    NULL,
    44
  ),
  (
    'parookaville',
    'Parookaville',
    'Weeze',
    'Airport Weeze, Alemania',
    'DE',
    '17-19 Julio 2026',
    'https://www.parookaville.com',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    '10° aniversario. El mayor festival de música electrónica de Alemania.',
    'partial',
    ARRAY['Charlotte de Witte', 'The Chainsmokers', 'Axwell', 'FISHER', 'Scooter', 'ATB', 'Cascada', 'Sound Rush', 'Tujamo', 'Da Tweekaz', 'Harris & Ford', 'Rooler', 'Avaion']::text[],
    NULL,
    45
  ),
  (
    'sonus-festival',
    'Sonus Festival',
    'Zrće Beach (Pag)',
    'Zrće Beach, Isla de Pag, Croacia',
    'HR',
    '16-20 Agosto 2026',
    'https://www.sonus-festival.com',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    '13° aniversario. 5 días y 5 noches de techno en la playa.',
    'unannounced',
    '{}'::text[],
    NULL,
    46
  ),
  (
    'dekmantel-festival',
    'Dekmantel Festival',
    'Amsterdam',
    'Amsterdamse Bos, Amsterdam, Países Bajos',
    'NL',
    '31 Julio - 2 Agosto 2026',
    'https://www.dekmantelfestival.com',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'partial',
    ARRAY['Four Tet', 'Avalon Emerson', 'Jeff Mills', 'The Orb', 'Leftfield', 'James Holden', 'Skee Mask', 'Anz', 'Floating Points', 'Palms Trax', 'Pearson Sound', 'Dr. Rubinstein', 'Shanti Celeste', 'Young Marco', 'Hunee']::text[],
    NULL,
    47
  ),
  (
    'time-warp',
    'Time Warp',
    'Mannheim',
    'Maimarkthalle, Mannheim, Alemania',
    'DE',
    '21 Marzo 2026',
    'https://www.time-warp.de',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    '19 horas non-stop de techno. Evento de un solo día.',
    'confirmed',
    ARRAY['Adam Beyer', 'Amelie Lens', 'Nina Kraviz', 'Richie Hawtin', 'Sven Väth', 'Charlotte de Witte', 'Joseph Capriati', 'Ben Klock', 'Marcel Dettmann', 'Honey Dijon', 'Jamie Jones', 'Loco Dice', 'Seth Troxler', 'Reinier Zonneveld', 'Sara Landry', 'Kobosil', 'Blawan', 'Mall Grab', 'Jayda G', 'Vintage Culture']::text[],
    NULL,
    48
  ),
  (
    'boomtown-fair',
    'Boomtown Fair',
    'Winchester',
    'Matterley Estate, Winchester, Inglaterra',
    'GB',
    '12-16 Agosto 2026',
    'https://www.boomtownfair.co.uk',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    'Más de 500 artistas y 80 géneros musicales.',
    'confirmed',
    ARRAY['Skrillex', 'Four Tet', 'Faithless', 'Kneecap', 'Scissor Sisters', 'Madness', 'Scooter', 'Ashnikko', 'Shaggy', 'EVE', 'Floating Points', 'Groove Armada', 'Skindred', 'Vengaboys', 'Wilkinson', 'Shy FX']::text[],
    NULL,
    49
  ),
  (
    'ruisrock',
    'Ruisrock',
    'Turku',
    'Isla de Ruissalo, Turku, Finlandia',
    'FI',
    '3-5 Julio 2026',
    'https://www.ruisrock.fi',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    'Uno de los festivales más antiguos de Europa.',
    'partial',
    ARRAY['Swedish House Mafia', 'Gunna', 'Electric Callboy', 'Lily Allen', 'Audrey Nuna', 'Eppu Normaali', 'Nylon Beat', 'Isac Elliot', 'Ares', 'Mirella', 'Vesala', 'Cledos']::text[],
    NULL,
    50
  ),
  (
    'provinssi',
    'Provinssi',
    'Seinäjoki',
    'Törnävänsaari Park, Seinäjoki, Finlandia',
    'FI',
    '25-27 Junio 2026',
    'https://www.provinssi.fi',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Bring Me The Horizon', 'The Prodigy', 'Bad Omens', 'Wolf Alice', 'Apulanta', 'Käärijä', 'Eppu Normaali', 'Turmiön Kätilöt', 'Blood Incantation', 'Cemetery Skyline', 'Huora', 'Luna Kills', 'Kuumaa', 'Mirella', 'Robin Packalen']::text[],
    NULL,
    51
  ),
  (
    'ilosaarirock',
    'Ilosaarirock',
    'Joensuu',
    'Laulurinne Park, Joensuu, Finlandia',
    'FI',
    '17-19 Julio 2026',
    'https://www.ilosaarirock.fi',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    'Uno de los festivales más grandes de Finlandia.',
    'partial',
    ARRAY['Sex Pistols Featuring Frank Carter', 'Beast In Black', 'Auri', 'HOKKA', 'Vesala', 'KUUMAA', 'Komiat', 'emma & matilda', 'Lauri Haav', 'ibe', 'Vilma Jää']::text[],
    NULL,
    52
  ),
  (
    'nummirock',
    'Nummirock',
    'Nummijärvi',
    'Nummijärvi, Kauhajoki, Finlandia',
    'FI',
    '17-20 Junio 2026',
    'https://www.nummirock.fi',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    '40° aniversario del festival de metal.',
    'partial',
    ARRAY['Satyricon', 'Rise Of The Northstar', 'UADA', 'Immortal Disfigurement', 'Omnium Gatherum', 'Moonsorrow', 'Swallow The Sun', 'Kaunis Kuolematon', 'Ruoska', 'Stoned Statues']::text[],
    NULL,
    53
  ),
  (
    'steelfest',
    'Steelfest Open Air',
    'Hyvinkää',
    'Old Wool Factory, Hyvinkää, Finlandia',
    'FI',
    '14-16 Mayo 2026',
    'https://www.steelfest.fi',
    'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800',
    NULL,
    '{}'::text[],
    'Festival de black metal y extreme metal. K-18.',
    'confirmed',
    ARRAY['Beherit', 'Revenge', 'Tormentor', 'Akhlys', 'Inquisition', 'Satanic Warmaster', 'Forteresse', 'Concrete Winds', 'White Death', 'Shape of Despair', 'Deathchain', 'Torture Killer', 'Morgal', 'Demonical']::text[],
    NULL,
    54
  ),
  (
    'blockfest',
    'Blockfest',
    'Tampere',
    'Tampere Stadium, Tampere, Finlandia',
    'FI',
    '21-22 Agosto 2026',
    'https://www.blockfest.fi',
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800',
    NULL,
    '{}'::text[],
    'El mayor festival de hip-hop de los países nórdicos.',
    'unannounced',
    '{}'::text[],
    NULL,
    55
  ),
  (
    'helsinki-city-festival',
    'Helsinki City Festival',
    'Helsinki',
    'Helsingin Jäähalli, Helsinki, Finlandia',
    'FI',
    '12-14 Junio 2026',
    'https://www.helsinkicityfestival.fi',
    'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Black Eyed Peas', 'Macklemore', 'Flo Rida', 'Lewis Capaldi', 'The Rasmus', 'Alexandra Stan', 'Akcent', 'Basement Jaxx', 'Showtek', 'Chamillionaire', 'Mohombi', 'Outlandish', 'Windows95Man', 'Evelina']::text[],
    NULL,
    56
  ),
  (
    'pori-jazz',
    'Pori Jazz',
    'Pori',
    'Kirjurinluoto Concert Park, Pori, Finlandia',
    'FI',
    '10-18 Julio 2026',
    'https://www.porijazz.fi/',
    'https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=800',
    NULL,
    '{}'::text[],
    NULL,
    'confirmed',
    ARRAY['Juanes', 'Victor Wooten & The Wooten Brothers', 'Cécile McLorin Salvant', 'Jalen Ngonda', 'Say She She', 'Pale Jay', 'Matteo Mancuso', 'Sasha Berliner', 'Mikko Kuustonen', 'Salin', 'Vesala', 'Ricky-Tick Big Band & Julkinen Sana']::text[],
    NULL,
    57
  ),
  (
    'rock-in-seine',
    'Rock in Seine',
    'Paris',
    'Domaine national de Saint-Cloud, Paris, Francia',
    'FR',
    '26-30 Agosto 2026',
    'https://www.rockenseine.com/en/',
    'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800',
    NULL,
    ARRAY['/images/rock-in-seine/rock-in-seine-2026.png']::text[],
    NULL,
    'confirmed',
    ARRAY['The Cure', 'Nick Cave & The Bad Seeds', 'Tyler, The Creator', 'Deftones', 'Turnstile', 'Franz Ferdinand', 'Interpol', 'Amyl and The Sniffers', 'The Black Keys', 'Biffy Clyro', 'Kurt Vile & The Violators', 'Landmvrks', 'Lambrini Girls', 'Ravyn Lenae', 'Slowdive', 'Miki', 'Sombr']::text[],
    NULL,
    58
  )
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
-- crea esta tabla (ver server/db.js), asi que en dev local `npm run dev` levanta
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
