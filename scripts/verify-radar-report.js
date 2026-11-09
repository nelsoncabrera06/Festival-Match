#!/usr/bin/env node
'use strict';

// Tests del reporte semanal del radar (fase 4, paso 16).
//
// Verifica la parte que decide si se abre un issue y el texto que ve Nelson:
// no debe abrir issues vacíos, debe marcar propuestas nuevas/fallos, debe usar
// `announced_at` solo cuando existe y debe caer a `first_seen_at` cuando no.
//
// Uso: node scripts/verify-radar-report.js

const assert = require('assert');

const { buildRadarReport, formatDate } = require('../server/radarReport');
const { parseArgs } = require('./radar-report');

const GENERATED = '2026-11-09T11:45:00.000Z';

function emptyScan(overrides = {}) {
  return {
    summary: {
      total: 63, checked: 63, skipped: 0, errors: 0, notModified: 0,
      observations: { inserted: 0, baseline: 0, unchanged: 63, skipped: 0, errors: 0 },
      ...overrides.summary,
    },
    results: [],
    observed: [],
    ...overrides,
  };
}

function emptyExtraction(overrides = {}) {
  return {
    summary: {
      pending: 0, analyzed: 0, valid: 0, failed: 0, skipped: 0, artists: 0,
      created: 0, updated: 0, pendingTotal: 0,
      promptTokens: 0, completionTokens: 0, costUsd: null,
      ...overrides.summary,
    },
    results: [],
    ...overrides,
  };
}

// ---------- CLI ----------
assert.deepStrictEqual(parseArgs([]), {
  scan: null, extract: null, reportOut: null, help: false, extractFailed: false,
});
assert.strictEqual(parseArgs(['--scan=a.json']).scan, 'a.json');
assert.strictEqual(parseArgs(['--extract=b.json']).extract, 'b.json');
assert.strictEqual(parseArgs(['--report-out=c.md']).reportOut, 'c.md');
assert.strictEqual(parseArgs(['--extract-failed=true']).extractFailed, true);
assert.strictEqual(parseArgs(['--extract-failed=false']).extractFailed, false);
assert.throws(() => parseArgs(['--extract-failed=si']), /true o false/);
assert.throws(() => parseArgs(['--publicar']), /desconocido/);

