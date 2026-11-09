#!/usr/bin/env node
'use strict';

// Tests de aprobación/rechazo de propuestas de datos de festival (paso 18/19).
// Intercepta `pg` y verifica que aprobar actualice festivals en una transacción
// y que rechazar no toque el catálogo.

const assert = require('assert');
const Module = require('module');
const path = require('path');

const state = { proposal: null, newerPending: false, queries: [] };

class FakeClient {
  async query(sql, params = []) {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ sql: flat, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(flat)) return { rows: [], rowCount: 0 };
    if (flat.includes('FROM public.festival_fact_proposals p') && flat.includes('FOR UPDATE OF p, f')) {
      return { rows: state.proposal ? [state.proposal] : [], rowCount: state.proposal ? 1 : 0 };
    }
    if (flat.includes('FROM public.festival_fact_proposals') && flat.includes('first_seen_at >')) {
      const rows = state.newerPending ? [{ id: 99 }] : [];
      return { rows, rowCount: rows.length };
    }
    if (flat.startsWith('UPDATE public.festivals')) return { rows: [], rowCount: 1 };
    if (flat.includes("review_status = 'superseded'")) return { rows: [], rowCount: 0 };
    if (flat.startsWith('UPDATE public.festival_fact_proposals SET review_status =')) {
      const status = flat.includes("'approved'") ? 'approved' : 'rejected';
      return { rows: [{ id: Number(params[0]), review_status: status, reviewed_at: '2026-11-09T12:00:00Z', reviewed_by: params[1] }], rowCount: 1 };
    }
    if (flat.startsWith('SELECT id, review_status FROM public.festival_fact_proposals')) {
      return { rows: state.proposal ? [{ id: Number(state.proposal.id), review_status: state.proposal.review_status }] : [], rowCount: state.proposal ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
  release() {}
}

class Pool {
  constructor() { this.on = () => {}; }
  connect() { return Promise.resolve(new FakeClient()); }
  query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool };
  return realLoad.apply(this, arguments);
};
const db = require(path.join(__dirname, '..', 'server', 'db.js'));

function reset(overrides = {}, { newerPending = false } = {}) {
  state.proposal = {
    id: 1, festival_id: 'glastonbury', source_url: 'https://www.glastonburyfestivals.co.uk', page_url: 'https://www.glastonburyfestivals.co.uk/news/glastonbury-2027-ticket-information-confirmed/',
    seen_hash: 'hash', model: 'm', schema_version: 1,
    proposed_dates: '23-27 Junio 2027', proposed_lineup_status: 'unannounced',
    proposed_starts_on: '2027-06-23', proposed_ends_on: '2027-06-27',
    evidence: ['x'], confidence: 0.9, payload: {}, review_status: 'pending',
    reviewed_at: null, reviewed_by: null, first_seen_at: '2026-11-09T10:00:00Z',
    created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z',
    festival_name: 'Glastonbury Festival', current_dates: '2027 (confirmado)',
    current_lineup_status: 'hiatus', current_starts_on: null, current_ends_on: null,
    ...overrides,
  };
  state.newerPending = newerPending;
  state.queries = [];
}

function festivalUpdate() {
  return state.queries.find((q) => q.sql.startsWith('UPDATE public.festivals'));
}

(async () => {
  // Aprobación normal: aplica estado, fechas y starts/ends propuestos.
  reset();
  const approved = await db.approveFestivalFactProposal(1, { reviewedBy: 'nelson@example.com' });
  const update = festivalUpdate();
  assert.ok(update);
  assert.strictEqual(update.params[0], 'glastonbury');
  assert.strictEqual(update.params[1], 'unannounced');
  assert.strictEqual(update.params[2], '23-27 Junio 2027');
  assert.strictEqual(update.params[3], '2027-06-23');
  assert.strictEqual(update.params[4], '2027-06-27');
  assert.strictEqual(approved.proposal.review_status, 'approved');
  assert.strictEqual(approved.festival.lineupStatus, 'unannounced');

  // Override de fechas desde el admin: se re-derivan starts/ends.
  reset();
  await db.approveFestivalFactProposal(1, { reviewedBy: 'admin', dates: '27-29 Agosto 2027', lineupStatus: 'unannounced' });
  const overridden = festivalUpdate();
  assert.strictEqual(overridden.params[2], '27-29 Agosto 2027');
  assert.strictEqual(overridden.params[3], '2027-08-27');
  assert.strictEqual(overridden.params[4], '2027-08-29');

  // Una propuesta ya revisada no se vuelve a aplicar.
  reset({ review_status: 'approved' });
  await assert.rejects(
    () => db.approveFestivalFactProposal(1, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'ALREADY_REVIEWED'
  );
  assert.strictEqual(festivalUpdate(), undefined);

  // No aprobar una propuesta vieja si hay otra más nueva pendiente.
  reset({}, { newerPending: true });
  await assert.rejects(
    () => db.approveFestivalFactProposal(1, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'SUPERSEDED_BY_NEWER'
  );
  assert.strictEqual(festivalUpdate(), undefined);

  // Estado inválido: no toca festivals.
  reset({ proposed_lineup_status: 'inventado' });
  await assert.rejects(
    () => db.approveFestivalFactProposal(1, { reviewedBy: 'admin' }),
    (err) => err.proposalCode === 'INVALID_STATUS'
  );
  assert.strictEqual(festivalUpdate(), undefined);

  // Rechazo: no toca festivals.
  reset();
  await db.rejectFestivalFactProposal(1, { reviewedBy: 'nelson@example.com' });
  assert.ok(state.queries.some((q) => q.sql.startsWith('UPDATE public.festival_fact_proposals SET review_status =') && q.sql.includes("'rejected'")));
  assert.strictEqual(festivalUpdate(), undefined);

  // Aprobación de no_edition: mantiene hiatus y las fechas actuales si no hay propuesta de fecha.
  reset({
    festival_id: 'bonnaroo', festival_name: 'Bonnaroo',
    proposed_dates: null, proposed_lineup_status: 'hiatus',
    proposed_starts_on: null, proposed_ends_on: null,
    current_dates: '2027 (sin edición)', current_lineup_status: 'hiatus',
  });
  await db.approveFestivalFactProposal(1, { reviewedBy: 'admin' });
  const hiatusUpdate = festivalUpdate();
  assert.strictEqual(hiatusUpdate.params[1], 'hiatus');
  assert.strictEqual(hiatusUpdate.params[2], '2027 (sin edición)');

  console.log('Todo OK: aprobación de propuestas de datos de festival');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
