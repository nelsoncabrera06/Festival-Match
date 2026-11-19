-- Borrar las columnas de flyers del catálogo (cierre de proyecto, 19/11/2026).
--
-- `flyer` y `flyer_images` guardaban el póster de la edición, pero el catálogo
-- ya no los usa: sus valores se vaciaron el 19/11/2026 (eran posters 2026 en
-- festivales con fechas 2027) y la UI dejó de renderizar la galería. `image`
-- SE CONSERVA: es la foto de portada de las tarjetas del catálogo.
--
-- ORDEN DE DESPLIEGUE OBLIGATORIO:
--   1. Deployar primero el código que ya no menciona estas columnas.
--   2. Recién después aplicar esta migración.
-- Al revés, el código viejo en producción hace `SELECT ... flyer` y el sitio
-- queda con 500 hasta que termine el deploy.
--
-- Esta migración es incremental y no toca filas ni otras columnas.
BEGIN;

ALTER TABLE public.festivals
  DROP COLUMN IF EXISTS flyer,
  DROP COLUMN IF EXISTS flyer_images;

COMMIT;
