#!/usr/bin/env node
'use strict';

// Tests del radar de datos de festivales (fase 4, paso 18).
// No usa red, DB ni OpenRouter: inyecta fetch y request falsos.
//
// Uso: node scripts/verify-festival-facts.js

const assert = require('assert');

const {
  FACTS_SCHEMA_VERSION, buildFactsPrompt, requestFacts, validateFacts,
} = require('../server/festivalFactsExtractor');
const {
  analyzeFestival, buildPageContext, discoverLinks, factsChanged, needsMoreEvidence,
  parseArgs, renderMarkdown, targetYearOf,
} = require('./festival-facts');

const FESTIVAL = {
  id: 'glastonbury', name: 'Glastonbury Festival', dates: '2027 (confirmado)',
  website: 'https://www.glastonburyfestivals.co.uk', lineupSourceUrl: 'https://www.glastonburyfestivals.co.uk/line-up/',
  lineupStatus: 'hiatus', startsOn: null, endsOn: null,
};

function facts(overrides = {}) {
  return {
    edition_status: 'has_edition',
    edition_year: 2027,
    dates_text: '23-27 June 2027',
    starts_on: '2027-06-23',
    ends_on: '2027-06-27',
    evidence: ['General Admission tickets valid from Wednesday 23rd June to Sunday 27th June, 2027.'],
    confidence: 0.95,
    uncertainty: [],
    ...overrides,
  };
}

function response(extraction, overrides = {}) {
  return {
    extraction,
    model: 'deepseek/deepseek-v4.1-flash-1017',
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    format: 'json_schema',
    ...overrides,
  };
}

