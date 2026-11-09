#!/usr/bin/env node
'use strict';

// Extractor con IA del radar de lineups (fase 4, paso 14).
//
// Lee las observaciones pendientes (cambios detectados por el scanner),
// consulta al modelo y **crea propuestas**. Por defecto es dry run: llama al
// modelo y muestra el resultado sin escribir nada en la base.
//
// Nunca toca `festivals`: publicar un lineup requiere aprobación humana desde
// el panel admin (paso 15). Una propuesta inválida se guarda como fallo visible
// y tampoco publica.
const fs = require('fs');
const path = require('path');

const { Client } = require('pg');
const { formatDate, formatDateTime } = require('./lineup-sweep');
const {
  DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_MODEL, EXTRACTION_SCHEMA_VERSION,
  MIN_CONFIDENCE_FOR_REVIEW, buildPrompt, buildProposalRecord, estimateCost,
  requestProposal, validateExtraction,
} = require('../server/lineupExtractor');

const USAGE = `Uso: node scripts/lineup-extract.js [opciones]

  --dry                 consulta al modelo sin escribir en la base (default)
  --apply               guarda las propuestas y marca las observaciones como procesadas
  --retry-failed        reintenta observaciones cuya propuesta falló
  --festival=<id>       limita la extracción a un festival
  --observation=<id>    procesa una sola observación
  --limit=<n>           máximo de observaciones por corrida (1-10, default 5)
  --model=<id>          modelo de OpenRouter (default ${DEFAULT_MODEL})
  --json-out=<ruta>     guarda el reporte JSON local
  --report-out=<ruta>   guarda el reporte Markdown (lo usa el workflow)
  --help                muestra esta ayuda

Requiere OPENROUTER_API_KEY en el entorno, también en dry run: el dry run no
escribe en la base, pero sí gasta tokens. El extractor solo crea propuestas;
publicar un lineup sigue siendo una decisión humana desde el panel admin.
`;

function parseArgs(argv) {
  const options = {
    festival: null, observation: null, limit: 5, model: DEFAULT_MODEL,
    jsonOut: null, reportOut: null, help: false, apply: false, retryFailed: false,
  };
  for (const arg of argv) {
    if (arg === '--dry') continue;
    if (arg === '--apply') options.apply = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--festival=')) options.festival = arg.slice(11);
    else if (arg.startsWith('--observation=')) options.observation = arg.slice(14);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg.startsWith('--json-out=')) options.jsonOut = arg.slice(11);
    else if (arg.startsWith('--report-out=')) options.reportOut = arg.slice(13);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.festival === '') throw new Error('--festival necesita un id.');
  if (options.observation === '') throw new Error('--observation necesita un id.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10) {
    throw new Error('--limit debe ser un entero entre 1 y 10.');
  }
  if (options.observation !== null) {
    const id = Number(options.observation);
    if (!Number.isInteger(id) || id < 1) throw new Error('--observation debe ser un id numérico.');
    options.observation = id;
  }
  if (options.model === '') throw new Error('--model necesita un id de modelo.');
  if (options.jsonOut === '') throw new Error('--json-out necesita una ruta.');
  if (options.reportOut === '') throw new Error('--report-out necesita una ruta.');
  if (options.retryFailed && !options.apply) {
    throw new Error('--retry-failed solo se usa junto con --apply.');
  }
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
    statement_timeout: 30000,
    ssl: isSupabase ? { rejectUnauthorized: false } : false,
  });
}

function mapObservationRow(row) {
  return {
    observation: {
      id: Number(row.id),
      festivalId: row.festival_id,
      sourceUrl: row.source_url,
      seenHash: row.seen_hash,
      hashVersion: row.hash_version,
      title: row.title,
      excerpt: row.excerpt,
      detectedAt: row.detected_at,
    },
    festival: {
      id: row.festival_id,
      name: row.name,
      city: row.city,
      country: row.country,
      dates: row.dates,
      lineup: Array.isArray(row.lineup) ? row.lineup : [],
      lineupStatus: row.lineup_status,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
    },
  };
}

