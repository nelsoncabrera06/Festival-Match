#!/usr/bin/env node
'use strict';

// Tests del extractor con IA (fase 4, paso 14). No usan red ni base de datos:
// el fetch y el cliente de Postgres se simulan, igual que en los otros
// verificadores del repo.
const assert = require('assert');

const {
  DEFAULT_MODEL, EXTRACTION_SCHEMA_VERSION, LINEUP_STATUSES, MAX_ARTISTS,
  OPENROUTER_URL, TICKET_STATUSES, buildPrompt, buildProposalRecord, cleanArtistName,
  estimateCost, isValidIsoDate, parseCompletion, proposalJsonSchema, requestProposal,
  targetYearOf, validateExtraction,
} = require('../server/lineupExtractor');
const {
  extractOne, markObservationProcessed, parseArgs, renderMarkdown, saveProposal,
} = require('./lineup-extract');

const FESTIVAL = {
  id: 'sonar', name: 'Sónar', city: 'Barcelona', country: 'España',
  dates: '11-13 junio 2027', lineup: [], lineupStatus: 'unannounced',
  startsOn: '2027-06-11', endsOn: '2027-06-13',
};
const OBSERVATION = {
  id: 42, festivalId: 'sonar', sourceUrl: 'https://sonar.es/en',
  seenHash: 'abc123', hashVersion: 2, title: 'Sónar 2027',
  excerpt: 'Sónar 2027. Line-up: Bad Gyal, Rosalía, The Strokes y más artistas por confirmar.',
};

function validExtraction(overrides = {}) {
  return {
    lineup_status: 'partial',
    artists: [
      { name: 'Bad Gyal', day: null },
      { name: 'Rosalía', day: null },
      { name: 'The Strokes', day: '2027-06-12' },
    ],
    dates_text: '11-13 junio 2027',
    lineup_announcement: { announced_at: null, quote: null },
    tickets: { status: 'not_mentioned', on_sale_at: null, quote: null },
    page_edition_year: 2027,
    evidence: ['Line-up: Bad Gyal, Rosalía, The Strokes y más artistas por confirmar.'],
    confidence: 0.9,
    uncertainty: ['El cartel parece incompleto.'],
    ...overrides,
  };
}

// Respuesta mínima con forma de OpenRouter.
function completion(content, overrides = {}) {
  return {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    usage: { prompt_tokens: 1200, completion_tokens: 400 },
    choices: [{ message: { content }, finish_reason: 'stop', ...overrides }],
  };
}

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  impl.calls = calls;
  return impl;
}

function fakeClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
  };
}

