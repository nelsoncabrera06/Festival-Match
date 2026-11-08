-- Corregir la candidata de Sónar: el host production-portal.sonar.es no
-- coincide con el certificado TLS que presenta el servidor. La URL oficial
-- canónica sonar.es/en publica el lineup de la edición actual.
-- Condicional para preservar cualquier cambio manual hecho desde el admin.
BEGIN;

UPDATE public.festivals
   SET lineup_source_url = 'https://sonar.es/en'
 WHERE id = 'sonar'
   AND lineup_source_url = 'https://production-portal.sonar.es/en/programme/line-up';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.festivals
     WHERE id = 'sonar' AND lineup_source_url IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'No existe fuente lineup_source_url para sonar';
  END IF;
END $$;

COMMIT;
