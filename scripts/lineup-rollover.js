#!/usr/bin/env node
'use strict';

/**
 * CLI del radar de lineups.
 *
 * Es el mismo reporte que usan el botón del panel admin y el workflow semanal
 * (server/rolloverReport.js), pero desde la terminal. Sirve para ver qué va a
 * pasar antes de que pase: el default es dry run.
 *
 * Uso:
 *   node scripts/lineup-rollover.js                          # dry run
 *   node scripts/lineup-rollover.js --apply                  # rota de verdad
 *   node scripts/lineup-rollover.js --festival=amf --apply   # solo uno
 *   node scripts/lineup-rollover.js --report-out=reporte.md  # guarda el texto
 *   node scripts/lineup-rollover.js --today=2026-11-07       # fecha de prueba
 *
 * Códigos de salida:
 *   0  todo bien (dry run con candidatos incluido)
 *   1  falló el reporte o algún rollover individual
 *   2  argumentos inválidos
 *
 * NO se puede correr desde Vercel: está pensado para localhost y para GitHub
 * Actions, que es donde vive el cron. Desde localhost escribe en la Supabase de
 * producción, así que necesita ALLOW_LOCAL_PRODUCTION_DB=true en .env.local.
 */

// Mismo orden que app.js: .env.local pisa lo que traiga .env, y dotenv no
// sobrescribe variables ya definidas. Las rutas son absolutas para que el
// script funcione sin importar desde qué directorio se invoque.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');

// db.js se protege solo: si el host es Supabase y no hay opt-in explícito,
// tira al requerirlo. Se captura para no escupir un stack trace crudo.
let db;
try {
  db = require('../server/db');
} catch (err) {
  console.error(`No se pudo inicializar la conexión a la base: ${err.message}`);
  process.exit(1);
}

const { buildRolloverReport } = require('../server/rolloverReport');

const USO = `Uso: node scripts/lineup-rollover.js [opciones]

  --dry                 imprime el reporte y no escribe nada (default)
  --apply               rota los festivales terminados
  --festival=<id>       limita el rollover a un festival
  --report-out=<ruta>   guarda el Markdown en un archivo
  --today=YYYY-MM-DD    fecha de referencia (para probar sin esperar al lunes)
  --help                muestra esta ayuda
`;

function errorDeUso(mensaje) {
  console.error(`${mensaje}\n\n${USO}`);
  process.exit(2);
}

function parsearArgumentos(argv) {
  const opciones = {
    apply: false,
    dry: false,
    festival: null,
    reportOut: null,
    today: null,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--apply') opciones.apply = true;
    else if (arg === '--dry') opciones.dry = true;
    else if (arg === '--help' || arg === '-h') opciones.help = true;
    else if (arg.startsWith('--festival=')) opciones.festival = arg.slice('--festival='.length);
    else if (arg.startsWith('--report-out=')) opciones.reportOut = arg.slice('--report-out='.length);
    else if (arg.startsWith('--today=')) opciones.today = arg.slice('--today='.length);
    else errorDeUso(`Argumento desconocido: ${arg}`);
  }

  if (opciones.apply && opciones.dry) {
    errorDeUso('--apply y --dry son excluyentes. --dry ya es el default.');
  }
  if (opciones.festival === '') errorDeUso('--festival necesita un id, por ejemplo --festival=amf.');
  if (opciones.reportOut === '') errorDeUso('--report-out necesita una ruta de archivo.');

  return opciones;
}

async function main() {
  const opciones = parsearArgumentos(process.argv.slice(2));

  if (opciones.help) {
    console.log(USO);
    return 0;
  }

  if (opciones.apply) {
    // Va a stderr para no ensuciar el Markdown de stdout (se puede pipear).
    console.error('Aplicando rollover: esto ESCRIBE en la base del catálogo.\n');
  } else {
    console.error('Dry run: no se escribe nada.\n');
  }

  let resultado;
  try {
    resultado = await buildRolloverReport({
      apply: opciones.apply,
      today: opciones.today || undefined,
      festivalId: opciones.festival || undefined,
    });
  } catch (err) {
    console.error(`No se pudo generar el reporte: ${err.message}`);
    return 1;
  }

  console.log(resultado.markdown);

  if (opciones.reportOut) {
    const destino = path.resolve(opciones.reportOut);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    // newline final: el cuerpo de un issue sin salto final se ve apretado.
    fs.writeFileSync(destino, `${resultado.markdown}\n`, 'utf8');
    console.error(`Reporte guardado en ${destino}`);
  }

  if (opciones.apply) {
    console.error(
      `Rotados: ${resultado.counts.rotados} de ${resultado.counts.candidatos} candidatos.`
    );
  }

  if (resultado.errores.length > 0) {
    console.error(`Fallaron ${resultado.errores.length} rollovers; ver la sección de errores.`);
    return 1;
  }

  return 0;
}

main()
  .then((codigo) => {
    // Cerrar el pool o el proceso queda colgado en Node 18+.
    return db.pool.end().then(() => codigo);
  })
  .then((codigo) => process.exit(codigo))
  .catch(async (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    try {
      await db.pool.end();
    } catch {
      // si el pool ya estaba cerrado, no importa
    }
    process.exit(1);
  });
