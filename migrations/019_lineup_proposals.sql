-- Propuestas de lineup extraídas con IA (fase 4, paso 14).
--
-- Una fila por observación analizada. `lineup_source_observations` guarda el
-- cambio detectado (hash + extracto); esta tabla guarda lo que el modelo
-- propone a partir de ese extracto. **Nada de acá se publica solo**: el
-- catálogo (`festivals`) no se toca hasta que un admin apruebe la propuesta
-- en el paso 15.
--
-- Decisiones de schema:
-- - `payload JSONB` guarda la propuesta completa (artistas, fechas, aviso de
--   anuncio, tickets, evidencia, confianza, incertidumbre). Los campos de
--   tickets y fecha de anuncio NO existen en `festivals` y no se van a exponer
--   en `rowToFestival()`: son información de revisión, no contrato del frontend.
-- - `lineup_status`, `artists_count` y `confidence` salen del payload a
--   columnas propias porque son las que se filtran y ordenan en el panel admin.
-- - `model` + `schema_version` quedan registrados para poder auditar qué
--   versión del extractor produjo cada propuesta y comparar modelos.
-- - `extraction_error` no nulo significa "el modelo falló o devolvió algo
--   inválido". La fila existe para que el fallo sea visible; nunca publica.
--   El reintento es explícito (`--retry-failed`), no automático, para no
--   gastar tokens en una fuente rota en cada corrida.
-- - Único por (festival_id, seen_hash): la misma versión del contenido no se
--   propone dos veces, aunque el scanner vuelva a detectarla.
-- - `review_status` arranca en 'pending'. 'superseded' marca una propuesta
--   vieja cuando aparece otra más nueva del mismo festival.
--
-- Igual que 004, 017 y 018: RLS sin políticas y sin privilegios para
-- anon/authenticated, porque el navegador nunca consulta esta tabla.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lineup_proposals (
  id               BIGSERIAL PRIMARY KEY,
  festival_id      TEXT NOT NULL REFERENCES public.festivals(id) ON DELETE CASCADE,
  observation_id   BIGINT REFERENCES public.lineup_source_observations(id) ON DELETE SET NULL,
  source_url       TEXT NOT NULL,
  seen_hash        TEXT NOT NULL,
  hash_version     INTEGER NOT NULL,
  model            TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  lineup_status    TEXT CHECK (lineup_status IS NULL OR lineup_status IN ('confirmed', 'partial', 'unannounced')),
  artists_count    INTEGER NOT NULL DEFAULT 0 CHECK (artists_count >= 0),
  confidence       NUMERIC(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  payload          JSONB NOT NULL,
  extraction_error TEXT,
  review_status    TEXT NOT NULL DEFAULT 'pending'
                     CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded')),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      TEXT,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (festival_id, seen_hash),
  -- Una fila es o una propuesta usable, o un fallo visible. Nunca las dos
  -- cosas a medias: el panel admin necesita distinguirlas sin interpretar.
  CONSTRAINT lineup_proposals_outcome_check CHECK (
    (extraction_error IS NULL AND lineup_status IS NOT NULL)
    OR (extraction_error IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS lineup_proposals_pending_idx
  ON public.lineup_proposals (first_seen_at DESC)
  WHERE review_status = 'pending';

CREATE INDEX IF NOT EXISTS lineup_proposals_festival_idx
  ON public.lineup_proposals (festival_id, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS lineup_proposals_observation_idx
  ON public.lineup_proposals (observation_id);

ALTER TABLE public.lineup_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.lineup_proposals FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lineup_proposals_id_seq FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'lineup_proposals'
  ) THEN
    RAISE EXCEPTION 'No se creó lineup_proposals';
  END IF;
END $$;

COMMIT;
