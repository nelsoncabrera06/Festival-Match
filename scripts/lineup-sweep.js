#!/usr/bin/env node
'use strict';

// Barrido del radar de lineups. Por defecto es dry run: lee lineup_source_url,
// hace GET acotados y no escribe nada. Con --apply-state persiste el estado
// operativo en festival_source_checks (hash, ETag, errores, cadencia).
const fs = require('fs');
const path = require('path');

const { Client } = require('pg');
const { fetchSource } = require('../server/lineupSourceFetcher');
const {
  RELEVANT_HASH_VERSION, analyzeRelevantContent, analyzeVisibleText, extractTitle,
  findLineupHits, htmlToVisibleText, refineTriageWithLineup,
} = require('../server/lineupHtml');
const { isCheckDue, nextCheckAt } = require('../server/sourceSchedule');

const USAGE = `Uso: node scripts/lineup-sweep.js [opciones]

  --dry                 barrido de lectura sin escribir (default)
  --apply-state         guarda estado y respeta next_check_at de cada fuente
  --observe             con --apply-state, crea una observación si el contenido cambió
  --force               con --apply-state, revisa aunque no esté vencida
  --festival=<id>       limita la inspección a un festival
  --limit=<n>           limita el número de fuentes (1-63)
  --json-out=<ruta>     guarda el reporte JSON local
  --report-out=<ruta>   guarda el reporte Markdown (lo usa el workflow)
  --help                muestra esta ayuda

El comando lee las URLs desde Supabase y solicita páginas públicas HTTPS.
Nunca publica lineups: solo observa y, con --apply-state, registra cuándo se
revisó cada fuente, el hash/ETag y el próximo chequeo. Errores individuales
aparecen en el reporte y no detienen el resto del barrido.
`;

function parseArgs(argv) {
  const options = {
    festival: null, limit: 63, jsonOut: null, reportOut: null, help: false,
    applyState: false, observe: false, force: false,
  };
  for (const arg of argv) {
    if (arg === '--dry') continue;
    if (arg === '--apply-state') options.applyState = true;
    else if (arg === '--observe') options.observe = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--festival=')) options.festival = arg.slice(11);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--json-out=')) options.jsonOut = arg.slice(11);
    else if (arg.startsWith('--report-out=')) options.reportOut = arg.slice(13);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.festival === '') throw new Error('--festival necesita un id.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 63) {
    throw new Error('--limit debe ser un entero entre 1 y 63.');
  }
  if (options.jsonOut === '') throw new Error('--json-out necesita una ruta.');
  if (options.reportOut === '') throw new Error('--report-out necesita una ruta.');
  if (options.force && !options.applyState) throw new Error('--force solo se usa junto con --apply-state.');
  if (options.observe && !options.applyState) throw new Error('--observe solo se usa junto con --apply-state.');
  return options;
}

function databaseClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Falta DATABASE_URL en el entorno.');
  let host;
  try { host = new URL(connectionString).hostname; } catch { throw new Error('DATABASE_URL no es válida.'); }
  const isSupabase = host.endsWith('.pooler.supabase.com') || host.endsWith('.supabase.co');
  return new Client({
    connectionString,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    ssl: isSupabase ? { rejectUnauthorized: false } : false,
  });
}