async function loadPendingObservations(client, options) {
  // `$3` = retryFailed. Sin --retry-failed se excluyen las observaciones que ya
  // tienen una propuesta (válida o fallida) para no volver a gastar tokens en
  // la misma versión del contenido.
  try {
    const result = await client.query(
      `SELECT o.id, o.festival_id, o.source_url, o.seen_hash, o.hash_version,
              o.title, o.excerpt, o.detected_at,
              f.name, f.city, f.country, f.dates, f.lineup, f.lineup_status,
              f.starts_on, f.ends_on
         FROM public.lineup_source_observations o
         JOIN public.festivals f ON f.id = o.festival_id
        WHERE o.processed_at IS NULL
          AND ($1::text IS NULL OR o.festival_id = $1)
          AND ($2::bigint IS NULL OR o.id = $2)
          AND ($3::boolean OR NOT EXISTS (
                SELECT 1 FROM public.lineup_proposals p WHERE p.observation_id = o.id))
        ORDER BY o.detected_at ASC, o.id ASC
        LIMIT $4`,
      [options.festival, options.observation, options.retryFailed, options.limit]
    );
    return result.rows.map(mapObservationRow);
  } catch (error) {
    if (error.code === '42P01') {
      throw new Error('Falta migrations/019_lineup_proposals.sql. Aplicá la migración antes de usar --apply.');
    }
    throw error;
  }
}

// Una extracción: prompt, llamada, parseo y validación. Todo inyectable para
// poder testear sin red ni base de datos.
async function extractOne({ festival, observation }, { apiKey, model, fetchImpl } = {}) {
  if (!observation.excerpt || !observation.excerpt.trim()) {
    return { skipped: true, reason: 'la observación no tiene extracto de texto' };
  }
  const messages = buildPrompt({ festival, observation });
  try {
    const response = await requestProposal({ apiKey, model, messages, fetchImpl });
    const validation = validateExtraction(response.extraction, { festival, observation });
    const usage = estimateCost(response.usage);
    const warnings = [...validation.warnings];
    if (response.format === 'json_object') {
      warnings.push('El proveedor no aceptó el esquema estricto: se usó json_object.');
    }
    const record = buildProposalRecord({
      festival,
      observation,
      proposal: validation.ok ? validation.proposal : null,
      model: response.model || model,
      error: validation.ok ? null : validation.errors.join(' '),
    });
    return {
      ok: validation.ok,
      skipped: false,
      record,
      proposal: validation.proposal,
      errors: validation.errors,
      warnings,
      usage,
      model: response.model || model,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      record: buildProposalRecord({ festival, observation, proposal: null, model, error: error.message }),
      proposal: null,
      errors: [error.message],
      warnings: [],
      usage: null,
      model,
    };
  }
}

// Persistencia: inserta la propuesta (idempotente por festival + hash) y marca
// la observación como procesada. Un reintento solo puede actualizar filas que
// fallaron: una propuesta válida no se pisa.
async function saveProposal(client, record) {
  const inserted = await client.query(
    `INSERT INTO public.lineup_proposals
       (festival_id, observation_id, source_url, seen_hash, hash_version, model,
        schema_version, lineup_status, artists_count, confidence, payload, extraction_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     ON CONFLICT (festival_id, seen_hash) DO UPDATE SET
       observation_id = EXCLUDED.observation_id,
       model = EXCLUDED.model,
       schema_version = EXCLUDED.schema_version,
       lineup_status = EXCLUDED.lineup_status,
       artists_count = EXCLUDED.artists_count,
       confidence = EXCLUDED.confidence,
       payload = EXCLUDED.payload,
       extraction_error = EXCLUDED.extraction_error,
       updated_at = NOW()
     WHERE public.lineup_proposals.extraction_error IS NOT NULL
     RETURNING id`,
    [
      record.festivalId, record.observationId, record.sourceUrl, record.seenHash,
      record.hashVersion, record.model, record.schemaVersion, record.lineupStatus,
      record.artistsCount, record.confidence, JSON.stringify(record.payload),
      record.extractionError,
    ]
  );
  return inserted.rowCount > 0;
}

async function markObservationProcessed(client, observation) {
  // El estado del scanner guarda qué versión ya fue analizada. No es crítico
  // para la idempotencia (esa la da `processed_at`) y puede faltar si la
  // migración 017 no está aplicada, así que su fallo no corta nada.
  await client.query(
    `UPDATE public.festival_source_checks
        SET last_processed_hash = $2, updated_at = NOW()
      WHERE festival_id = $1`,
    [observation.festivalId, observation.seenHash]
  ).catch(() => {});
  await client.query(
    `UPDATE public.lineup_source_observations
        SET processed_at = NOW()
      WHERE id = $1 AND processed_at IS NULL`,
    [observation.id]
  );
}

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

