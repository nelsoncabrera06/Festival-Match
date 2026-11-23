#!/usr/bin/env node
'use strict';

// Tests de la aprobación de propuestas de lineup (fase 4, paso 15).
//
// Igual que verify-rollover-report.js: no usa red ni una base real. Intercepta
// `pg` con un cliente falso para poder verificar lo que más importa:
//   - la limpieza de sufijos ("(live)", "DJ set", "b2b") antes de publicar,
//   - que aprobar actualice `festivals` y marque la propuesta en la misma
//     transacción,
//   - que una propuesta inválida, vieja o con error NO toque el catálogo,
//   - que las fechas solo se pisen cuando el admin lo pide explícitamente.
//
// Uso: node scripts/verify-lineup-approval.js

const assert = require('assert');
const Module = require('module');
const path = require('path');

const { cleanArtistName, prepareArtists } = require('../server/lineupApproval');

const state = {
  proposal: null,
  newerPending: false,
  queries: [],
};

class FakeClient {
  constructor() {
    this.released = false;
  }

  async query(sql, params = []) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ sql: flat, params });

    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(flat)) {
      return { rows: [], rowCount: 0 };
    }

    // SELECT de la propuesta + festival con FOR UPDATE OF p, f.
    if (flat.includes('FROM public.lineup_proposals p') && flat.includes('FOR UPDATE OF p, f')) {
      return { rows: state.proposal ? [state.proposal] : [], rowCount: state.proposal ? 1 : 0 };
    }

    // Chequeo de una propuesta más nueva pendiente.
    if (flat.includes('first_seen_at >')) {
      const rows = state.newerPending ? [{ id: 99 }] : [];
      return { rows, rowCount: rows.length };
    }

    // UPDATE del catálogo.
    if (flat.startsWith('UPDATE public.festivals SET')) {
      return { rows: [], rowCount: 1 };
    }

    // UPDATE de las propuestas viejas a superseded.
    if (flat.includes("review_status = 'superseded'")) {
      return { rows: [], rowCount: 0 };
    }

    // UPDATE de la propuesta revisada (approved o rejected).
    if (flat.startsWith('UPDATE public.lineup_proposals SET review_status =')) {
      const status = flat.includes("'approved'") ? 'approved' : 'rejected';
      return {
        rows: [{ id: Number(params[0]), review_status: status, reviewed_at: '2026-11-09T12:00:00Z', reviewed_by: params[1] }],
        rowCount: 1,
      };
    }

    // SELECT de rechazo: solo necesita el estado.
    if (flat.startsWith('SELECT id, review_status FROM public.lineup_proposals')) {
      return {
        rows: state.proposal ? [{ id: Number(state.proposal.id), review_status: state.proposal.review_status }] : [],
        rowCount: state.proposal ? 1 : 0,
      };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

class Pool {
  constructor() {
    this.on = () => {};
  }

  connect() {
    return Promise.resolve(new FakeClient());
  }

  query() {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool };
  return realLoad.apply(this, arguments);
};

const db = require(path.join(__dirname, '..', 'server', 'db.js'));

function reset(proposal, { newerPending = false } = {}) {
  state.proposal = proposal ? { ...proposal } : null;
  state.newerPending = newerPending;
  state.queries = [];
}

function proposalRow(overrides = {}) {
  return {
    id: 7,
    festival_id: 'sonar',
    source_url: 'https://sonar.es/en',
    seen_hash: 'hash',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    schema_version: 1,
    lineup_status: 'partial',
    artists_count: 3,
    confidence: 0.9,
    payload: {
      lineupStatus: 'partial',
      artists: [
        { name: 'Bad Gyal', day: null },
        { name: 'Bicep (live)', day: null },
        { name: 'Charlotte de Witte b2b Rødhåd', day: null },
      ],
      datesText: '17-19 junio 2027',
      lineupAnnouncement: { announcedAt: null, quote: null },
      tickets: { status: 'on_sale', onSaleAt: null, quote: null },
      evidence: ['primera ola'],
      uncertainty: [],
      pageEditionYear: 2027,
      editionMatchesTarget: true,
    },
    extraction_error: null,
    review_status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    first_seen_at: '2026-11-09T10:00:00Z',
    created_at: '2026-11-09T10:00:00Z',
    updated_at: '2026-11-09T10:00:00Z',
    festival_name: 'Sónar',
    current_lineup: ['Bad Gyal', 'Viejo Artista'],
    current_lineup_status: 'partial',
    festival_dates: '2027 (fecha por anunciar)',
    ...overrides,
  };
}

function festivalUpdate() {
  return state.queries.find((q) => q.sql.startsWith('UPDATE public.festivals SET'));
}

(async () => {
  // ---------- limpieza de nombres ----------
  assert.strictEqual(cleanArtistName('Bicep (live)'), 'Bicep');
  assert.strictEqual(cleanArtistName('Peggy Gou - DJ set'), 'Peggy Gou');
  assert.strictEqual(cleanArtistName('Peggy Gou [live]'), 'Peggy Gou');
  assert.strictEqual(cleanArtistName('Live'), 'Live', 'un nombre propio "Live" no se vacía');
  assert.strictEqual(cleanArtistName('Bicep b2b'), 'Bicep', 'un b2b sin pareja al final también se limpia');
  assert.strictEqual(cleanArtistName('  Björk  '), 'Björk');

  assert.deepStrictEqual(
    prepareArtists(['Bicep (live)', 'Charlotte de Witte b2b Rødhåd', 'bjork', 'BJÖRK', '  ']),
    ['Bicep', 'Charlotte de Witte', 'Rødhåd', 'bjork']
  );
  assert.deepStrictEqual(
    prepareArtists([{ name: 'A back to back B' }, { name: 'C - b2b' }]),
    ['A', 'B', 'C']
  );

  // ---------- mapeo de la propuesta: fechas y comparación con el catálogo ----------
  // La fuente escribe "13-15.05.2027" y el catálogo "13-15 Mayo 2027": es la
  // misma fecha, así que el panel no debe mostrar "no se pudo interpretar" ni
  // ofrecer pisar las fechas.
  const mismaFecha = db.rowToProposal(proposalRow({
    payload: { ...proposalRow().payload, datesText: '13-15.05.2027' },
    festival_dates: '13-15 Mayo 2027',
  }));
  assert.strictEqual(mismaFecha.proposalDates.startsOn, '2027-05-13');
  assert.strictEqual(mismaFecha.proposalDates.endsOn, '2027-05-15');
  assert.strictEqual(mismaFecha.datesChanged, false, 'misma fecha con otro formato: datesChanged false');

  const fechaDistinta = db.rowToProposal(proposalRow({
    payload: { ...proposalRow().payload, datesText: '14-16.05.2027' },
    festival_dates: '13-15 Mayo 2027',
  }));
  assert.strictEqual(fechaDistinta.datesChanged, true);

  const catalogoSinFecha = db.rowToProposal(proposalRow({
    payload: { ...proposalRow().payload, datesText: '13-15.05.2027' },
    festival_dates: '2027 (fecha por anunciar)',
  }));
  assert.strictEqual(catalogoSinFecha.proposalDates.startsOn, '2027-05-13');
  assert.strictEqual(catalogoSinFecha.datesChanged, null, 'sin fecha en el catálogo no hay nada que comparar');

  const propuestaSinInterpretar = db.rowToProposal(proposalRow({
    payload: { ...proposalRow().payload, datesText: 'TBA' },
    festival_dates: '13-15 Mayo 2027',
  }));
  assert.strictEqual(propuestaSinInterpretar.proposalDates.startsOn, null);
  assert.strictEqual(propuestaSinInterpretar.datesChanged, null);

  // ---------- mapeo del catálogo: entradas ----------
  // `rowToFestival` tiene que exponer `tickets` solo cuando hay dato, y omitir
  // la clave cuando la columna es NULL (mismo criterio que `image`, para no
  // romper el round-trip con el seed).
  const conTickets = db.rowToFestival({
    id: 'ultra-buenos-aires', name: 'Ultra Buenos Aires', city: 'Buenos Aires',
    location: 'Buenos Aires, Argentina', country: 'AR', dates: '2-3 Abril 2027',
    website: 'https://ultra.com.ar', lineup_status: 'partial', lineup: ['A'],
    tickets_status: 'on_sale', tickets_on_sale_at: null, tickets_updated_at: '2026-11-22T10:00:00Z',
  });
  assert.deepStrictEqual(conTickets.tickets, {
    status: 'on_sale',
    onSaleAt: null,
    updatedAt: '2026-11-22T10:00:00Z',
  });

  const sinTickets = db.rowToFestival({
    id: 'x', name: 'X', city: 'X', location: 'X, X', country: 'AR', dates: '2027',
    website: '', lineup_status: 'unannounced', lineup: [],
    tickets_status: null, tickets_on_sale_at: null, tickets_updated_at: null,
  });
  assert.ok(!('tickets' in sinTickets), 'sin dato de entradas la clave no existe');

  // ---------- aprobación exitosa ----------
  reset(proposalRow());
  const approved = await db.approveLineupProposal(7, {
    reviewedBy: 'nelson@example.com',
    applyDates: true,
  });
  const update = festivalUpdate();
  assert.ok(update, 'aprobación: actualiza festivals');
  assert.strictEqual(update.params[0], 'sonar');
  assert.deepStrictEqual(update.params[1], ['Bad Gyal', 'Bicep', 'Charlotte de Witte', 'Rødhåd']);
  assert.strictEqual(update.params[2], 'partial');
  // applyDates: dates, starts_on, ends_on.
  assert.strictEqual(update.params[3], '17-19 junio 2027');
  assert.strictEqual(update.params[4], '2027-06-17');
  assert.strictEqual(update.params[5], '2027-06-19');
  assert.ok(
    state.queries.some((q) => q.sql.includes("review_status = 'superseded'")),
    'aprobación: marca como superseded las otras pendientes del festival'
  );
  assert.ok(
    state.queries.some((q) => q.sql.startsWith('UPDATE public.lineup_proposals SET review_status =') && q.sql.includes("'approved'")),
    'aprobación: marca la propuesta como approved'
  );
  assert.strictEqual(approved.proposal.review_status, 'approved');
  assert.strictEqual(approved.festival.lineup.length, 4);

  // ---------- no pisa fechas si no se pide ----------
  reset(proposalRow());
  await db.approveLineupProposal(7, { reviewedBy: 'admin' });
  const updateSinFechas = festivalUpdate();
  // Se asserta sobre las columnas del SET y no sobre params.length: la cantidad
  // de parámetros cambia si se agrega un campo (entradas, migración 023) y el
  // test tiene que verificar la intención, no un número que se rompe solo.
  for (const columna of ['dates =', 'starts_on =', 'ends_on =']) {
    assert.ok(
      !updateSinFechas.sql.includes(columna),
      `sin applyDates no toca ${columna.trim()}`
    );
  }

  // ---------- las entradas se publican al aprobar ----------
  // El estado de tickets vivía solo en `lineup_proposals.payload` y no llegaba a
  // la ficha pública. Ahora se escribe en `festivals` en la misma transacción.
  assert.ok(updateSinFechas.sql.includes('tickets_status ='), 'aprobación: publica el estado de entradas');
  assert.ok(updateSinFechas.sql.includes('tickets_on_sale_at ='));
  assert.ok(updateSinFechas.sql.includes('tickets_updated_at = NOW()'));
  assert.ok(updateSinFechas.params.includes('on_sale'));

  // "not_mentioned" no pisa el catálogo: que una página deje de hablar de
  // entradas no significa que se agotaron.
  reset(proposalRow({
    payload: {
      ...proposalRow().payload,
      tickets: { status: 'not_mentioned', onSaleAt: null, quote: null },
    },
  }));
  await db.approveLineupProposal(7, { reviewedBy: 'admin' });
  const updateSinTickets = festivalUpdate();
  assert.ok(
    !updateSinTickets.sql.includes('tickets_status ='),
    'not_mentioned: no borra el estado de entradas ya publicado'
  );

  // ---------- una propuesta con error no se aprueba ----------
  reset(proposalRow({ extraction_error: 'JSON inválido', lineup_status: null }));
  await assert.rejects(
    () => db.approveLineupProposal(7, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'EXTRACTION_ERROR' && err.statusCode === 409
  );
  assert.strictEqual(festivalUpdate(), undefined, 'error de extracción: no toca festivals');
  assert.strictEqual(state.queries.filter((q) => q.sql === 'ROLLBACK').length, 1, 'hace ROLLBACK');

  // ---------- no aprueba una propuesta ya revisada ----------
  reset(proposalRow({ review_status: 'approved' }));
  await assert.rejects(
    () => db.approveLineupProposal(7, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'ALREADY_REVIEWED'
  );
  assert.strictEqual(festivalUpdate(), undefined);

  // ---------- no aprueba una propuesta reemplazada por otra más nueva ----------
  reset(proposalRow(), { newerPending: true });
  await assert.rejects(
    () => db.approveLineupProposal(7, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'SUPERSEDED_BY_NEWER'
  );
  assert.strictEqual(festivalUpdate(), undefined);

  // ---------- unannounced con lineup actual: no borra el catálogo ----------
  reset(proposalRow({
    lineup_status: 'unannounced',
    payload: { artists: [], datesText: null, evidence: [], uncertainty: [] },
    current_lineup: ['Artista vigente'],
  }));
  await assert.rejects(
    () => db.approveLineupProposal(7, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'WOULD_CLEAR_LINEUP'
  );
  assert.strictEqual(festivalUpdate(), undefined, 'no borra un lineup existente');

  // ---------- unannounced sin lineup actual: solo cambia el estado ----------
  reset(proposalRow({
    lineup_status: 'unannounced',
    payload: { artists: [], datesText: null, evidence: [], uncertainty: [] },
    current_lineup: [],
  }));
  await db.approveLineupProposal(7, { reviewedBy: 'admin' });
  const updateVacio = festivalUpdate();
  assert.deepStrictEqual(updateVacio.params[1], []);
  assert.strictEqual(updateVacio.params[2], 'unannounced');

  // ---------- el admin puede editar la lista antes de publicar ----------
  reset(proposalRow());
  await db.approveLineupProposal(7, {
    reviewedBy: 'admin',
    artists: ['  Artista editado (live) ', 'Otra b2b Tercera'],
  });
  assert.deepStrictEqual(
    festivalUpdate().params[1],
    ['Artista editado', 'Otra', 'Tercera'],
    'la lista editada también pasa por la limpieza'
  );

  // ---------- rechazo ----------
  reset(proposalRow());
  await db.rejectLineupProposal(7, { reviewedBy: 'nelson@example.com' });
  assert.ok(
    state.queries.some((q) => q.sql.startsWith('UPDATE public.lineup_proposals SET review_status =') && q.sql.includes("'rejected'")),
    'rechazo: marca la propuesta como rejected'
  );
  assert.strictEqual(festivalUpdate(), undefined, 'rechazo: no toca festivals');

  reset(proposalRow({ review_status: 'rejected' }));
  await assert.rejects(
    () => db.rejectLineupProposal(7, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'ALREADY_REVIEWED'
  );

  console.log('Todo OK: aprobación de propuestas de lineup');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