async function readOnlyRows(client, sql, params) {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function mapSourceRow(row) {
  return {
    id: row.id,
    name: row.name,
    lineupSourceUrl: row.lineup_source_url,
    lineup: row.lineup,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    lineupStatus: row.lineup_status,
    state: row.next_check_at || row.last_checked_at || row.etag || row.last_modified
      || row.last_http_status || row.last_error || row.consecutive_failures
      ? {
        nextCheckAt: row.next_check_at,
        lastSeenHash: row.last_seen_hash,
        etag: row.etag,
        lastModified: row.last_modified,
        consecutiveFailures: row.consecutive_failures,
        hashVersion: row.hash_version ?? null,
      }
      : null,
  };
}

async function loadSources(client, options) {
  const filter = `f.lineup_source_url IS NOT NULL AND BTRIM(f.lineup_source_url) <> ''
          AND ($1::text IS NULL OR f.id = $1)`;
  const params = [options.festival, options.limit];
  try {
    const rows = await readOnlyRows(client,
      `SELECT f.id, f.name, f.lineup_source_url, f.lineup,
              f.starts_on, f.ends_on, f.lineup_status,
              c.next_check_at, c.last_seen_hash, c.etag, c.last_modified,
              c.last_checked_at, c.last_http_status, c.last_error, c.consecutive_failures,
              c.hash_version
         FROM public.festivals f
         LEFT JOIN public.festival_source_checks c ON c.festival_id = f.id
        WHERE ${filter}
        ORDER BY f.id
        LIMIT $2`, params);
    return rows.map(mapSourceRow);
  } catch (error) {
    // Permite correr el dry run antes de aplicar migrations/017 o 018. Sin
    // estado no hay caché condicional ni cadencia persistida, pero se lee igual.
    if (error.code !== '42P01' && error.code !== '42703') throw error;
    console.error('Aviso: falta el esquema de estado (migrations/017 y 018). Se barre sin estado persistido ni observaciones.');
    const rows = await readOnlyRows(client,
      `SELECT f.id, f.name, f.lineup_source_url, f.lineup,
              f.starts_on, f.ends_on, f.lineup_status
         FROM public.festivals f
        WHERE ${filter}
        ORDER BY f.id
        LIMIT $2`, params);
    return rows.map(mapSourceRow);
  }
}

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

// Fechas para humanos: DD-MM-YYYY (y hora en UTC cuando hace falta). El
// almacenamiento sigue en ISO/UTC; esto es solo presentación del reporte.
function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${formatDate(date)} ${hours}:${minutes}:${seconds} UTC`;
}

function renderMarkdown(report) {
  const applied = report.mode !== 'dry-run';
  const modeLabel = report.mode === 'observe' ? 'observe' : applied ? 'apply-state' : 'dry run';
  const observations = report.mode === 'observe' ? report.summary.observations : null;
  const lines = [
    `# Lineup source sweep (${modeLabel})`,
    '',
    `- **Generado:** ${formatDateTime(report.generatedAt)}`,
    `- **Fuentes:** ${report.summary.total}`,
    `- **Revisadas:** ${report.summary.checked}`,
    `- **Salteadas por cadencia:** ${report.summary.skipped}`,
    `- **OK:** ${report.summary.ok}`,
    `- **Sin cambios (304):** ${report.summary.notModified}`,
    `- **Errores:** ${report.summary.errors}`,
    `- **HTML candidato:** ${report.summary.candidateHtml}`,
  ];
  if (observations) {
    lines.push(`- **Observaciones nuevas:** ${observations.inserted}`);
    lines.push(`- **Línea base:** ${observations.baseline}`);
  }
  lines.push(
    '',
    '| Festival | Triage | Artistas DB | HTTP | Título | Señales | Texto | Hash normalizado | Próximo chequeo | URL final / error |',
    '|---|---|---|---:|---|---|---:|---|---|---|',
  );
  for (const row of report.results) {
    const outcome = row.error ? 'error' : 'ok';
    const detail = row.error || (row.notModified ? '304 Not Modified' : row.finalUrl);
    const coverage = row.lineupArtistTotal
      ? `${row.lineupArtistMatched}/${row.lineupArtistTotal} (${Math.round(row.lineupHitRatio * 100)}%)`
      : '';
    const next = row.nextCheckAt ? `${formatDate(row.nextCheckAt)} (${row.scheduleReason}${row.cadenceDays ? `, ${row.cadenceDays}d` : ''})` : 'pausado';
    lines.push(`| ${escapeCell(row.name)} (${escapeCell(row.id)}) | ${row.triage || outcome} | ${coverage} | ${row.status ?? ''} | ${escapeCell(row.title || '')} | ${escapeCell((row.lineupSignals || []).join(', '))} | ${row.visibleTextLength ?? ''} | ${row.relevantHash || row.visibleTextHash || ''} | ${next} | ${escapeCell(detail)} |`);
  }
  if (report.observed && report.observed.length) {
    lines.push('', '## Observaciones nuevas', '', '| Festival | Hash anterior | Hash nuevo | Detectado |', '|---|---|---|---|');
    for (const row of report.observed) {
      lines.push(`| ${escapeCell(row.name)} (${escapeCell(row.id)}) | ${(row.previousHash || '').slice(0, 12)} | ${(row.seenHash || '').slice(0, 12)} | ${formatDateTime(row.detectedAt)} |`);
    }
  }
  if (report.skipped.length) {
    lines.push('', '## Salteadas por cadencia', '', '| Festival | Próximo chequeo |', '|---|---|');
    for (const row of report.skipped) {
      lines.push(`| ${escapeCell(row.name)} (${escapeCell(row.id)}) | ${row.nextCheckAt ? formatDate(row.nextCheckAt) : 'pausado'} |`);
    }
  }
  lines.push('', 'El triage combina palabras clave del texto visible con evidencia dura: "Artistas DB" cuenta cuántos nombres del lineup guardado en el catálogo aparecen en la página (sin acentos ni mayúsculas). `lineup_not_in_html` significa que el catálogo tiene lineup pero la página no lo muestra en texto visible (JavaScript, datos embebidos en scripts o edición distinta). El hash normalizado ignora tags, scripts, estilos y espacios de maquetación.');
  if (observations) {
    lines.push('El estado se guardó en `festival_source_checks` y los cambios detectados en `lineup_source_observations`. Una observación es solo una fila con hash, título y extracto: **no se publica ningún lineup** hasta la aprobación humana del paso 15. La primera corrida con una versión nueva de hash se trata como línea base y no genera observaciones falsas.');
  } else {
    lines.push(applied
      ? 'El estado se guardó en `festival_source_checks`: hash visto, ETag/Last-Modified, status HTTP, error y próximo chequeo. `last_processed_hash` queda intacto para la fase 3.'
      : 'Dry run: no se escribió estado en la base. Las fechas de "Próximo chequeo" son las que se guardarían con `--apply-state`.');
  }
  return `${lines.join('\n')}\n`;
}

