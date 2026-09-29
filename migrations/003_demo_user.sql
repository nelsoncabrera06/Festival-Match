-- Perfil compartido de solo lectura para el modo demo. No tiene credenciales
-- ni google_id, por lo que no puede iniciar sesión.
ALTER TABLE user_artists ADD COLUMN IF NOT EXISTS image TEXT;

INSERT INTO users (email, name, role)
VALUES ('demo@festival-match.invalid', 'Festival Match Demo', 'user')
ON CONFLICT (email) DO NOTHING;

-- Preferencias iniciales del demo. Los festivales favoritos se agregan a mano
-- en user_festivals después de aplicar esta migración.
INSERT INTO user_artists (user_id, artist_name)
SELECT users.id, seed.artist_name
FROM users
CROSS JOIN (VALUES
  ('Charli XCX'), ('Dua Lipa'), ('Fred Again..'), ('Bicep'), ('The 1975'),
  ('Arctic Monkeys'), ('LCD Soundsystem'), ('Disclosure'), ('Fontaines D.C.'),
  ('Jamie xx'), ('Four Tet'), ('Peggy Gou'), ('Clairo'), ('Tame Impala'),
  ('The Killers'), ('Gorillaz'), ('Glass Animals'), ('Jungle'), ('JPEGMAFIA'),
  ('Little Simz')
) AS seed(artist_name)
WHERE users.email = 'demo@festival-match.invalid'
ON CONFLICT (user_id, artist_name) DO NOTHING;
