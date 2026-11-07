/**
 * Verifica el comportamiento del rollover y del reporte SIN tocar la base.
 *
 * Por que existe: el camino `--apply` es el unico que borra datos reales
 * (lineups de 130 artistas). No se puede probar contra produccion, y leer el
 * codigo no alcanza para saber si:
 *   - el dry run no escribe,
 *   - el apply rota el año correcto y limpia el texto de fechas,
 *   - un segundo apply no rota dos veces,
 *   - un error en un festival no corta el resto del reporte,
 *   - el filtro `--festival=id` limita el rollover.
 *
 * Intercepta el modulo `pg` igual que verify-festivals-queries.js, pero con un
 * Pool que responde con filas de mentira y registra los UPDATE.
 *
 * Uso:  node scripts/verify-rollover-report.js
 */

const Module = require('module');
const path = require('path');

// Filas de mentira. El fake no entiende SQL de verdad: alcanza con reconocer
// las tres consultas que usa el reporte (vencidos, catalogo completo, rollover).
const estado = {
  // Se modifican entre casos para simular "ya se rotó" o "falló el UPDATE".
  vencidos: [],
  catalogo: [],
  rotados: [],
  fallarIds: new Set(),
};

const queries = [];

class Pool {
  constructor() { this.on = () => {}; }

