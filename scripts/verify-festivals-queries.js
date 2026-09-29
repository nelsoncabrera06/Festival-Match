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
  await db.updateFestival('x', { id: 'hacked-id', sort_order: 999, lineup_status: 'hacked' });

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
  const setPart = (queries[1].sql.replace(/\s+/g, ' ').match(/SET (.+?) WHERE/) || [])[1] || '';
  const used = setPart.split(',').map(s => s.trim().split('=')[0].trim());
  check(used.filter(c => c !== 'updated_at').every(c => allowed.has(c)),
    'columnas del SET dentro del whitelist: ' + used.join(','));
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

  console.log(fail ? `\n${fail} fallas` : '\nTodo OK');
  process.exit(fail ? 1 : 0);
})();
