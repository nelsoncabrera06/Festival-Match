-- Refresh confirmed Argentina lineups from the current published artist lists.
-- Update only lineup_status and lineup, preserving other admin-managed festival fields.
BEGIN;
DO $$
DECLARE
  changed_rows INTEGER;
BEGIN
    UPDATE festivals
       SET lineup_status = 'confirmed',
           lineup = ARRAY['2 Minutos', 'A La Par', 'Abril Olivera', 'Ale Kurz', 'Autos Robados', 'Babasónicos', 'Bacanas', 'BB Asul', 'Blair', 'Blues Motel', 'Botafogo', 'Búfalos Sedientos', 'Cada Cual', 'Camionero', 'Capital Cities', 'Catupecu Machu', 'César Valdomir', 'Chapa & Castelo', 'Ciro y Los Persas', 'Cruzando el Charco', 'Cuatro al Hilo', 'Daniela Spalla', 'Delfina Campos', 'Dellacasa', 'Divididos', 'El Kuelgue', 'El Mató a un Policía Motorizado', 'El Plan de la Mariposa', 'El Zar', 'Escalopez', 'Florián', 'Franco Cinelli', 'Gauchito Club', 'Gente Negra', 'Guasones', 'Gustavo Cordera', 'Héctor Couto', 'Ilan Amores', 'Illya Kuryaki and the Valderramas', 'Jack Johnson', 'Jay de Lys', 'Jorge Drexler', 'Juan Ingaramo', 'Justi Riga', 'Kapanga', 'Kat Riggins', 'Koino Yokan', 'La Chancha Muda', 'La Cumparsita Rock', 'La Delio Valdez', 'La Forastería', 'La Grecia', 'La H No Murió', 'La Kermesse Redonda', 'La Mississippi', 'La Virgenxita', 'Las Pastillas del Abuelo', 'Las Pelotas', 'Lisandro Aristimuño', 'Locche', 'Los Besos', 'Los Cafres', 'Los Espíritus', 'Los Fabulosos Cadillacs', 'Los Gardelitos', 'Los Neuropibes', 'Los Pérez García', 'Lulú Matheu', 'Manu Desrets', 'Manu Martínez', 'Mar Monzon', 'Mariano Mellino', 'Marilina Bertoldi', 'Marino’s Band', 'Martín Huergo', 'Mateo Dufour', 'Memphis La Blusera', 'Mixo', 'MRTNA', 'Nacho Bolognani', 'Najles', 'Nick Curly', 'Nicola', 'No Te Va Gustar', 'Nonpalidece', 'Peces Raros', 'Perras on the Beach', 'Piti Fernández', 'Pizza', 'Q’ Lokura', 'Ramma', 'Ramita Puzzo', 'Ratones Paranoicos', 'Reybruja', 'Richie Hawtin', 'Ryan', 'Salas Velatorias', 'Sandra Vázquez', 'Siloé', 'Silvestre y La Naranja', 'Só', 'Sour District', 'Tan Biónica', 'The Ginger Hearts', 'The Rhythm Gamblers', 'Tiky Sironi & Agus Prieto', 'Un Poco de Ruido', 'Usted Señalemelo', 'Victoria Whynot', 'Viejo Motor', 'Wayra Iglesias', 'Winona Riders', 'Wos', 'Zaren', 'Zoe Gotusso']::text[],
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'cosquin-rock';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Expected one row for %, updated %', 'cosquin-rock', changed_rows;
    END IF;

    UPDATE festivals
       SET lineup_status = 'confirmed',
           lineup = ARRAY['Gorillaz', 'The Strokes', 'FKA twigs', 'Lily Allen', 'Yung Lean', 'CMAT', 'Courtney Barnett', 'underscores', 'Danny L Harle', 'Nation of Language', 'Juana Molina', 'Santiago Motorizado', 'Cara Delevingne', 'Smerz', 'Marilina Bertoldi', 'Ecco2K', 'Jaime Sin Tierra', 'John Talabot', 'Juana Aguirre', 'Juliana Gattas', 'Los Thuthanaka', 'Machine Girl', 'Mannequin Pussy', 'Metrika', 'Model/Actriz', 'Nick León', 'Sophia Stel', 'This Is Lorelei', 'Ambik', 'Babeblade', 'Candelabro', 'Chechi de Marcos', 'Fin del Mundo', 'Lisa Scha', 'Maria Wolff', 'El Nota', 'Pizza', 'Sunlid', 'Wiranda Johansen', 'Yeyo']::text[],
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'primavera-sound-buenos-aires';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Expected one row for %, updated %', 'primavera-sound-buenos-aires', changed_rows;
    END IF;

    UPDATE festivals
       SET lineup_status = 'confirmed',
           lineup = ARRAY['Âme (Live)', 'Anfisa Letyago', 'The Blessed Madonna', 'Charlotte de Witte', 'Enrico Sangiuliano', 'Faithless Sound System', 'FISHER', 'HUGEL', 'Innellea', 'Kölsch', 'Kevin Di Serna', 'Loud Luxury', 'Nic Fanciulli', 'SOSA', 'Sven Väth', 'Ana Hagen', 'Carca (DJ Set)', 'DJs Pareja', 'Festa Bros', 'Guido Sartoris', 'Loïc', 'Lulú Matheou', 'Luis Nieva', 'Mabel', 'Manu Oubiña', 'Mar Monzon', 'Martin Huergo', 'Miguel Silver', 'Momo Trosman', 'Pabels']::text[],
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'creamfields-argentina';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Expected one row for %, updated %', 'creamfields-argentina', changed_rows;
    END IF;

    UPDATE festivals
       SET lineup_status = 'confirmed',
           lineup = ARRAY['Hana', 'BB Asul', 'Zoe Gotusso', 'Marilina Bertoldi', 'Dillom', 'Guasones', 'La Vela Puerca', 'Cosmic Kid', 'Ramma', 'Aterciopelados', 'El Mató a un Policía Motorizado', 'YSY A', 'Las Pastillas del Abuelo', 'Alejo', 'Un Muerto Más', 'Broke Carrey', 'La Franela', 'Lisandro Aristimuño', 'Carca', 'Autos Robados', 'Caliope Family', 'El Zar', 'Peces Raros', 'Pablikoman & TFT', 'Amira', 'Vandera', 'Nuestro Romance', 'Perras on the Beach', 'La Grecia', 'Javiera Mena', 'Mi Amigo Invencible', 'Bandalos Chinos']::text[],
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'festival-bandera';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Expected one row for %, updated %', 'festival-bandera', changed_rows;
    END IF;

    UPDATE festivals
       SET lineup_status = 'confirmed',
           lineup = ARRAY['Travis Scott', 'Charli XCX', 'The Killers', 'TINI', 'David Guetta', 'Queens of the Stone Age', 'The Neighbourhood', 'Rawayana', 'Fontaines D.C.', 'Sombr', 'The Prodigy', 'Dillom', 'Malcolm Todd', 'Geese', 'Cage the Elephant', 'Dominic Fike', 'RAYE', 'Lola Young', 'Slayyyter', 'Adéla', 'Un Poco de Ruido', 'Marlon Hoffstadt', 'Four Tet', 'Angine de Poitrine', 'Tomora', 'K4OS', 'Leon Bridges', 'Usted Señalemelo', 'Boys Noize', 'Snow Strippers', 'Carlita', 'Sammy Virji', 'Ninajirachi', 'Julia Wolf', 'Die Spitz', 'Yorghaki', 'The Avalanches', 'Rivo', 'Boy Harsher', 'Mateo Dufour Live', 'Amaia', 'Midnight Generation', 'Mind Enterprises', 'Ayybo', 'Juan Hansen Live', 'Violet Grohl', 'Ela Taubert', 'Enzocerobulto', 'Juana Rozas', 'Francisca Valenzuela', 'Broke Carrey', 'Princesa Alba', 'Lolu Menayed', 'Folgar', 'Tiga', 'Santos Bravos', 'Daniela Spalla', 'Kchiporros', 'Natalia Lacunza', 'Zé Pequeña', 'Sofía Mora', 'Dandára', 'Joaco Burgos', 'Ara', 'Palo', 'Fabrizio', 'Mai Lawson', 'Hana Fox', 'Varese', 'Sol Porro', 'Hellolola', 'Molle', 'Pato Mallet', 'Las Sombras', 'La Ramona']::text[],
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'lollapalooza-argentina';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Expected one row for %, updated %', 'lollapalooza-argentina', changed_rows;
    END IF;
END $$;
COMMIT;
