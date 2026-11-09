'use strict';

// Extractor con IA del radar de lineups (fase 4, paso 14).
//
// Toma una observación (el extracto de texto que el scanner guardó cuando
// cambió una fuente oficial) y le pide a un modelo un JSON con la grilla
// propuesta. **No escribe en la base y no publica nada**: devuelve datos
// validados para que `scripts/lineup-extract.js` decida qué persistir y para
// que el panel admin (paso 15) decida qué aprobar.
//
// Principio de diseño: el modelo es un lector, no una fuente de verdad.
// - Solo puede copiar nombres que estén en el texto; el prompt lo exige y el
//   validador descarta contradicciones (por ejemplo "unannounced" con artistas).
// - La normalización (acentos, duplicados, espacios) la hace este archivo.
// - Todo lo que no encaja en el esquema se rechaza con un error explícito; una
//   propuesta inválida se guarda como fallo visible y nunca se publica.

const { MAX_EXCERPT_CHARS, normalizeForMatch } = require('./lineupHtml');

const EXTRACTION_SCHEMA_VERSION = 1;
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ARTISTS = 300;
const MAX_EVIDENCE = 5;
const MAX_UNCERTAINTY = 5;
const MAX_QUOTE_CHARS = 400;
const DEFAULT_MAX_COMPLETION_TOKENS = 8000;
// Umbral para el panel admin: por debajo, la propuesta se muestra pero no se
// ofrece para aprobación rápida. No bloquea nada por sí solo.
const MIN_CONFIDENCE_FOR_REVIEW = 0.6;

// Precio en USD por token de `deepseek/deepseek-v4.1-flash-1017` en OpenRouter
// (consultado el 08/11/2026). Es solo para estimar el costo en el reporte: si
// el modelo cambia, se actualiza acá y el cálculo sigue siendo aproximado.
const PRICING_PER_TOKEN = {
  prompt: 0.000000006,
  completion: 0.0000005,
  cacheRead: 0.000000005,
};

const LINEUP_STATUSES = ['confirmed', 'partial', 'unannounced'];
const TICKET_STATUSES = ['on_sale', 'presale', 'sold_out', 'coming_soon', 'not_mentioned'];

// Esquema que se manda como `response_format` (JSON Schema strict). El modelo
// no puede devolver texto libre: o cumple esto o la API rechaza la respuesta.
function proposalJsonSchema() {
  const isoDate = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'lineup_status', 'artists', 'dates_text', 'lineup_announcement',
      'tickets', 'page_edition_year', 'evidence', 'confidence', 'uncertainty',
    ],
    properties: {
      lineup_status: { type: 'string', enum: LINEUP_STATUSES },
      artists: {
        type: 'array',
        maxItems: MAX_ARTISTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'day'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            day: isoDate,
          },
        },
      },
      dates_text: { type: ['string', 'null'], maxLength: 200 },
      lineup_announcement: {
        type: 'object',
        additionalProperties: false,
        required: ['announced_at', 'quote'],
        properties: {
          announced_at: isoDate,
          quote: { type: ['string', 'null'], maxLength: MAX_QUOTE_CHARS },
        },
      },
      tickets: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'on_sale_at', 'quote'],
        properties: {
          status: { type: 'string', enum: TICKET_STATUSES },
          on_sale_at: isoDate,
          quote: { type: ['string', 'null'], maxLength: MAX_QUOTE_CHARS },
        },
      },
      page_edition_year: { type: ['integer', 'null'], minimum: 1990, maximum: 2100 },
      evidence: {
        type: 'array',
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
  };
}