async function scanRows(rows, { concurrency = 2, now = new Date(), fetch = fetchSource } = {}) {
  const results = new Array(rows.length);
  const nextStartByHost = new Map();
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      try {
        let host;
        try { host = new URL(row.lineup_source_url).hostname.toLowerCase(); } catch { host = ''; }
        const earliest = nextStartByHost.get(host) || 0;
        if (earliest > Date.now()) await new Promise((resolve) => setTimeout(resolve, earliest - Date.now()));
        nextStartByHost.set(host, Date.now() + 1500);
        let fetched = await fetch(row.lineupSourceUrl, {
          etag: row.state?.etag || null,
          lastModified: row.state?.lastModified || null,
        });
        // Si el servidor responde 304 pero el hash guardado es de otra versión,
        // no podemos comparar: se pide una vez sin condicional para establecer
        // la línea base. Sin esto, el primer cambio real de esa fuente se
        // tomaría como línea base y se perdería la observación.
        if (fetched.notModified && row.state?.hashVersion !== RELEVANT_HASH_VERSION) {
          fetched = await fetch(row.lineupSourceUrl, {});
        }
        let result;
        if (fetched.notModified) {
          result = {
            id: row.id, name: row.name, sourceUrl: row.lineupSourceUrl,
            startedAt, durationMs: Date.now() - startMs, status: 304,
            notModified: true, finalUrl: fetched.finalUrl,
            visibleTextHash: row.state?.lastSeenHash || null,
            triage: 'not_modified',
            etag: fetched.etag, lastModified: fetched.lastModified,
          };
        } else {
          const html = fetched.body.toString('utf8');
          const visibleText = htmlToVisibleText(html);
          const relevant = analyzeRelevantContent(html);
          const lineupHits = findLineupHits(visibleText, row.lineup);
          const analysis = refineTriageWithLineup(
            analyzeVisibleText(visibleText, extractTitle(html)),
            lineupHits,
          );
          result = {
            id: row.id, name: row.name, sourceUrl: row.lineupSourceUrl,
            startedAt, durationMs: Date.now() - startMs, status: fetched.status,
            contentType: fetched.contentType, bytes: fetched.bytes, rawHash: fetched.hash,
            ...analysis,
            lineupArtistTotal: lineupHits.total,
            lineupArtistMatched: lineupHits.matched,
            lineupHitRatio: lineupHits.ratio,
            lineupHitSample: lineupHits.hits.slice(0, 10),
            relevantHash: relevant.hash,
            relevantHashVersion: relevant.hashVersion,
            relevantText: relevant.text,
            etag: fetched.etag, lastModified: fetched.lastModified, finalUrl: fetched.finalUrl,
          };
        }
        results[index] = withSchedule(result, row, now, 0);
      } catch (error) {
        results[index] = withSchedule({
          id: row.id, name: row.name, sourceUrl: row.lineupSourceUrl,
          startedAt, durationMs: Date.now() - startMs, error: error.message,
          errorStatus: error.status ?? null, retryAfterMs: error.retryAfterMs ?? null,
        }, row, now, (row.state?.consecutiveFailures || 0) + 1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

// Agrega la cadencia sugerida. En fallos se pasa la cuenta nueva de fallos
// consecutivos; en éxito/304 vuelve a 0.
function withSchedule(result, row, now, failures) {
  const schedule = nextCheckAt({
    now,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    lineupStatus: row.lineupStatus,
    consecutiveFailures: failures,
    retryAfterMs: result.retryAfterMs || null,
  });
  return {
    ...result,
    consecutiveFailures: failures,
    nextCheckAt: schedule.at ? schedule.at.toISOString() : null,
    cadenceDays: schedule.cadenceDays,
    scheduleReason: schedule.reason,
  };
}

// Persistencia explícita: solo se llama con --apply-state. Tres variantes para
// no pisar hash/ETag cuando la respuesta fue 304 o un error.
async function saveSourceState(client, result, row, now = new Date()) {
  const checkedAt = new Date(now).toISOString();
  if (result.error) {
    await client.query(
      `INSERT INTO public.festival_source_checks
         (festival_id, last_checked_at, next_check_at, last_http_status, last_error, consecutive_failures, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (festival_id) DO UPDATE SET
         last_checked_at = EXCLUDED.last_checked_at,
         next_check_at = EXCLUDED.next_check_at,
         last_http_status = EXCLUDED.last_http_status,
         last_error = EXCLUDED.last_error,
         consecutive_failures = EXCLUDED.consecutive_failures,
         updated_at = NOW()`,
      [row.id, checkedAt, result.nextCheckAt, result.errorStatus ?? null, result.error, result.consecutiveFailures]
    );
    return;
  }
  if (result.notModified) {
    await client.query(
      `INSERT INTO public.festival_source_checks
         (festival_id, last_checked_at, next_check_at, last_http_status, last_error, consecutive_failures, updated_at)
       VALUES ($1, $2, $3, 304, NULL, 0, NOW())
       ON CONFLICT (festival_id) DO UPDATE SET
         last_checked_at = EXCLUDED.last_checked_at,
         next_check_at = EXCLUDED.next_check_at,
         last_http_status = 304,
         last_error = NULL,
         consecutive_failures = 0,
         updated_at = NOW()`,
      [row.id, checkedAt, result.nextCheckAt]
    );
    return;
  }
  await client.query(
    `INSERT INTO public.festival_source_checks
       (festival_id, last_checked_at, next_check_at, last_seen_hash, hash_version, etag,
        last_modified, last_http_status, last_error, consecutive_failures, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 0, NOW())
     ON CONFLICT (festival_id) DO UPDATE SET
       last_checked_at = EXCLUDED.last_checked_at,
       next_check_at = EXCLUDED.next_check_at,
       last_seen_hash = EXCLUDED.last_seen_hash,
       hash_version = EXCLUDED.hash_version,
       etag = EXCLUDED.etag,
       last_modified = EXCLUDED.last_modified,
       last_http_status = EXCLUDED.last_http_status,
       last_error = NULL,
       consecutive_failures = 0,
       updated_at = NOW()`,
    [
      row.id, checkedAt, result.nextCheckAt,
      result.relevantHash || result.visibleTextHash,
      result.relevantHashVersion || RELEVANT_HASH_VERSION,
      result.etag || null, result.lastModified || null, result.status,
    ]
  );
}

// Decide qué hacer con una respuesta respecto de las observaciones. Es una
// función pura para poder testearla sin DB:
// - sin estado o con otra versión de hash: línea base (no es un cambio real);
// - mismo hash: nada;
// - hash distinto: observación nueva.
function decideObservation(row, result) {
  if (!result || result.error) return { action: 'skip', reason: 'error' };
  if (result.notModified) return { action: 'skip', reason: 'not_modified' };
  if (!result.relevantHash) return { action: 'skip', reason: 'sin_hash' };
  const state = row.state;
  if (!state || !state.lastSeenHash) return { action: 'baseline', reason: 'sin_estado' };
  if (state.hashVersion !== RELEVANT_HASH_VERSION) return { action: 'baseline', reason: 'hash_version' };
  if (state.lastSeenHash === result.relevantHash) return { action: 'none', reason: 'sin_cambios' };
  return { action: 'observe', reason: 'cambio', previousHash: state.lastSeenHash };
}

// Inserta la observación una sola vez por festival+hash. Devuelve true si
// insertó y false si ya existía (idempotente ante reintentos).
async function saveObservation(client, row, result) {
  const inserted = await client.query(
    `INSERT INTO public.lineup_source_observations
       (festival_id, source_url, previous_hash, seen_hash, hash_version, title, excerpt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (festival_id, seen_hash) DO NOTHING
     RETURNING id`,
    [
      row.id, row.lineupSourceUrl, result.previousHash || null,
      result.relevantHash, result.relevantHashVersion || RELEVANT_HASH_VERSION,
      result.title || null, result.relevantText || null,
    ]
  );
  return inserted.rowCount > 0;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) { console.log(USAGE); return 0; }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const client = databaseClient();
  try {
    await client.connect();
    const rows = await loadSources(client, options);
    if (!rows.length) {
      console.error(options.festival ? `No se encontró fuente para ${options.festival}.` : 'No hay fuentes configuradas.');
      return 1;
    }
    const now = new Date();
    let dueRows = rows;
    const skipped = [];
    if (options.applyState && !options.force) {
      dueRows = rows.filter((row) => {
        if (isCheckDue(row.state, now)) return true;
        skipped.push(row);
        return false;
      });
    }

    const results = await scanRows(dueRows, { now });

    let stateErrors = 0;
    const observations = { inserted: 0, baseline: 0, unchanged: 0, skipped: 0, errors: 0 };
    const observed = [];
    if (options.applyState) {
      const byId = new Map(dueRows.map((row) => [row.id, row]));
      for (const result of results) {
        const row = byId.get(result.id);
        const decision = options.observe ? decideObservation(row, result) : null;
        if (decision) result.observation = decision.action;
        try {
          await saveSourceState(client, result, row, now);
          if (options.observe && decision) {
            if (decision.action === 'observe') {
              const created = await saveObservation(client, row, result);
              if (created) {
                observations.inserted += 1;
                observed.push({
                  id: row.id,
                  name: row.name,
                  previousHash: decision.previousHash,
                  seenHash: result.relevantHash,
                  detectedAt: new Date(now).toISOString(),
                });
              } else {
                observations.unchanged += 1;
              }
            } else if (decision.action === 'baseline') observations.baseline += 1;
            else if (decision.action === 'none') observations.unchanged += 1;
            else observations.skipped += 1;
          }
        } catch (error) {
          stateErrors += 1;
          result.stateError = error.message;
          if (options.observe && decision?.action === 'observe') observations.errors += 1;
        }
      }
    }

    const report = {
      mode: options.observe ? 'observe' : options.applyState ? 'apply-state' : 'dry-run',
      generatedAt: new Date().toISOString(),
      summary: {
        total: rows.length,
        checked: results.length,
        skipped: skipped.length,
        stateErrors,
        observations,
        ok: results.filter((row) => !row.error).length,
        notModified: results.filter((row) => row.notModified).length,
        errors: results.filter((row) => row.error).length,
        candidateHtml: results.filter((row) => row.triage === 'candidate_html').length,
        candidateWithArtists: results.filter((row) => row.triage === 'candidate_html' && row.lineupArtistMatched > 0).length,
        sourceWithAnyArtistHit: results.filter((row) => row.lineupArtistMatched > 0).length,
        triage: results.reduce((counts, row) => {
          const key = row.triage || 'error';
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
      },
      results,
      observed,
      skipped: skipped.map((row) => ({
        id: row.id,
        name: row.name,
        nextCheckAt: row.state?.nextCheckAt instanceof Date
          ? row.state.nextCheckAt.toISOString()
          : row.state?.nextCheckAt || null,
      })),
    };
    const markdown = renderMarkdown(report);
    console.log(markdown);
    if (options.reportOut) {
      const outputPath = path.resolve(options.reportOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdown, 'utf8');
      console.error(`Reporte Markdown guardado en ${outputPath}`);
    }
    if (stateErrors) {
      console.error(`Atención: ${stateErrors} actualizaciones de estado u observaciones fallaron.`);
    }
    if (options.jsonOut) {
      const outputPath = path.resolve(options.jsonOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.error(`JSON guardado localmente en ${outputPath}`);
    }
    return 0;
  } catch (error) {
    console.error(`No se pudo ejecutar el barrido: ${error.message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  decideObservation, formatDate, formatDateTime, loadSources, parseArgs, renderMarkdown,
  saveObservation, saveSourceState, scanRows, withSchedule,
};
