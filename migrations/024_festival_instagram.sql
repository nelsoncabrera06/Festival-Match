-- Instagram oficial del festival (23/11/2026).
--
-- Por qué existe: hay anuncios que salen primero (o únicamente) en redes. El
-- caso concreto es Quilmes Rock 2027: el lineup se publicó en Instagram el
-- 02/11/2026 mientras la web oficial todavía dice "antes de que se devele el
-- lineup oficial". El radar no puede leer esa red (los nombres están en la
-- imagen y el CDN responde 403), así que por ahora es un enlace para el usuario,
-- no una fuente automática.
--
-- La columna queda NULL en el resto del catálogo a propósito: se llena de a uno
-- cuando se confirma la cuenta oficial de cada festival. NULL = no hay enlace y
-- la ficha no muestra nada.
--
-- ORDEN DE DESPLIEGUE: aplicar ANTES de deployar (igual que la 023). El código
-- nuevo hace `SELECT ... instagram`; al revés, el catálogo da 500. Aplicarla
-- antes es inofensivo para el código viejo, que ignora la columna.
--
-- Es incremental: agrega la columna y carga el único dato confirmado.
BEGIN;

ALTER TABLE public.festivals
  ADD COLUMN IF NOT EXISTS instagram TEXT;

-- Única cuenta cargada por ahora. Se verifica que la cuenta exista antes de
-- escribirla (instagram.com/quilmesrock responde con el perfil oficial).
UPDATE public.festivals
   SET instagram = 'https://www.instagram.com/quilmesrock/'
 WHERE id = 'quilmes-rock';

COMMIT;