  query(sql, params) {
    const plano = String(sql).replace(/\s+/g, ' ');
    queries.push({ sql: plano, params: params || [] });

    // getFestivalsEndedBefore(fecha): filtra por el $1 que manda el reporte.
    if (plano.includes('ends_on < $1::date')) {
      const fecha = params[0];
      return Promise.resolve({
        rows: estado.vencidos.filter((f) => f.ends_on < fecha),
        rowCount: 0,
      });
    }

    // getFestivalsReportRows(): todo el catalogo.
    if (plano.startsWith('SELECT') && plano.includes('ORDER BY sort_order')) {
      return Promise.resolve({ rows: estado.catalogo, rowCount: estado.catalogo.length });
    }

    // rolloverFestival(): el fake respeta el WHERE re-validando ends_on, que es
    // justamente lo que hace idempotente al UPDATE real.
    if (plano.startsWith('UPDATE festivals') && plano.includes("lineup_status = 'unannounced'")) {
      const id = params[0];
      const fila = estado.vencidos.find((f) => f.id === id);
      if (estado.fallarIds.has(id)) {
        return Promise.reject(new Error('fallo simulado del UPDATE'));
      }
      if (!fila) return Promise.resolve({ rows: [], rowCount: 0 });

      // Simula el efecto: deja de estar vencido, para que un segundo apply no
      // lo vuelva a encontrar (igual que ends_on = NULL en la base real).
      fila.ends_on = null;
      fila.dates = params[1];
      fila.lineup_status = 'unannounced';
      fila.artist_count = 0;
      const rotado = { id, name: fila.name, dates: params[1] };
      estado.rotados.push(rotado);
      return Promise.resolve({ rows: [rotado], rowCount: 1 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool };
  return realLoad.apply(this, arguments);
};

const db = require(path.join(__dirname, '..', 'server', 'db.js'));
const { buildRolloverReport } = require(path.join(__dirname, '..', 'server', 'rolloverReport.js'));

let fail = 0;
const check = (cond, msg) => {
  if (cond) console.log('OK ' + msg);
  else { console.log('X  ' + msg); fail++; }
};

function fila({ id, name, dates, endsOn, status = 'confirmed', artistas = 10 }) {
  return {
    id, name, dates, ends_on: endsOn, lineup_status: status, artist_count: artistas,
  };
}

function reiniciar({ vencidos = [], catalogo = [], fallarIds = [] } = {}) {
  queries.length = 0;
  estado.vencidos = vencidos.map((f) => ({ ...f }));
  estado.catalogo = catalogo.map((f) => ({ ...f }));
  estado.rotados = [];
  estado.fallarIds = new Set(fallarIds);
}

function updatesDeRollover() {
  return queries.filter(
    (q) => q.sql.startsWith('UPDATE festivals') && q.sql.includes("lineup_status = 'unannounced'")
  );
}

(async () => {
  const amf = fila({
    id: 'amf', name: 'Amsterdam Music Festival', dates: '24 Octubre 2026',
    endsOn: '2026-10-24', artistas: 8,
  });
  const acl = fila({
    id: 'austin-city-limits', name: 'Austin City Limits', dates: '2-4 & 9-11 Octubre 2026',
    endsOn: '2026-10-11', artistas: 130,
  });
  const futuro = fila({
    id: 'rock-am-ring', name: 'Rock am Ring', dates: '4-6 Junio 2027',
    endsOn: '2027-06-06', artistas: 50,
  });
  const hiatus = fila({
    id: 'bonnaroo', name: 'Bonnaroo', dates: '2027 (sin edición)',
    endsOn: null, status: 'hiatus', artistas: 0,
  });

  // 1. Dry run: reporta los dos vencidos y NO ejecuta ningun UPDATE.
  reiniciar({ vencidos: [acl, amf], catalogo: [acl, amf, futuro, hiatus] });
  const dry = await buildRolloverReport({ today: '2026-11-07' });
  check(updatesDeRollover().length === 0, 'dry run: no ejecuta ningun UPDATE');
  check(dry.counts.candidatos === 2 && dry.counts.rotados === 0,
    'dry run: 2 candidatos y 0 rotados');
  check(/Candidatos a rotar \(2\)/.test(dry.markdown), 'dry run: el titulo dice "Candidatos a rotar"');
  check(/dry run: no se aplicó nada/i.test(dry.markdown), 'dry run: el reporte avisa que no escribio');
  check(/pasaría a 2027/.test(dry.markdown), 'dry run: usa condicional ("pasaría")');

  // 2. Apply: rota cada uno a su año+1 y escribe el texto de la edicion nueva.
  reiniciar({ vencidos: [acl, amf], catalogo: [acl, amf, futuro, hiatus] });
  const aplicado = await buildRolloverReport({ today: '2026-11-07', apply: true });
  const upd = updatesDeRollover();
  check(upd.length === 2, 'apply: ejecuta un UPDATE por candidato');
  check(upd.every((q) => q.params[1] === '2027 (fecha por anunciar)'),
    'apply: el texto nuevo es "2027 (fecha por anunciar)"');
  check(upd.map((q) => q.params[0]).sort().join(',') === 'amf,austin-city-limits',
    'apply: rota los ids correctos');
  check(aplicado.counts.rotados === 2 && /Rotados \(2\)/.test(aplicado.markdown),
    'apply: el reporte dice "Rotados (2)"');
  check(/pasa a 2027/.test(aplicado.markdown), 'apply: usa afirmativo ("pasa a")');

  // 3. Segundo apply: ya no hay vencidos, no rota nada (idempotencia del WHERE).
  reiniciar({ vencidos: [], catalogo: [futuro, hiatus] });
  const segundo = await buildRolloverReport({ today: '2026-11-07', apply: true });
  check(updatesDeRollover().length === 0, 'segundo apply: no ejecuta UPDATE');
  check(segundo.counts.rotados === 0, 'segundo apply: 0 rotados');

  // 4. Filtro --festival: solo rota el id pedido.
  reiniciar({ vencidos: [acl, amf], catalogo: [acl, amf, futuro, hiatus] });
  const filtrado = await buildRolloverReport({
    today: '2026-11-07', apply: true, festivalId: 'amf',
  });
  check(updatesDeRollover().length === 1 && updatesDeRollover()[0].params[0] === 'amf',
    'filtro: solo rota el festival pedido');
  check(filtrado.counts.rotados === 1 && filtrado.festivalId === 'amf',
    'filtro: el resultado queda marcado con el id');

  // 5. Filtro sin candidato: reporte claro, sin UPDATE.
  reiniciar({ vencidos: [acl], catalogo: [acl, futuro] });
  const sinCandidato = await buildRolloverReport({
    today: '2026-11-07', apply: true, festivalId: 'amf',
  });
  check(updatesDeRollover().length === 0, 'filtro sin candidato: no escribe');
  check(/Filtro `--festival=amf`/.test(sinCandidato.markdown),
    'filtro sin candidato: el reporte explica por que no hay nada');

  // 6. Un error en un festival no corta a los demas y marca hasNews.
  reiniciar({
    vencidos: [acl, amf], catalogo: [acl, amf, futuro], fallarIds: ['austin-city-limits'],
  });
  const conError = await buildRolloverReport({ today: '2026-11-07', apply: true });
  check(conError.errores.length === 1 && conError.errores[0].id === 'austin-city-limits',
    'error: se registra el festival que fallo');
  check(conError.counts.rotados === 1 && conError.rotados[0].id === 'amf',
    'error: el resto se sigue rotando');
  check(/## Errores \(1\)/.test(conError.markdown), 'error: el reporte tiene seccion de errores');
  check(conError.hasNews === true, 'error: hasNews es true');

  // 7. hasNews: "terminan pronto" no dispara aviso; un vencido sí.
  reiniciar({ vencidos: [], catalogo: [futuro, hiatus] });
  const tranquilo = await buildRolloverReport({ today: '2026-11-07' });
  check(tranquilo.hasNews === false, 'sin novedades: hasNews es false');
  check(/Sin novedades/.test(tranquilo.markdown), 'sin novedades: el reporte lo dice');

  // 8. Atencion: hiatus vencido y texto con año pasado ilegible.
  const hiatusVencido = fila({
    id: 'glastonbury', name: 'Glastonbury', dates: '2026 (sin edición)',
    endsOn: '2026-06-28', status: 'hiatus', artistas: 0,
  });
  const anioViejo = fila({
    id: 'x', name: 'Festival X', dates: '2025 (fecha por anunciar)',
    endsOn: null, status: 'unannounced', artistas: 0,
  });
  reiniciar({ vencidos: [], catalogo: [hiatusVencido, anioViejo] });
  const atencion = await buildRolloverReport({ today: '2026-11-07' });
  check(atencion.atencion.length === 2, 'atencion: detecta hiatus vencido y año viejo ilegible');
  check(atencion.hasNews === true, 'atencion: hasNews es true');
  check(/## Requieren atención \(2\)/.test(atencion.markdown), 'atencion: seccion en el reporte');

  console.log(fail ? `\n${fail} fallas` : '\nTodo OK');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
