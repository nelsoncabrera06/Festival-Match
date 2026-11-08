#!/usr/bin/env node
'use strict';

// Dry-run manual del radar. Solo lee lineup_source_url y hace GET acotados;
// no escribe en Postgres ni persiste hashes/estado.
const fs = require('fs');
const path = require('path');

const { Client } = require('pg');
const { fetchSource } = require('../server/lineupSourceFetcher');
const {
  analyzeVisibleText, extractTitle, findLineupHits, htmlToVisibleText, refineTriageWithLineup,
} = require('../server/lineupHtml');

const USAGE = `Uso: node scripts/lineup-sweep.js [opciones]

  --dry                 hace un barrido de lectura y no escribe en DB (default)
  --festival=<id>       limita la inspección a un festival
  --limit=<n>           limita el número de fuentes (1-63)
  --json-out=<ruta>     guarda el reporte JSON local
  --help                muestra esta ayuda

El comando lee las URLs desde Supabase y solicita páginas públicas HTTPS. No
actualiza next_check_at ni guarda hashes. Errores individuales aparecen en el
reporte y no detienen el resto del barrido.
`;

function parseArgs(argv) {
  const options = { festival: null, limit: 63, jsonOut: null, help: false };
  for (const arg of argv) {
    if (arg === '--dry') continue;
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--festival=')) options.festival = arg.slice(11);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--json-out=')) options.jsonOut = arg.slice(11);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.festival === '') throw new Error('--festival necesita un id.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 63) {
    throw new Error('--limit debe ser un entero entre 1 y 63.');
  }
  if (options.jsonOut === '') throw new Error('--json-out necesita una ruta.');
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

async function loadSources(client, options) {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(
      `SELECT id, name, lineup_source_url, lineup
         FROM public.festivals
        WHERE lineup_source_url IS NOT NULL AND BTRIM(lineup_source_url) <> ''
          AND ($1::text IS NULL OR id = $1)
        ORDER BY id
        LIMIT $2`,
      [options.festival, options.limit]
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

function renderMarkdown(report) {
  const lines = [
    '# Lineup source sweep (dry run)',
    '',
    `Generado: ${report.generatedAt} · Fuentes: ${report.summary.total} · OK: ${report.summary.ok} · Errores: ${report.summary.errors} · HTML candidato: ${report.summary.candidateHtml}`,
    '',
    '| Festival | Triage | Artistas DB | HTTP | Título | Señales | Texto | Hash normalizado | URL final / error |',
    '|---|---|---|---:|---|---|---:|---|---|',
  ];
  for (const row of report.results) {
    const outcome = row.error ? 'error' : 'ok';
    const detail = row.error || row.finalUrl;
    const coverage = row.lineupArtistTotal
      ? `${row.lineupArtistMatched}/${row.lineupArtistTotal} (${Math.round(row.lineupHitRatio * 100)}%)`
      : '';
    lines.push(`| ${escapeCell(row.name)} (${escapeCell(row.id)}) | ${row.triage || outcome} | ${coverage} | ${row.status ?? ''} | ${escapeCell(row.title || '')} | ${escapeCell((row.lineupSignals || []).join(', '))} | ${row.visibleTextLength ?? ''} | ${row.visibleTextHash || ''} | ${escapeCell(detail)} |`);
  }
  lines.push('', 'El triage combina palabras clave del texto visible con evidencia dura: "Artistas DB" cuenta cuántos nombres del lineup guardado en el catálogo aparecen en la página (sin acentos ni mayúsculas). `lineup_not_in_html` significa que el catálogo tiene lineup pero la página no lo muestra en texto visible (JavaScript, datos embebidos en scripts o edición distinta). El hash normalizado ignora tags, scripts, estilos y espacios de maquetación; no se guardó ningún estado en la base.');
  return `${lines.join('\n')}\n`;
}

async function scanRows(rows, concurrency = 2) {
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
        const fetched = await fetchSource(row.lineup_source_url);
        const html = fetched.body.toString('utf8');
        const visibleText = htmlToVisibleText(html);
        const lineupHits = findLineupHits(visibleText, row.lineup);
        const analysis = refineTriageWithLineup(
          analyzeVisibleText(visibleText, extractTitle(html)),
          lineupHits,
        );
        results[index] = {
          id: row.id, name: row.name, sourceUrl: row.lineup_source_url,
          startedAt, durationMs: Date.now() - startMs, status: fetched.status,
          contentType: fetched.contentType, bytes: fetched.bytes, rawHash: fetched.hash,
          ...analysis,
          lineupArtistTotal: lineupHits.total,
          lineupArtistMatched: lineupHits.matched,
          lineupHitRatio: lineupHits.ratio,
          lineupHitSample: lineupHits.hits.slice(0, 10),
          etag: fetched.etag, lastModified: fetched.lastModified, finalUrl: fetched.finalUrl,
        };
      } catch (error) {
        results[index] = {
          id: row.id, name: row.name, sourceUrl: row.lineup_source_url,
          startedAt, durationMs: Date.now() - startMs, error: error.message,
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
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
    const results = await scanRows(rows);
    const report = {
      mode: 'dry-run', generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        ok: results.filter((row) => !row.error).length,
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
    };
    console.log(renderMarkdown(report));
    if (options.jsonOut) {
      const outputPath = path.resolve(options.jsonOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.error(`JSON guardado localmente en ${outputPath}`);
    }
    return 0;
  } catch (error) {
    console.error(`No se pudo ejecutar el dry-run: ${error.message}`);
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

module.exports = { loadSources, parseArgs, renderMarkdown, scanRows };
