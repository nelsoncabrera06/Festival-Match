#!/usr/bin/env node
'use strict';

// Radar de datos del festival (fase 4, paso 18).
//
// Revisa SOLO los festivales en `hiatus` y trata de responder una pregunta:
// ¿la web oficial confirma una edición para el año objetivo del catálogo, y con
// qué fechas? Nació porque Glastonbury y Mysteryland quedaron congelados con
// `dates = '2027 (confirmado)'` aunque ya tenían fechas.
//
// No publica nada y no escribe en la base: genera un JSON/Markdown para el
// reporte semanal y el issue. El admin corrige desde el panel.
//
// Descubrimiento de páginas: se empieza por `website`; si no alcanza, se
// siguen hasta 2 links del mismo dominio que mencionen el año objetivo o
// palabras como ticket/news/info. La búsqueda web externa queda para una
// segunda etapa; la fuente de verdad sigue siendo la web oficial.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { fetchSource } = require('../server/lineupSourceFetcher');
const {
  extractTitle, htmlToRelevantText, htmlToVisibleText,
} = require('../server/lineupHtml');
const {
  FACTS_SCHEMA_VERSION, MAX_EVIDENCE, buildFactsPrompt,
  requestFacts, validateFacts,
} = require('../server/festivalFactsExtractor');
const { DEFAULT_MODEL, estimateCost } = require('../server/lineupExtractor');

const USAGE = `Uso: node scripts/festival-facts.js [opciones]

  --festival=<id>       revisa un solo festival en hiatus
  --limit=<n>           máximo de festivales a revisar (1-20, default 10)
  --model=<id>          modelo de OpenRouter (default ${DEFAULT_MODEL})
  --apply               guarda propuestas en festival_fact_proposals
  --json-out=<ruta>     guarda el reporte JSON (lo usa el workflow)
  --report-out=<ruta>   guarda un Markdown simple (debug local)
  --help                muestra esta ayuda

Requiere OPENROUTER_API_KEY y DATABASE_URL. Con --apply guarda propuestas;
publicar sigue siendo una acción humana desde el panel admin.
`;

