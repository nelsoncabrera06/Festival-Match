'use strict';

// Normalización de nombres al aprobar una propuesta de lineup (fase 4, paso 15).
//
// El extractor copia los nombres EXACTAMENTE como están en la página oficial.
// Eso es correcto para no inventar, pero una grilla suele traer marcas de
// formato que no son parte del nombre del artista:
//
//   - "Bicep (live)"            -> "Bicep"
//   - "Peggy Gou - DJ set"      -> "Peggy Gou"
//   - "Charlotte de Witte b2b Rødhåd"
//                               -> "Charlotte de Witte", "Rødhåd"
//
// La limpieza se hace recién al publicar y no en el extractor: la propuesta
// conserva el texto original como evidencia, y el admin puede editar la lista
// antes de aprobar. Es deliberadamente conservadora: solo saca sufijos de
// formato al final del nombre y separa colaboraciones `b2b`. No corrige
// ortografía, no traduce y no toca nombres que son únicamente "Live".

const { normalizeForMatch } = require('./lineupHtml');

// Sufijos de formato que no aportan identidad al artista. Se exige que haya
// algo antes del sufijo para no convertir "Live" (nombre propio) en "".
const SUFFIX_PATTERNS = [
  /\s*[-–—]\s*(?:live|dj\s*set|b2b)\s*$/i,
  /\s*\(\s*(?:live|dj\s*set|b2b)\s*\)\s*$/i,
  /\s*\[\s*(?:live|dj\s*set|b2b)\s*\]\s*$/i,
  /\s+(?:live|dj\s*set|b2b)\s*$/i,
];

// Separa "A b2b B" en dos artistas. `back to back` es la forma larga y también
// aparece en carteles. No se separa "B2B" cuando es parte de un nombre sin
// espacios alrededor (por ejemplo una marca), solo como token independiente.
const B2B_SPLIT = /\s+\b(?:b2b|back[-\s]?to[-\s]?back)\b\s+/i;

function cleanArtistName(value) {
  let name = String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();

  // Puede haber más de un sufijo pegado: "A b2b B (live)". Se repite hasta que
  // no quede ninguno, con un tope por seguridad.
  for (let i = 0; i < 4; i += 1) {
    const before = name;
    for (const pattern of SUFFIX_PATTERNS) {
      name = name.replace(pattern, '').trim();
    }
    if (name === before) break;
  }

  return name;
}

// Devuelve la lista que se publica en `festivals.lineup`: limpia, separa b2b y
// elimina duplicados sin distinguir acentos ni mayúsculas.
function prepareArtists(artists) {
  const result = [];
  const seen = new Set();

  for (const entry of Array.isArray(artists) ? artists : []) {
    const raw = typeof entry === 'string' ? entry : entry && entry.name;
    if (typeof raw !== 'string') continue;

    for (const part of raw.split(B2B_SPLIT)) {
      const name = cleanArtistName(part);
      if (!name) continue;

      const key = normalizeForMatch(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
  }

  return result;
}

module.exports = {
  B2B_SPLIT,
  SUFFIX_PATTERNS,
  cleanArtistName,
  prepareArtists,
};
