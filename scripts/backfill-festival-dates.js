/**
 * Genera migrations/012_festival_dates.sql a partir de server/festivals.json.
 *
 * Por que se genera y no se escribe a mano: las fechas se derivan del texto de
 * `dates` con server/dateRange.js, el mismo parser que usa la app. Escribir 38
 * UPDATEs a mano seria una segunda implementacion del formato, y la primera vez
 * que una de las dos se equivoque la migracion y el runtime van a discrepar.
 *
 * Uso:
 *   node scripts/backfill-festival-dates.js
 *   node scripts/backfill-festival-dates.js --check   # solo verifica que este al dia
 *
 * El .sql se commitea y se aplica con psql (ver AGENTS.md).
 */

const fs = require('fs');
const path = require('path');
const { parseDateRange } = require(path.join(__dirname, '..', 'server', 'dateRange.js'));

const FESTIVALS_JSON = path.join(__dirname, '..', 'server', 'festivals.json');
const OUTPUT_SQL = path.join(__dirname, '..', 'migrations', '012_festival_dates.sql');

function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function generate(festivals) {
  const conFecha = [];
  const sinFecha = [];

  for (const f of festivals) {
    const rango = parseDateRange(f.dates);
    if (rango.endsOn) conFecha.push({ id: f.id, dates: f.dates, ...rango });
    else sinFecha.push({ id: f.id, dates: f.dates });
  }

  const updates = conFecha.map(
    (f) =>
      `UPDATE festivals SET starts_on = ${sqlText(f.startsOn)}, ends_on = ${sqlText(f.endsOn)}\n` +
      ` WHERE id = ${sqlText(f.id)};  -- ${f.dates}`
  );

  const sinFechaComment = sinFecha
    .map((f) => `--   ${f.id}: ${f.dates}`)
    .join('\n');

  return `-- =============================================================================
-- Migracion 012: fechas estructuradas del catalogo
-- =============================================================================
--
-- QUE HACE
--
-- Agrega starts_on y ends_on (DATE) a la tabla festivales y las completa a
-- partir del texto de \`dates\`. Son DERIVADAS: \`dates\` sigue siendo la fuente
-- de verdad y la que se muestra en la app. Estas dos columnas existen para que
-- el rollover pueda saber si una edicion ya termino sin parsear texto en SQL.
--
-- No toca ninguna otra columna: ni lineup, ni lineup_status, ni dates.
--
-- POR QUE NO SE EXPONEN EN LA API
--
-- rowToFestival() no las devuelve a proposito.
-- scripts/verify-festivals-roundtrip.js hace deep-equal de todos los objetos de
-- la DB contra festivals.json, y sumar claves nuevas rompe ese contrato. Si
-- algun dia el panel las necesita, se exponen ahi y se ajusta el test.
--
-- ES DE UNA SOLA VIA
--
-- El bloque DO aborta si ya hay filas con fechas cargadas. Re-aplicarla pisaria
-- correcciones hechas desde el panel admin y desharia el rollover, que deja
-- ambas columnas en NULL a proposito para la edicion siguiente.
--
-- GENERADO por scripts/backfill-festival-dates.js desde server/festivals.json.
-- No editar a mano: se regenera.
--
-- Cobertura: ${conFecha.length} de ${festivals.length} festivales tienen fecha parseable.
-- Los otros ${sinFecha.length} quedan en NULL y el rollover los saltea.
--
-- =============================================================================

BEGIN;

ALTER TABLE festivals ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE festivals ADD COLUMN IF NOT EXISTS ends_on   DATE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM festivals WHERE starts_on IS NOT NULL OR ends_on IS NOT NULL) THEN
    RAISE EXCEPTION '012 ya aplicada: hay filas con starts_on/ends_on. No re-aplicar.';
  END IF;
END $$;

-- =============================================================================
-- Backfill: fechas derivadas de \`dates\`
-- =============================================================================

${updates.join('\n')}

-- =============================================================================
-- Sin fecha parseable: quedan NULL (${sinFecha.length})
-- =============================================================================
--
-- No es un error: son festivales que todavia no anunciaron fechas o que estan
-- en hiatus. El rollover solo mira ends_on, asi que no los toca.
--
${sinFechaComment}

COMMIT;
`;
}

function main() {
  const festivals = JSON.parse(fs.readFileSync(FESTIVALS_JSON, 'utf8'));
  const sql = generate(festivals);

  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT_SQL)) {
      console.error('Falta migrations/012_festival_dates.sql. Correlo sin --check.');
      process.exit(1);
    }
    if (fs.readFileSync(OUTPUT_SQL, 'utf8') !== sql) {
      console.error('migrations/012_festival_dates.sql esta desactualizado respecto de festivals.json.');
      console.error('Corré: node scripts/backfill-festival-dates.js');
      process.exit(1);
    }
    console.log('012_festival_dates.sql esta al dia con festivals.json');
    return;
  }

  fs.writeFileSync(OUTPUT_SQL, sql, 'utf8');
  const conFecha = festivals.filter((f) => parseDateRange(f.dates).endsOn).length;
  console.log(
    `migrations/012_festival_dates.sql generado: ${conFecha} de ${festivals.length} festivales con fecha.`
  );
}

main();
