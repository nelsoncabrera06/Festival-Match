/**
 * Festival Match - Server
 *
 * IMPORTANTE PARA FUTURAS SESIONES DE IA:
 * - Año actual: 2026
 * - Última actualización: 12 de Enero de 2026
 * - Los festivales deben buscarse para el año 2026 (o temporada actual)
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const festivals = require('./festivals.json');

// Base de datos y autenticacion
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// Almacenamiento en memoria de tokens Spotify (en produccion usar Redis/DB)
const spotifyTokenStore = {};

// ==========================================
// PAGINA PRINCIPAL
// ==========================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==========================================
// GOOGLE OAUTH
// ==========================================

// Iniciar login con Google
app.get('/auth/google', (req, res) => {
  const authUrl = auth.getAuthUrl();
  res.redirect(authUrl);
});

// Callback de Google OAuth
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + error);
  }

  try {
    const { user, sessionId } = await auth.handleCallback(code);

    // Establecer cookie de sesion
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
      sameSite: 'lax',
    });

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Error en Google callback:', err);
    console.error('Stack:', err.stack);
    res.redirect('/?error=auth_failed');
  }
});

// Obtener usuario actual
app.get('/auth/me', auth.optionalAuth, (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }

  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
    },
  });
});

// Cerrar sesion
app.post('/auth/logout', (req, res) => {
  const sessionId = req.cookies?.session;
  auth.logout(sessionId);
  res.clearCookie('session');
  res.json({ success: true });
});

// ==========================================
// PREFERENCIAS DE USUARIO
// ==========================================

// Obtener artistas del usuario
app.get('/api/user/artists', auth.requireAuth, (req, res) => {
  const artists = db.getUserArtists(req.user.id);
  res.json({ artists });
});

// Anadir artista
app.post('/api/user/artists', auth.requireAuth, (req, res) => {
  const { artistName, musicbrainzId } = req.body;

  if (!artistName || artistName.trim().length === 0) {
    return res.status(400).json({ error: 'Nombre de artista requerido' });
  }

  const artist = db.addUserArtist(req.user.id, artistName, musicbrainzId);

  if (!artist) {
    return res.status(409).json({ error: 'Artista ya existe' });
  }

  res.status(201).json({ artist });
});

// Eliminar artista
app.delete('/api/user/artists/:id', auth.requireAuth, (req, res) => {
  const artistId = parseInt(req.params.id);
  const removed = db.removeUserArtist(req.user.id, artistId);

  if (!removed) {
    return res.status(404).json({ error: 'Artista no encontrado' });
  }

  res.json({ success: true });
});

// Obtener generos disponibles
app.get('/api/genres', (req, res) => {
  res.json({ genres: db.getAvailableGenres() });
});

// Obtener generos del usuario
app.get('/api/user/genres', auth.requireAuth, (req, res) => {
  const genres = db.getUserGenres(req.user.id);
  res.json({ genres });
});

// Anadir genero
app.post('/api/user/genres', auth.requireAuth, (req, res) => {
  const { genre } = req.body;

  if (!genre || genre.trim().length === 0) {
    return res.status(400).json({ error: 'Genero requerido' });
  }

  const result = db.addUserGenre(req.user.id, genre);

  if (!result) {
    return res.status(409).json({ error: 'Genero ya existe' });
  }

  res.status(201).json({ genre: result });
});

// Eliminar genero
app.delete('/api/user/genres/:id', auth.requireAuth, (req, res) => {
  const genreId = parseInt(req.params.id);
  const removed = db.removeUserGenre(req.user.id, genreId);

  if (!removed) {
    return res.status(404).json({ error: 'Genero no encontrado' });
  }

  res.json({ success: true });
});

// ==========================================
// FESTIVALES FAVORITOS
// ==========================================

// Obtener festivales favoritos del usuario
app.get('/api/user/favorite-festivals', auth.requireAuth, (req, res) => {
  const favorites = db.getUserFavoriteFestivals(req.user.id);
  res.json({ festivals: favorites });
});

// Agregar festival a favoritos
app.post('/api/user/favorite-festivals', auth.requireAuth, (req, res) => {
  const { festivalId } = req.body;

  if (!festivalId || festivalId.trim().length === 0) {
    return res.status(400).json({ error: 'ID de festival requerido' });
  }

  const result = db.addUserFestival(req.user.id, festivalId);

  if (!result) {
    return res.status(409).json({ error: 'Festival ya está en favoritos' });
  }

  res.status(201).json({ festival: result });
});

// Eliminar festival de favoritos
app.delete('/api/user/favorite-festivals/:festivalId', auth.requireAuth, (req, res) => {
  const festivalId = req.params.festivalId;
  const removed = db.removeUserFestival(req.user.id, festivalId);

  if (!removed) {
    return res.status(404).json({ error: 'Festival no encontrado en favoritos' });
  }

  res.json({ success: true });
});

// ==========================================
// BUSQUEDA DE ARTISTAS (MusicBrainz)
// ==========================================

app.get('/api/search/artists', async (req, res) => {
  const query = req.query.q;

  if (!query || query.length < 2) {
    return res.json({ artists: [] });
  }

  try {
    const response = await axios.get('https://musicbrainz.org/ws/2/artist', {
      params: {
        query: query,
        limit: 10,
        fmt: 'json',
      },
      headers: {
        'User-Agent': 'FestivalMatch/1.0 (https://github.com/festival-match)',
      },
    });

    const artists = response.data.artists.map(artist => ({
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation || null,
      country: artist.country || null,
    }));

    res.json({ artists });
  } catch (err) {
    console.error('Error buscando artistas:', err.message);
    res.status(500).json({ error: 'Error al buscar artistas' });
  }
});

// ==========================================
// TOUR DATES (Bandsintown API)
// ==========================================

// Configuración de regiones
const REGIONS = {
  europe: {
    // Nombres de países (para Bandsintown API)
    countryNames: [
      'Germany', 'France', 'Spain', 'Italy', 'Netherlands',
      'Belgium', 'Portugal', 'United Kingdom', 'Ireland',
      'Denmark', 'Sweden', 'Norway', 'Finland', 'Poland',
      'Austria', 'Switzerland', 'Czech Republic', 'Czechia', 'Hungary',
      'Croatia', 'Serbia', 'Greece', 'Romania', 'Bulgaria',
      'Slovakia', 'Slovenia', 'Estonia', 'Latvia', 'Lithuania',
      'Luxembourg', 'Iceland', 'Turkey', 'Ukraine', 'Russia'
    ],
    // Códigos de país ISO (para festivals.json)
    countryCodes: [
      'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'PT', 'GB', 'UK', 'IE',
      'DK', 'SE', 'NO', 'FI', 'PL', 'AT', 'CH', 'CZ', 'HU',
      'HR', 'RS', 'GR', 'RO', 'BG', 'SK', 'SI', 'EE', 'LV', 'LT',
      'LU', 'IS', 'TR', 'UA', 'RU'
    ]
  },
  usa: {
    countryNames: ['United States', 'USA', 'US'],
    countryCodes: ['US', 'USA']
  },
  latam: {
    countryNames: [
      'Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia',
      'Peru', 'Ecuador', 'Venezuela', 'Uruguay', 'Paraguay',
      'Bolivia', 'Costa Rica', 'Panama', 'Guatemala', 'Honduras',
      'El Salvador', 'Nicaragua', 'Cuba', 'Dominican Republic', 'Puerto Rico'
    ],
    countryCodes: [
      'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'VE', 'UY', 'PY',
      'BO', 'CR', 'PA', 'GT', 'HN', 'SV', 'NI', 'CU', 'DO', 'PR'
    ]
  }
};

// Alias para compatibilidad
const EUROPEAN_COUNTRIES = REGIONS.europe.countryNames;

// Cache de 2 niveles para tour dates:
// Nivel 1: Memoria (tourDatesCache) - ultra rápido, se pierde al reiniciar
// Nivel 2: SQLite (db.getTourCache) - persistente, sobrevive reinicios
const tourDatesCache = {};
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 horas

// Funcion para buscar artista en festivales
function findArtistInFestivals(artistName) {
  const normalizedArtist = normalizeString(artistName);
  const festivalMatches = [];

  for (const festival of festivals) {
    if (festival.lineup && festival.lineup.length > 0) {
      const found = festival.lineup.find(a => normalizeString(a) === normalizedArtist);
      if (found) {
        festivalMatches.push({
          name: festival.name,
          dates: festival.dates,
          location: festival.location,
          country: festival.country,
          website: festival.website
        });
      }
    }
  }

  return festivalMatches;
}

app.get('/api/artist-events/:artistName', async (req, res) => {
  const artistName = req.params.artistName;
  const region = req.query.region || 'europe';
  const regionConfig = REGIONS[region] || REGIONS.europe;

  if (!artistName) {
    return res.status(400).json({ error: 'Nombre de artista requerido' });
  }

  // Buscar en festivales de la región seleccionada
  const allFestivalAppearances = findArtistInFestivals(artistName);
  const festivalAppearances = allFestivalAppearances.filter(f =>
    regionConfig.countryCodes.includes(f.country)
  );

  // NIVEL 1: Check cache en memoria (más rápido)
  const cacheKey = `${artistName.toLowerCase()}_${region}`;
  if (tourDatesCache[cacheKey] && Date.now() - tourDatesCache[cacheKey].timestamp < CACHE_DURATION) {
    console.log(`[Cache MEMORIA] ${artistName} (${region})`);
    const cachedData = { ...tourDatesCache[cacheKey].data };
    cachedData.festivalAppearances = festivalAppearances;
    return res.json(cachedData);
  }

  // NIVEL 2: Check cache en base de datos (persiste entre reinicios)
  const dbCacheData = db.getTourCache(artistName, region);
  if (dbCacheData) {
    console.log(`[Cache DB] ${artistName} (${region})`);
    // Guardar en memoria para próximas consultas rápidas
    tourDatesCache[cacheKey] = {
      data: dbCacheData,
      timestamp: Date.now()
    };
    const cachedData = { ...dbCacheData };
    cachedData.festivalAppearances = festivalAppearances;
    return res.json(cachedData);
  }

  // NIVEL 3: No hay cache, llamar a la API
  console.log(`[API Bandsintown] ${artistName} (${region})`);
  try {
    const encodedName = encodeURIComponent(artistName);
    const response = await axios.get(
      `https://rest.bandsintown.com/artists/${encodedName}/events`,
      {
        params: {
          app_id: 'festival_match_app',
          date: 'upcoming'
        },
        headers: {
          'Accept': 'application/json'
        },
        timeout: 5000
      }
    );

    if (!Array.isArray(response.data)) {
      throw new Error('Respuesta invalida de Bandsintown');
    }

    // Filtrar eventos por región seleccionada
    const regionEvents = response.data
      .filter(event => regionConfig.countryNames.includes(event.venue?.country))
      .slice(0, 10)
      .map(event => ({
        id: event.id,
        date: event.datetime,
        venue: event.venue?.name || 'Venue TBA',
        city: event.venue?.city || '',
        country: event.venue?.country || '',
        url: event.url || event.offers?.[0]?.url || null,
        lineup: event.lineup || []
      }));

    // Buscar en qué otras regiones tiene eventos
    const otherRegions = [];
    for (const [regKey, regConf] of Object.entries(REGIONS)) {
      if (regKey !== region) {
        const hasEvents = response.data.some(e => regConf.countryNames.includes(e.venue?.country));
        if (hasEvents) {
          otherRegions.push(regKey);
        }
      }
    }

    const result = {
      artist: artistName,
      region: region,
      events: regionEvents,
      totalRegionEvents: response.data.filter(e => regionConfig.countryNames.includes(e.venue?.country)).length,
      festivalAppearances: festivalAppearances,
      otherRegionsWithEvents: otherRegions,
      bandsintownUrl: `https://www.bandsintown.com/a/${encodeURIComponent(artistName)}`
    };

    // Guardar en memoria (nivel 1)
    tourDatesCache[cacheKey] = {
      data: result,
      timestamp: Date.now()
    };

    // Guardar en base de datos (nivel 2 - persiste entre reinicios)
    db.setTourCache(artistName, region, result);

    res.json(result);
  } catch (err) {
    console.error('Error obteniendo tour dates para', artistName, ':', err.message);

    const result = {
      artist: artistName,
      region: region,
      events: [],
      totalRegionEvents: 0,
      festivalAppearances: festivalAppearances,
      otherRegionsWithEvents: [],
      bandsintownUrl: `https://www.bandsintown.com/a/${encodeURIComponent(artistName)}`,
      apiError: true
    };

    res.json(result);
  }
});

// ==========================================
// FESTIVALES - Usuario logueado
// ==========================================

app.get('/api/user/festivals', auth.requireAuth, (req, res) => {
  const region = req.query.region || 'europe';
  const regionConfig = REGIONS[region] || REGIONS.europe;

  // Filtrar festivales por región
  const regionFestivals = festivals.filter(f =>
    regionConfig.countryCodes.includes(f.country)
  );

  // Obtener festivales favoritos del usuario
  const userFavorites = db.getUserFavoriteFestivals(req.user.id);
  const favoriteIds = new Set(userFavorites.map(f => f.festival_id));

  const userArtistsList = db.getUserArtists(req.user.id);
  const userArtists = userArtistsList.map(a => normalizeString(a.artist_name));

  if (userArtists.length === 0) {
    return res.json({
      festivals: regionFestivals.map(f => ({
        ...f,
        matchPercentage: 0,
        matchedArtists: 0,
        totalUserArtists: 0,
        artistsInCommon: [],
        isFavorite: favoriteIds.has(f.id),
      })),
      message: 'Anade artistas a tu perfil para ver tu compatibilidad',
    });
  }

  const festivalsWithMatch = regionFestivals.map(festival => {
    const festivalArtists = festival.lineup.map(a => normalizeString(a));
    const matches = userArtists.filter(artist => festivalArtists.includes(artist));
    const matchPercentage = Math.round((matches.length / userArtists.length) * 100);

    return {
      ...festival,
      matchPercentage,
      matchedArtists: matches.length,
      totalUserArtists: userArtists.length,
      artistsInCommon: festival.lineup.filter(a =>
        userArtists.includes(normalizeString(a))
      ),
      isFavorite: favoriteIds.has(festival.id),
    };
  });

  festivalsWithMatch.sort((a, b) => b.matchPercentage - a.matchPercentage);

  res.json({ festivals: festivalsWithMatch });
});

// ==========================================
// MODO DEMO (sin autenticacion)
// ==========================================

const demoArtists = [
  { name: 'Charli XCX', image: 'https://i.scdn.co/image/ab6761610000e5eb9e35c40cec4c80095f1a3ef9', genres: ['art pop', 'dance pop'] },
  { name: 'Dua Lipa', image: 'https://i.scdn.co/image/ab6761610000e5eb1bbee4a02f85ecc58d385c3e', genres: ['dance pop', 'pop'] },
  { name: 'Fred Again..', image: 'https://i.scdn.co/image/ab6761610000e5eb5c0f95e7c4be4a9c0b9c5c48', genres: ['uk electronic'] },
  { name: 'Bicep', image: 'https://i.scdn.co/image/ab6761610000e5ebd969cf117d0b0d4424bebdc5', genres: ['electronica', 'uk dance'] },
  { name: 'The 1975', image: 'https://i.scdn.co/image/ab6761610000e5eb3c6c7c3a4e1c8c1e0e8c3b3e', genres: ['modern rock', 'pop'] },
  { name: 'Arctic Monkeys', image: 'https://i.scdn.co/image/ab6761610000e5eb7da39dea0a72f581535fb11f', genres: ['garage rock', 'modern rock'] },
  { name: 'LCD Soundsystem', image: 'https://i.scdn.co/image/ab6761610000e5eb4c3f8c1c5c3c5c3c5c3c5c3c', genres: ['dance-punk', 'indietronica'] },
  { name: 'Disclosure', image: 'https://i.scdn.co/image/ab6761610000e5eb8c9c9c9c9c9c9c9c9c9c9c9c', genres: ['uk garage', 'house'] },
  { name: 'Fontaines D.C.', image: 'https://i.scdn.co/image/ab6761610000e5eb1c1c1c1c1c1c1c1c1c1c1c1c', genres: ['post-punk', 'art punk'] },
  { name: 'Jamie xx', image: 'https://i.scdn.co/image/ab6761610000e5eb2c2c2c2c2c2c2c2c2c2c2c2c', genres: ['uk electronic', 'indietronica'] },
  { name: 'Four Tet', image: 'https://i.scdn.co/image/ab6761610000e5eb3c3c3c3c3c3c3c3c3c3c3c3c', genres: ['electronica', 'folktronica'] },
  { name: 'Peggy Gou', image: 'https://i.scdn.co/image/ab6761610000e5eb4c4c4c4c4c4c4c4c4c4c4c4c', genres: ['house', 'tech house'] },
  { name: 'Clairo', image: 'https://i.scdn.co/image/ab6761610000e5eb5c5c5c5c5c5c5c5c5c5c5c5c', genres: ['bedroom pop', 'indie pop'] },
  { name: 'Tame Impala', image: 'https://i.scdn.co/image/ab6761610000e5eb6c6c6c6c6c6c6c6c6c6c6c6c', genres: ['psychedelic rock', 'neo-psychedelia'] },
  { name: 'The Killers', image: 'https://i.scdn.co/image/ab6761610000e5eb7c7c7c7c7c7c7c7c7c7c7c7c', genres: ['alternative rock', 'new wave'] },
  { name: 'Gorillaz', image: 'https://i.scdn.co/image/ab6761610000e5eb8c8c8c8c8c8c8c8c8c8c8c8c', genres: ['alternative rock', 'trip hop'] },
  { name: 'Glass Animals', image: 'https://i.scdn.co/image/ab6761610000e5eb9c9c9c9c9c9c9c9c9c9c9c9c', genres: ['indietronica', 'psychedelic pop'] },
  { name: 'Jungle', image: 'https://i.scdn.co/image/ab6761610000e5ebacacacacacacacacacacacac', genres: ['funk', 'neo soul'] },
  { name: 'JPEGMAFIA', image: 'https://i.scdn.co/image/ab6761610000e5ebbcbcbcbcbcbcbcbcbcbcbcbc', genres: ['experimental hip hop', 'industrial hip hop'] },
  { name: 'Little Simz', image: 'https://i.scdn.co/image/ab6761610000e5ebcccccccccccccccccccccccc', genres: ['uk hip hop', 'conscious hip hop'] },
];

app.get('/api/demo/artists', (req, res) => {
  res.json({ artists: demoArtists, isDemo: true });
});

app.get('/api/demo/festivals', (req, res) => {
  const region = req.query.region || 'europe';
  const regionConfig = REGIONS[region] || REGIONS.europe;

  // Filtrar festivales por región
  const regionFestivals = festivals.filter(f =>
    regionConfig.countryCodes.includes(f.country)
  );

  const userArtists = demoArtists.map(a => normalizeString(a.name));

  const festivalsWithMatch = regionFestivals.map(festival => {
    const festivalArtists = festival.lineup.map(a => normalizeString(a));
    const matches = userArtists.filter(artist => festivalArtists.includes(artist));
    const matchPercentage = userArtists.length > 0
      ? Math.round((matches.length / userArtists.length) * 100)
      : 0;

    return {
      ...festival,
      matchPercentage,
      matchedArtists: matches.length,
      totalUserArtists: userArtists.length,
      artistsInCommon: festival.lineup.filter(a =>
        userArtists.includes(normalizeString(a))
      ),
      isFavorite: false, // Demo mode no tiene favoritos
    };
  });

  festivalsWithMatch.sort((a, b) => b.matchPercentage - a.matchPercentage);

  res.json({ festivals: festivalsWithMatch, isDemo: true });
});

// ==========================================
// SPOTIFY API (deshabilitado por ahora)
// ==========================================

const SPOTIFY_SCOPES = 'user-top-read';

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  const authUrl = new URL('https://accounts.spotify.com/authorize');

  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', process.env.SPOTIFY_CLIENT_ID);
  authUrl.searchParams.append('scope', SPOTIFY_SCOPES);
  authUrl.searchParams.append('redirect_uri', process.env.REDIRECT_URI);
  authUrl.searchParams.append('state', state);

  res.redirect(authUrl.toString());
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + error);
  }

  try {
    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(
            process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
          ).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const sessionId = generateRandomString(32);
    spotifyTokenStore[sessionId] = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + (expires_in * 1000),
    };

    res.redirect('/?session=' + sessionId);
  } catch (err) {
    console.error('Error en callback:', err.response?.data || err.message);
    res.redirect('/?error=token_error');
  }
});

app.get('/api/top-artists', async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId || !spotifyTokenStore[sessionId]) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/top/artists', {
      headers: {
        'Authorization': 'Bearer ' + spotifyTokenStore[sessionId].accessToken,
      },
      params: { limit: 50, time_range: 'medium_term' },
    });

    const artists = response.data.items.map(artist => ({
      name: artist.name,
      image: artist.images[0]?.url,
      genres: artist.genres,
    }));

    res.json({ artists });
  } catch (err) {
    console.error('Error obteniendo artistas:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al obtener artistas' });
  }
});

app.get('/api/festivals', async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId || !spotifyTokenStore[sessionId]) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const artistsResponse = await axios.get('https://api.spotify.com/v1/me/top/artists', {
      headers: {
        'Authorization': 'Bearer ' + spotifyTokenStore[sessionId].accessToken,
      },
      params: { limit: 50, time_range: 'medium_term' },
    });

    const userArtists = artistsResponse.data.items.map(a => normalizeString(a.name));

    const festivalsWithMatch = festivals.map(festival => {
      const festivalArtists = festival.lineup.map(a => normalizeString(a));
      const matches = userArtists.filter(artist => festivalArtists.includes(artist));
      const matchPercentage = userArtists.length > 0
        ? Math.round((matches.length / userArtists.length) * 100)
        : 0;

      return {
        ...festival,
        matchPercentage,
        matchedArtists: matches.length,
        totalUserArtists: userArtists.length,
        artistsInCommon: festival.lineup.filter(a =>
          userArtists.includes(normalizeString(a))
        ),
      };
    });

    festivalsWithMatch.sort((a, b) => b.matchPercentage - a.matchPercentage);
    res.json({ festivals: festivalsWithMatch });
  } catch (err) {
    console.error('Error calculando matches:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al calcular matches' });
  }
});

// ==========================================
// UTILIDADES
// ==========================================

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function normalizeString(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ==========================================
// AÑO ACTUAL (se obtiene de internet al iniciar)
// ==========================================

let currentYear = new Date().getFullYear(); // Fallback al año del sistema

async function fetchCurrentYear() {
  try {
    const response = await axios.get('http://worldtimeapi.org/api/ip', { timeout: 5000 });
    const dateStr = response.data.datetime; // "2026-01-12T..."
    currentYear = parseInt(dateStr.substring(0, 4));
    console.log(`📅 Año actual obtenido de internet: ${currentYear}`);
  } catch (err) {
    console.log(`📅 No se pudo obtener el año de internet, usando año del sistema: ${currentYear}`);
  }
}

// Endpoint para obtener el año actual
app.get('/api/current-year', (req, res) => {
  res.json({ year: currentYear });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, async () => {
  await fetchCurrentYear();
  console.log(`🎵 Festival Match ${currentYear} corriendo en http://localhost:${PORT}`);
  console.log('📋 Configuracion:');
  console.log('   - Google OAuth: ' + (process.env.GOOGLE_CLIENT_ID ? 'Configurado' : 'No configurado'));
  console.log('   - Spotify API: ' + (process.env.SPOTIFY_CLIENT_ID ? 'Configurado' : 'No configurado (deshabilitado)'));
});
