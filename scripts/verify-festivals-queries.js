/**
 * Verifica el SQL que arman las 5 funciones de la tabla `festivals` en db.js.
 *
 * Chequea lo que no se ve leyendo el codigo:
 *  1. Que ningun valor de usuario quede interpolado en el string SQL.
 *     Se pasan valores marcador (ZQXNAME, ZQX7CITY...) que no pueden aparecer
 *     por casualidad, y se verifica que no esten en el SQL.
 *  2. Que la cantidad de $N coincida con la cantidad de parametros.
 *  3. Que las columnas dinamicas del SET salgan del whitelist
 *     (UPDATABLE_FESTIVAL_FIELDS) y no de un "lo que venga en el body".
 *  4. Que `id` y `sort_order` no sean escribibles desde el body.
 *
 * NO NECESITA BASE DE DATOS: intercepta el modulo `pg` y captura las queries.
 *
 * Uso:  node scripts/verify-festivals-queries.js
 */

const Module = require('module');
const path = require('path');

const queries = [];
class Pool {
  constructor() { this.on = () => {}; }
  query(sql, params) {
    queries.push({ sql, params: params || [] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool };
  return realLoad.apply(this, arguments);
};

const db = require(path.join(__dirname, '..', 'server', 'db.js'));

// Marcadores: cadenas que NO pueden aparecer por casualidad en el SQL. Se usan
// en vez de "N" o "ES" porque esas letras SÍ aparecen (lineup, COUNT, ...).
const MARK = {
  name: 'ZQXNAME', city: 'ZQX7CITY', location: 'ZQX8LOC', dates: 'ZQX9DATE',
  website: 'ZQX10WEB', image: 'ZQX11IMG', flyer: 'ZQX12FLY',
  flyerImage: 'ZQX13FI', description: 'ZQX14DESC', lineup: 'ZQX15ART', note: 'ZQX16NOTE',
};

let fail = 0;
const check = (cond, msg) => {
  if (cond) console.log('OK ' + msg);
  else { console.log('X  ' + msg); fail++; }
};

(async () => {
  // 1. Lectura
  await db.getFestivals();

  // 2. Update con TODOS los campos escribibles, con valores marcador
  await db.updateFestival('primavera-sound', {
    name: MARK.name, city: MARK.city, location: MARK.location, country: 'ES',
    dates: MARK.dates, website: MARK.website, image: MARK.image, flyer: MARK.flyer,
    flyerImages: [MARK.flyerImage], description: MARK.description,
    lineupStatus: 'partial', lineup: [MARK.lineup], note: MARK.note,
  });

  // 3. Update intentando escribir lo que NO se debe poder tocar
  await db.updateFestival('x', {
    id: 'hacked-id', sort_order: 999, lineup_status: 'hacked',
    startsOn: '1999-01-01', endsOn: '1999-01-02',
  });

  // 4. Create
  await db.createFestival({
    id: 'nuevo', name: 'N', city: 'C', location: 'L', country: 'ES', dates: 'D',
  });

  // 5. Delete
  await db.deleteFestival('primavera-sound');

  check(queries.length === 5, `se ejecutaron ${queries.length} queries (esperado 5)`);

  queries.forEach(({ sql, params }, i) => {
    const flat = sql.replace(/\s+/g, ' ');

    const leaked = Object.entries(MARK)
      .filter(([, v]) => flat.includes(v))
      .map(([k]) => k);
    check(leaked.length === 0,
      `#${i} sin valores de usuario dentro del SQL` + (leaked.length ? ': ' + leaked.join(',') : ''));

    const maxIdx = Math.max(0, ...[...flat.matchAll(/\$(\d+)/g)].map(m => +m[1]));
    check(params.length === maxIdx,
      `#${i} ${params.length} parametros para $1..$${maxIdx}`);
  });

  // Whitelist: el mapa es camelCase -> columna, asi que lo que se valida contra
  // el SQL son los VALUES del mapa. updated_at lo agrega la funcion, no el body.
  const allowed = new Set(Object.values(db.UPDATABLE_FESTIVAL_FIELDS));
  // starts_on/ends_on no son campos del body: son DERIVADAS de `dates` por
  // server/dateRange.js. Viajan en el mismo UPDATE pero no en el whitelist.
  const derived = new Set(['starts_on', 'ends_on']);
  const setPart = (queries[1].sql.replace(/\s+/g, ' ').match(/SET (.+?) WHERE/) || [])[1] || '';
  const used = setPart.split(',').map(s => s.trim().split('=')[0].trim());
  check(used.filter(c => c !== 'updated_at' && !derived.has(c)).every(c => allowed.has(c)),
    'columnas del SET dentro del whitelist (o derivadas): ' + used.join(','));
  check(used.includes('starts_on') && used.includes('ends_on'),
    'si el body trae dates, el mismo UPDATE recalcula starts_on y ends_on');
  check(!used.includes('id') && !used.includes('sort_order'),
    'id y sort_order NO son escribibles desde el body');
  check(Array.isArray(queries[1].params.find(p => Array.isArray(p))),
    'lineup va como parametro array, no como texto');

  // El attempt de hackear id/sort_order cae al SELECT, no a un UPDATE
  check(queries[2].sql.includes('SELECT') && !queries[2].sql.includes('UPDATE'),
    'update sin campos validos no escribe (devuelve el estado actual)');

  check(queries[0].sql.includes('ORDER BY sort_order'),
    'getFestivals: ORDER BY sort_order (preserva el orden curado del JSON)');
  check(/SELECT COALESCE\(MAX\(sort_order\), 0\) \+ 1 FROM festivals/.test(queries[3].sql),
    'createFestival: sort_order = MAX(sort_order) + 1 (va al final)');
  check(queries[4].sql.includes('RETURNING'),
    'deleteFestival: RETURNING para poder devolver el festival borrado');

  // Rollover: se llaman DESPUES de los indices fijos de arriba, para no
  // correrlos. No tocan la base: el pool interceptado devuelve filas vacias.
  await db.getFestivalsEndedBefore('2026-11-07');
  await db.rolloverFestival('amf', 2027);
  const ended = queries[5].sql.replace(/\s+/g, ' ');
  const roll = queries[6].sql.replace(/\s+/g, ' ');

  check(ended.includes('ends_on < $1::date') && ended.includes("lineup_status <> 'hiatus'"),
    'getFestivalsEndedBefore: filtra por ends_on y saltea hiatus');
  check(ended.includes('ends_on::text'),
    'getFestivalsEndedBefore: ends_on sale como texto (sin corrimiento de TZ)');
  check(roll.includes("lineup = '{}'") && roll.includes("lineup_status = 'unannounced'"),
    'rollover: la edicion nueva queda sin lineup y sin anunciar');
  check(roll.includes('flyer = NULL') && roll.includes("flyer_images = '{}'"),
    'rollover: limpia los flyers de la edicion que termino');
  check(roll.includes('dates = $2'),
    'rollover: el texto de fechas va como parametro, no interpolado');
  check(roll.includes('ends_on < CURRENT_DATE'),
    'rollover: re-valida en el WHERE (doble click no rota dos veces)');
  check(queries[6].params[1] === '2027 (fecha por anunciar)',
    'rollover: arma "<año+1> (fecha por anunciar)"');

  console.log(fail ? `\n${fail} fallas` : '\nTodo OK');
  process.exit(fail ? 1 : 0);
})();
