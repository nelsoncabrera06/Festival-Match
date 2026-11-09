-- Propuestas de datos de festival (fase 4, paso 18/19).
--
-- El radar de datos detecta fechas/estado de edición en la web oficial. Hasta
-- ahora eso solo aparecía en el issue semanal y había que corregirlo a mano.
-- Esta tabla guarda la propuesta para que el admin la confirme o rechace desde
-- el panel, igual que `lineup_proposals`.
--
-- Nada se publica solo: aprobar esta propuesta es la única vía para cambiar
-- `festivals.dates` / `festivals.lineup_status` desde el radar.
BEGIN;

CREATE TABLE IF NOT EXISTS public.festival_fact_proposals (
  id                       BIGSERIAL PRIMARY KEY,
  festival_id              TEXT NOT NULL REFERENCES public.festivals(id) ON DELETE CASCADE,
  source_url               TEXT NOT NULL,
  page_url                 TEXT,
  seen_hash                TEXT NOT NULL,
  model                    TEXT NOT NULL,
  schema_version           INTEGER NOT NULL,
  proposed_dates           TEXT,
  proposed_lineup_status   TEXT CHECK (
    proposed_lineup_status IS NULL
    OR proposed_lineup_status IN ('confirmed', 'partial', 'unannounced', 'hiatus')
  ),
  proposed_starts_on       DATE,
  proposed_ends_on         DATE,
  evidence                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence               NUMERIC(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  payload                  JSONB NOT NULL,
  review_status            TEXT NOT NULL DEFAULT 'pending'
                             CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded')),
  reviewed_at              TIMESTAMPTZ,
  reviewed_by              TEXT,
  first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (festival_id, seen_hash),
  CONSTRAINT festival_fact_proposals_has_change CHECK (
    proposed_lineup_status IS NOT NULL
    OR proposed_dates IS NOT NULL
    OR proposed_starts_on IS NOT NULL
    OR proposed_ends_on IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS festival_fact_proposals_pending_idx
  ON public.festival_fact_proposals (first_seen_at DESC)
  WHERE review_status = 'pending';

CREATE INDEX IF NOT EXISTS festival_fact_proposals_festival_idx
  ON public.festival_fact_proposals (festival_id, first_seen_at DESC);

ALTER TABLE public.festival_fact_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.festival_fact_proposals FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.festival_fact_proposals_id_seq FROM anon, authenticated;

COMMIT;
