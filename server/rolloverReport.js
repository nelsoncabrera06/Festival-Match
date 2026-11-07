'use strict';

// Reporte del radar de lineups.
//
// Lo comparten el CLI (scripts/lineup-rollover.js), el boton del panel admin y
// el workflow semanal, para que Nelson vea exactamente el mismo texto en el dry
// run, en el modal y en el issue de GitHub.
//
// El reporte se arma desde la DB y no solo desde las acciones de la corrida: si
// el proceso se cae a mitad de camino, lo que se alcance a imprimir sigue
// mostrando el estado real del catalogo.
//
// No hay IA ni llamadas de red aca. Todo sale de SQL.

const db = require('./db');

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_DE_HOY = /^\d{4}-\d{2}-\d{2}$/;

// Fecha "de hoy" en UTC, que es el mismo reloj que usa CURRENT_DATE en Supabase.
// El cron corre a las 11:17 UTC, lejos de la medianoche, y el dry run acepta
// --today para no depender del reloj de la maquina.
function hoyUtc() {
  return new Date().toISOString().slice(0, 10);
}

function formatearFecha(iso) {
  const [anio, mes, dia] = iso.split('-').map(Number);
  return `${dia} ${MESES_CORTOS[mes - 1]} ${anio}`;
}

function diasEntre(desdeIso, hastaIso) {
  const a = Date.UTC(...desdeIso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const b = Date.UTC(...hastaIso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((b - a) / 86400000);
}

function enDias(n) {
  if (n === 0) return 'hoy';
  if (n === 1) return 'en 1 día';
  return `en ${n} días`;
}

function plural(n, singular, plural_) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

// Agrupa los textos de fecha que no se pudieron parsear, para no listar 25 ids.
function agruparSinFecha(rows) {
  const cuenta = new Map();
  for (const row of rows) cuenta.set(row.dates, (cuenta.get(row.dates) || 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
}

function renderReport(data) {
  const {
    today, apply, candidatos, errores, proximos, atencion, sinFecha, stats, festivalId,
  } = data;

  const lines = [];
  lines.push(`# Radar de lineups — ${today}`);
  lines.push('');

  if (candidatos.length === 0 && errores.length === 0 && atencion.length === 0) {
    lines.push(
      festivalId
        ? `Sin novedades para \`${festivalId}\`: no terminó su edición, no hubo errores y no hay nada que revisar.`
        : 'Sin novedades: ningún festival terminó, no hubo errores y no hay nada que revisar.'
    );
    lines.push('');
  }

  const tituloRotados = apply ? 'Rotados' : 'Candidatos a rotar';
  lines.push(`## ${tituloRotados} (${candidatos.length})`);
  if (candidatos.length === 0) {
    // Con --festival=id el reporte se limita a uno. Si no aparece, hay que
    // decirlo: "Ninguno" a secas se confunde con "no terminó ninguno".
    if (festivalId) {
      lines.push(`- Filtro \`--festival=${festivalId}\`: no está vencido, está en hiatus o ya fue rotado.`);
    } else {
      lines.push('- Ninguno.');
    }
  } else {
    if (!apply) lines.push('- Dry run: no se aplicó nada. Para rotar: botón del panel o `--apply`.');
    for (const f of candidatos) {
      const anioEdicion = f.endsOn.slice(0, 4);
      const destino = apply ? 'pasa a' : 'pasaría a';
      lines.push(
        `- **${f.name}** — edición ${anioEdicion} (${f.dates}) ${destino} ${f.nextYear || Number(anioEdicion) + 1}, ` +
        `lineup sin anunciar (${plural(f.artistCount, 'artista', 'artistas')} en el cartel anterior).`
      );
    }
  }
  lines.push('');

  if (errores.length > 0) {
    lines.push(`## Errores (${errores.length})`);
    for (const e of errores) lines.push(`- **${e.name}** (${e.id}) — ${e.error}`);
    lines.push('');
  }

  lines.push(`## Terminan pronto (${proximos.length})`);
  if (proximos.length === 0) {
    lines.push('- Ninguno en los próximos 30 días.');
  } else {
    for (const f of proximos) {
      const dias = diasEntre(today, f.endsOn);
      lines.push(`- **${f.name}** — ${f.dates} (${enDias(dias)})`);
    }
  }
  lines.push('');

  // Solo se muestra si hay algo: un heading vacío todas las semanas es ruido.
  if (atencion.length > 0) {
    lines.push(`## Requieren atención (${atencion.length})`);
    for (const a of atencion) {
      lines.push(`- **${a.name}** — ${a.motivo}`);
    }
    lines.push('');
  }

  lines.push(`## Datos incompletos (${sinFecha.length})`);
  if (sinFecha.length === 0) {
    lines.push('- Todos los festivales tienen fecha parseable.');
  } else {
    lines.push(`- ${plural(sinFecha.length, 'festival', 'festivales')} sin fecha parseable:`);
    for (const [texto, n] of agruparSinFecha(sinFecha)) {
      lines.push(`  - ${n} «${texto}»`);
    }
    lines.push('  Informativo: el rollover los saltea y no se inventa ninguna fecha.');
  }
  lines.push('');

  lines.push('## Estado del catálogo');
  lines.push(`- ${plural(stats.total, 'festival', 'festivales')}`);
  lines.push(`- ${stats.conLineup} con lineup publicado`);
  lines.push(`- ${stats.unannounced} sin anunciar`);
  lines.push(`- ${stats.partial} parcial`);
  lines.push(`- ${stats.confirmed} confirmado`);
  lines.push(`- ${stats.hiatus} en hiatus`);
  lines.push('');

  return lines.join('\n');
}

// Junta el estado, rota si corresponde y devuelve el Markdown.
//
// `apply: false` (default) no escribe nada. El default seguro importa: este
// modulo se usa tambien desde el endpoint del admin y desde el dry run local,
// que apuntan a la base de produccion.
async function buildRolloverReport(options = {}) {
  const apply = options.apply === true;
  const today = options.today || hoyUtc();
  const festivalId = options.festivalId || null;
  if (!DIAS_DE_HOY.test(today)) {
    throw new Error(`Fecha inválida: ${today}. Se espera YYYY-MM-DD.`);
  }

  const candidatosDb = festivalId
    ? (await db.getFestivalsEndedBefore(today)).filter((f) => f.id === festivalId)
    : await db.getFestivalsEndedBefore(today);

  const rotados = [];
  const errores = [];

  if (apply) {
    for (const f of candidatosDb) {
      try {
        const nextYear = Number(f.endsOn.slice(0, 4)) + 1;
        const actualizado = await db.rolloverFestival(f.id, nextYear);
        // null = alguien lo rotó entre el SELECT y el UPDATE. No es un error:
        // el WHERE del UPDATE lo hizo idempotente.
        if (actualizado) rotados.push({ ...f, nextYear });
      } catch (err) {
        errores.push({ id: f.id, name: f.name, error: err.message });
      }
    }
  }

  // Las filas se leen DESPUES de rotar, para que el estado del catalogo sea el
  // real al momento del reporte.
  const rows = await db.getFestivalsReportRows();

  const candidatos = apply ? rotados : candidatosDb;

  const proximos = rows
    .filter((f) => f.endsOn && f.endsOn >= today && diasEntre(today, f.endsOn) <= 30)
    .filter((f) => f.lineupStatus !== 'hiatus')
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn));

  const anioActual = Number(today.slice(0, 4));
  const atencion = [];

  for (const f of rows) {
    if (f.lineupStatus === 'hiatus' && f.endsOn && f.endsOn < today) {
      atencion.push({
        name: f.name,
        motivo: `terminó el ${formatearFecha(f.endsOn)} pero está en hiatus: no se rota. Confirmar si vuelve.`,
      });
      continue;
    }
    // Guard de datos: un texto de fecha con un año que ya pasó y sin fecha
    // parseable significa que el catalogo quedó atrasado en ese festival.
    const anioEnTexto = (f.dates.match(/\b(19|20)\d{2}\b/) || [])[0];
    if (!f.endsOn && anioEnTexto && Number(anioEnTexto) < anioActual) {
      atencion.push({
        name: f.name,
        motivo: `las fechas dicen «${f.dates}», un año que ya pasó, y no se pudieron parsear.`,
      });
    }
  }

  const sinFecha = rows.filter((f) => !f.endsOn);

  const stats = {
    total: rows.length,
    conLineup: rows.filter((f) => f.artistCount > 0).length,
    confirmed: rows.filter((f) => f.lineupStatus === 'confirmed').length,
    partial: rows.filter((f) => f.lineupStatus === 'partial').length,
    unannounced: rows.filter((f) => f.lineupStatus === 'unannounced').length,
    hiatus: rows.filter((f) => f.lineupStatus === 'hiatus').length,
  };

  // Un issue por "termina en 30 días" seria cuatro avisos por cada festival.
  // El aviso se dispara cuando hay algo que pasó o que hay que revisar; los
  // que terminan pronto igual aparecen en el cuerpo y en el step summary.
  const hasNews = candidatos.length > 0 || errores.length > 0 || atencion.length > 0;

  const markdown = renderReport({
    today, apply, candidatos, errores, proximos, atencion, sinFecha, stats, festivalId,
  });

  return {
    markdown,
    hasNews,
    today,
    apply,
    festivalId,
    counts: {
      candidatos: candidatos.length,
      rotados: rotados.length,
      errores: errores.length,
      proximos: proximos.length,
      atencion: atencion.length,
      sinFecha: sinFecha.length,
    },
    candidatos,
    rotados,
    errores,
    atencion,
  };
}

module.exports = { buildRolloverReport, renderReport, hoyUtc };
