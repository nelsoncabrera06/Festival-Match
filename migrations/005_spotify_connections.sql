-- Guarda el refresh token de Spotify cifrado y asociado al usuario Festival Match.
-- No expone esta tabla por la Data API; solo la usa el backend Express.

BEGIN;

CREATE TABLE IF NOT EXISTS public.spotify_connections (
  user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  refresh_token_encrypted TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.spotify_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.spotify_connections FROM anon, authenticated;

COMMIT;
