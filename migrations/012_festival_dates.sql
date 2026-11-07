-- =============================================================================
-- Migracion 012: fechas estructuradas del catalogo
-- =============================================================================
--
-- QUE HACE
--
-- Agrega starts_on y ends_on (DATE) a la tabla festivales y las completa a
-- partir del texto de `dates`. Son DERIVADAS: `dates` sigue siendo la fuente
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
-- Cobertura: 38 de 63 festivales tienen fecha parseable.
-- Los otros 25 quedan en NULL y el rollover los saltea.
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
-- Backfill: fechas derivadas de `dates`
-- =============================================================================

UPDATE festivals SET starts_on = '2027-06-03', ends_on = '2027-06-05'
 WHERE id = 'primavera-sound';  -- 3-5 Junio 2027
UPDATE festivals SET starts_on = '2027-06-04', ends_on = '2027-06-06'
 WHERE id = 'rock-am-ring';  -- 4-6 Junio 2027
UPDATE festivals SET starts_on = '2027-08-10', ends_on = '2027-08-14'
 WHERE id = 'sziget';  -- 10-14 Agosto 2027
UPDATE festivals SET starts_on = '2027-06-26', ends_on = '2027-07-03'
 WHERE id = 'roskilde';  -- 26 Junio - 3 Julio 2027
UPDATE festivals SET starts_on = '2027-08-20', ends_on = '2027-08-22'
 WHERE id = 'lowlands';  -- 20-22 Agosto 2027
UPDATE festivals SET starts_on = '2027-07-08', ends_on = '2027-07-10'
 WHERE id = 'nos-alive';  -- 8-10 Julio 2027
UPDATE festivals SET starts_on = '2027-08-13', ends_on = '2027-08-15'
 WHERE id = 'flow-festival';  -- 13-15 Agosto 2027
UPDATE festivals SET starts_on = '2027-07-01', ends_on = '2027-07-04'
 WHERE id = 'rock-werchter';  -- 1-4 Julio 2027
UPDATE festivals SET starts_on = '2027-06-30', ends_on = '2027-07-03'
 WHERE id = 'open-er';  -- 30 Junio - 3 Julio 2027
UPDATE festivals SET starts_on = '2027-07-02', ends_on = '2027-07-04'
 WHERE id = 'tuska';  -- 2-4 Julio 2027
UPDATE festivals SET starts_on = '2026-10-24', ends_on = '2026-10-24'
 WHERE id = 'amf';  -- 24 Octubre 2026
UPDATE festivals SET starts_on = '2026-10-02', ends_on = '2026-10-11'
 WHERE id = 'austin-city-limits';  -- 2-4 & 9-11 Octubre 2026
UPDATE festivals SET starts_on = '2027-05-14', ends_on = '2027-05-23'
 WHERE id = 'edc-las-vegas';  -- 14-16 & 21-23 Mayo 2027
UPDATE festivals SET starts_on = '2027-02-06', ends_on = '2027-02-07'
 WHERE id = 'cosquin-rock';  -- 6-7 Febrero 2027
UPDATE festivals SET starts_on = '2027-04-16', ends_on = '2027-04-18'
 WHERE id = 'quilmes-rock';  -- 16-18 Abril 2027
UPDATE festivals SET starts_on = '2026-11-28', ends_on = '2026-11-29'
 WHERE id = 'primavera-sound-buenos-aires';  -- 28-29 Noviembre 2026
UPDATE festivals SET starts_on = '2026-11-14', ends_on = '2026-11-14'
 WHERE id = 'creamfields-argentina';  -- 14 Noviembre 2026
UPDATE festivals SET starts_on = '2026-10-24', ends_on = '2026-10-24'
 WHERE id = 'festival-bandera';  -- 24 Octubre 2026
UPDATE festivals SET starts_on = '2027-03-12', ends_on = '2027-03-14'
 WHERE id = 'lollapalooza-argentina';  -- 12-14 Marzo 2027
UPDATE festivals SET starts_on = '2027-03-12', ends_on = '2027-03-14'
 WHERE id = 'lollapalooza-chile';  -- 12-14 Marzo 2027
UPDATE festivals SET starts_on = '2027-03-19', ends_on = '2027-03-21'
 WHERE id = 'lollapalooza-brasil';  -- 19-21 Marzo 2027
UPDATE festivals SET starts_on = '2027-03-13', ends_on = '2027-03-14'
 WHERE id = 'vive-latino';  -- 13-14 Marzo 2027
