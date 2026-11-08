'use strict';

// Política de cadencia del radar de lineups. Función pura, sin DB ni red: así
// se puede testear y también reutilizar desde el scanner de fase 3.
//
// Reglas (acordadas en agent-plan/plan.md, paso 12):
// - Temporada activa (la edición todavía no terminó o terminó hace <= 7 días):
//   revisar cada 7 días.
// - Fuera de temporada o sin fechas estructuradas: cada 30 días.
// - Hiatus: en pausa (`nextCheckAt = null`), se saltea salvo --force.
// - Fallos consecutivos: backoff 1, 2, 4 y 7 días (tope).
// - `Retry-After` del servidor manda sobre el backoff si es mayor.

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CADENCE_DAYS = 7;
const OFF_SEASON_CADENCE_DAYS = 30;
const ACTIVE_GRACE_DAYS = 7;
const FAILURE_BACKOFF_DAYS = [1, 2, 4, 7];

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnly ? new Date(`${text}T00:00:00Z`) : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDate(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Fecha de referencia inválida');
  return parsed;
}

// Devuelve la próxima fecha de chequeo sugerida y el motivo, para poder
// explicarlo en el reporte y en la tabla de estado.
function nextCheckAt({
  now = new Date(),
  startsOn = null,
  endsOn = null,
  lineupStatus = null,
  consecutiveFailures = 0,
  retryAfterMs = null,
} = {}) {
  const nowDate = toDate(now);

  if (lineupStatus === 'hiatus') {
    return { at: null, cadenceDays: null, paused: true, reason: 'hiatus' };
  }

  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return {
      at: new Date(nowDate.getTime() + retryAfterMs),
      cadenceDays: null,
      paused: false,
      reason: 'retry_after',
    };
  }

  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  if (failures > 0) {
    const days = FAILURE_BACKOFF_DAYS[Math.min(failures - 1, FAILURE_BACKOFF_DAYS.length - 1)];
    return {
      at: new Date(nowDate.getTime() + days * DAY_MS),
      cadenceDays: days,
      paused: false,
      reason: 'backoff',
    };
  }

  const end = parseDate(endsOn);
  const start = parseDate(startsOn);
  const running = end ? end.getTime() >= nowDate.getTime() - ACTIVE_GRACE_DAYS * DAY_MS : false;
  const startingSoon = start
    ? start.getTime() >= nowDate.getTime() && start.getTime() - nowDate.getTime() <= 45 * DAY_MS
    : false;
  const active = running || startingSoon;
  const days = active ? ACTIVE_CADENCE_DAYS : OFF_SEASON_CADENCE_DAYS;

  return {
    at: new Date(nowDate.getTime() + days * DAY_MS),
    cadenceDays: days,
    paused: false,
    reason: active ? 'active_season' : 'off_season',
  };
}

// Nunca chequeada = due. `nextCheckAt` null = en pausa (no due).
function isCheckDue(state, now = new Date()) {
  if (!state) return true;
  if (!state.nextCheckAt) return false;
  const at = parseDate(state.nextCheckAt);
  if (!at) return true;
  return at.getTime() <= toDate(now).getTime();
}

module.exports = {
  ACTIVE_CADENCE_DAYS,
  ACTIVE_GRACE_DAYS,
  DAY_MS,
  FAILURE_BACKOFF_DAYS,
  OFF_SEASON_CADENCE_DAYS,
  isCheckDue,
  nextCheckAt,
  parseDate,
};