function renderMarkdown(report) {
  const modeLabel = report.mode === 'apply' ? 'apply' : 'dry run';
  const summary = report.summary;
  const cost = summary.costUsd === null ? 'sin datos' : `$${summary.costUsd.toFixed(6)} USD`;
  const lines = [
    `# Lineup extractor (${modeLabel})`,
    '',
    `- **Generado:** ${formatDateTime(report.generatedAt)}`,
    `- **Modelo:** ${report.model}`,
    `- **Schema de extracción:** v${report.schemaVersion}`,
    `- **Observaciones pendientes:** ${summary.pending}`,
    `- **Analizadas:** ${summary.analyzed}`,
    `- **Propuestas válidas:** ${summary.valid}`,
    `- **Con error de extracción:** ${summary.failed}`,
    `- **Omitidas:** ${summary.skipped}`,
    `- **Artistas propuestos:** ${summary.artists}`,
    `- **Tokens de entrada:** ${summary.promptTokens}`,
    `- **Tokens de salida:** ${summary.completionTokens}`,
    `- **Costo estimado:** ${cost}`,
  ];

  if (report.results.length) {
    lines.push(
      '',
      '| Festival | Estado | Artistas | Confianza | Anuncio lineup | Tickets | Edición | Resultado |',
      '|---|---|---:|---:|---|---|---|---|',
    );
    for (const row of report.results) {
      const announcement = row.lineupAnnouncementAt ? formatDate(row.lineupAnnouncementAt) : '—';
      const edition = row.pageEditionYear === null
        ? '—'
        : row.editionMatchesTarget === false ? `${row.pageEditionYear} ⚠` : String(row.pageEditionYear);
      const confidence = row.confidence === null ? '—' : row.confidence.toFixed(2);
      lines.push(`| ${escapeCell(row.name)} (${escapeCell(row.festivalId)}) | ${row.status || '—'} | ${row.artistsCount} | ${confidence} | ${announcement} | ${row.ticketsStatus || '—'} | ${edition} | ${row.ok ? 'ok' : 'error'} |`);
    }

    lines.push('', '## Detalle', '');
    for (const row of report.results) {
      lines.push(`### ${row.name} (${row.festivalId})`, '');
      lines.push(`- **Fuente:** ${row.sourceUrl}`);
      if (!row.ok) {
        lines.push(`- **Error:** ${row.errors.join(' ') || 'desconocido'}`);
        lines.push('');
        continue;
      }
      lines.push(`- **Estado propuesto:** ${row.status}`);
      if (row.artistsCount) {
        lines.push(`- **Artistas:** ${row.artistsCount}${row.artistSample.length ? ` (${row.artistSample.join(', ')}${row.artistsCount > row.artistSample.length ? ', …' : ''})` : ''}`);
      }
      if (row.datesText) lines.push(`- **Fechas en la página:** ${row.datesText}`);
      if (row.lineupAnnouncementAt) {
        lines.push(`- **El sitio anuncia el lineup el:** ${formatDate(row.lineupAnnouncementAt)}`);
      }
      if (row.ticketsStatus && row.ticketsStatus !== 'not_mentioned') {
        lines.push(`- **Tickets:** ${row.ticketsStatus}${row.ticketsOnSaleAt ? ` (${formatDate(row.ticketsOnSaleAt)})` : ''}`);
      }
      if (row.confidence !== null && row.confidence < MIN_CONFIDENCE_FOR_REVIEW) {
        lines.push(`- **Confianza baja:** ${row.confidence.toFixed(2)} (revisar con cuidado)`);
      }
      if (row.evidence.length) {
        lines.push('- **Evidencia:**');
        for (const quote of row.evidence) lines.push(`  - "${quote}"`);
      }
      if (row.uncertainty.length) {
        lines.push('- **Dudas del modelo:**');
        for (const item of row.uncertainty) lines.push(`  - ${item}`);
      }
      if (row.warnings.length) {
        lines.push('- **Advertencias:**');
        for (const item of row.warnings) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }

  lines.push(report.mode === 'apply'
    ? 'Las propuestas se guardaron en `lineup_proposals` con estado `pending`. Las observaciones consumidas quedaron con `processed_at`. **Ningún lineup cambió en el catálogo**: aprobar o rechazar es una acción humana en el panel admin.'
    : 'Dry run: no se escribió nada en la base. El modelo sí se consultó, así que esta corrida consumió tokens. Usá `--apply` para guardar las propuestas.');

  return `${lines.join('\n')}\n`;
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Falta OPENROUTER_API_KEY. Creala en https://openrouter.ai/keys y ponela en .env (local) y como secret del workflow.');
    return 1;
  }

  const client = databaseClient();
  try {
    await client.connect();
    const pending = await loadPendingObservations(client, options);
    if (!pending.length) {
      console.error(options.observation
        ? `No hay una observación pendiente con id ${options.observation}.`
        : 'No hay observaciones pendientes de extraer.');
    }

    const results = [];
    const summary = {
      pending: pending.length,
      analyzed: 0,
      valid: 0,
      failed: 0,
      skipped: 0,
      artists: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
    };
    let saveErrors = 0;

    for (const item of pending) {
      const result = await extractOne(item, { apiKey, model: options.model });
      summary.analyzed += result.skipped ? 0 : 1;
      if (result.skipped) {
        summary.skipped += 1;
        console.error(`Omitida ${item.festival.id}: ${result.reason}.`);
        if (options.apply) {
          await markObservationProcessed(client, item.observation).catch(() => { saveErrors += 1; });
        }
        continue;
      }
      if (result.usage) {
        summary.promptTokens += result.usage.promptTokens;
        summary.completionTokens += result.usage.completionTokens;
        summary.costUsd = (summary.costUsd || 0) + result.usage.costUsd;
      }
      if (result.ok) {
        summary.valid += 1;
        summary.artists += result.proposal.artists.length;
      } else {
        summary.failed += 1;
      }

      if (options.apply) {
        try {
          const written = await saveProposal(client, result.record);
          if (!written) {
            result.warnings.push('Ya existía una propuesta válida para esta versión del contenido.');
          }
          // La observación solo se marca procesada cuando la propuesta es
          // válida. Un fallo queda con `processed_at` en NULL y su fila de
          // error visible: el reintento es explícito (--retry-failed) y no se
          // gasta tokens en la misma fuente en cada corrida.
          if (result.ok) await markObservationProcessed(client, item.observation);
        } catch (error) {
          saveErrors += 1;
          result.errors.push(`No se pudo guardar: ${error.message}`);
        }
      }

      results.push({
        festivalId: item.festival.id,
        name: item.festival.name,
        sourceUrl: item.observation.sourceUrl,
        ok: result.ok,
        status: result.proposal ? result.proposal.lineupStatus : null,
        artistsCount: result.proposal ? result.proposal.artists.length : 0,
        artistSample: result.proposal ? result.proposal.artists.slice(0, 8).map((artist) => artist.name) : [],
        confidence: result.proposal ? result.proposal.confidence : null,
        datesText: result.proposal ? result.proposal.datesText : null,
        lineupAnnouncementAt: result.proposal ? result.proposal.lineupAnnouncement.announcedAt : null,
        ticketsStatus: result.proposal ? result.proposal.tickets.status : null,
        ticketsOnSaleAt: result.proposal ? result.proposal.tickets.onSaleAt : null,
        pageEditionYear: result.proposal ? result.proposal.pageEditionYear : null,
        editionMatchesTarget: result.proposal ? result.proposal.editionMatchesTarget : null,
        evidence: result.proposal ? result.proposal.evidence : [],
        uncertainty: result.proposal ? result.proposal.uncertainty : [],
        errors: result.errors,
        warnings: result.warnings,
        usage: result.usage,
        model: result.model,
      });
    }

    summary.costUsd = summary.costUsd === null ? null : Number(summary.costUsd.toFixed(6));

    const report = {
      mode: options.apply ? 'apply' : 'dry-run',
      generatedAt: new Date().toISOString(),
      model: options.model,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      summary: { ...summary, saveErrors },
      results,
    };

    const markdown = renderMarkdown(report);
    console.log(markdown);
    if (options.reportOut) {
      const outputPath = path.resolve(options.reportOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdown, 'utf8');
      console.error(`Reporte Markdown guardado en ${outputPath}`);
    }
    if (options.jsonOut) {
      const outputPath = path.resolve(options.jsonOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.error(`JSON guardado localmente en ${outputPath}`);
    }
    if (saveErrors) console.error(`Atención: ${saveErrors} escrituras fallaron.`);
    if (summary.analyzed > 0 && summary.valid === 0) return 1;
    return 0;
  } catch (error) {
    console.error(`No se pudo ejecutar el extractor: ${error.message}`);
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
  extractOne, loadPendingObservations, main, markObservationProcessed, parseArgs,
  renderMarkdown, saveProposal,
};