UPDATE festivals SET starts_on = '2026-11-20', ends_on = '2026-11-22'
 WHERE id = 'corona-capital';  -- 20-22 Noviembre 2026
UPDATE festivals SET starts_on = '2027-03-26', ends_on = '2027-03-28'
 WHERE id = 'ultra-miami';  -- 26-28 Marzo 2027
UPDATE festivals SET starts_on = '2027-04-02', ends_on = '2027-04-03'
 WHERE id = 'ultra-buenos-aires';  -- 2-3 Abril 2027
UPDATE festivals SET starts_on = '2027-07-09', ends_on = '2027-07-11'
 WHERE id = 'ultra-europe';  -- 9-11 Julio 2027
UPDATE festivals SET starts_on = '2027-06-04', ends_on = '2027-06-06'
 WHERE id = 'rock-im-park';  -- 4-6 Junio 2027
UPDATE festivals SET starts_on = '2027-08-26', ends_on = '2027-08-29'
 WHERE id = 'reading-festival';  -- 26-29 Agosto 2027
UPDATE festivals SET starts_on = '2027-08-26', ends_on = '2027-08-29'
 WHERE id = 'leeds-festival';  -- 26-29 Agosto 2027
UPDATE festivals SET starts_on = '2027-08-19', ends_on = '2027-08-22'
 WHERE id = 'pukkelpop';  -- 19-22 Agosto 2027
UPDATE festivals SET starts_on = '2027-06-18', ends_on = '2027-06-20'
 WHERE id = 'hurricane-festival';  -- 18-20 Junio 2027
UPDATE festivals SET starts_on = '2027-06-18', ends_on = '2027-06-20'
 WHERE id = 'southside-festival';  -- 18-20 Junio 2027
UPDATE festivals SET starts_on = '2027-07-01', ends_on = '2027-07-03'
 WHERE id = 'provinssi';  -- 1-3 Julio 2027
UPDATE festivals SET starts_on = '2027-07-16', ends_on = '2027-07-18'
 WHERE id = 'ilosaarirock';  -- 16-18 Julio 2027
UPDATE festivals SET starts_on = '2027-06-23', ends_on = '2027-06-26'
 WHERE id = 'nummirock';  -- 23-26 Junio 2027
UPDATE festivals SET starts_on = '2027-05-13', ends_on = '2027-05-15'
 WHERE id = 'steelfest';  -- 13-15 Mayo 2027
UPDATE festivals SET starts_on = '2027-06-18', ends_on = '2027-06-19'
 WHERE id = 'helsinki-city-festival';  -- 18-19 Junio 2027
UPDATE festivals SET starts_on = '2027-07-15', ends_on = '2027-07-17'
 WHERE id = 'pori-jazz';  -- 15-17 Julio 2027

-- =============================================================================
-- Sin fecha parseable: quedan NULL (25)
-- =============================================================================
--
-- No es un error: son festivales que todavia no anunciaron fechas o que estan
-- en hiatus. El rollover solo mira ends_on, asi que no los toca.
--
--   tomorrowland: 2027 (fecha por anunciar)
--   mad-cool: 2027 (fecha por anunciar)
--   lollapalooza-berlin: 2027 (fecha por anunciar)
--   sonar: 2027 (fecha por anunciar)
--   sea-star: 2027 (fecha por anunciar)
--   glastonbury: 2027 (confirmado)
--   mysteryland: 2027 (confirmado)
--   coachella: 2027 (fecha por anunciar)
--   lollapalooza-chicago: 2027 (fecha por anunciar)
--   bonnaroo: 2027 (sin edición)
--   rock-in-rio: 2028 (fecha por anunciar)
--   estereo-picnic: 2027 (fecha por anunciar)
--   weekend-festival: 2027 (fecha por anunciar)
--   festival-buena-vibra: 2027 (fecha por anunciar)
--   exit-festival: 2027 (fecha por anunciar)
--   nos-primavera-sound-porto: 2027 (fecha por anunciar)
--   awakenings-festival: 2027 (fecha por anunciar)
--   parookaville: 2027 (fecha por anunciar)
--   sonus-festival: 2027 (fecha por anunciar)
--   dekmantel-festival: 2027 (fecha por anunciar)
--   time-warp: 2027 (fecha por anunciar)
--   boomtown-fair: 2027 (fecha por anunciar)
--   ruisrock: 2027 (fecha por anunciar)
--   blockfest: 2027 (fecha por anunciar)
--   rock-in-seine: 2027 (fecha por anunciar)

COMMIT;
