-- Scanner de cambios del radar (fase 3, paso 13).
--
-- `hash_version` en festival_source_checks permite cambiar el algoritmo de hash
-- sin generar una observación falsa por cada fuente: si la versión guardada no
-- coincide con la del código, la corrida se trata como línea base y solo
-- actualiza el hash. Hoy: versión 2 = texto relevante (sin nav/header/footer).
--
-- `lineup_source_observations` guarda una fila por cambio detectado. El
-- extractor con IA (paso 14) la va a consumir y marcar con `processed_at`.
-- No se publica nada desde acá: el catálogo no se toca.
--
-- Igual que 004 y 017: RLS sin políticas y sin privilegios para anon/authenticated.
BEGIN;

ALTER TABLE public.festival_source_checks
  ADD COLUMN IF NOT EXISTS hash_version INTEGER;

CREATE TABLE IF NOT EXISTS public.lineup_source_observations (
  id            BIGSERIAL PRIMARY KEY,
  festival_id   TEXT NOT NULL REFERENCES public.festivals(id) ON DELETE CASCADE,
  source_url    TEXT NOT NULL,
  previous_hash TEXT,
  seen_hash     TEXT NOT NULL,
  hash_version  INTEGER NOT NULL,
  title         TEXT,
  excerpt       TEXT,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (festival_id, seen_hash)
);

CREATE INDEX IF NOT EXISTS lineup_source_observations_pending_idx
  ON public.lineup_source_observations (festival_id, detected_at DESC)
  WHERE processed_at IS NULL;

ALTER TABLE public.lineup_source_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.lineup_source_observations FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lineup_source_observations_id_seq FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'lineup_source_observations'
  ) THEN
    RAISE EXCEPTION 'No se creó lineup_source_observations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'festival_source_checks'
       AND column_name = 'hash_version'
  ) THEN
    RAISE EXCEPTION 'No se agregó festival_source_checks.hash_version';
  END IF;
END $$;

COMMIT;