// ---------- semana sin novedades ----------
const quiet = buildRadarReport({
  scan: emptyScan(),
  extraction: emptyExtraction(),
  pending: [],
  approved: [],
  generatedAt: GENERATED,
});
assert.strictEqual(quiet.hasNews, false, 'sin novedades no hay alerta');
assert.match(quiet.title, /sin cambios \(09 nov 2026\)/, 'el issue de prueba igual tiene título');
assert.match(quiet.markdown, /# Radar de lineups — reporte semanal/);
assert.match(quiet.markdown, /\*\*Fuentes revisadas:\*\* 63 de 63/);
assert.match(quiet.markdown, /\*\*Propuestas nuevas:\*\* 0/);
assert.match(quiet.markdown, /Sin cambios que reportar/);
assert.match(quiet.markdown, /No se generaron propuestas nuevas/);
assert.match(quiet.markdown, /No hay propuestas pendientes/);
assert.match(quiet.markdown, /se publica como issue/);

// ---------- propuesta nueva: issue + link + anuncio explícito ----------
const withNew = buildRadarReport({
  scan: emptyScan({
    summary: { observations: { inserted: 1, baseline: 0, unchanged: 62, skipped: 0, errors: 0 } },
    observed: [{
      id: 'sonar', name: 'Sónar', sourceUrl: 'https://sonar.es/en',
      previousHash: 'aaa', seenHash: 'bbb', detectedAt: '2026-11-09T11:40:00.000Z',
    }],
  }),
  extraction: emptyExtraction({
    summary: { created: 1, valid: 1, analyzed: 1, artists: 20, pendingTotal: 1 },
    results: [{
      festivalId: 'sonar', name: 'Sónar', sourceUrl: 'https://sonar.es/en',
      ok: true, created: true, status: 'partial', artistsCount: 20,
      confidence: 0.9, datesText: '17-19 junio 2027',
      lineupAnnouncementAt: '2026-11-05', pageEditionYear: 2027, editionMatchesTarget: true,
      errors: [], warnings: [],
    }],
  }),
  pending: [{
    id: 1, festivalId: 'sonar', festivalName: 'Sónar', sourceUrl: 'https://sonar.es/en',
    lineupStatus: 'partial', artistsCount: 20, confidence: 0.9,
    announcedAt: '2026-11-05', firstSeenAt: '2026-11-09T11:40:00.000Z', extractionError: null,
  }],
  approved: [],
  generatedAt: GENERATED,
});
assert.strictEqual(withNew.hasNews, true);
assert.match(withNew.title, /1 propuesta nueva/);
assert.match(withNew.markdown, /Detecciones de cambio/);
assert.match(withNew.markdown, /\*\*Sónar\*\* — 20 artistas/);
assert.match(withNew.markdown, /Anuncio declarado: 05 nov 2026/);
assert.match(withNew.markdown, /\(https:\/\/sonar\.es\/en\)/);
assert.match(withNew.markdown, /Propuestas pendientes:\*\* 1/);
assert.ok(!withNew.markdown.includes('Detectado por primera vez: 05 nov 2026'),
  'con announced_at no se muestra first_seen como si fuera el anuncio');

// ---------- pendiente sin fecha de anuncio: usa first_seen_at ----------
const pendingOnly = buildRadarReport({
  scan: emptyScan(),
  extraction: emptyExtraction(),
  pending: [{
    id: 2, festivalId: 'amf', festivalName: 'AMF', sourceUrl: 'https://amf-festival.com/',
    lineupStatus: 'partial', artistsCount: 8, confidence: 0.8,
    announcedAt: null, firstSeenAt: '2026-11-08T10:00:00.000Z', extractionError: null,
  }],
  approved: [],
  generatedAt: GENERATED,
});
assert.strictEqual(pendingOnly.hasNews, false, 'una pendiente vieja no reabre el issue');
assert.match(pendingOnly.markdown, /Detectado por primera vez: 08 nov 2026/);
assert.match(pendingOnly.markdown, /AMF/);

// ---------- fallo de extracción del propio script ----------
const crashed = buildRadarReport({
  scan: emptyScan(),
  extraction: emptyExtraction(),
  pending: [],
  approved: [],
  extractionFailed: true,
  generatedAt: GENERATED,
});
assert.strictEqual(crashed.hasNews, true);
assert.match(crashed.title, /revisar corrida del extractor/);
assert.match(crashed.markdown, /terminó con error antes de generar un reporte/);

// ---------- fallos por propuesta y cambios aprobados ----------
const withFailure = buildRadarReport({
  scan: emptyScan(),
  extraction: emptyExtraction({
    summary: { failed: 1, analyzed: 1 },
    results: [{
      festivalId: 'tuska', name: 'Tuska', sourceUrl: 'https://tuska.fi/',
      ok: false, created: false, errors: ['La respuesta del modelo está vacía.'],
    }],
  }),
  pending: [],
  approved: [{
    id: 3, festivalId: 'amf', festivalName: 'AMF', artistsCount: 8,
    reviewedAt: '2026-11-09T06:00:00.000Z', reviewedBy: 'nelson@example.com',
  }],
  generatedAt: GENERATED,
});
assert.strictEqual(withFailure.hasNews, true);
assert.match(withFailure.title, /1 fallo de extracción/);
assert.match(withFailure.markdown, /La respuesta del modelo está vacía/);
assert.match(withFailure.markdown, /Cambios aprobados en los últimos 7 días/);
assert.match(withFailure.markdown, /\*\*AMF\*\* — 8 artistas publicados/);

// ---------- errores de fuentes ----------
const sourceError = buildRadarReport({
  scan: emptyScan({
    summary: { errors: 1 },
    results: [{
      id: 'tomorrowland', name: 'Tomorrowland', error: 'HTTP 403',
      sourceUrl: 'https://www.tomorrowland.com/en/festival/faq',
    }],
  }),
  extraction: emptyExtraction(),
  pending: [],
  approved: [],
  generatedAt: GENERATED,
});
assert.match(sourceError.markdown, /Fuentes con error/);
assert.match(sourceError.markdown, /Tomorrowland/);
assert.match(sourceError.markdown, /HTTP 403/);
assert.match(sourceError.title, /fuentes con error/);

assert.strictEqual(formatDate('2026-11-09T11:45:00.000Z'), '09 nov 2026');

console.log('Todo OK: reporte semanal del radar');
