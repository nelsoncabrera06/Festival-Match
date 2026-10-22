-- Add the five Argentina festivals from server/festivals.json.
-- Existing festival content edited through the admin panel is preserved.
-- Safe to re-run: a complete prior application is a no-op; a partial state aborts.
BEGIN;
DO $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count FROM festivals
  WHERE id = ANY(ARRAY['cosquin-rock', 'quilmes-rock', 'primavera-sound-buenos-aires', 'creamfields-argentina', 'festival-bandera']::text[]);

  IF existing_count = 0 THEN
    -- Make room at their curated positions in the JSON without changing lineup data.
    UPDATE festivals SET sort_order = sort_order + 5 WHERE sort_order >= 24;
    INSERT INTO festivals (
      id, name, city, location, country, dates, website, image, flyer,
      flyer_images, description, lineup_status, lineup, note, sort_order
    ) VALUES
  ('cosquin-rock', 'Cosquín Rock', 'Santa María de Punilla', 'Aeródromo Santa María de Punilla, Córdoba', 'AR', '6-7 Febrero 2027', 'https://cosquinrock.net', 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=800', NULL, '{}'::text[], NULL, 'partial', ARRAY['Ciro y Los Persas', 'Divididos', 'Los Fabulosos Cadillacs', 'Babasónicos', 'Tan Biónica', 'Catupecu Machu', 'El Mató a un Policía Motorizado', 'Los Cafres', 'Las Pelotas', 'Ratones Paranoicos', 'Jack Johnson', 'Capital Cities', 'Jorge Drexler', 'No Te Va Gustar', 'Un Poco de Ruido']::text[], NULL, 24),
  ('quilmes-rock', 'Quilmes Rock', 'Buenos Aires', 'Buenos Aires, Argentina (predio por anunciar)', 'AR', '16-18 Abril 2027', 'https://www.quilmesrock.com.ar', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800', NULL, '{}'::text[], NULL, 'unannounced', '{}'::text[], NULL, 25),
  ('primavera-sound-buenos-aires', 'Primavera Sound Buenos Aires', 'Buenos Aires', 'Club Ciudad de Buenos Aires', 'AR', '28-29 Noviembre 2026', 'https://www.primaverasound.com/en/buenos-aires', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800', NULL, '{}'::text[], NULL, 'partial', ARRAY['Gorillaz', 'The Strokes', 'FKA twigs', 'Yung Lean', 'Lily Allen', 'Courtney Barnett', 'CMAT', 'Nation of Language', 'Danny L Harle', 'Juana Molina', 'Marilina Bertoldi', 'Santiago Motorizado', 'Juliana Gattas', 'Juana Aguirre', 'Fin del Mundo']::text[], NULL, 26),
  ('creamfields-argentina', 'Creamfields Argentina', 'Buenos Aires', 'Parque de la Ciudad, Buenos Aires', 'AR', '14 Noviembre 2026', 'https://www.creamfields.ar', 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800', NULL, '{}'::text[], NULL, 'partial', ARRAY['Charlotte de Witte', 'FISHER', 'HUGEL', 'The Blessed Madonna', 'Anfisa Letyago', 'Loud Luxury', 'SOSA', 'Kölsch', 'Sven Väth', 'Innellea', 'Nic Fanciulli', 'Enrico Sangiuliano', 'Faithless Sound System', 'DJs Pareja', 'Sol Ortega']::text[], NULL, 27),
  ('festival-bandera', 'Festival Bandera', 'Rosario', 'Parque Estación Central Córdoba, Rosario, Santa Fe', 'AR', '24 Octubre 2026', 'https://www.instagram.com/festivalbanderaok/', 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800', NULL, '{}'::text[], NULL, 'partial', ARRAY['YSY A', 'Dillom', 'La Vela Puerca', 'Las Pastillas del Abuelo', 'Guasones', 'Peces Raros', 'El Mató a un Policía Motorizado', 'Marilina Bertoldi', 'Aterciopelados', 'Bandalos Chinos', 'Zoe Gotusso', 'Javiera Mena', 'Lisandro Aristimuño', 'Mi Amigo Invencible', 'El Zar']::text[], NULL, 28);
  ELSIF existing_count <> 5 THEN
    RAISE EXCEPTION 'Partial Argentina festival seed found (% of 5); inspect before applying', existing_count;
  END IF;
END $$;
COMMIT;