function parseArgs(argv) {
  const options = {
    festival: null, limit: 10, model: DEFAULT_MODEL,
    jsonOut: null, reportOut: null, help: false, apply: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--festival=')) options.festival = arg.slice(11);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg.startsWith('--json-out=')) options.jsonOut = arg.slice(11);
    else if (arg.startsWith('--report-out=')) options.reportOut = arg.slice(13);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.festival === '') throw new Error('--festival necesita un id.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('--limit debe ser un entero entre 1 y 20.');
  }
  if (options.model === '') throw new Error('--model necesita un id de modelo.');
  if (options.jsonOut === '') throw new Error('--json-out necesita una ruta.');
  if (options.reportOut === '') throw new Error('--report-out necesita una ruta.');
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

async function loadHiatusFestivals(client, options) {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(
      `SELECT id, name, city, country, dates, website, lineup_source_url,
              lineup_status, starts_on::text AS starts_on, ends_on::text AS ends_on
         FROM public.festivals
        WHERE lineup_status = 'hiatus'
          AND ($1::text IS NULL OR id = $1)
        ORDER BY id
        LIMIT $2`,
      [options.festival, options.limit]
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      city: row.city,
      country: row.country,
      dates: row.dates,
      website: row.website,
      lineupSourceUrl: row.lineup_source_url,
      lineupStatus: row.lineup_status,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function targetYearOf(festival) {
  if (festival.startsOn) {
    const year = Number(String(festival.startsOn).slice(0, 4));
    if (Number.isInteger(year) && year > 1990) return year;
  }
  const match = String(festival.dates || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function uniqueSnippets(snippets, max = 8, size = 320) {
  const seen = new Set();
  const result = [];
  for (const snippet of snippets) {
    const clean = String(snippet || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean.slice(0, size));
    if (result.length >= max) break;
  }
  return result;
}

// Texto que se le manda al modelo: visible + meta descriptions + JSON-LD +
// fragmentos alrededor del año objetivo. Lo último es clave para páginas como
// Mysteryland, que tienen las fechas dentro de un script y no en texto visible.
function buildPageContext(html, targetYear) {
  const visible = htmlToRelevantText(html);
  const meta = [];
  const ld = [];
  const snippets = [];

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/(?:description|og:description|twitter:description)/i.test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) meta.push(htmlToVisibleText(content[1]).replace(/\s+/g, ' ').trim());
  }

  for (const block of html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []) {
    const content = block.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '');
    if (targetYear && content.includes(String(targetYear)) || /"@type"\s*:\s*"Event"/i.test(content)) {
      ld.push(content.slice(0, 4000));
    }
  }

  if (targetYear) {
    const year = String(targetYear);
    let index = html.indexOf(year);
    while (index !== -1 && snippets.length < 20) {
      snippets.push(html.slice(Math.max(0, index - 180), index + 220));
      index = html.indexOf(year, index + year.length);
    }
  }

  return [
    visible ? `TEXTO VISIBLE:\n${visible.slice(0, 9000)}` : '',
    meta.length ? `META DESCRIPTIONS:\n${uniqueSnippets(meta).join('\n')}` : '',
    ld.length ? `DATOS ESTRUCTURADOS:\n${ld.join('\n')}` : '',
    snippets.length ? `FRAGMENTOS CON EL AÑO ${targetYear}:\n${uniqueSnippets(snippets).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function discoverLinks(html, baseUrl, targetYear) {
  const base = new URL(baseUrl);
  const found = new Map();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = match[1];
    const text = htmlToVisibleText(match[2]).replace(/\s+/g, ' ').trim().slice(0, 140);
    let url;
    try { url = new URL(rawHref, base); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== base.hostname) continue;
    url.hash = '';
    if (url.toString() === base.toString()) continue;

    const haystack = `${text} ${url.pathname} ${url.search}`.toLowerCase();
    const hasYear = targetYear ? haystack.includes(String(targetYear)) : false;
    const hasKeyword = /(news|noticia|ticket|entrada|info|fecha|date|line-?up|program|edition|festival|cartel|anuncio)/i.test(haystack);
    const score = (hasYear ? 3 : 0) + (hasKeyword ? 1 : 0);
    if (score < 3) continue;

    const key = url.toString();
    const previous = found.get(key);
    if (!previous || score > previous.score) found.set(key, { url: key, text, score });
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, 3);
}

async function fetchPage(url, targetYear, fetchImpl = fetchSource) {
  const response = await fetchImpl(url);
  const html = response.body.toString('utf8');
  return {
    url: response.finalUrl || url,
    title: extractTitle(html),
    html,
    text: buildPageContext(html, targetYear),
  };
}

function needsMoreEvidence(facts) {
  if (!facts) return true;
  if (facts.editionStatus === 'no_edition') return false;
  if (facts.datesText && facts.matchesTarget !== false) return false;
  return true;
}

const MESES_ES = {
  january: 'Enero', february: 'Febrero', march: 'Marzo', april: 'Abril',
  may: 'Mayo', june: 'Junio', july: 'Julio', august: 'Agosto',
  september: 'Septiembre', october: 'Octubre', november: 'Noviembre', december: 'Diciembre',
  janeiro: 'Enero', fevereiro: 'Febrero', marco: 'Marzo', abril: 'Abril',
  maio: 'Mayo', junho: 'Junio', julho: 'Julio', agosto: 'Agosto',
  setembro: 'Septiembre', outubro: 'Octubre', novembro: 'Noviembre', dezembro: 'Diciembre',
  januari: 'Enero', februari: 'Febrero', maart: 'Marzo', mei: 'Mayo',
  juni: 'Junio', juli: 'Julio', augustus: 'Agosto', september_nl: 'Septiembre',
  oktober: 'Octubre', november_nl: 'Noviembre', december_nl: 'Diciembre',
};

function monthEs(month) {
  return MESES_ES[String(month || '').toLowerCase()] || null;
}

function formatDateRangeEs(startsOn, endsOn) {
  if (!startsOn || !endsOn) return null;
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const sm = months[start.getUTCMonth()];
  const em = months[end.getUTCMonth()];
  if (startsOn === endsOn) return `${start.getUTCDate()} ${sm} ${start.getUTCFullYear()}`;
  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return `${start.getUTCDate()}-${end.getUTCDate()} ${sm} ${start.getUTCFullYear()}`;
  }
  return `${start.getUTCDate()} ${sm} - ${end.getUTCDate()} ${em} ${end.getUTCFullYear()}`;
}

// Normaliza fechas a un texto que entienda `server/dateRange.js`: "23-27 Junio
// 2027", "27-29 Agosto 2027", "Septiembre 2028". Si no se puede, conserva el
// texto original de la página.
function normalizeSuggestedDates(facts) {
  if (!facts) return null;
  if (facts.startsOn && facts.endsOn) return formatDateRangeEs(facts.startsOn, facts.endsOn);
  const text = String(facts.datesText || '').trim();
  if (!text) return null;
  const monthYear = text.match(/^([A-Za-zÀ-ÿ]+)\s+(?:de\s+|of\s+)?(\d{4})$/i);
  if (monthYear) {
    const month = monthEs(monthYear[1]);
    if (month) return `${month} ${monthYear[2]}`;
  }
  return text;
}

function factsChanged(festival, facts) {
  const reasons = [];
  const suggestion = facts && facts.suggestion;
  if (!suggestion) return reasons;

  if (suggestion.lineupStatus && suggestion.lineupStatus !== festival.lineupStatus) {
    reasons.push(`estado ${festival.lineupStatus} → ${suggestion.lineupStatus}`);
  }
  if (suggestion.datesText && suggestion.datesText.replace(/\s+/g, ' ').trim() !== String(festival.dates || '').replace(/\s+/g, ' ').trim()) {
    reasons.push(`fechas "${festival.dates || '—'}" → "${suggestion.datesText}"`);
  }
  if (suggestion.startsOn && suggestion.startsOn !== festival.startsOn) {
    reasons.push(`starts_on ${festival.startsOn || '—'} → ${suggestion.startsOn}`);
  }
  if (suggestion.endsOn && suggestion.endsOn !== festival.endsOn) {
    reasons.push(`ends_on ${festival.endsOn || '—'} → ${suggestion.endsOn}`);
  }
  return reasons;
}

async function analyzeFestival(festival, {
  apiKey, model, fetchImpl = fetchSource, requestImpl = requestFacts, requestFetchImpl,
}) {
  const targetYear = targetYearOf(festival);
  const firstUrl = festival.website || festival.lineupSourceUrl;
  if (!firstUrl) {
    return {
      ok: false, festival, targetYear, sourceUrl: null,
      errors: ['El festival no tiene website ni fuente oficial configurada.'],
      warnings: [], usage: null, pagesChecked: 0,
    };
  }

  const usageTotal = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 };
  const visited = [];
  let best = null;
  let lastError = null;
  let pagesChecked = 0;

  const candidates = [{ url: firstUrl, reason: 'website' }];
  for (let index = 0; index < candidates.length && pagesChecked < 3; index += 1) {
    const candidate = candidates[index];
    pagesChecked += 1;
    let page;
    try {
      page = await fetchPage(candidate.url, targetYear, fetchImpl);
    } catch (error) {
      lastError = `${candidate.url} → ${error.message}`;
      if (index === 0) {
        // Si falla la portada, probar la fuente de lineup como respaldo.
        if (festival.lineupSourceUrl && festival.lineupSourceUrl !== candidate.url) {
          candidates.push({ url: festival.lineupSourceUrl, reason: 'lineup_source' });
        }
      }
      continue;
    }
    visited.push({ url: page.url, title: page.title, reason: candidate.reason });

    if (!page.text.trim()) {
      lastError = 'La página no tiene texto útil.';
      continue;
    }

    const messages = buildFactsPrompt({ festival, page });
    // Ojo: `fetchImpl` es para bajar la página oficial. El cliente HTTP de
    // OpenRouter es otro (global fetch por defecto); mezclarlos hacía que el
    // modelo recibiera la URL de OpenRouter con el fetcher del radar.
    const response = await requestImpl({ apiKey, model, messages, fetchImpl: requestFetchImpl });
    const validation = validateFacts(response.extraction, { festival });
    const usage = estimateCost(response.usage);
    if (usage) {
      for (const key of Object.keys(usageTotal)) usageTotal[key] += usage[key] || 0;
    }

    const result = {
      ...validation,
      page,
      model: response.model || model,
      format: response.format,
      usage,
    };
    const score = (result.facts ? result.facts.confidence : 0)
      + (result.facts && result.facts.datesText ? 1 : 0)
      + (result.facts && result.facts.editionStatus !== 'unclear' ? 1 : 0)
      + (result.facts && result.facts.matchesTarget === true ? 1 : 0);
    if (!best || score > best.score) best = { ...result, score };

    if (result.ok && !needsMoreEvidence(result.facts)) break;

    if (index === 0) {
      for (const link of discoverLinks(page.html, page.url, targetYear)) {
        if (!candidates.some((item) => item.url === link.url)) {
          candidates.push({ url: link.url, reason: `link: ${link.text || link.url}` });
        }
      }
      // Si la portada no alcanza, la fuente de lineup suele tener la página de
      // información/FAQ. Para Rock in Rio la home es solo un redirect; sin este
      // fallback el chequeo queda en "unclear".
      if ((!result.ok || needsMoreEvidence(result.facts))
        && festival.lineupSourceUrl
        && !candidates.some((item) => item.url === festival.lineupSourceUrl)) {
        candidates.push({ url: festival.lineupSourceUrl, reason: 'lineup_source' });
      }
    }
  }

  usageTotal.costUsd = Number(usageTotal.costUsd.toFixed(6));
  const facts = best && best.ok ? best.facts : null;
  if (facts && facts.suggestion) {
    const normalized = normalizeSuggestedDates(facts);
    if (normalized) facts.suggestion.datesText = normalized;
  }
  const changeReasons = facts ? factsChanged(festival, facts) : [];
  const warnings = [...(best?.warnings || [])];
  if (best?.format === 'json_object') warnings.push('El proveedor no aceptó el esquema estricto: se usó json_object.');
  const sameUrl = (a, b) => {
    try { return new URL(a).toString() === new URL(b).toString(); } catch { return a === b; }
  };
  if (best?.page && !sameUrl(best.page.url, firstUrl)) warnings.push(`Se siguió una página adicional: ${best.page.url}`);
  if (!facts && lastError) warnings.push(lastError);

  return {
    ok: Boolean(facts),
    festival,
    targetYear,
    sourceUrl: firstUrl,
    pageUrl: best?.page?.url || null,
    pageTitle: best?.page?.title || '',
    pagesChecked,
    visited,
    editionStatus: facts?.editionStatus || null,
    editionYear: facts?.editionYear ?? null,
    datesText: facts?.datesText ?? null,
    startsOn: facts?.startsOn ?? null,
    endsOn: facts?.endsOn ?? null,
    matchesTarget: facts?.matchesTarget ?? null,
    suggestion: facts?.suggestion || null,
    changed: changeReasons.length > 0,
    changeReasons,
    evidence: facts?.evidence || [],
    uncertainty: facts?.uncertainty || [],
    confidence: facts?.confidence ?? null,
    errors: best?.errors || (lastError ? [lastError] : ['No se obtuvieron datos de la fuente oficial.']),
    warnings,
    usage: usageTotal.totalTokens ? usageTotal : null,
  };
}

function buildFactProposalRecord(result) {
  const suggestion = result.suggestion || {};
  const proposedDates = suggestion.datesText || null;
  const proposedLineupStatus = suggestion.lineupStatus || null;
  const proposedStartsOn = suggestion.startsOn || result.startsOn || null;
  const proposedEndsOn = suggestion.endsOn || result.endsOn || null;
  const signature = JSON.stringify({
    festivalId: result.festival.id,
    pageUrl: result.pageUrl || result.sourceUrl,
    editionStatus: result.editionStatus,
    editionYear: result.editionYear,
    datesText: result.datesText,
    startsOn: result.startsOn,
    endsOn: result.endsOn,
    proposedDates,
    proposedLineupStatus,
  });
  return {
    festivalId: result.festival.id,
    sourceUrl: result.sourceUrl || result.pageUrl || '',
    pageUrl: result.pageUrl || null,
    seenHash: crypto.createHash('sha256').update(signature).digest('hex'),
    model: result.model || DEFAULT_MODEL,
    schemaVersion: FACTS_SCHEMA_VERSION,
    proposedDates,
    proposedLineupStatus,
    proposedStartsOn,
    proposedEndsOn,
    evidence: result.evidence || [],
    confidence: result.confidence,
    payload: {
      editionStatus: result.editionStatus,
      editionYear: result.editionYear,
      datesText: result.datesText,
      startsOn: result.startsOn,
      endsOn: result.endsOn,
      matchesTarget: result.matchesTarget,
      suggestion: result.suggestion,
      evidence: result.evidence || [],
      uncertainty: result.uncertainty || [],
      confidence: result.confidence,
      targetYear: result.targetYear,
      pageUrl: result.pageUrl,
      pageTitle: result.pageTitle,
      visited: result.visited,
    },
  };
}

async function saveFactProposal(client, record) {
  await client.query('BEGIN');
  try {
    const inserted = await client.query(
      `INSERT INTO public.festival_fact_proposals
         (festival_id, source_url, page_url, seen_hash, model, schema_version,
          proposed_dates, proposed_lineup_status, proposed_starts_on,
          proposed_ends_on, evidence, confidence, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)
       ON CONFLICT (festival_id, seen_hash) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         page_url = EXCLUDED.page_url,
         model = EXCLUDED.model,
         schema_version = EXCLUDED.schema_version,
         proposed_dates = EXCLUDED.proposed_dates,
         proposed_lineup_status = EXCLUDED.proposed_lineup_status,
         proposed_starts_on = EXCLUDED.proposed_starts_on,
         proposed_ends_on = EXCLUDED.proposed_ends_on,
         evidence = EXCLUDED.evidence,
         confidence = EXCLUDED.confidence,
         payload = EXCLUDED.payload,
         updated_at = NOW()
       WHERE public.festival_fact_proposals.review_status = 'pending'
       RETURNING id, (xmax = 0) AS inserted`,
      [
        record.festivalId, record.sourceUrl, record.pageUrl, record.seenHash,
        record.model, record.schemaVersion, record.proposedDates,
        record.proposedLineupStatus, record.proposedStartsOn, record.proposedEndsOn,
        JSON.stringify(record.evidence), record.confidence, JSON.stringify(record.payload),
      ]
    );
    const row = inserted.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return { written: false, id: null, inserted: false };
    }
    // Una propuesta nueva reemplaza a las pendientes anteriores del mismo
    // festival: no queremos dos sugerencias contradictorias en el admin.
    await client.query(
      `UPDATE public.festival_fact_proposals
          SET review_status = 'superseded', reviewed_at = NOW(),
              reviewed_by = 'radar', updated_at = NOW()
        WHERE festival_id = $1 AND id <> $2 AND review_status = 'pending'`,
      [record.festivalId, row.id]
    );
    await client.query('COMMIT');
    return { written: true, id: Number(row.id), inserted: Boolean(row.inserted) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function optionsApplyLine(report) {
  return report.mode === 'apply'
    ? 'Las propuestas se guardaron en `festival_fact_proposals` con estado `pending`. **Ningún festival cambió**: aprobar o rechazar es una acción humana desde el panel admin.'
    : 'Dry run: no se escribió en la base. Usá `--apply` para guardar las propuestas en el panel admin.';
}

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

function renderMarkdown(report) {
  const summary = report.summary;
  const cost = summary.costUsd === null ? 'sin datos' : `$${summary.costUsd.toFixed(6)} USD`;
  const lines = [
    '# Festival facts (check)',
    '',
    `- **Generado:** ${report.generatedAt}`,
    `- **Modelo:** ${report.model}`,
    `- **Festivales en hiatus:** ${summary.total}`,
    `- **Analizados:** ${summary.analyzed}`,
    `- **Con datos válidos:** ${summary.ok}`,
    `- **Con cambios sugeridos:** ${summary.changes}`,
    `- **Propuestas nuevas:** ${summary.created ?? 0}`,
    `- **Propuestas actualizadas:** ${summary.updated ?? 0}`,
    `- **Fallos:** ${summary.failed}`,
    `- **Tokens de entrada:** ${summary.promptTokens}`,
    `- **Tokens de salida:** ${summary.completionTokens}`,
    `- **Costo estimado:** ${cost}`,
  ];
  if (report.results.length) {
    lines.push('', '| Festival | Actual | Detectado | Sugerencia | Cambio | Fuente |', '|---|---|---|---|---|---|');
    for (const row of report.results) {
      const current = `${row.festival.lineupStatus} · ${row.festival.dates || '—'}`;
      const detected = row.ok
        ? `${row.editionStatus || '—'} · ${row.datesText || '—'}${row.editionYear ? ` (${row.editionYear})` : ''}`
        : 'error';
      const suggestion = row.suggestion
        ? `${row.suggestion.lineupStatus || 'sin estado'}${row.suggestion.datesText ? ` · ${row.suggestion.datesText}` : ''}`
        : '—';
      lines.push(`| ${escapeCell(row.festival.name)} (${escapeCell(row.festival.id)}) | ${escapeCell(current)} | ${escapeCell(detected)} | ${escapeCell(suggestion)} | ${escapeCell(row.changeReasons.join('; ')) || '—'} | ${escapeCell(row.pageUrl || row.sourceUrl || '')} |`);
    }
    lines.push('', '## Detalle', '');
    for (const row of report.results) {
      lines.push(`### ${row.festival.name} (${row.festival.id})`, '');
      lines.push(`- **Fuente:** ${row.pageUrl || row.sourceUrl || '—'}`);
      if (row.ok) {
        lines.push(`- **Edición detectada:** ${row.editionStatus}${row.editionYear ? ` · ${row.editionYear}` : ''}`);
        if (row.datesText) lines.push(`- **Fechas en la página:** ${row.datesText}`);
        if (row.suggestion) lines.push(`- **Sugerencia:** ${row.suggestion.reason}`);
        if (row.changeReasons.length) lines.push(`- **Cambios:** ${row.changeReasons.join('; ')}`);
        if (row.evidence.length) {
          lines.push('- **Evidencia:**');
          for (const quote of row.evidence.slice(0, MAX_EVIDENCE)) lines.push(`  - "${quote}"`);
        }
      } else {
        lines.push(`- **Error:** ${row.errors.join(' ') || 'desconocido'}`);
      }
      if (row.warnings.length) {
        lines.push('- **Advertencias:**');
        for (const item of row.warnings) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }
  lines.push(optionsApplyLine(report));
  return `${lines.join('\n')}\n`;
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Falta OPENROUTER_API_KEY. No se puede revisar datos de festivales.');
    return 1;
  }

  const client = databaseClient();
  try {
    await client.connect();
    const festivals = await loadHiatusFestivals(client, options);
    if (!festivals.length) {
      console.error(options.festival
        ? `No hay un festival en hiatus con id ${options.festival}.`
        : 'No hay festivales en hiatus para revisar.');
    }

    const results = [];
    const summary = {
      total: festivals.length,
      analyzed: 0,
      ok: 0,
      changes: 0,
      failed: 0,
      created: 0,
      updated: 0,
      saveErrors: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
    };

    for (const festival of festivals) {
      let result;
      try {
        result = await analyzeFestival(festival, { apiKey, model: options.model });
      } catch (error) {
        result = {
          ok: false, festival, targetYear: targetYearOf(festival),
          sourceUrl: festival.website, pageUrl: null, pageTitle: '',
          pagesChecked: 0, visited: [], errors: [error.message], warnings: [],
          changed: false, changeReasons: [], evidence: [], uncertainty: [],
          confidence: null, usage: null,
        };
      }
      summary.analyzed += 1;
      if (result.ok) summary.ok += 1;
      else summary.failed += 1;
      if (result.changed) summary.changes += 1;
      if (result.usage) {
        summary.promptTokens += result.usage.promptTokens;
        summary.completionTokens += result.usage.completionTokens;
        summary.costUsd = (summary.costUsd || 0) + result.usage.costUsd;
      }

      if (options.apply && result.ok && result.changed && result.suggestion
        && (result.suggestion.lineupStatus || result.suggestion.datesText)) {
        try {
          const saved = await saveFactProposal(client, buildFactProposalRecord(result));
          result.saved = saved;
          if (saved.inserted) summary.created += 1;
          else if (saved.written) summary.updated += 1;
        } catch (error) {
          summary.saveErrors += 1;
          result.warnings.push(`No se pudo guardar la propuesta: ${error.message}`);
        }
      }

      results.push(result);
    }

    summary.costUsd = summary.costUsd === null ? null : Number(summary.costUsd.toFixed(6));
    const report = {
      mode: options.apply ? 'apply' : 'dry-run',
      generatedAt: new Date().toISOString(),
      model: options.model,
      schemaVersion: FACTS_SCHEMA_VERSION,
      summary,
      results,
    };
    const markdown = renderMarkdown(report);
    console.log(markdown);

    if (options.reportOut) {
      const outputPath = path.resolve(options.reportOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdown, 'utf8');
    }
    if (options.jsonOut) {
      const outputPath = path.resolve(options.jsonOut);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    if (process.env.GITHUB_OUTPUT) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `has_fact_changes=${summary.changes > 0}\nfacts_checked=${summary.analyzed}\nfacts_failed=${summary.failed}\nfact_proposals_created=${summary.created}\n`
        );
      } catch (error) {
        console.error(`No se pudo escribir en GITHUB_OUTPUT: ${error.message}`);
      }
    }

    if (summary.analyzed > 0 && summary.ok === 0) return 1;
    return 0;
  } catch (error) {
    console.error(`No se pudo revisar datos de festivales: ${error.message}`);
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
  analyzeFestival, buildFactProposalRecord, buildPageContext, discoverLinks, factsChanged, formatDateRangeEs,
  loadHiatusFestivals, main, needsMoreEvidence, normalizeSuggestedDates, parseArgs,
  renderMarkdown, saveFactProposal, targetYearOf,
};