const SYSTEM_PROMPT = `Sos un extractor de grillas de festivales de música. Recibís el texto visible de una página oficial y devolvés una propuesta estructurada.

Reglas estrictas:
1. Copiá los nombres de artistas EXACTAMENTE como aparecen en el texto. No traduzcas, no corrijas la ortografía, no completes nombres y nunca agregues artistas que conozcas de memoria pero que no estén en el texto.
2. Si el texto no lista artistas (por ejemplo "próximamente", "lineup coming soon", "stay tuned"), devolvé lineup_status "unannounced" y artists [].
3. Usá "partial" si el texto indica que el cartel no está cerrado ("primera ola", "fase 1", "más artistas por confirmar", "más nombres pronto"). Usá "confirmed" solo si la página presenta la grilla como completa.
4. El campo "day" (YYYY-MM-DD) solo se completa si el texto asocia explícitamente ese artista a una fecha. Si no, null. No deduzcas el día por posición en la lista.
5. lineup_announcement.announced_at solo si el texto declara cuándo se anuncia la grilla (por ejemplo "el lineup se anuncia el 5 de noviembre"). Si no, null. "quote" es la frase textual que lo dice.
6. tickets describe solo lo que dice el texto sobre entradas. Si no menciona entradas, status "not_mentioned", on_sale_at null y quote null. No interpretes "próximamente" como venta activa.
7. page_edition_year es el año de la edición que muestra la página, si surge del texto o del título. Si no es claro, null.
8. evidence: entre 1 y 5 citas cortas y TEXTUALES que justifiquen el estado y los artistas. No parafrasees.
9. confidence: número entre 0 y 1 según qué tan inequívoco es el texto.
10. uncertainty: dudas concretas y breves (por ejemplo "el cartel parece de la edición anterior").
11. Devolvé únicamente el JSON del esquema. Sin markdown, sin explicaciones, sin comentarios.

Forma exacta de la respuesta (todas las claves son obligatorias):
{"lineup_status":"confirmed|partial|unannounced","artists":[{"name":"texto","day":"YYYY-MM-DD o null"}],"dates_text":"texto o null","lineup_announcement":{"announced_at":"YYYY-MM-DD o null","quote":"texto o null"},"tickets":{"status":"on_sale|presale|sold_out|coming_soon|not_mentioned","on_sale_at":"YYYY-MM-DD o null","quote":"texto o null"},"page_edition_year":2027,"evidence":["cita textual"],"confidence":0.9,"uncertainty":["duda"]}`;

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cleanArtistName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/^[\s•·*|]+/, '')
    .replace(/[\s,;•·|]+$/, '')
    .trim()
    .slice(0, 200);
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Año de la edición del catálogo: las fechas estructuradas mandan; si faltan,
// se busca un año de 4 dígitos en el texto libre de `dates`.
function targetYearOf(festival = {}) {
  const startsOn = festival.startsOn || festival.starts_on || null;
  if (startsOn) {
    const year = Number(String(startsOn).slice(0, 4));
    if (Number.isInteger(year) && year > 1990) return year;
  }
  const match = String(festival.dates || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function buildPrompt({ festival, observation, maxExcerptChars = MAX_EXCERPT_CHARS }) {
  const lineup = Array.isArray(festival.lineup) ? festival.lineup : [];
  const targetYear = targetYearOf(festival);
  const sample = lineup.slice(0, 15).join(', ');
  const excerpt = truncate(observation.excerpt || '', maxExcerptChars);
  const context = [
    `Festival: ${festival.name || festival.id}`,
    festival.city || festival.country ? `Ubicación: ${[festival.city, festival.country].filter(Boolean).join(', ')}` : null,
    `Edición del catálogo: ${targetYear || 'año desconocido'}${festival.dates ? ` (${festival.dates})` : ''}`,
    `Estado actual en el catálogo: ${festival.lineupStatus || festival.lineup_status || 'desconocido'}`,
    `Artistas ya guardados en el catálogo: ${lineup.length}${sample ? ` (${sample}${lineup.length > 15 ? ', …' : ''})` : ''}`,
    `URL de la fuente: ${observation.sourceUrl || observation.source_url || ''}`,
    observation.title ? `Título de la página: ${observation.title}` : null,
  ].filter(Boolean);

  const userContent = [
    ...context,
    '',
    '--- TEXTO VISIBLE DE LA PÁGINA ---',
    excerpt || '(vacío)',
    '--- FIN DEL TEXTO ---',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

function stripFences(content) {
  return String(content)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

// Convierte la respuesta cruda de OpenRouter en la extracción. Falla fuerte y
// con un mensaje corto: el CLI lo guarda como `extraction_error`.
function parseCompletion(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  if (!choice) throw new Error('La respuesta del modelo no trae choices.');
  if (choice.finish_reason === 'length') {
    throw new Error('La respuesta se cortó por el límite de tokens.');
  }
  if (choice.finish_reason === 'content_filter') {
    throw new Error('El proveedor filtró la respuesta.');
  }
  const message = choice.message || {};
  if (message.refusal) throw new Error(`El modelo rechazó la extracción: ${truncate(message.refusal, 200)}`);
  let content = message.content;
  if (Array.isArray(content)) content = content.map((part) => (part && part.text) || '').join('');
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('La respuesta del modelo está vacía.');
  }
  let extraction;
  try {
    extraction = JSON.parse(stripFences(content));
  } catch {
    throw new Error('El contenido devuelto no es JSON válido.');
  }
  return {
    extraction,
    usage: body.usage || null,
    model: body.model || null,
    finishReason: choice.finish_reason || null,
  };
}

// Valida la extracción contra el contrato que espera la DB. Devuelve
// `{ ok, errors, warnings, proposal }`; con `ok === false` no se persiste una
// propuesta utilizable, solo el fallo.
function validateExtraction(raw, { festival = {}, observation = {} } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (message) => { errors.push(message); };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['La extracción no es un objeto.'], warnings, proposal: null };
  }

  const lineupStatus = raw.lineup_status;
  if (!LINEUP_STATUSES.includes(lineupStatus)) {
    fail(`lineup_status inválido: ${JSON.stringify(lineupStatus)}.`);
  }

  const rawArtists = Array.isArray(raw.artists) ? raw.artists : null;
  if (!rawArtists) fail('artists debe ser un array.');
  if (rawArtists && rawArtists.length > MAX_ARTISTS) {
    fail(`artists supera el máximo de ${MAX_ARTISTS} nombres (${rawArtists.length}).`);
  }

  const artists = [];
  const seen = new Set();
  let duplicates = 0;
  let discarded = 0;
  for (const entry of rawArtists || []) {
    if (!entry || typeof entry !== 'object') { discarded += 1; continue; }
    const name = cleanArtistName(entry.name);
    if (!name) { discarded += 1; continue; }
    const day = entry.day ?? null;
    if (day !== null && !isValidIsoDate(day)) {
      fail(`Fecha inválida para "${name}": ${JSON.stringify(day)}.`);
      continue;
    }
    const key = normalizeForMatch(name);
    if (!key) { discarded += 1; continue; }
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    artists.push({ name, day });
  }
  if (duplicates) warnings.push(`${duplicates} artistas duplicados descartados.`);
  if (discarded) warnings.push(`${discarded} entradas de artistas vacías descartadas.`);

  // Contradicciones que no se pueden publicar ni revisar con sentido.
  if (lineupStatus === 'unannounced' && artists.length > 0) {
    fail('lineup_status "unannounced" con artistas: el modelo se contradice.');
  }
  if ((lineupStatus === 'confirmed' || lineupStatus === 'partial') && artists.length === 0) {
    fail(`lineup_status "${lineupStatus}" sin artistas: propuesta vacía.`);
  }

  const datesText = raw.dates_text == null ? null : truncate(String(raw.dates_text).trim(), 200) || null;

  const announcement = raw.lineup_announcement && typeof raw.lineup_announcement === 'object'
    ? raw.lineup_announcement : {};
  const announcedAt = announcement.announced_at ?? null;
  if (announcedAt !== null && !isValidIsoDate(announcedAt)) {
    fail(`lineup_announcement.announced_at inválido: ${JSON.stringify(announcedAt)}.`);
  }
  const announcementQuote = announcement.quote == null
    ? null : truncate(String(announcement.quote).trim(), MAX_QUOTE_CHARS) || null;

  const tickets = raw.tickets && typeof raw.tickets === 'object' ? raw.tickets : {};
  const ticketStatus = tickets.status ?? 'not_mentioned';
  if (!TICKET_STATUSES.includes(ticketStatus)) {
    fail(`tickets.status inválido: ${JSON.stringify(ticketStatus)}.`);
  }
  const ticketsOnSaleAt = tickets.on_sale_at ?? null;
  if (ticketsOnSaleAt !== null && !isValidIsoDate(ticketsOnSaleAt)) {
    fail(`tickets.on_sale_at inválido: ${JSON.stringify(ticketsOnSaleAt)}.`);
  }
  const ticketsQuote = tickets.quote == null
    ? null : truncate(String(tickets.quote).trim(), MAX_QUOTE_CHARS) || null;
  if (ticketStatus === 'not_mentioned' && (ticketsOnSaleAt || ticketsQuote)) {
    warnings.push('tickets.status "not_mentioned" con datos de venta: se ignoran las fechas.');
  }

  const pageEditionYear = raw.page_edition_year == null ? null : Number(raw.page_edition_year);
  if (pageEditionYear !== null && (!Number.isInteger(pageEditionYear) || pageEditionYear < 1990 || pageEditionYear > 2100)) {
    fail(`page_edition_year inválido: ${JSON.stringify(raw.page_edition_year)}.`);
  }

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, MAX_EVIDENCE)
    .map((item) => truncate(item.trim(), MAX_QUOTE_CHARS));
  if (artists.length > 0 && evidence.length === 0) {
    fail('Sin evidencia textual para una propuesta con artistas.');
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
  const editionMatchesTarget = pageEditionYear === null || targetYear === null
    ? null : pageEditionYear === targetYear;
  if (editionMatchesTarget === false) {
    warnings.push(`La página muestra la edición ${pageEditionYear} y el catálogo es ${targetYear}.`);
  }
  if (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE_FOR_REVIEW) {
    warnings.push(`Confianza baja (${confidence}).`);
  }

  if (errors.length) {
    return { ok: false, errors, warnings, proposal: null };
  }

  return {
    ok: true,
    errors,
    warnings,
    proposal: {
      lineupStatus,
      artists,
      datesText,
      lineupAnnouncement: { announcedAt, quote: announcementQuote },
      tickets: {
        status: ticketStatus,
        onSaleAt: ticketStatus === 'not_mentioned' ? null : ticketsOnSaleAt,
        quote: ticketStatus === 'not_mentioned' ? null : ticketsQuote,
      },
      pageEditionYear,
      editionMatchesTarget,
      targetYear,
      evidence,
      confidence,
      uncertainty,
      observationId: observation.id ?? null,
    },
  };
}

function estimateCost(usage) {
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) || 0;
  const billablePrompt = Math.max(prompt - cached, 0);
  const cost = billablePrompt * PRICING_PER_TOKEN.prompt
    + cached * PRICING_PER_TOKEN.cacheRead
    + completion * PRICING_PER_TOKEN.completion;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    totalTokens: prompt + completion,
    costUsd: Number(cost.toFixed(6)),
  };
}

