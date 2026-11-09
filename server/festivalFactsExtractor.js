'use strict';

// Extractor de datos del festival (fase 4, paso 18).
//
// El radar de lineups busca artistas. Este extractor busca otra cosa: si la
// edición del año objetivo existe y qué fechas declara la página oficial.
// Nace por Glastonbury/Mysteryland, que quedaron en `hiatus` con fechas
// desactualizadas porque el scanner solo miraba lineups.
//
// Principio: la web oficial es la fuente; el buscador, si se agrega después,
// solo sirve para descubrir qué URL mirar. El modelo no publica nada: devuelve
// datos validados para que el reporte semanal los muestre y el admin decida.

const {
  DEFAULT_MODEL, estimateCost, isValidIsoDate, sendRequest, targetYearOf,
} = require('./lineupExtractor');

const FACTS_SCHEMA_VERSION = 1;
const MAX_QUOTE_CHARS = 400;
const MAX_EVIDENCE = 5;
const MAX_UNCERTAINTY = 5;
const DEFAULT_MAX_COMPLETION_TOKENS = 2000;
const EDITION_STATUSES = ['has_edition', 'no_edition', 'unclear'];

const STRICT_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'festival_facts',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'edition_status', 'edition_year', 'dates_text', 'starts_on', 'ends_on',
        'evidence', 'confidence', 'uncertainty',
      ],
      properties: {
        edition_status: { type: 'string', enum: EDITION_STATUSES },
        edition_year: { type: ['integer', 'null'], minimum: 1990, maximum: 2100 },
        dates_text: { type: ['string', 'null'], maxLength: 200 },
        starts_on: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        ends_on: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        evidence: {
          type: 'array',
          minItems: 0,
          maxItems: MAX_EVIDENCE,
          items: { type: 'string', minLength: 1, maxLength: MAX_QUOTE_CHARS },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        uncertainty: {
          type: 'array',
          maxItems: MAX_UNCERTAINTY,
          items: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  },
};

const JSON_OBJECT_FORMAT = { type: 'json_object' };

const SYSTEM_PROMPT = `Sos un extractor de datos de festivales de música. Recibís texto de una página oficial y devolvés datos estructurados sobre UNA edición.

Reglas estrictas:
1. La única fuente es el texto de la página. No uses conocimiento previo, no busques en internet y no completes datos que no estén en el texto.
2. edition_status:
   - "has_edition" si la página confirma que hay una edición (fechas, venta de entradas, anuncio de edición).
   - "no_edition" si dice explícitamente que no hay edición ese año, que el festival descansa o vuelve más adelante.
   - "unclear" si no alcanza para decidir.
3. edition_year es el año de la edición que describe la página. Si no surge del texto, null.
4. dates_text es el texto de fechas EXACTO o casi exacto de la página ("23-27 June 2027", "27-28-29 August 2027"). Si no hay fechas, null.
5. starts_on y ends_on solo si el texto da fechas exactas y completas. Formato YYYY-MM-DD. Si solo hay mes/año o una fecha parcial, dejá ambos null.
6. evidence: entre 1 y 5 citas cortas y TEXTUALES que justifiquen edition_status y las fechas. No parafrasees.
7. confidence: número entre 0 y 1 según qué tan inequívoco es el texto.
8. uncertainty: dudas concretas y breves.
9. Devolvé únicamente el JSON del esquema. Sin markdown, sin explicaciones.

Forma exacta:
{"edition_status":"has_edition|no_edition|unclear","edition_year":2027,"dates_text":"23-27 June 2027","starts_on":"2027-06-23","ends_on":"2027-06-27","evidence":["texto textual"],"confidence":0.9,"uncertainty":["duda"]}`;

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildFactsPrompt({ festival = {}, page = {}, maxExcerptChars = 12000 } = {}) {
  const targetYear = targetYearOf(festival);
  const text = truncate(page.text || '', maxExcerptChars);
  const context = [
    `Festival: ${festival.name || festival.id}`,
    `Año objetivo del catálogo: ${targetYear || 'desconocido'}`,
    `Fechas actuales del catálogo: ${festival.dates || 'sin datos'}`,
    `Estado actual del catálogo: ${festival.lineupStatus || festival.lineup_status || 'desconocido'}`,
    `URL de la página: ${page.url || ''}`,
    page.title ? `Título de la página: ${page.title}` : null,
  ].filter(Boolean);

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...context,
        '',
        '--- TEXTO DE LA PÁGINA OFICIAL ---',
        text || '(vacío)',
        '--- FIN DEL TEXTO ---',
      ].join('\n'),
    },
  ];
}

