-- Estado operativo del radar de lineups, separado del catálogo.
--
-- Una fila por festival con fuente configurada. No se expone en
-- rowToFestival(): el frontend no necesita saber cuándo se revisó una fuente.
-- `last_processed_hash` queda para la fase 3 (extractor con IA): indica qué
-- versión del contenido ya fue analizada. El hash `last_seen_hash` solo dice
-- qué se vio en el último chequeo.
--
-- `next_check_at = NULL` significa "en pausa" (por ejemplo hiatus). El scanner
-- lo saltea salvo que se lo fuerce explícitamente.
--
-- `consecutive_failures` alimenta el backoff progresivo del CLI; se resetea a 0
-- en el primer chequeo exitoso.
--
-- Igual que 004: RLS sin políticas y sin privilegios para anon/authenticated,
-- porque el navegador nunca consulta esta tabla directamente.
BEGIN;

CREATE TABLE IF NOT EXISTS public.festival_source_checks (
  festival_id         TEXT PRIMARY KEY REFERENCES public.festivals(id) ON DELETE CASCADE,
  last_checked_at     TIMESTAMPTZ,
  next_check_at       TIMESTAMPTZ,
  last_seen_hash      TEXT,
  last_processed_hash TEXT,
  etag                TEXT,
  last_modified       TEXT,
  last_http_status    INTEGER,
  last_error          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS festival_source_checks_next_check_idx
  ON public.festival_source_checks (next_check_at);

ALTER TABLE public.festival_source_checks ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.festival_source_checks FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'festival_source_checks'
  ) THEN
    RAISE EXCEPTION 'No se creó festival_source_checks';
  END IF;
END $$;

COMMIT;
