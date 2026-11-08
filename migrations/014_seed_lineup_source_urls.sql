-- Candidatas iniciales para el radar. Cada festival parte de su sitio oficial
-- ya registrado en `website`; las fuentes directas verificadas lo reemplazan.
-- Los sitios generales y redes sociales quedan como candidatas oficiales, no
-- como garantía de que el scanner HTTP pueda leerlos. La clasificación técnica
-- se documenta en agent-plan/lineup-sources.md y se completa antes de activar
-- cualquier lector automático.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.festivals WHERE lineup_source_url IS NOT NULL) THEN
    RAISE EXCEPTION '014 espera lineup_source_url vacía; no sobrescribir fuentes ya cargadas';
  END IF;
END $$;

-- Fallback oficial por festival para no dejar el catálogo sin URL candidata.
UPDATE public.festivals
   SET lineup_source_url = website
 WHERE NULLIF(BTRIM(website), '') IS NOT NULL;

-- Rutas oficiales específicas localizadas para lineups, programas, anuncios o
-- estado de edición. Las URLs no se copian al contrato público del festival.
WITH sources(id, url) AS (
  VALUES
    ('rock-am-ring', 'https://www.rock-am-ring.com/en/line-up'),
    ('sziget', 'https://szigetfestival.com/en/festival-info'),
    ('mad-cool', 'https://www.madcoolfestival.es/line-up/'),
    ('lollapalooza-berlin', 'https://www.lollapaloozade.com/en/lineup/'),
    ('roskilde', 'https://www.roskilde-festival.dk/program'),
    ('sonar', 'https://production-portal.sonar.es/en/programme/line-up'),
    ('lowlands', 'https://lowlands.nl/updates/'),
    ('nos-alive', 'https://nosalive.com/en/nosalive-lineup/'),
    ('flow-festival', 'https://www.flowfestival.com/en/program/music/'),
    ('rock-werchter', 'https://www.rockwerchter.be/en/line-up/a-z'),
    ('tuska', 'https://tuska.fi/en/program/lineup/'),
    ('glastonbury', 'https://www.glastonburyfestivals.co.uk/line-up/'),
    ('amf', 'https://amf-festival.com/line-up/'),
    ('coachella', 'https://coachella.com/2027-advance-sale'),
    ('lollapalooza-chicago', 'https://www.lollapalooza.com/lineup'),
    ('bonnaroo', 'https://help.bonnaroo.com/article/1270-bonnaroo-2027'),
    ('austin-city-limits', 'https://www.aclfestival.com/lineup'),
    ('cosquin-rock', 'https://cosquinrock.net/'),
    ('quilmes-rock', 'https://www.quilmesrock.com.ar/faqs'),
    ('primavera-sound-buenos-aires', 'https://www.primaverasound.com/en/buenos-aires'),
    ('lollapalooza-argentina', 'https://www.lollapaloozaar.com/informacion'),
    ('lollapalooza-chile', 'https://www.lollapaloozacl.com/'),
    ('lollapalooza-brasil', 'https://www.lollapaloozabr.com/'),
    ('rock-in-rio', 'https://rockinrio.com/rio/pt-br/informacoes/'),
    ('vive-latino', 'https://www.vivelatino.com.mx/lineup'),
    ('estereo-picnic', 'https://www.festivalestereopicnic.com/artistas'),
    ('corona-capital', 'https://www.coronacapital.com.mx/lineup'),
    ('ultra-miami', 'https://ultramusicfestival.com/lineup'),
    ('ultra-europe', 'https://ultraeurope.com/lineup/'),
    ('rock-im-park', 'https://www.rock-im-park.com/line-up'),
    ('exit-festival', 'https://www.exitfest.org/exit-2027'),
    ('pukkelpop', 'https://www.pukkelpop.be/en/'),
    ('hurricane-festival', 'https://hurricane.de/en/line-up/'),
    ('southside-festival', 'https://southside.de/en/line-up/?view=all'),
    ('awakenings-festival', 'https://www.awakenings.com/en/events/2027/07/awakenings-festival-2027/399344/'),
    ('parookaville', 'https://www.parookaville.com/en/line-up'),
    ('time-warp', 'https://www.time-warp.de/germany/mannheim/'),
    ('rock-in-seine', 'https://www.rockenseine.com/en/'),
    ('provinssi', 'https://www.provinssi.fi/en/program/'),
    ('ilosaarirock', 'https://ilosaarirock.fi/en/'),
    ('nummirock', 'https://nummirock.fi/etusivu'),
    ('steelfest', 'https://steelfest.fi/pages/steelfest-2027'),
    ('blockfest', 'https://www.blockfest.fi/en/info/'),
    ('pori-jazz', 'https://porijazz.fi/')
)
UPDATE public.festivals AS f
   SET lineup_source_url = sources.url
  FROM sources
 WHERE f.id = sources.id;

DO $$
DECLARE
  total_rows INTEGER;
  source_rows INTEGER;
BEGIN
  SELECT COUNT(*), COUNT(lineup_source_url)
    INTO total_rows, source_rows
    FROM public.festivals;
  IF total_rows <> 63 OR source_rows <> total_rows THEN
    RAISE EXCEPTION '014 esperaba 63 fuentes para 63 festivales; encontró %/%', source_rows, total_rows;
  END IF;
END $$;

COMMIT;