async function main() {
  // ---------- argumentos ----------
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.limit, 5);
  assert.strictEqual(defaults.model, DEFAULT_MODEL);
  assert.strictEqual(defaults.apply, false);
  assert.strictEqual(defaults.retryFailed, false);
  assert.strictEqual(parseArgs(['--dry']).apply, false);
  assert.strictEqual(parseArgs(['--apply', '--limit=10']).limit, 10);
  assert.strictEqual(parseArgs(['--observation=7']).observation, 7);
  assert.throws(() => parseArgs(['--limit=0']), /entre 1 y 10/);
  assert.throws(() => parseArgs(['--limit=11']), /entre 1 y 10/);
  assert.throws(() => parseArgs(['--observation=abc']), /numérico/);
  assert.throws(() => parseArgs(['--retry-failed']), /--apply/);
  assert.strictEqual(parseArgs(['--apply', '--retry-failed']).retryFailed, true);
  assert.throws(() => parseArgs(['--model=']), /modelo/);
  assert.throws(() => parseArgs(['--publicar']), /desconocido/);
  assert.throws(() => parseArgs(['--festival=']), /id/);

  // ---------- esquema ----------
  const schema = proposalJsonSchema();
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.required, [
    'lineup_status', 'artists', 'dates_text', 'lineup_announcement',
    'tickets', 'page_edition_year', 'evidence', 'confidence', 'uncertainty',
  ]);
  assert.deepStrictEqual(schema.properties.lineup_status.enum, LINEUP_STATUSES);
  assert.deepStrictEqual(schema.properties.tickets.properties.status.enum, TICKET_STATUSES);
  assert.strictEqual(schema.properties.artists.maxItems, MAX_ARTISTS);
  // Todos los campos declarados son obligatorios: es lo que exige el modo strict.
  for (const key of Object.keys(schema.properties)) {
    assert.ok(schema.required.includes(key), `${key} debe ser obligatorio`);
  }
  // Fechas: solo ISO corto, nunca texto libre.
  assert.strictEqual(schema.properties.artists.items.properties.day.pattern, '^\\d{4}-\\d{2}-\\d{2}$');

  // ---------- prompt ----------
  const messages = buildPrompt({ festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'system');
  assert.match(messages[0].content, /No traduzcas/);
  assert.match(messages[1].content, /Sónar/);
  assert.match(messages[1].content, /2027/);
  assert.match(messages[1].content, /https:\/\/sonar\.es\/en/);
  assert.match(messages[1].content, /Bad Gyal/);
  assert.match(messages[1].content, /--- TEXTO VISIBLE DE LA PÁGINA ---/);
  const longPrompt = buildPrompt({
    festival: FESTIVAL,
    observation: { ...OBSERVATION, excerpt: 'x'.repeat(30000) },
    maxExcerptChars: 100,
  });
  assert.ok(longPrompt[1].content.includes('x'.repeat(100)));
  assert.ok(!longPrompt[1].content.includes('x'.repeat(101)), 'el extracto debe recortarse');

  // ---------- año objetivo ----------
  assert.strictEqual(targetYearOf({ startsOn: '2027-06-11' }), 2027);
  assert.strictEqual(targetYearOf({ dates: '2027 (fecha por anunciar)' }), 2027);
  assert.strictEqual(targetYearOf({ dates: 'fecha por anunciar' }), null);
  assert.strictEqual(targetYearOf({}), null);

  // ---------- validación ----------
  const happy = validateExtraction(validExtraction(), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(happy.ok, true);
  assert.strictEqual(happy.proposal.artists.length, 3);
  assert.strictEqual(happy.proposal.artists[2].day, '2027-06-12');
  assert.strictEqual(happy.proposal.editionMatchesTarget, true);
  assert.strictEqual(happy.proposal.tickets.status, 'not_mentioned');
  assert.deepStrictEqual(happy.errors, []);

  // Duplicados y nombres sucios: se limpian acá, no en el modelo.
  const dirty = validateExtraction(validExtraction({
    artists: [
      { name: '  Björk  ', day: null },
      { name: 'BJORK', day: null },
      { name: '• Rosalía,', day: null },
      { name: '   ', day: null },
    ],
  }), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(dirty.ok, true);
  assert.deepStrictEqual(dirty.proposal.artists.map((artist) => artist.name), ['Björk', 'Rosalía']);
  assert.match(dirty.warnings.join(' '), /duplicados/);
  assert.match(dirty.warnings.join(' '), /vacías/);

  // Contradicciones: son las que evitan publicar inventos.
  const contradiction = validateExtraction(validExtraction({
    lineup_status: 'unannounced', artists: [{ name: 'Bad Gyal', day: null }],
  }), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(contradiction.ok, false);
  assert.match(contradiction.errors.join(' '), /unannounced/);

  const emptyConfirmed = validateExtraction(validExtraction({ artists: [] }), {
    festival: FESTIVAL, observation: OBSERVATION,
  });
  assert.strictEqual(emptyConfirmed.ok, false);
  assert.match(emptyConfirmed.errors.join(' '), /sin artistas/);

  // Un "unannounced" vacío y con evidencia sí es válido: es el caso
  // "todavía no hay lineup, se anuncia el 5 de noviembre".
  const announcedLater = validateExtraction(validExtraction({
    lineup_status: 'unannounced',
    artists: [],
    lineup_announcement: { announced_at: '2026-11-05', quote: 'El line-up se anuncia el 5 de noviembre' },
    tickets: { status: 'on_sale', on_sale_at: '2026-10-20', quote: 'Early birds a la venta' },
    confidence: 0.95,
    uncertainty: [],
  }), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(announcedLater.ok, true);
  assert.strictEqual(announcedLater.proposal.lineupStatus, 'unannounced');
  assert.strictEqual(announcedLater.proposal.lineupAnnouncement.announcedAt, '2026-11-05');
  assert.strictEqual(announcedLater.proposal.tickets.status, 'on_sale');

  // Fechas y números fuera de rango.
  assert.strictEqual(validateExtraction(validExtraction({
    artists: [{ name: 'Bad Gyal', day: '2027-13-40' }],
  }), { festival: FESTIVAL, observation: OBSERVATION }).ok, false);
  assert.strictEqual(validateExtraction(validExtraction({ confidence: 1.5 }), {
    festival: FESTIVAL, observation: OBSERVATION,
  }).ok, false);
  assert.strictEqual(validateExtraction(validExtraction({ confidence: 'alta' }), {
    festival: FESTIVAL, observation: OBSERVATION,
  }).ok, false);
  assert.strictEqual(validateExtraction(validExtraction({
    tickets: { status: 'quizas', on_sale_at: null, quote: null },
  }), { festival: FESTIVAL, observation: OBSERVATION }).ok, false);
  assert.strictEqual(validateExtraction(validExtraction({ lineup_status: 'casi' }), {
    festival: FESTIVAL, observation: OBSERVATION,
  }).ok, false);

  // Sin evidencia no se acepta una propuesta con artistas.
  assert.strictEqual(validateExtraction(validExtraction({ evidence: [] }), {
    festival: FESTIVAL, observation: OBSERVATION,
  }).ok, false);

  // Tickets "not_mentioned" con datos: se ignoran los datos y queda advertencia.
  const ignoredTickets = validateExtraction(validExtraction({
    tickets: { status: 'not_mentioned', on_sale_at: '2026-10-20', quote: 'algo' },
  }), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(ignoredTickets.ok, true);
  assert.strictEqual(ignoredTickets.proposal.tickets.onSaleAt, null);
  assert.strictEqual(ignoredTickets.proposal.tickets.quote, null);
  assert.match(ignoredTickets.warnings.join(' '), /not_mentioned/);

  // Edición distinta a la del catálogo: no invalida, pero queda marcada.
  const oldEdition = validateExtraction(validExtraction({ page_edition_year: 2026 }), {
    festival: FESTIVAL, observation: OBSERVATION,
  });
  assert.strictEqual(oldEdition.ok, true);
  assert.strictEqual(oldEdition.proposal.editionMatchesTarget, false);
  assert.match(oldEdition.warnings.join(' '), /edición 2026/);

  // Confianza baja: advertencia, no bloqueo.
  const lowConfidence = validateExtraction(validExtraction({ confidence: 0.2 }), {
    festival: FESTIVAL, observation: OBSERVATION,
  });
  assert.strictEqual(lowConfidence.ok, true);
  assert.match(lowConfidence.warnings.join(' '), /Confianza baja/);

  // Demasiados artistas: se rechaza en vez de truncar en silencio.
  const tooMany = validateExtraction(validExtraction({
    artists: Array.from({ length: MAX_ARTISTS + 1 }, (_, index) => ({ name: `Artista ${index}`, day: null })),
  }), { festival: FESTIVAL, observation: OBSERVATION });
  assert.strictEqual(tooMany.ok, false);
  assert.match(tooMany.errors.join(' '), /máximo/);

  assert.strictEqual(cleanArtistName('  • AC/DC,  '), 'AC/DC');
  assert.strictEqual(isValidIsoDate('2027-02-29'), false);
  assert.strictEqual(isValidIsoDate('2028-02-29'), true);
  assert.strictEqual(isValidIsoDate('2027-6-1'), false);

  // ---------- parseo de la respuesta ----------
  assert.deepStrictEqual(parseCompletion(completion(JSON.stringify(validExtraction()))).extraction.lineup_status, 'partial');
  assert.deepStrictEqual(
    parseCompletion(completion('```json\n' + JSON.stringify(validExtraction()) + '\n```')).extraction.lineup_status,
    'partial'
  );
  assert.throws(() => parseCompletion({}), /choices/);
  assert.throws(() => parseCompletion(completion('', { finish_reason: 'length' })), /límite de tokens/);
  assert.throws(() => parseCompletion(completion('', { finish_reason: 'content_filter' })), /filtró/);
  assert.throws(() => parseCompletion(completion('no es json')), /JSON válido/);
  assert.throws(() => parseCompletion({ choices: [{ message: { refusal: 'no puedo' } }] }), /rechazó/);
  assert.throws(() => parseCompletion(completion('   ')), /vacía/);
  const usage = parseCompletion(completion(JSON.stringify(validExtraction()))).usage;
  assert.strictEqual(usage.prompt_tokens, 1200);

  // ---------- costo ----------
  const cost = estimateCost({ prompt_tokens: 1000, completion_tokens: 1000 });
  assert.strictEqual(cost.promptTokens, 1000);
  assert.strictEqual(cost.totalTokens, 2000);
  assert.strictEqual(cost.costUsd, 0.000506);
  const cachedCost = estimateCost({ prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } });
  assert.strictEqual(cachedCost.costUsd, 0.000005);
  assert.strictEqual(estimateCost(null), null);

  // ---------- llamada a OpenRouter ----------
  const fetchImpl = fakeFetch(completion(JSON.stringify(validExtraction())));
  const response = await requestProposal({
    apiKey: 'clave-de-prueba', model: DEFAULT_MODEL,
    messages: buildPrompt({ festival: FESTIVAL, observation: OBSERVATION }), fetchImpl,
  });
  assert.strictEqual(response.extraction.lineup_status, 'partial');
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.url, OPENROUTER_URL);
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.headers.Authorization, 'Bearer clave-de-prueba');
  const sent = JSON.parse(call.init.body);
  assert.strictEqual(sent.model, DEFAULT_MODEL);
  assert.strictEqual(sent.temperature, 0);
  assert.strictEqual(sent.response_format.type, 'json_schema');
  assert.strictEqual(sent.response_format.json_schema.strict, true);
  assert.strictEqual(sent.response_format.json_schema.schema.additionalProperties, false);
  assert.ok(sent.max_completion_tokens > 0);
  assert.strictEqual(sent.messages.length, 2);

  await assert.rejects(
    () => requestProposal({ apiKey: 'k', messages: [], fetchImpl: fakeFetch('no autorizado', { status: 401 }) }),
    /401/
  );
  await assert.rejects(
    () => requestProposal({ messages: [], fetchImpl }), /OPENROUTER_API_KEY/
  );
  await assert.rejects(
    () => requestProposal({ apiKey: 'k', messages: [], fetchImpl: fakeFetch('<html>error</html>') }),
    /no es JSON/
  );
  assert.strictEqual(response.format, 'json_schema');

  // Fallback: si el proveedor rechaza json_schema se reintenta con json_object.
  const fallbackBodies = [];
  const fallbackFetch = async (url, init) => {
    fallbackBodies.push(JSON.parse(init.body));
    if (fallbackBodies.length === 1) {
      return {
        ok: false, status: 400,
        text: async () => '{"error":{"message":"response_format json_schema is not supported"}}',
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(completion(JSON.stringify(validExtraction()))) };
  };
  const fallback = await requestProposal({
    apiKey: 'k', messages: buildPrompt({ festival: FESTIVAL, observation: OBSERVATION }),
    fetchImpl: fallbackFetch,
  });
  assert.strictEqual(fallback.format, 'json_object');
  assert.strictEqual(fallbackBodies.length, 2);
  assert.strictEqual(fallbackBodies[0].response_format.type, 'json_schema');
  assert.strictEqual(fallbackBodies[1].response_format.type, 'json_object');
  assert.strictEqual(fallback.extraction.lineup_status, 'partial');

  // Un 400 que no es de formato no se reintenta: no se gasta dos veces.
  const hardFail = fakeFetch('{"error":"model not found"}', { status: 400 });
  await assert.rejects(() => requestProposal({ apiKey: 'k', messages: [], fetchImpl: hardFail }), /400/);
  assert.strictEqual(hardFail.calls.length, 1);

  // ---------- extracción de una observación ----------
  const okRun = await extractOne({ festival: FESTIVAL, observation: OBSERVATION }, {
    apiKey: 'k', model: DEFAULT_MODEL, fetchImpl: fakeFetch(completion(JSON.stringify(validExtraction()))),
  });
  assert.strictEqual(okRun.ok, true);
  assert.strictEqual(okRun.record.festivalId, 'sonar');
  assert.strictEqual(okRun.record.observationId, 42);
  assert.strictEqual(okRun.record.seenHash, 'abc123');
  assert.strictEqual(okRun.record.hashVersion, 2);
  assert.strictEqual(okRun.record.lineupStatus, 'partial');
  assert.strictEqual(okRun.record.artistsCount, 3);
  assert.strictEqual(okRun.record.extractionError, null);
  assert.strictEqual(okRun.record.schemaVersion, EXTRACTION_SCHEMA_VERSION);
  assert.ok(okRun.usage.costUsd > 0);

  const skipped = await extractOne({ festival: FESTIVAL, observation: { ...OBSERVATION, excerpt: '  ' } }, {
    apiKey: 'k', fetchImpl,
  });
  assert.strictEqual(skipped.skipped, true);

  const invalidRun = await extractOne({ festival: FESTIVAL, observation: OBSERVATION }, {
    apiKey: 'k', model: DEFAULT_MODEL,
    fetchImpl: fakeFetch(completion(JSON.stringify(validExtraction({
      lineup_status: 'unannounced', artists: [{ name: 'Bad Gyal', day: null }],
    })))),
  });
  assert.strictEqual(invalidRun.ok, false);
  assert.strictEqual(invalidRun.record.extractionError.length > 0, true);
  assert.deepStrictEqual(invalidRun.record.payload, {});
  assert.strictEqual(invalidRun.record.lineupStatus, null);

  const networkRun = await extractOne({ festival: FESTIVAL, observation: OBSERVATION }, {
    apiKey: 'k', model: DEFAULT_MODEL,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.strictEqual(networkRun.ok, false);
  assert.match(networkRun.errors.join(' '), /ECONNRESET/);

  const record = buildProposalRecord({
    festival: FESTIVAL, observation: OBSERVATION, proposal: happy.proposal,
    model: DEFAULT_MODEL, schemaVersion: EXTRACTION_SCHEMA_VERSION,
  });
  assert.strictEqual(record.artistsCount, 3);
  assert.strictEqual(record.confidence, 0.9);

  // ---------- persistencia ----------
  const client = fakeClient();
  await saveProposal(client, record);
  const insert = client.queries[0];
  assert.strictEqual(insert.params.length, 12, 'la sentencia debe tener 12 parámetros');
  for (let index = 1; index <= 12; index += 1) {
    assert.ok(insert.sql.includes(`$${index}`), `falta $${index}`);
  }
  assert.match(insert.sql, /ON CONFLICT \(festival_id, seen_hash\) DO UPDATE/);
  assert.match(insert.sql, /WHERE public\.lineup_proposals\.extraction_error IS NOT NULL/);
  assert.ok(!insert.sql.includes('Sónar'), 'los valores nunca van interpolados en el SQL');
  assert.ok(!insert.sql.includes('abc123'));
  assert.strictEqual(typeof insert.params[10], 'string', 'el payload viaja como JSON serializado');
  assert.strictEqual(JSON.parse(insert.params[10]).artists.length, 3);

  // El marcado de la observación deja el update crítico al final: si el estado
  // del scanner falla (migración 017 ausente), la observación igual queda
  // procesada y no se vuelve a pagar la misma extracción.
  const markClient = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/festival_source_checks/.test(sql)) throw new Error('42P01');
      return { rowCount: 1, rows: [] };
    },
  };
  await markObservationProcessed(markClient, OBSERVATION);
  assert.strictEqual(markClient.queries.length, 2);
  assert.match(markClient.queries[1].sql, /UPDATE public\.lineup_source_observations/);
  assert.deepStrictEqual(markClient.queries[1].params, [42]);

  // ---------- reporte ----------
  const markdown = renderMarkdown({
    mode: 'dry-run',
    generatedAt: '2026-11-08T12:30:00.000Z',
    model: DEFAULT_MODEL,
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    summary: {
      pending: 1, analyzed: 1, valid: 1, failed: 0, skipped: 0, artists: 3,
      promptTokens: 1200, completionTokens: 400, costUsd: 0.000207,
    },
    results: [{
      festivalId: 'sonar', name: 'Sónar', sourceUrl: 'https://sonar.es/en', ok: true,
      status: 'partial', artistsCount: 3, artistSample: ['Bad Gyal', 'Rosalía', 'The Strokes'],
      confidence: 0.9, datesText: '11-13 junio 2027', lineupAnnouncementAt: '2026-11-05',
      ticketsStatus: 'not_mentioned', ticketsOnSaleAt: null, pageEditionYear: 2027,
      editionMatchesTarget: true, evidence: ['Line-up: Bad Gyal, Rosalía, The Strokes'],
      uncertainty: [], errors: [], warnings: [], usage: null, model: DEFAULT_MODEL,
    }],
  });
  assert.match(markdown, /# Lineup extractor \(dry run\)/);
  assert.match(markdown, /- \*\*Generado:\*\* 08-11-2026 12:30:00 UTC/);
  assert.match(markdown, /- \*\*Costo estimado:\*\* \$0\.000207 USD/);
  assert.match(markdown, /\| Sónar \(sonar\) \| partial \| 3 \| 0\.90 \| 05-11-2026 \|/);
  assert.match(markdown, /Ninguna propuesta se guardó|Dry run: no se escribió nada en la base/);
  assert.match(markdown, /consumió tokens/);
  assert.ok(!markdown.includes('clave-de-prueba'));

  const emptyReport = renderMarkdown({
    mode: 'apply', generatedAt: '2026-11-08T12:30:00.000Z', model: DEFAULT_MODEL,
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    summary: {
      pending: 0, analyzed: 0, valid: 0, failed: 0, skipped: 0, artists: 0,
      promptTokens: 0, completionTokens: 0, costUsd: null,
    },
    results: [],
  });
  assert.match(emptyReport, /- \*\*Observaciones pendientes:\*\* 0/);
  assert.match(emptyReport, /- \*\*Costo estimado:\*\* sin datos/);
  assert.match(emptyReport, /estado `pending`/);

  console.log('OK verify-lineup-extractor: argumentos, esquema, prompt, validación, parseo, costo, persistencia y reporte.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
