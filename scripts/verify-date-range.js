/**
 * Verifica `server/dateRange.js` contra las cadenas que hoy existen en
 * `server/festivals.json`.
 *
 * Por que los esperados estan escritos a mano y no calculados: si salieran del
 * propio parser, el test pasaria siempre y no probaria nada. La gracia es que
 * alguien haya decidido de antemano que "2-4 & 9-11 Octubre 2026" termina el 11
 * y no el 4.
 *
 * Ademas cubre casos de borde que el catalogo no tiene pero puede tener cuando
 * el extractor de la fase 3 empiece a escribir fechas: bisiesto, 31 de abril,
 * rango invertido, cruce de año y texto libre.
 *
 * NO NECESITA BASE DE DATOS.
 *
 * Uso:  node scripts/verify-date-range.js
 */

const path = require('path');
const { parseDateRange } = require(path.join(__dirname, '..', 'server', 'dateRange.js'));
const festivals = require(path.join(__dirname, '..', 'server', 'festivals.json'));

let fail = 0;
const check = (cond, msg) => {
  if (cond) console.log('OK ' + msg);
  else { console.log('X  ' + msg); fail++; }
};

// [texto, startsOn esperado, endsOn esperado]
//
// Las 37 cadenas distintas del catalogo, en orden alfabetico como salen de un
// `SELECT DISTINCT dates`. Si se agrega un festival con un formato nuevo, el
// check de cobertura de abajo falla y obliga a sumar el caso aca.
const CASOS_CATALOGO = [
  ['1-3 Julio 2027', '2027-07-01', '2027-07-03'],
  ['1-4 Julio 2027', '2027-07-01', '2027-07-04'],
  ['10-14 Agosto 2027', '2027-08-10', '2027-08-14'],
  ['12-14 Marzo 2027', '2027-03-12', '2027-03-14'],
  ['13-14 Marzo 2027', '2027-03-13', '2027-03-14'],
  ['13-15 Agosto 2027', '2027-08-13', '2027-08-15'],
  ['13-15 Mayo 2027', '2027-05-13', '2027-05-15'],
  ['14 Noviembre 2026', '2026-11-14', '2026-11-14'],
  ['14-16 & 21-23 Mayo 2027', '2027-05-14', '2027-05-23'],
  ['15-17 Julio 2027', '2027-07-15', '2027-07-17'],
  ['16-18 Abril 2027', '2027-04-16', '2027-04-18'],
  ['16-18 Julio 2027', '2027-07-16', '2027-07-18'],
  ['18-19 Junio 2027', '2027-06-18', '2027-06-19'],
  ['18-20 Junio 2027', '2027-06-18', '2027-06-20'],
  ['19-21 Marzo 2027', '2027-03-19', '2027-03-21'],
  ['19-22 Agosto 2027', '2027-08-19', '2027-08-22'],
  ['2-3 Abril 2027', '2027-04-02', '2027-04-03'],
  // ACL: dos fines de semana. El rollover necesita el ultimo dia (11), no el
  // cuarto dia del primer tramo.
  ['2-4 & 9-11 Octubre 2026', '2026-10-02', '2026-10-11'],
  ['2-4 Julio 2027', '2027-07-02', '2027-07-04'],
  ['20-22 Agosto 2027', '2027-08-20', '2027-08-22'],
  ['20-22 Noviembre 2026', '2026-11-20', '2026-11-22'],
  ['2027 (confirmado)', null, null],
  ['2027 (fecha por anunciar)', null, null],
  ['2027 (sin edición)', null, null],
  ['2028 (fecha por anunciar)', null, null],
  ['23-26 Junio 2027', '2027-06-23', '2027-06-26'],
  // AMF: un solo dia.
  ['24 Octubre 2026', '2026-10-24', '2026-10-24'],
  // Roskilde: cruza de junio a julio.
  ['26 Junio - 3 Julio 2027', '2027-06-26', '2027-07-03'],
  ['26-28 Marzo 2027', '2027-03-26', '2027-03-28'],
  ['26-29 Agosto 2027', '2027-08-26', '2027-08-29'],
  ['28-29 Noviembre 2026', '2026-11-28', '2026-11-29'],
  ['3-5 Junio 2027', '2027-06-03', '2027-06-05'],
  ["30 Junio - 3 Julio 2027", '2027-06-30', '2027-07-03'],
  ['4-6 Junio 2027', '2027-06-04', '2027-06-06'],
  ['6-7 Febrero 2027', '2027-02-06', '2027-02-07'],
  ['8-10 Julio 2027', '2027-07-08', '2027-07-10'],
  ['9-11 Julio 2027', '2027-07-09', '2027-07-11'],
];

