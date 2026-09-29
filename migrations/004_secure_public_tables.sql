-- Restringe el acceso del Data API de Supabase a las tablas de la app.
-- El navegador solo llama a Express; el backend conecta a Postgres como
-- postgres.<project-ref>, por lo que las queries del servidor siguen funcionando.
-- Sin políticas, anon/authenticated no pueden leer ni modificar estas tablas.

BEGIN;

ALTER TABLE public.festival_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.festivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tour_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_festivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.festival_suggestions,
  public.festivals,
  public.sessions,
  public.tour_cache,
  public.user_artists,
  public.user_festivals,
  public.user_genres,
  public.users
FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
FROM anon, authenticated;

COMMIT;
