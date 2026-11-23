-- Entradas a la venta en el catálogo (23/11/2026).
--
-- Hasta ahora el estado de tickets que detecta el radar de lineups quedaba SOLO
-- dentro de `lineup_proposals.payload`: el admin lo veía al revisar la propuesta
-- y después desaparecía. Estas columnas lo publican en la ficha del festival y
-- en el panel admin, que es donde sirve.
--
-- Nada se publica solo: las escribe `approveLineupProposal` cuando el admin
-- aprueba una propuesta del radar, o el propio admin desde el formulario de
-- edición del festival. Los códigos son los mismos que usa
-- `server/lineupExtractor.js`; `tickets_status` NULL significa "sin dato" y
-- `not_mentioned` nunca se escribe (que una página deje de hablar de tickets no
-- significa que se agotaron).
--
-- ORDEN DE DESPLIEGUE OBLIGATORIO (al revés que la 022, que borraba columnas):
--   1. Aplicar PRIMERO esta migración.
--   2. Recién después deployar.
-- El código nuevo hace `SELECT ... tickets_status`: deployar sin columnas deja
-- las queries del catálogo en 500. Al revés es inofensivo, porque el código
-- viejo ignora columnas nuevas.
--
-- Es incremental: no toca filas existentes salvo el backfill documentado abajo.
BEGIN;

ALTER TABLE public.festivals
  ADD COLUMN IF NOT EXISTS tickets_status TEXT,
  ADD COLUMN IF NOT EXISTS tickets_on_sale_at DATE,
  ADD COLUMN IF NOT EXISTS tickets_updated_at TIMESTAMPTZ;

ALTER TABLE public.festivals
  DROP CONSTRAINT IF EXISTS festivals_tickets_status_check;

ALTER TABLE public.festivals
  ADD CONSTRAINT festivals_tickets_status_check
  CHECK (
    tickets_status IS NULL
    OR tickets_status IN ('on_sale', 'presale', 'sold_out', 'coming_soon')
  );

-- Backfill: las propuestas aprobadas antes de esta migración nunca escribieron
-- tickets porque la columna no existía (caso Ultra Buenos Aires, aprobada el
-- 22/11/2026). Se toma la propuesta aprobada más reciente de cada festival que
-- traiga estado de entradas. Las pendientes NO se tocan: siguen esperando la
-- aprobación humana.
UPDATE public.festivals f
   SET tickets_status = t.tickets_status,
       tickets_on_sale_at = t.tickets_on_sale_at,
       tickets_updated_at = COALESCE(t.reviewed_at, t.first_seen_at)
  FROM (
    SELECT DISTINCT ON (p.festival_id)
           p.festival_id,
           p.payload->'tickets'->>'status' AS tickets_status,
           NULLIF(p.payload->'tickets'->>'onSaleAt', '')::date AS tickets_on_sale_at,
           p.reviewed_at,
           p.first_seen_at
      FROM public.lineup_proposals p
     WHERE p.review_status = 'approved'
       AND p.payload->'tickets'->>'status' IN ('on_sale', 'presale', 'sold_out', 'coming_soon')
     ORDER BY p.festival_id, COALESCE(p.reviewed_at, p.first_seen_at) DESC, p.id DESC
  ) t
 WHERE t.festival_id = f.id;

COMMIT;
