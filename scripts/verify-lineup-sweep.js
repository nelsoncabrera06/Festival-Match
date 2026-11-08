#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { fetchSource, isPublicAddress, resolvePublic, validateUrl } = require('../server/lineupSourceFetcher');
const {
  analyzeHtml, extractTitle, findLineupHits, htmlToVisibleText, normalizeForMatch,
  refineTriageWithLineup,
} = require('../server/lineupHtml');
const { parseArgs } = require('./lineup-sweep');

async function main() {
  for (const address of [
    '0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.20.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1',
    'fe80::1', '::ffff:127.0.0.1', '2001:db8::1',
  ]) assert.strictEqual(isPublicAddress(address), false, `${address} debe bloquearse`);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.strictEqual(isPublicAddress(address), true, `${address} debe ser pública`);
  }
  assert.deepStrictEqual(await resolvePublic('[2606:4700:4700::1111]'), [
    { address: '2606:4700:4700::1111', family: 6 },
  ]);

  assert.throws(() => validateUrl('http://example.com'), /HTTPS/);
  assert.throws(() => validateUrl('https://user:pass@example.com'), /credenciales/);
  assert.throws(() => parseArgs(['--limit=0']), /entre 1 y 63/);
  assert.throws(() => parseArgs(['--apply']), /desconocido/);
  assert.strictEqual(parseArgs(['--dry', '--limit=2']).limit, 2);

  const repeatedCopy = '<p>Festival schedule and artist information for this edition.</p>'.repeat(8);
  const htmlA = `<html><head><title>FEP &amp; Más</title><script>const now = 1;</script></head><body><h1>Line-up</h1><p>Artists: Björk<br>Rosalía</p>${repeatedCopy}</body></html>`;
  const htmlB = `<html>\n<head><title>FEP &#38; Más</title><script>const now = 999;</script></head>\n<body><h1> Line-up </h1> <p>Artists: Björk<br/> Rosalía </p>${repeatedCopy}</body></html>`;
  const analysisA = analyzeHtml(htmlA);
  const analysisB = analyzeHtml(htmlB);
  assert.strictEqual(analysisA.title, 'FEP & Más');
  assert.strictEqual(analysisA.triage, 'candidate_html');
  assert.deepStrictEqual(analysisA.lineupSignals, ['lineup', 'artists']);
  assert.strictEqual(analysisA.visibleTextHash, analysisB.visibleTextHash, 'el hash ignora tags, espacios y scripts volátiles');
  const futureNotice = analyzeHtml(`<html><body><h1>Festival info</h1><p>Artists will be announced later this year.</p>${repeatedCopy}</body></html>`);
  assert.strictEqual(futureNotice.triage, 'announcement_only');
  assert.strictEqual(futureNotice.announcementOnly, true);

  assert.strictEqual(normalizeForMatch('Björk & Rosalía'), 'bjork and rosalia');
  const lineupHtml = '<h1>Line-up 2027</h1><p>Artists: Björk<br>ROSALÍA<br>AC/DC</p>' + repeatedCopy;
  const lineupHits = findLineupHits(htmlToVisibleText(lineupHtml), ['Björk', 'Rosalía', 'AC/DC', 'The Strokes']);
  assert.deepStrictEqual(lineupHits.hits, ['Björk', 'Rosalía', 'AC/DC']);
  assert.deepStrictEqual(lineupHits.missing, ['The Strokes']);
  assert.strictEqual(lineupHits.total, 4);
  assert.strictEqual(lineupHits.ratio, 0.75);
  // "Muse" no debe coincidir con la palabra "museo" ni dentro de otro nombre.
  assert.strictEqual(findLineupHits('Visita el museo del festival', ['Muse']).matched, 0);
  assert.strictEqual(findLineupHits('Muse en vivo', ['Muse']).matched, 1);
  // Sin lineup en el catálogo no se inventa cobertura.
  assert.strictEqual(findLineupHits('cualquier texto', []).ratio, null);

  // El triage se corrige con evidencia: 0/N artistas y palabras clave es falso positivo,
  // artistas visibles sin palabras clave es falso negativo.
  const keywordOnly = analyzeHtml('<h1>Line-up</h1><p>Artists</p>' + repeatedCopy);
  assert.strictEqual(keywordOnly.triage, 'candidate_html');
  assert.strictEqual(refineTriageWithLineup(keywordOnly, findLineupHits('sin nombres', ['A', 'B', 'C'])).triage, 'lineup_not_in_html');
  const noKeywords = analyzeHtml('<h1>Programa</h1><p>Björk, Rosalía y AC/DC</p>' + repeatedCopy);
  assert.notStrictEqual(noKeywords.triage, 'candidate_html');
  assert.strictEqual(refineTriageWithLineup(noKeywords, findLineupHits('Björk, Rosalía y AC/DC', ['Björk', 'Rosalía', 'AC/DC'])).triage, 'candidate_html');
  // Un aviso de "se anunciará más adelante" nunca se convierte en candidato.
  assert.strictEqual(refineTriageWithLineup(futureNotice, findLineupHits('sin nombres', ['A', 'B', 'C'])).triage, 'announcement_only');
  // Sin lineup en el catálogo se respeta el triage léxico.
  assert.strictEqual(refineTriageWithLineup(keywordOnly, findLineupHits('x', [])).triage, keywordOnly.triage);
  assert.strictEqual(extractTitle('<html><head><title> FEP &amp; Más </title></head></html>'), 'FEP & Más');

  // Requests condicionales: si hay ETag/Last-Modified se envían, y un 304 no
  // descarga cuerpo ni produce hash nuevo.
  let conditionalHeaders = null;
  const notModified = await fetchSource('https://source.example/lineup', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    etag: '"v1"',
    lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    request: async (_url, _addresses, _timeout, _maxBytes, headers) => {
      conditionalHeaders = headers;
      return { status: 304, headers: {}, body: Buffer.alloc(0) };
    },
  });
  assert.strictEqual(conditionalHeaders['if-none-match'], '"v1"');
  assert.strictEqual(conditionalHeaders['if-modified-since'], 'Wed, 21 Oct 2026 07:28:00 GMT');
  assert.strictEqual(notModified.notModified, true);
  assert.strictEqual(notModified.status, 304);
  assert.strictEqual(notModified.hash, null);
  assert.strictEqual(notModified.bytes, 0);

  // Errores HTTP: status y Retry-After quedan disponibles para el scheduler.
  const rateLimited = await fetchSource('https://source.example/lineup', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ status: 429, headers: { 'retry-after': '120' }, body: Buffer.alloc(0) }),
  }).then(() => null, (error) => error);
  assert.strictEqual(rateLimited.status, 429);
  assert.strictEqual(rateLimited.retryAfterMs, 120000);

  let requested = 0;
  const result = await fetchSource('https://source.example/lineup', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => {
      requested += 1;
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' },
        body: Buffer.from('<h1>Lineup</h1>'),
      };
    },
  });
  assert.strictEqual(requested, 1);
  assert.strictEqual(result.contentType, 'text/html');
  assert.strictEqual(result.etag, '"v1"');
  assert.strictEqual(result.hash, crypto.createHash('sha256').update('<h1>Lineup</h1>').digest('hex'));

  let redirectLookup = 0;
  await assert.rejects(fetchSource('https://source.example/', {
    resolve: async (host) => {
      redirectLookup += 1;
      return [{ address: host === 'source.example' ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    },
    request: async () => ({ status: 302, headers: { location: 'https://internal.example/' }, body: Buffer.alloc(0) }),
  }), /no pública/);
  assert.strictEqual(redirectLookup, 2, 'cada redirect debe volver a validar DNS');

  await assert.rejects(fetchSource('https://source.example/', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('x') }),
  }), /Content-Type no permitido/);

  console.log('OK: lineup sweep valida destinos, redirecciones, tipos de contenido, hash y CLI.');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