function validateFacts(raw, { festival = {} } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['La extracción no es un objeto.'], warnings, facts: null };
  }

  const editionStatus = raw.edition_status;
  if (!EDITION_STATUSES.includes(editionStatus)) {
    fail(`edition_status inválido: ${JSON.stringify(editionStatus)}.`);
  }

  const editionYear = raw.edition_year == null ? null : Number(raw.edition_year);
  if (editionYear !== null && (!Number.isInteger(editionYear) || editionYear < 1990 || editionYear > 2100)) {
    fail(`edition_year inválido: ${JSON.stringify(raw.edition_year)}.`);
  }

  const datesText = raw.dates_text == null ? null : truncate(String(raw.dates_text).trim(), 200) || null;
  const startsOn = raw.starts_on == null ? null : String(raw.starts_on);
  const endsOn = raw.ends_on == null ? null : String(raw.ends_on);
  if (startsOn !== null && !isValidIsoDate(startsOn)) fail(`starts_on inválido: ${JSON.stringify(raw.starts_on)}.`);
  if (endsOn !== null && !isValidIsoDate(endsOn)) fail(`ends_on inválido: ${JSON.stringify(raw.ends_on)}.`);
  if (startsOn && endsOn && startsOn > endsOn) fail('starts_on es posterior a ends_on.');
  if ((startsOn && !endsOn) || (!startsOn && endsOn)) {
    warnings.push('La página dio una fecha parcial; no se usarán starts_on/ends_on.');
  }

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, MAX_EVIDENCE)
    .map((item) => truncate(item.trim(), MAX_QUOTE_CHARS));
  if (editionStatus !== 'unclear' && evidence.length === 0) {
    fail('Sin evidencia textual para afirmar si hay o no edición.');
  }

  const confidence = typeof raw.confidence === 'number' ? raw.confidence : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail(`confidence inválida: ${JSON.stringify(raw.confidence)}.`);
  }

  const uncertainty = (Array.isArray(raw.uncertainty) ? raw.uncertainty : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, MAX_UNCERTAINTY)
    .map((item) => truncate(item.trim(), 300));

  const targetYear = targetYearOf(festival);
  const matchesTarget = editionYear === null || targetYear === null ? null : editionYear === targetYear;
  if (matchesTarget === false) {
    warnings.push(`La página describe la edición ${editionYear} y el catálogo apunta a ${targetYear}.`);
  }

  let suggestion = null;
  if (editionStatus === 'no_edition') {
    suggestion = {
      lineupStatus: 'hiatus',
      reason: `La página oficial indica que no hay edición${editionYear ? ` en ${editionYear}` : ''}.`,
    };
  } else if (editionStatus === 'has_edition' && matchesTarget === true) {
    suggestion = {
      lineupStatus: 'unannounced',
      datesText,
      startsOn: startsOn && endsOn ? startsOn : null,
      endsOn: startsOn && endsOn ? endsOn : null,
      reason: 'La edición existe; el lineup todavía puede estar sin anunciar.',
    };
  } else if (editionStatus === 'has_edition' && matchesTarget === false) {
    suggestion = {
      lineupStatus: null,
      reason: `La página describe ${editionYear}, no el año objetivo ${targetYear}.`,
    };
  }

  if (errors.length) {
    return { ok: false, errors, warnings, facts: null };
  }

  return {
    ok: true,
    errors,
    warnings,
    facts: {
      editionStatus,
      editionYear,
      datesText,
      startsOn: startsOn && endsOn ? startsOn : null,
      endsOn: startsOn && endsOn ? endsOn : null,
      targetYear,
      matchesTarget,
      suggestion,
      evidence,
      confidence,
      uncertainty,
    },
  };
}

async function requestFacts({
  apiKey, model = DEFAULT_MODEL, messages, fetchImpl = globalThis.fetch,
  timeoutMs = 60000, maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
} = {}) {
  if (!apiKey) throw new Error('Falta OPENROUTER_API_KEY en el entorno.');
  if (typeof fetchImpl !== 'function') throw new Error('No hay fetch disponible en este runtime.');

  const body = {
    model,
    messages,
    temperature: 0,
    max_completion_tokens: maxCompletionTokens,
    response_format: STRICT_FORMAT,
  };
  try {
    return { ...(await sendRequest({ apiKey, fetchImpl, body, timeoutMs })), format: 'json_schema' };
  } catch (error) {
    const unsupported = error && error.status === 400
      && /response_format|json_schema|structured/i.test(error.message);
    if (!unsupported) throw error;
    return {
      ...(await sendRequest({
        apiKey, fetchImpl, timeoutMs, body: { ...body, response_format: JSON_OBJECT_FORMAT },
      })),
      format: 'json_object',
    };
  }
}

module.exports = {
  DEFAULT_MAX_COMPLETION_TOKENS,
  EDITION_STATUSES,
  FACTS_SCHEMA_VERSION,
  MAX_EVIDENCE,
  SYSTEM_PROMPT,
  buildFactsPrompt,
  estimateCost,
  requestFacts,
  validateFacts,
};
