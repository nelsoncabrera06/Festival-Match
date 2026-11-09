'use strict';

// Reporte semanal del radar de lineups (fase 4, paso 16).
//
// Junta tres fuentes que antes vivían separadas:
//   1. el barrido de fuentes (detecciones de cambios y errores HTTP),
//   2. la corrida del extractor (propuestas nuevas y fallos de extracción),
//   3. el estado actual de `lineup_proposals` (pendientes y aprobadas).
//
// El reporte se usa para el step summary del workflow y, solo cuando hay algo
// accionable, como cuerpo de un GitHub Issue. No publica lineups: la aprobación
// sigue siendo humana desde el panel admin.

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = MESES_CORTOS[date.getUTCMonth()];
  return `${day} ${month} ${date.getUTCFullYear()}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(date)} ${hours}:${minutes} UTC`;
}

function formatConfidence(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(2);
}

function sourceLink(url) {
  if (!url) return '—';
  return `[fuente](${url})`;
}

function announcementLabel(announcedAt, firstSeenAt) {
  if (announcedAt) return `Anuncio declarado: ${formatDate(announcedAt)}`;
  if (firstSeenAt) return `Detectado por primera vez: ${formatDate(firstSeenAt)}`;
  return 'Fecha de anuncio no declarada';
}

function buildRadarReport({ scan = null, extraction = null, pending = [], approved = [], extractionFailed = false, generatedAt = new Date().toISOString() } = {}) {
  const scanSummary = (scan && scan.summary) || {};
  const extractionSummary = (extraction && extraction.summary) || {};
  const detections = Array.isArray(scan && scan.observed) ? scan.observed : [];
  const sourceErrors = Array.isArray(scan && scan.results)
    ? scan.results.filter((row) => row && row.error)
    : [];
  const newProposals = Array.isArray(extraction && extraction.results)
    ? extraction.results.filter((row) => row && row.created)
    : [];
  const failedProposals = Array.isArray(extraction && extraction.results)
    ? extraction.results.filter((row) => row && !row.ok)
    : [];

  const observationsNew = scanSummary.observations?.inserted ?? detections.length;
  const created = extractionSummary.created ?? newProposals.length;
  const failed = extractionSummary.failed ?? failedProposals.length;
  const pendingCount = pending.length || extractionSummary.pendingTotal || 0;
  const extractionCrashed = Boolean(extractionFailed) && failedProposals.length === 0;
  const hasNews = created > 0 || failed > 0 || extractionCrashed;
  const quietWeek = !hasNews && sourceErrors.length === 0;

  // El workflow está en modo prueba: abre un issue todas las semanas para ver
  // el output. Por eso el título nunca queda vacío, incluso en una semana sin
  // novedades. Para volver al comportamiento normal alcanza con restaurar el
  // `if: steps.report.outputs.has_news == 'true'` en lineup-scan.yml.
  const title = created > 0
    ? `Radar de lineups — ${created} propuesta${created === 1 ? '' : 's'} nueva${created === 1 ? '' : 's'} (${formatDate(generatedAt)})`
    : failed > 0
      ? `Radar de lineups — ${failed} fallo${failed === 1 ? '' : 's'} de extracción (${formatDate(generatedAt)})`
      : extractionCrashed
        ? `Radar de lineups — revisar corrida del extractor (${formatDate(generatedAt)})`
        : sourceErrors.length > 0
          ? `Radar de lineups — fuentes con error (${formatDate(generatedAt)})`
          : `Radar de lineups — sin cambios (${formatDate(generatedAt)})`;

  const lines = [
    '# Radar de lineups — reporte semanal',
    '',
    `- **Generado:** ${formatDateTime(generatedAt)}`,
    `- **Fuentes revisadas:** ${scanSummary.checked ?? 0} de ${scanSummary.total ?? 0}`,
    `- **Saltadas por cadencia:** ${scanSummary.skipped ?? 0}`,
    `- **Sin cambios (304):** ${scanSummary.notModified ?? 0}`,
    `- **Errores de fuentes:** ${scanSummary.errors ?? sourceErrors.length}`,
    `- **Detecciones de cambio:** ${observationsNew}`,
    `- **Propuestas nuevas:** ${created}`,
    `- **Fallos de extracción:** ${failed}`,
    `- **Propuestas pendientes:** ${pendingCount}`,
    `- **Cambios aprobados (últimos 7 días):** ${approved.length}`,
    '',
  ];

  if (quietWeek) {
    lines.push('> **Sin cambios que reportar.**', '');
  }

  lines.push(
    '## Lineups anunciados / cambiados',
    '',
    '### Detecciones de cambio',
    '',
  );

  if (!detections.length) {
    lines.push('No se detectaron cambios de contenido en las fuentes revisadas.', '');
  } else {
    for (const detection of detections) {
      lines.push(`- **${detection.name || detection.id}** — detectado ${formatDateTime(detection.detectedAt)} · ${sourceLink(detection.sourceUrl)}`);
    }
    lines.push('');
  }

  lines.push('### Propuestas nuevas', '');
  if (!newProposals.length) {
    lines.push('No se generaron propuestas nuevas en esta corrida.', '');
  } else {
    for (const row of newProposals) {
      lines.push(
        `- **${row.name || row.festivalId}** — ${row.artistsCount ?? 0} artistas · ${row.status || 'sin estado'} · confianza ${formatConfidence(row.confidence)} · ${sourceLink(row.sourceUrl)}`
      );
      lines.push(`  - ${announcementLabel(row.lineupAnnouncementAt, generatedAt)}`);
      if (row.datesText) lines.push(`  - Fechas en la fuente: ${row.datesText}`);
      if (row.pageEditionYear && row.editionMatchesTarget === false) {
        lines.push(`  - ⚠ La página muestra la edición ${row.pageEditionYear}, distinta de la del catálogo.`);
      }
    }
    lines.push('');
  }

  lines.push('### Pendientes de aprobación', '');
  if (!pending.length) {
    lines.push('No hay propuestas pendientes.', '');
  } else {
    for (const row of pending) {
      const name = row.festivalName || row.festivalId;
      lines.push(
        `- **${name}** — ${row.artistsCount ?? 0} artistas · ${row.lineupStatus || 'sin estado'} · confianza ${formatConfidence(row.confidence)} · ${sourceLink(row.sourceUrl)}`
      );
      lines.push(`  - ${announcementLabel(row.announcedAt, row.firstSeenAt)}`);
      if (row.extractionError) lines.push(`  - ⚠ Error de extracción: ${row.extractionError}`);
      lines.push('  - Revisar y aprobar en el panel admin: Admin → Propuestas de lineup.');
    }
    lines.push('');
  }

  lines.push('### Cambios aprobados en los últimos 7 días', '');
  if (!approved.length) {
    lines.push('No hubo aprobaciones en la última semana.', '');
  } else {
    for (const row of approved) {
      lines.push(
        `- **${row.festivalName || row.festivalId}** — ${row.artistsCount ?? 0} artistas publicados · revisado ${formatDateTime(row.reviewedAt)}${row.reviewedBy ? ` por ${row.reviewedBy}` : ''}`
      );
    }
    lines.push('');
  }

  lines.push('### Fallos de extracción', '');
  if (!failedProposals.length && !extractionCrashed) {
    lines.push('No hubo fallos de extracción.', '');
  } else if (extractionCrashed) {
    lines.push('La corrida del extractor terminó con error antes de generar un reporte. Revisar el log del workflow.', '');
  } else {
    for (const row of failedProposals) {
      lines.push(`- **${row.name || row.festivalId}** — ${sourceLink(row.sourceUrl)}`);
      lines.push(`  - ${row.errors?.join(' ') || 'Error desconocido'}`);
    }
    lines.push('');
  }

  if (sourceErrors.length) {
    lines.push('## Fuentes con error', '');
    for (const row of sourceErrors.slice(0, 20)) {
      lines.push(`- **${row.name || row.id}** — ${row.error} · ${sourceLink(row.finalUrl || row.sourceUrl)}`);
    }
    if (sourceErrors.length > 20) lines.push(`- … y ${sourceErrors.length - 20} más.`);
    lines.push('');
  }

  lines.push(
    '## Cómo sigue',
    '',
    'Este workflow **no publica lineups**. Las propuestas se revisan en el panel admin',
    '(Admin → Propuestas de lineup) y recién ahí se actualiza el catálogo. El reporte',
    'semanal se publica como issue; cuando no hay novedades, el título lo indica.',
    ''
  );

  return {
    markdown: `${lines.join('\n')}\n`,
    hasNews,
    title,
    generatedAt,
    counts: {
      sources: scanSummary.total ?? 0,
      checked: scanSummary.checked ?? 0,
      sourceErrors: scanSummary.errors ?? sourceErrors.length,
      observations: observationsNew,
      created,
      failed,
      extractionCrashed,
      pending: pendingCount,
      approved: approved.length,
    },
  };
}

module.exports = {
  announcementLabel,
  buildRadarReport,
  formatConfidence,
  formatDate,
  formatDateTime,
  sourceLink,
};