// Llamada a OpenRouter. `fetchImpl` es inyectable para testear sin red.
//
// El formato preferido es `json_schema` con `strict: true`: la API rechaza la
// respuesta si no cumple el esquema. Si el proveedor no lo soporta (400
// mencionando response_format/structured), se reintenta una vez con
// `json_object`; el esquema también está escrito en el system prompt para que
// el modelo sepa qué forma devolver en ese caso. La validación de código es la
// misma en los dos caminos: nunca se confía en el formato para validar.
const STRICT_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'lineup_proposal', strict: true, schema: proposalJsonSchema() },
};
const JSON_OBJECT_FORMAT = { type: 'json_object' };

async function sendRequest({ apiKey, fetchImpl, body, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Festival Match Radar',
        'HTTP-Referer': 'https://festivalmatch.vercel.app',
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenRouter respondió ${response.status}: ${truncate(text, 300)}`);
      error.status = response.status;
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw new Error('OpenRouter devolvió una respuesta que no es JSON.');
    }
    return parseCompletion(parsed);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`OpenRouter no respondió en ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestProposal({
  apiKey, model = DEFAULT_MODEL, messages, fetchImpl = globalThis.fetch,
  timeoutMs = 120000, maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
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
    const result = await sendRequest({ apiKey, fetchImpl, body, timeoutMs });
    return { ...result, format: 'json_schema' };
  } catch (error) {
    const unsupported = error && error.status === 400
      && /response_format|json_schema|structured/i.test(error.message);
    if (!unsupported) throw error;
    const result = await sendRequest({
      apiKey, fetchImpl, timeoutMs, body: { ...body, response_format: JSON_OBJECT_FORMAT },
    });
    return { ...result, format: 'json_object' };
  }
}

// Arma la fila que va a `lineup_proposals`. Se separa de la persistencia para
// poder testear el mapeo sin base de datos.
function buildProposalRecord({ festival, observation, proposal, model, schemaVersion = EXTRACTION_SCHEMA_VERSION, error = null }) {
  if (error) {
    return {
      festivalId: festival.id,
      observationId: observation.id ?? null,
      sourceUrl: observation.sourceUrl || observation.source_url || '',
      seenHash: observation.seenHash || observation.seen_hash || '',
      hashVersion: observation.hashVersion || observation.hash_version || 0,
      model,
      schemaVersion,
      lineupStatus: null,
      artistsCount: 0,
      confidence: null,
      payload: {},
      extractionError: truncate(error, 500),
    };
  }
  return {
    festivalId: festival.id,
    observationId: observation.id ?? null,
    sourceUrl: observation.sourceUrl || observation.source_url || '',
    seenHash: observation.seenHash || observation.seen_hash || '',
    hashVersion: observation.hashVersion || observation.hash_version || 0,
    model,
    schemaVersion,
    lineupStatus: proposal.lineupStatus,
    artistsCount: proposal.artists.length,
    confidence: proposal.confidence,
    payload: proposal,
    extractionError: null,
  };
}

module.exports = {
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_MODEL,
  EXTRACTION_SCHEMA_VERSION,
  LINEUP_STATUSES,
  MAX_ARTISTS,
  MIN_CONFIDENCE_FOR_REVIEW,
  OPENROUTER_URL,
  PRICING_PER_TOKEN,
  SYSTEM_PROMPT,
  TICKET_STATUSES,
  buildPrompt,
  buildProposalRecord,
  cleanArtistName,
  estimateCost,
  isValidIsoDate,
  parseCompletion,
  proposalJsonSchema,
  requestProposal,
  targetYearOf,
  validateExtraction,
};
