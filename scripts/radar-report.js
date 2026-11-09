#!/usr/bin/env node
'use strict';

// Reporte semanal del radar de lineups (fase 4, paso 16).
//
// Junta el JSON del barrido (`lineup-sweep.js`) y el del extractor
// (`lineup-extract.js`) con el estado actual de `lineup_proposals`, y escribe
// un Markdown para el step summary y, si hay novedades, para el cuerpo del
// issue. No consulta al modelo ni publica lineups.
//
// Uso:
//   node scripts/radar-report.js --scan=radar-scan.json --extract=radar-extract.json \
//     --report-out=radar-weekly.md
//
// Exporta `has_news`, `title`, `created`, `pending` y `today` a $GITHUB_OUTPUT.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { buildRadarReport, formatDate } = require('../server/radarReport');

const USAGE = `Uso: node scripts/radar-report.js [opciones]

  --scan=<ruta>        JSON del barrido de fuentes (opcional)
  --extract=<ruta>     JSON de la corrida del extractor (opcional)
  --report-out=<ruta>  guarda el reporte Markdown (lo usa el workflow)
  --extract-failed=true|false  marca que el paso del extractor falló (lo usa el workflow)
  --help               muestra esta ayuda

Requiere DATABASE_URL. No usa OPENROUTER_API_KEY ni escribe en la base:
solo lee propuestas pendientes y aprobadas de la última semana.
`;

function parseArgs(argv) {
  const options = { scan: null, extract: null, reportOut: null, help: false, extractFailed: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--scan=')) options.scan = arg.slice(7);
    else if (arg.startsWith('--extract=')) options.extract = arg.slice(10);
    else if (arg.startsWith('--report-out=')) options.reportOut = arg.slice(13);
    else if (arg.startsWith('--extract-failed=')) {
      const value = arg.slice(17);
      if (!['true', 'false'].includes(value)) throw new Error('--extract-failed acepta true o false.');
      options.extractFailed = value === 'true';
    }
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.scan === '') throw new Error('--scan necesita una ruta.');
  if (options.extract === '') throw new Error('--extract necesita una ruta.');
  if (options.reportOut === '') throw new Error('--report-out necesita una ruta.');
  return options;
}

function readJsonFile(filePath, label) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch (error) {
    console.error(`Aviso: no se pudo leer ${label} (${filePath}): ${error.message}`);
    return null;
  }
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

function mapPending(row) {
  return {
    id: Number(row.id),
    festivalId: row.festival_id,
    festivalName: row.festival_name,
    sourceUrl: row.source_url,
    lineupStatus: row.lineup_status,
    artistsCount: row.artists_count,
    confidence: row.confidence === null ? null : Number(row.confidence),
    announcedAt: row.announced_at,
    announcementQuote: row.announcement_quote,
    firstSeenAt: row.first_seen_at,
    extractionError: row.extraction_error,
  };
}

function mapApproved(row) {
  return {
    id: Number(row.id),
    festivalId: row.festival_id,
    festivalName: row.festival_name,
    sourceUrl: row.source_url,
    lineupStatus: row.lineup_status,
    artistsCount: row.artists_count,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

async function loadProposalState(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const pending = await client.query(
      `SELECT p.id, p.festival_id, f.name AS festival_name, p.source_url,
              p.lineup_status, p.artists_count, p.confidence,
              p.payload->'lineupAnnouncement'->>'announcedAt' AS announced_at,
              p.payload->'lineupAnnouncement'->>'quote' AS announcement_quote,
              p.first_seen_at, p.extraction_error
         FROM public.lineup_proposals p
         JOIN public.festivals f ON f.id = p.festival_id
        WHERE p.review_status = 'pending'
        ORDER BY p.first_seen_at ASC, p.id ASC`
    );
    const approved = await client.query(
      `SELECT p.id, p.festival_id, f.name AS festival_name, p.source_url,
              p.lineup_status, p.artists_count, p.reviewed_at, p.reviewed_by
         FROM public.lineup_proposals p
         JOIN public.festivals f ON f.id = p.festival_id
        WHERE p.review_status = 'approved'
          AND p.reviewed_at >= NOW() - INTERVAL '7 days'
        ORDER BY p.reviewed_at DESC, p.id DESC`
    );
    await client.query('COMMIT');
    return {
      pending: pending.rows.map(mapPending),
      approved: approved.rows.map(mapApproved),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function writeGithubOutput(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `has_news=${result.hasNews}\n`
      + `title=${result.title || 'Radar de lineups'}\n`
      + `created=${result.counts.created}\n`
      + `pending=${result.counts.pending}\n`
      + `today=${result.today}\n`
    );
  } catch (error) {
    console.error(`No se pudo escribir en GITHUB_OUTPUT: ${error.message}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

  const scan = readJsonFile(options.scan, 'barrido');
  const extraction = readJsonFile(options.extract, 'extractor');
  const client = databaseClient();

  try {
    await client.connect();
    const proposalState = await loadProposalState(client);
    const result = buildRadarReport({
      scan,
      extraction,
      pending: proposalState.pending,
      approved: proposalState.approved,
      extractionFailed: options.extractFailed,
      generatedAt: new Date().toISOString(),
    });

    console.log(result.markdown);
    if (options.reportOut) {
      const outputPath = path.resolve(options.reportOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, result.markdown, 'utf8');
      console.error(`Reporte semanal guardado en ${outputPath}`);
    }

    writeGithubOutput({ ...result, today: formatDate(result.generatedAt || new Date().toISOString()) });
    console.error(
      `Radar semanal: ${result.counts.created} propuestas nuevas, `
      + `${result.counts.pending} pendientes, ${result.counts.failed} fallos de extracción.`
    );
    return 0;
  } catch (error) {
    console.error(`No se pudo generar el reporte semanal: ${error.message}`);
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
  loadProposalState, main, mapApproved, mapPending, parseArgs, readJsonFile,
};
