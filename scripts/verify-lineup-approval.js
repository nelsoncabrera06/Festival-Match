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
  assert.strictEqual(updateSinFechas.params.length, 3, 'sin applyDates no toca dates/starts_on/ends_on');

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
