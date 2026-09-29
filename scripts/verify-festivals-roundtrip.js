/**
 * Verifica que db.getFestivals() devuelva EXACTAMENTE lo que devolvia el array de
 * server/festivals.json, que es lo que consume public/app.js.
 *
 * Por que existe: el paso 4 movio el catalogo de un JSON a la tabla `festivals`, y
 * la promesa de AGENTS.md es que "la forma del objeto festival no cambia, asi que
 * el matching no necesita refactor". Eso solo se prueba comparando objeto por
 * objeto contra el JSON, no leyendo el codigo.
 *
 * NO NECESITA BASE DE DATOS: intercepta el modulo `pg` y devuelve filas
 * construidas desde el JSON, simulando lo que Postgres responderia. Por eso
 * sirve en una maquina sin postgres (esta, al 29/09/2026).
 *
 * Uso:  node scripts/verify-festivals-roundtrip.js
 */

const Module = require('module');
const path = require('path');

const FESTIVALS_JSON = path.join(__dirname, '..', 'server', 'festivals.json');

// Como quedaria cada fila en la base: snake_case, NULL para lo que el JSON no
// tenia, TEXT[] para los arrays. Es la traduccion que hace el INSERT del seed.
function jsonToRows(festivals) {
  return festivals.map((f, i) => ({
    id: f.id,
    name: f.name,
    city: f.city,
    location: f.location,
    country: f.country,
    dates: f.dates,
    website: f.website,
    image: f.image ?? null,
    flyer: f.flyer ?? null,
    flyer_images: f.flyerImages ?? [],
    description: f.description ?? null,
    lineup_status: f.lineupStatus,
    lineup: f.lineup,
    note: f.note ?? null,
    sort_order: i + 1,
  }));
}

const json = require(FESTIVALS_JSON);
const rows = jsonToRows(json);

// Intercepta `pg` ANTES de que db.js lo requiera.
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') {
    return {
      Pool: class {
        constructor() { this.on = () => {}; }
        query() { return Promise.resolve({ rows, rowCount: rows.length }); }
      },
    };
  }
  return realLoad.apply(this, arguments);
};

const db = require(path.join(__dirname, '..', 'server', 'db.js'));

let fail = 0;
const check = (cond, msg) => {
  if (cond) console.log('OK ' + msg);
  else { console.log('X  ' + msg); fail++; }
};

(async () => {
  const fromDb = await db.getFestivals();

  check(fromDb.length === json.length, `cantidad: ${fromDb.length} (= ${json.length})`);

  let mismatches = 0;
  for (let i = 0; i < json.length; i++) {
    const a = json[i], b = fromDb[i];
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();

    if (JSON.stringify(ka) !== JSON.stringify(kb)) {
      mismatches++;
      console.log(`\n  X ${a.id}: claves distintas`);
      console.log('    JSON:', ka.join(','));
      console.log('    DB  :', kb.join(','));
      continue;
    }
    for (const k of ka) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        mismatches++;
        console.log(`\n  X ${a.id}.${k}`);
        console.log('    JSON:', JSON.stringify(a[k]).slice(0, 160));
        console.log('    DB  :', JSON.stringify(b[k]).slice(0, 160));
      }
    }
  }

  check(mismatches === 0,
    `deep-equal: los ${json.length} objetos de la DB son identicos a los del JSON` +
    (mismatches ? ` (${mismatches} diferencias)` : ''));

  // Invariantes que el matching y el frontend dan por sentado.
  check(fromDb.every(f => Array.isArray(f.lineup)),
    'lineup es siempre array (el matching hace .map() sin chequear)');
  check(fromDb.every(f => !f.flyerImages || f.flyerImages.length > 0),
    'flyerImages nunca es un array vacio (undefined cuando no hay)');
  check(fromDb.every(f => ['confirmed', 'partial', 'unannounced', 'hiatus'].includes(f.lineupStatus)),
    'lineupStatus es siempre uno de los 4 valores de i18n');
  check(fromDb.every(f => f.lineup.length === 0 || f.lineupStatus !== 'unannounced'),
    'ningun festival con lineup tiene lineupStatus unannounced');

  // El orden tiene que seguir siendo el curado del JSON (sort_order).
  check(fromDb.map(f => f.id).join(',') === json.map(f => f.id).join(','),
    'orden preservado: sale en el mismo orden que el JSON');

  console.log(fail ? `\n${fail} fallas` : '\nTodo OK');
  process.exit(fail ? 1 : 0);
})();
