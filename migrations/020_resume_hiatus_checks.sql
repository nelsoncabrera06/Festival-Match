-- Reactivar el chequeo de festivales en `hiatus` (fase 4, paso 18).
--
-- Antes, `sourceSchedule.js` devolvía `next_check_at = NULL` para hiatus y el
-- scanner los salteaba para siempre. Eso dejó a Glastonbury y Mysteryland
-- congelados con `dates = '2027 (confirmado)'` aunque ya tenían fecha.
--
-- La nueva política es cadencia larga (30 días), no pausa infinita. Esta
-- migración pone `next_check_at = NOW()` en las filas que quedaron en NULL
-- para que la próxima corrida las revise y, desde ahí, el scheduler calcule
-- la cadencia normal.
--
-- No toca `lineup_status`: sigue en `hiatus` hasta que el admin confirme que
-- hay edición y lo cambie a `unannounced`/`partial`/`confirmed`.
BEGIN;

UPDATE public.festival_source_checks c
   SET next_check_at = NOW(),
       updated_at = NOW()
  FROM public.festivals f
 WHERE f.id = c.festival_id
   AND f.lineup_status = 'hiatus'
   AND c.next_check_at IS NULL;

COMMIT;