// Casos que el catalogo no tiene pero el parser tiene que aguantar. Se espera
// null cuando la fecha no existe o el texto no alcanza para decidir: nunca una
// fecha inventada.
const CASOS_BORDE = [
  ['TBA', null, null],
  ['Fecha por anunciar', null, null],
  ['', null, null],
  ['2027', null, null],
  ['3-5 junio 2027', '2027-06-03', '2027-06-05'],
  [' 3-5   JUNIO   2027 ', '2027-06-03', '2027-06-05'],
  ['29 Febrero 2028', '2028-02-29', '2028-02-29'],
  ['29 Febrero 2027', null, null],
  ['31 Abril 2027', null, null],
  ['5-3 Julio 2027', null, null],
  ['26 Diciembre - 2 Enero 2027', '2026-12-26', '2027-01-02'],
  ['Mayo 2026', '2026-05-01', '2026-05-31'],
];

console.log('--- catalogo (' + CASOS_CATALOGO.length + ' cadenas) ---');
for (const [texto, startsOn, endsOn] of CASOS_CATALOGO) {
  const got = parseDateRange(texto);
  const ok = got.startsOn === startsOn && got.endsOn === endsOn;
  check(ok, `${JSON.stringify(texto)} -> ${startsOn || 'null'} .. ${endsOn || 'null'}` +
    (ok ? '' : `  (obtenido: ${got.startsOn || 'null'} .. ${got.endsOn || 'null'})`));
}

console.log('--- casos de borde (' + CASOS_BORDE.length + ') ---');
for (const [texto, startsOn, endsOn] of CASOS_BORDE) {
  const got = parseDateRange(texto);
  const ok = got.startsOn === startsOn && got.endsOn === endsOn;
  check(ok, `${JSON.stringify(texto)} -> ${startsOn || 'null'} .. ${endsOn || 'null'}` +
    (ok ? '' : `  (obtenido: ${got.startsOn || 'null'} .. ${got.endsOn || 'null'})`));
}

// Entradas que no son texto: el parser se usa desde un UPDATE y desde un script,
// asi que un NULL de la DB tambien tiene que caer en "sin fecha".
for (const entrada of [null, undefined, 2027, {}]) {
  const got = parseDateRange(entrada);
  check(got.startsOn === null && got.endsOn === null,
    `no-texto ${String(entrada)} -> null .. null`);
}

console.log('--- invariantes ---');

// Cobertura: si el catalogo estrena un formato, este test lo tiene que frenar
// hasta que alguien escriba el esperado a mano.
const delCatalogo = [...new Set(festivals.map(f => f.dates))];
const cubiertas = new Set(CASOS_CATALOGO.map(([t]) => t));
const sinFixture = delCatalogo.filter(d => !cubiertas.has(d));
check(sinFixture.length === 0,
  `todas las cadenas del catalogo tienen fixture (${delCatalogo.length} distintas)` +
  (sinFixture.length ? ': faltan ' + JSON.stringify(sinFixture) : ''));

const resultados = delCatalogo.map(d => parseDateRange(d));
check(resultados.every(r => {
  const { startsOn, endsOn } = r;
  return (startsOn === null) === (endsOn === null);
}), 'nunca devuelve una fecha sola: son las dos o ninguna');

check(resultados.every(r => !r.startsOn || /^\d{4}-\d{2}-\d{2}$/.test(r.startsOn)),
  'startsOn sale en ISO YYYY-MM-DD');
check(resultados.every(r => !r.endsOn || /^\d{4}-\d{2}-\d{2}$/.test(r.endsOn)),
  'endsOn sale en ISO YYYY-MM-DD');
check(resultados.every(r => !r.endsOn || r.startsOn <= r.endsOn),
  'endsOn nunca es anterior a startsOn (comparacion lexicografica)');

const conFecha = festivals.filter(f => parseDateRange(f.dates).endsOn).length;
console.log(`INFO ${conFecha} de ${festivals.length} festivales tienen fecha; el resto queda null y el rollover lo saltea`);

console.log(fail ? `\n${fail} fallas` : '\nTodo OK');
process.exit(fail ? 1 : 0);
