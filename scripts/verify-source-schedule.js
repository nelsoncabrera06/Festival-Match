#!/usr/bin/env node
'use strict';

// Tests de la cadencia del radar y de la persistencia de estado, sin DB real.
const assert = require('assert');
const {
  isCheckDue, nextCheckAt, parseDate, ACTIVE_CADENCE_DAYS, OFF_SEASON_CADENCE_DAYS,
} = require('../server/sourceSchedule');
const { parseArgs, saveSourceState, scanRows } = require('./lineup-sweep');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-08T12:00:00Z');
const days = (value) => Math.round((new Date(value).getTime() - now.getTime()) / DAY);

function main() {
  // parseDate acepta DATE de Postgres y Date de node-postgres, en UTC para
  // que un ends_on no se corra un día por zona horaria.
  assert.strictEqual(parseDate('2027-06-05').toISOString(), '2027-06-05T00:00:00.000Z');
  assert.strictEqual(parseDate(new Date('2027-06-05T00:00:00Z')).getTime(), Date.parse('2027-06-05T00:00:00Z'));
  assert.strictEqual(parseDate(null), null);
  assert.strictEqual(parseDate('no es fecha'), null);

  // Temporada activa: la edición todavía no terminó o terminó hace <= 7 días.
  const active = nextCheckAt({ now, startsOn: '2027-06-03', endsOn: '2027-06-05' });
  assert.strictEqual(active.cadenceDays, ACTIVE_CADENCE_DAYS);
  assert.strictEqual(days(active.at), ACTIVE_CADENCE_DAYS);
  assert.strictEqual(active.reason, 'active_season');
  assert.strictEqual(nextCheckAt({ now, endsOn: '2026-11-05' }).reason, 'active_season');
  assert.strictEqual(nextCheckAt({ now, startsOn: '2026-12-01', endsOn: null }).reason, 'active_season');

  // Fuera de temporada, sin fechas o con la edición terminada hace tiempo.
  const off = nextCheckAt({ now, startsOn: '2026-10-01', endsOn: '2026-10-03' });
  assert.strictEqual(off.cadenceDays, OFF_SEASON_CADENCE_DAYS);
  assert.strictEqual(off.reason, 'off_season');
  assert.strictEqual(nextCheckAt({ now }).cadenceDays, OFF_SEASON_CADENCE_DAYS);

  // Hiatus = pausado, no se revisa salvo --force.
  const hiatus = nextCheckAt({ now, lineupStatus: 'hiatus', endsOn: '2027-06-05' });
  assert.strictEqual(hiatus.at, null);
  assert.strictEqual(hiatus.paused, true);
  assert.strictEqual(hiatus.reason, 'hiatus');

  // Backoff progresivo con tope de 7 días.
  assert.strictEqual(days(nextCheckAt({ now, consecutiveFailures: 1 }).at), 1);
  assert.strictEqual(days(nextCheckAt({ now, consecutiveFailures: 2 }).at), 2);
  assert.strictEqual(days(nextCheckAt({ now, consecutiveFailures: 3 }).at), 4);
  assert.strictEqual(days(nextCheckAt({ now, consecutiveFailures: 4 }).at), 7);
  assert.strictEqual(days(nextCheckAt({ now, consecutiveFailures: 9 }).at), 7);
  assert.strictEqual(nextCheckAt({ now, consecutiveFailures: 2 }).reason, 'backoff');

  // Retry-After manda sobre el backoff (y no se confunde con días).
  const retry = nextCheckAt({ now, consecutiveFailures: 3, retryAfterMs: 2 * 60 * 1000 });
  assert.strictEqual(retry.reason, 'retry_after');
  assert.strictEqual(new Date(retry.at).getTime() - now.getTime(), 2 * 60 * 1000);

  // isCheckDue: sin fila = due; next_check_at null = pausado; fechas pasadas = due.
  assert.strictEqual(isCheckDue(null, now), true);
  assert.strictEqual(isCheckDue({ nextCheckAt: null }, now), false);
  assert.strictEqual(isCheckDue({ nextCheckAt: new Date(now.getTime() - DAY) }, now), true);
  assert.strictEqual(isCheckDue({ nextCheckAt: new Date(now.getTime() + DAY) }, now), false);
  assert.strictEqual(isCheckDue({ nextCheckAt: '2026-11-01T00:00:00Z' }, now), true);

  // Argumentos: --apply-state escribe, --force exige --apply-state.
  const args = parseArgs(['--apply-state', '--force', '--limit=3']);
  assert.strictEqual(args.applyState, true);
  assert.strictEqual(args.force, true);
  assert.strictEqual(args.limit, 3);
  assert.throws(() => parseArgs(['--force']), /--apply-state/);

  // saveSourceState: tres variantes de SQL, sin tocar last_processed_hash.
  return (async () => {
    const calls = [];
    const fakeClient = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    const row = { id: 'rock-am-ring' };

    await saveSourceState(fakeClient, {
      status: 200, visibleTextHash: 'abc', etag: '"v2"', lastModified: null,
      nextCheckAt: '2026-11-15T12:00:00.000Z', consecutiveFailures: 0,
    }, row, now);
    assert.match(calls[0].sql, /last_seen_hash = EXCLUDED\.last_seen_hash/);
    assert.match(calls[0].sql, /consecutive_failures = 0/);
    assert.strictEqual(calls[0].params[3], 'abc');
    assert.strictEqual(calls[0].params[4], '"v2"');
    assert.ok(!/last_processed_hash/.test(calls[0].sql));

    calls.length = 0;
    await saveSourceState(fakeClient, {
      status: 304, notModified: true, nextCheckAt: '2026-11-15T12:00:00.000Z', consecutiveFailures: 0,
    }, row, now);
    assert.match(calls[0].sql, /304/);
    assert.ok(!/last_seen_hash/.test(calls[0].sql), 'un 304 no debe tocar el hash');
    assert.strictEqual(calls[0].params.length, 3);

    calls.length = 0;
    await saveSourceState(fakeClient, {
      error: 'Respuesta HTTP 429', errorStatus: 429, nextCheckAt: '2026-11-09T12:00:00.000Z', consecutiveFailures: 3,
    }, row, now);
    assert.match(calls[0].sql, /last_error = EXCLUDED\.last_error/);
    assert.strictEqual(calls[0].params[3], 429);
    assert.strictEqual(calls[0].params[5], 3);

    // scanRows propaga el estado con el fetcher inyectado: 304 conserva hash,
    // error incrementa fallos y aplica backoff.
    const rows = [{
      id: 'uno', name: 'Uno', lineupSourceUrl: 'https://source.example/lineup', lineup: [],
      startsOn: null, endsOn: null, lineupStatus: 'announced',
      state: { consecutiveFailures: 2, etag: '"e"', lastModified: null, lastSeenHash: 'h' },
    }];
    let conditional = null;
    const notModified = await scanRows(rows, {
      now, concurrency: 1,
      fetch: async (_url, options) => {
        conditional = options;
        return {
          status: 304, notModified: true, body: Buffer.alloc(0), hash: null,
          etag: '"e"', lastModified: null, finalUrl: _url,
        };
      },
    });
    assert.strictEqual(conditional.etag, '"e"');
    assert.strictEqual(notModified[0].notModified, true);
    assert.strictEqual(notModified[0].triage, 'not_modified');
    assert.strictEqual(notModified[0].consecutiveFailures, 0);
    assert.strictEqual(notModified[0].scheduleReason, 'off_season');

    const failed = await scanRows(rows, {
      now, concurrency: 1,
      fetch: async () => {
        const error = new Error('Respuesta HTTP 429');
        error.status = 429;
        error.retryAfterMs = 60000;
        throw error;
      },
    });
    assert.strictEqual(failed[0].consecutiveFailures, 3);
    assert.strictEqual(failed[0].errorStatus, 429);
    assert.strictEqual(failed[0].scheduleReason, 'retry_after');
    assert.strictEqual(new Date(failed[0].nextCheckAt).getTime() - now.getTime(), 60000);

    console.log('OK: cadencia (temporada, hiatus, backoff, Retry-After) y persistencia de estado.');
  })();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