async function main() {
  // ---------- argumentos ----------
  assert.deepStrictEqual(parseArgs([]), {
    festival: null, limit: 10, model: 'deepseek/deepseek-v4.1-flash-1017',
    jsonOut: null, reportOut: null, help: false,
  });
  assert.strictEqual(parseArgs(['--festival=glastonbury']).festival, 'glastonbury');
  assert.strictEqual(parseArgs(['--limit=20']).limit, 20);
  assert.throws(() => parseArgs(['--limit=0']), /entre 1 y 20/);
  assert.throws(() => parseArgs(['--limit=21']), /entre 1 y 20/);
  assert.throws(() => parseArgs(['--publicar']), /desconocido/);

  // ---------- año objetivo ----------
  assert.strictEqual(targetYearOf({ startsOn: '2027-06-23' }), 2027);
  assert.strictEqual(targetYearOf({ dates: '2027 (confirmado)' }), 2027);
  assert.strictEqual(targetYearOf({ dates: '2028 (fecha por anunciar)' }), 2028);
  assert.strictEqual(targetYearOf({ dates: 'TBA' }), null);

  // ---------- contexto de página ----------
  const html = `<!doctype html><html><head>
    <title>Glastonbury 2027</title>
    <meta name="description" content="Tickets for Glastonbury 2027" />
    <script type="application/ld+json">{"@type":"Event","startDate":"2027-06-23","endDate":"2027-06-27"}</script>
    </head><body><h1>24th - 28th June 2027?</h1><p>Visible text</p>
    <script>window.data = { dates: "23-27 June 2027" }</script>
    <a href="/news/glastonbury-2027-ticket-information-confirmed/">GLASTONBURY 2027 TICKET INFORMATION CONFIRMED</a>
    <a href="https://example.com/2027">externo</a>
    </body></html>`;
  const context = buildPageContext(html, 2027);
  assert.match(context, /TEXTO VISIBLE/);
  assert.match(context, /META DESCRIPTIONS/);
  assert.match(context, /DATOS ESTRUCTURADOS/);
  assert.match(context, /FRAGMENTOS CON EL AÑO 2027/);
  assert.match(context, /23-27 June 2027/);

  const links = discoverLinks(html, FESTIVAL.website, 2027);
  assert.strictEqual(links.length, 1, 'solo sigue links del mismo dominio');
  assert.match(links[0].url, /glastonburyfestivals\.co\.uk\/news\/glastonbury-2027/);

  // ---------- validación ----------
  const hasEdition = validateFacts(facts(), { festival: FESTIVAL });
  assert.strictEqual(hasEdition.ok, true);
  assert.strictEqual(hasEdition.facts.matchesTarget, true);
  assert.strictEqual(hasEdition.facts.suggestion.lineupStatus, 'unannounced');
  assert.strictEqual(hasEdition.facts.suggestion.datesText, '23-27 June 2027');
  assert.strictEqual(hasEdition.facts.startsOn, '2027-06-23');

  const noEdition = validateFacts(facts({
    edition_status: 'no_edition', dates_text: null, starts_on: null, ends_on: null,
    evidence: ['Bonnaroo will be taking a much-needed year off in 2027.'],
  }), { festival: { ...FESTIVAL, id: 'bonnaroo', name: 'Bonnaroo' } });
  assert.strictEqual(noEdition.ok, true);
  assert.strictEqual(noEdition.facts.suggestion.lineupStatus, 'hiatus');

  const wrongEdition = validateFacts(facts({
    edition_year: 2028, dates_text: 'September 2028', starts_on: null, ends_on: null,
    evidence: ['SETEMBRO DE 2028.'],
  }), { festival: FESTIVAL });
  assert.strictEqual(wrongEdition.ok, true);
  assert.strictEqual(wrongEdition.facts.suggestion.lineupStatus, null);
  assert.match(wrongEdition.warnings.join(' '), /edición 2028/);

  const partialDate = validateFacts(facts({ starts_on: '2027-06-23', ends_on: null }), { festival: FESTIVAL });
  assert.strictEqual(partialDate.ok, true);
  assert.strictEqual(partialDate.facts.startsOn, null);
  assert.match(partialDate.warnings.join(' '), /fecha parcial/);

  const invalidDate = validateFacts(facts({ starts_on: '2027-02-30' }), { festival: FESTIVAL });
  assert.strictEqual(invalidDate.ok, false);
  assert.match(invalidDate.errors.join(' '), /starts_on inválido/);

  const noEvidence = validateFacts(facts({ evidence: [] }), { festival: FESTIVAL });
  assert.strictEqual(noEvidence.ok, false);
  assert.match(noEvidence.errors.join(' '), /Sin evidencia/);

  // ---------- prompt ----------
  const messages = buildFactsPrompt({
    festival: FESTIVAL,
    page: { url: 'https://www.glastonburyfestivals.co.uk/', title: 'Glastonbury', text: context },
  });
  assert.strictEqual(messages[0].role, 'system');
  assert.match(messages[0].content, /La única fuente es el texto de la página/);
  assert.match(messages[1].content, /Año objetivo del catálogo: 2027/);
  assert.match(messages[1].content, /TEXTO DE LA PÁGINA OFICIAL/);

  // ---------- cambios ----------
  assert.deepStrictEqual(factsChanged(FESTIVAL, hasEdition.facts), [
    'estado hiatus → unannounced',
    'fechas "2027 (confirmado)" → "23-27 June 2027"',
    'starts_on — → 2027-06-23',
    'ends_on — → 2027-06-27',
  ]);
  assert.deepStrictEqual(factsChanged({ ...FESTIVAL, lineupStatus: 'unannounced', dates: '23-27 June 2027', startsOn: '2027-06-23', endsOn: '2027-06-27' }, hasEdition.facts), []);

  // ---------- análisis con páginas falsas ----------
  const pages = {
    'https://www.glastonburyfestivals.co.uk': `<!doctype html><html><head><title>Glastonbury</title></head><body>
      <p>Tickets for Glastonbury 2027 are on sale.</p>
      <a href="/news/glastonbury-2027-ticket-information-confirmed/">GLASTONBURY 2027 TICKET INFORMATION CONFIRMED</a>
      </body></html>`,
    'https://www.glastonburyfestivals.co.uk/news/glastonbury-2027-ticket-information-confirmed/': `<!doctype html><html><head><title>Glastonbury 2027 tickets</title></head><body>
      <p>General Admission tickets are valid from Wednesday 23rd June to Sunday 27th June, 2027.</p>
      </body></html>`,
  };
  const visited = [];
  const fakeFetch = async (url) => {
    visited.push(url);
    if (!pages[url]) throw new Error('404');
    return { finalUrl: url, body: Buffer.from(pages[url]) };
  };
  let calls = 0;
  const fakeRequest = async () => {
    calls += 1;
    return calls === 1
      ? response(facts({ dates_text: null, starts_on: null, ends_on: null, confidence: 0.6 }))
      : response(facts());
  };
  const analyzed = await analyzeFestival(FESTIVAL, {
    apiKey: 'k', fetchImpl: fakeFetch, requestImpl: fakeRequest,
  });
  assert.strictEqual(calls, 2, 'sigue una página de noticias cuando la portada no da fechas');
  assert.strictEqual(analyzed.ok, true);
  assert.strictEqual(analyzed.pageUrl, 'https://www.glastonburyfestivals.co.uk/news/glastonbury-2027-ticket-information-confirmed/');
  assert.strictEqual(analyzed.suggestion.lineupStatus, 'unannounced');
  assert.strictEqual(analyzed.changed, true);
  assert.strictEqual(analyzed.usage.totalTokens, 2400);

  // Si la portada ya dice "no_edition", no sigue links.
  visited.length = 0;
  calls = 0;
  const noEditionAnalysis = await analyzeFestival({ ...FESTIVAL, id: 'bonnaroo', name: 'Bonnaroo' }, {
    apiKey: 'k',
    fetchImpl: async (url) => { visited.push(url); return { finalUrl: url, body: Buffer.from('<p>Bonnaroo will take a year off in 2027.</p>') }; },
    requestImpl: async () => {
      calls += 1;
      return response(facts({
        edition_status: 'no_edition', edition_year: 2027,
        dates_text: null, starts_on: null, ends_on: null,
        evidence: ['Bonnaroo will take a year off in 2027.'],
      }));
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(visited.length, 1);
  assert.strictEqual(noEditionAnalysis.suggestion.lineupStatus, 'hiatus');
  assert.strictEqual(needsMoreEvidence({ editionStatus: noEditionAnalysis.editionStatus }), false);

  // ---------- reporte ----------
  const report = renderMarkdown({
    generatedAt: '2026-11-09T10:00:00.000Z', model: 'm', schemaVersion: FACTS_SCHEMA_VERSION,
    summary: {
      total: 1, analyzed: 1, ok: 1, changes: 1, failed: 0,
      promptTokens: 1000, completionTokens: 200, costUsd: 0.0001,
    },
    results: [analyzed],
  });
  assert.match(report, /# Festival facts \(check\)/);
  assert.match(report, /Glastonbury Festival/);
  assert.match(report, /estado hiatus → unannounced/);
  assert.match(report, /Este chequeo \*\*no modifica el catálogo\*\*/);

  // ---------- OpenRouter: formato y error sin key ----------
  await assert.rejects(() => requestFacts({ messages: [] }), /OPENROUTER_API_KEY/);
  const sent = [];
  const fakeFetchOpenRouter = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'm', usage: {}, choices: [{ message: { content: JSON.stringify(facts()) }, finish_reason: 'stop' }] }) };
  };
  const openRouter = await requestFacts({ apiKey: 'k', messages: [], fetchImpl: fakeFetchOpenRouter });
  assert.strictEqual(openRouter.format, 'json_schema');
  assert.strictEqual(sent[0].body.response_format.type, 'json_schema');
  assert.strictEqual(sent[0].body.response_format.json_schema.strict, true);
  assert.strictEqual(sent[0].body.temperature, 0);

  console.log('Todo OK: radar de datos de festivales');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
