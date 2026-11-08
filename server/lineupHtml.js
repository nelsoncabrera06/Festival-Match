'use strict';

const crypto = require('crypto');

const ENTITY_MAP = {
  amp: '&', apos: "'", copy: '©', gt: '>', hellip: '…', lt: '<', mdash: '—',
  nbsp: ' ', ndash: '–', quot: '"', reg: '®', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', trade: '™',
};

function decodeEntity(entity) {
  if (entity[0] !== '#') return ENTITY_MAP[entity.toLowerCase()] ?? `&${entity};`;
  const hex = entity[1]?.toLowerCase() === 'x';
  const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return `&${entity};`;
  try { return String.fromCodePoint(code); } catch { return `&${entity};`; }
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (_, entity) => decodeEntity(entity));
}

function htmlToVisibleText(html) {
  return decodeHtmlEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<br\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|tr|td|th|main)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .normalize('NFC')
    .replace(/[\t\r\f\v ]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractTitle(html) {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match ? htmlToVisibleText(match[1]).replace(/\s+/g, ' ').slice(0, 240) : '';
}

// Normaliza para comparar nombres de artistas contra el texto visible: sin
// acentos, minúsculas, "&" como "and" y todo lo no alfanumérico como espacio.
// Permite "Björk" = "bjork" y "AC/DC" = "ac dc".
function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Mide cuántos artistas del lineup guardado en la DB aparecen textualmente en la
// página. Es la señal objetiva para separar candidatos reales de falsos positivos
// del triage léxico: una página con "Line up" y cero artistas no sirve todavía.
function findLineupHits(visibleText, lineup) {
  const haystack = ` ${normalizeForMatch(visibleText)} `;
  const names = [...new Set((Array.isArray(lineup) ? lineup : [])
    .map((name) => String(name ?? '').trim()).filter(Boolean))];
  const hits = [];
  const missing = [];
  for (const name of names) {
    const needle = normalizeForMatch(name);
    if (!needle) continue;
    if (haystack.includes(` ${needle} `)) hits.push(name);
    else missing.push(name);
  }
  return {
    total: names.length,
    matched: hits.length,
    ratio: names.length ? Number((hits.length / names.length).toFixed(3)) : null,
    hits,
    missing,
  };
}

function analyzeHtml(html) {
  return analyzeVisibleText(htmlToVisibleText(html), extractTitle(html));
}

// Corrige el triage léxico con evidencia dura: cuántos artistas del catálogo
// aparecen en el texto. Un triage que dice "candidato" con 0/N artistas es un
// falso positivo (contenido por JavaScript, edición equivocada o página de
// aviso); una página sin palabras clave pero con artistas visibles es un falso
// negativo. Solo se aplica cuando hay lineup en el catálogo para comparar.
function refineTriageWithLineup(analysis, hits) {
  if (!hits || !hits.total || analysis.announcementOnly) return analysis;
  if (hits.matched === 0) return { ...analysis, triage: 'lineup_not_in_html' };
  if (hits.matched >= 3 && hits.ratio >= 0.2) return { ...analysis, triage: 'candidate_html' };
  return analysis;
}

// Separado de analyzeHtml para que un llamador que ya extrajo el texto visible
// (por ejemplo el sweep, que también compara artistas) no lo procese dos veces.
function analyzeVisibleText(visibleText, title = '') {
  const lowerText = visibleText.toLocaleLowerCase('en');
  const signals = [
    ['lineup', /\bline[ -]?up\b/],
    ['artists', /\bartists?\b/],
    ['artistas', /\bartistas?\b/],
    ['programme', /\bprogram(?:me|a)\b/],
    ['cartel', /\bcartel(?:a)?\b/],
    ['grilla', /\bgrilla\b/],
    ['acts', /\bacts?\b/],
    ['anuncio', /\b(?:announced|anunciad[oa]s?)\b/],
  ].filter(([, pattern]) => pattern.test(lowerText)).map(([name]) => name);
  const announcementOnly = /(?:line[ -]?up|artists?|artistas?|cartel|grilla)[\s\S]{0,100}(?:will be announced|announced later|to be announced|later this year|anunciar[aá]n|se anunciar[aá]|más adelante|próximamente)|(?:will be announced|announced later|to be announced|later this year|anunciar[aá]n|se anunciar[aá]|más adelante|próximamente)[\s\S]{0,100}(?:line[ -]?up|artists?|artistas?|cartel|grilla)/i.test(visibleText);
  let triage = 'generic_or_social';
  if (visibleText.length < 300) triage = 'possibly_js_or_blocked';
  else if (announcementOnly) triage = 'announcement_only';
  else if (signals.includes('lineup') && (signals.includes('artists') || signals.includes('artistas') || signals.includes('grilla') || signals.includes('cartel'))) {
    triage = 'candidate_html';
  } else if (signals.length) triage = 'needs_review';
  return {
    title,
    visibleTextLength: visibleText.length,
    visibleTextHash: crypto.createHash('sha256').update(`${title.normalize('NFC')}\n${visibleText}`).digest('hex'),
    lineupSignals: signals,
    announcementOnly,
    triage,
  };
}

module.exports = {
  analyzeHtml, analyzeVisibleText, decodeHtmlEntities, extractTitle, findLineupHits,
  htmlToVisibleText, normalizeForMatch, refineTriageWithLineup,
};
