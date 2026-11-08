-- Refinar dos fuentes detectadas durante la inspección del HTML:
-- Tomorrowland homepage destaca Brasil, mientras el catálogo sigue Bélgica 2027.
-- Mad Cool /line-up todavía sirve el cartel 2026, y el catálogo sigue 2027.
-- Cambios condicionales para preservar ediciones manuales del admin.
BEGIN;

UPDATE public.festivals
   SET lineup_source_url = 'https://faq.tomorrowland.com/hc/en-us/articles/4402621418132-Where-and-when-will-Tomorrowland-Belgium-2027-take-place'
 WHERE id = 'tomorrowland'
   AND lineup_source_url = 'https://www.tomorrowland.com';

UPDATE public.festivals
   SET lineup_source_url = 'https://madcoolfestival.es/noticias'
 WHERE id = 'mad-cool'
   AND lineup_source_url = 'https://www.madcoolfestival.es/line-up/';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.festivals
     WHERE id IN ('tomorrowland', 'mad-cool') AND lineup_source_url IS NULL
  ) THEN
    RAISE EXCEPTION 'Falta fuente oficial para Tomorrowland o Mad Cool';
  END IF;
END $$;

COMMIT;
