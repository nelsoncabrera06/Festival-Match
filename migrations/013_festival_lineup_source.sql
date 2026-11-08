-- Fuente oficial que consultará el radar para detectar cambios de lineup.
-- Se mantiene separada de `website` (sitio general del festival) y no se
-- expone en rowToFestival(), para preservar el contrato público del catálogo.
-- Las URLs se cargarán y mantendrán desde el panel admin tras su verificación.

ALTER TABLE public.festivals
  ADD COLUMN IF NOT EXISTS lineup_source_url TEXT;
