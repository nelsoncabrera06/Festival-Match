// Festival Match - Cliente JavaScript v2

const API_BASE = '';

// Estado de la aplicacion
let currentUser = null;
let isDemo = false;
let myArtists = [];
let myGenres = [];
let myFavoriteFestivals = []; // IDs de festivales favoritos
let availableGenres = [];
let searchTimeout = null;
let searchTimeoutTab = null;
let festivalSearchTimeout = null;
let artistTourData = {}; // Cache de tour dates
let calendarMonth = 5; // Junio (0-indexed)
let calendarYear = 2026;
let festivalsData = []; // Cache de festivales para calendario
let currentRegion = 'europe'; // Región actual (europe, usa, latam)
let currentCountry = ''; // Filtro de país ('' = todos)
let currentCity = ''; // Filtro de ciudad ('' = todas)
let currentYear = new Date().getFullYear(); // Año actual (se actualiza desde el servidor)

// Mapeo de códigos de país a nombres con banderas
const COUNTRY_INFO = {
  // Europa
  'ES': { name: 'España', flag: '🇪🇸' },
  'DE': { name: 'Alemania', flag: '🇩🇪' },
  'FI': { name: 'Finlandia', flag: '🇫🇮' },
  'BE': { name: 'Bélgica', flag: '🇧🇪' },
  'NL': { name: 'Países Bajos', flag: '🇳🇱' },
  'PT': { name: 'Portugal', flag: '🇵🇹' },
  'DK': { name: 'Dinamarca', flag: '🇩🇰' },
  'PL': { name: 'Polonia', flag: '🇵🇱' },
  'HU': { name: 'Hungría', flag: '🇭🇺' },
  'HR': { name: 'Croacia', flag: '🇭🇷' },
  'GB': { name: 'Reino Unido', flag: '🇬🇧' },
  // USA
  'US': { name: 'Estados Unidos', flag: '🇺🇸' },
  // Latam
  'AR': { name: 'Argentina', flag: '🇦🇷' },
  'CL': { name: 'Chile', flag: '🇨🇱' },
  'BR': { name: 'Brasil', flag: '🇧🇷' },
  'MX': { name: 'México', flag: '🇲🇽' },
  'CO': { name: 'Colombia', flag: '🇨🇴' }
};

// Elementos del DOM
const elements = {};

// Obtener año actual del servidor
async function updateCurrentYear() {
  try {
    const response = await fetch('/api/current-year');
    const data = await response.json();
    currentYear = data.year;

    // Actualizar título de la página
    document.title = `Festival Match ${currentYear} - Encuentra tu festival ideal`;

    // Actualizar logo si existe
    const logoText = document.querySelector('.logo-text');
    if (logoText) {
      logoText.textContent = `Festival Match ${currentYear}`;
    }
  } catch (err) {
    console.log('No se pudo obtener el año del servidor, usando año local:', currentYear);
  }
}

// Inicializacion
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Obtener año actual del servidor y actualizar título
  await updateCurrentYear();

  // Cachear elementos del DOM
  cacheElements();

  // Verificar parametros de URL
  const urlParams = new URLSearchParams(window.location.search);
  const authSuccess = urlParams.get('auth');
  const error = urlParams.get('error');

  // Limpiar URL
  if (authSuccess || error) {
    window.history.replaceState({}, document.title, '/');
  }

  if (error) {
    showError(getErrorMessage(error));
    return;
  }

  // Verificar si hay usuario logueado
  await checkAuth();

  // Event listeners
  setupEventListeners();
}

function cacheElements() {
  elements.landing = document.getElementById('landing');
  elements.loading = document.getElementById('loading');
  elements.preferences = document.getElementById('preferences');
  elements.results = document.getElementById('results');
  elements.error = document.getElementById('error');

  elements.googleBtn = document.getElementById('google-btn');
  elements.demoBtn = document.getElementById('demo-btn');
  elements.logoutBtn = document.getElementById('logout-btn');
  elements.retryBtn = document.getElementById('retry-btn');
  elements.viewFestivalsBtn = document.getElementById('view-festivals-btn');
  elements.editPreferencesBtn = document.getElementById('edit-preferences-btn');

  elements.userInfo = document.getElementById('user-info');
  elements.userAvatar = document.getElementById('user-avatar');
  elements.userName = document.getElementById('user-name');

  elements.artistSearch = document.getElementById('artist-search');
  elements.searchResults = document.getElementById('search-results');
  elements.myArtists = document.getElementById('my-artists');
  elements.genreSelector = document.getElementById('genre-selector');
  elements.myGenres = document.getElementById('my-genres');

  // Festival favorites search
  elements.festivalSearch = document.getElementById('festival-search');
  elements.festivalSearchResults = document.getElementById('festival-search-results');
  elements.myFestivals = document.getElementById('my-festivals');

  elements.artistsList = document.getElementById('artists-list');
  elements.festivalsGrid = document.getElementById('festivals-grid');
  elements.errorMessage = document.getElementById('error-message');

  // Tabs
  elements.tabs = document.querySelectorAll('.tab');
  elements.tabFestivals = document.getElementById('tab-festivals');
  elements.tabArtists = document.getElementById('tab-artists');
  elements.artistSearchTab = document.getElementById('artist-search-tab');
  elements.searchResultsTab = document.getElementById('search-results-tab');
  elements.artistsTours = document.getElementById('artists-tours');

  // Calendar view
  elements.viewBtns = document.querySelectorAll('.view-btn');
  elements.festivalsListView = document.getElementById('festivals-list-view');
  elements.festivalsCalendarView = document.getElementById('festivals-calendar-view');
  elements.calendarGrid = document.getElementById('calendar-grid');
  elements.calendarMonthTitle = document.getElementById('calendar-month-title');
  elements.calendarLegend = document.getElementById('calendar-legend');
  elements.prevMonth = document.getElementById('prev-month');
  elements.nextMonth = document.getElementById('next-month');

  // Region selector
  elements.regionBtns = document.querySelectorAll('.region-btn');

  // Cascade filters
  elements.countryFilter = document.getElementById('country-filter');
  elements.cityFilter = document.getElementById('city-filter');
}

function setupEventListeners() {
  elements.googleBtn?.addEventListener('click', loginWithGoogle);
  elements.demoBtn?.addEventListener('click', startDemo);
  elements.logoutBtn?.addEventListener('click', logout);
  elements.retryBtn?.addEventListener('click', () => showSection('landing'));
  elements.viewFestivalsBtn?.addEventListener('click', loadUserFestivals);
  elements.editPreferencesBtn?.addEventListener('click', () => showSection('preferences'));

  // Busqueda de artistas
  elements.artistSearch?.addEventListener('input', handleArtistSearch);
  elements.artistSearch?.addEventListener('focus', () => {
    if (elements.searchResults.innerHTML) {
      elements.searchResults.style.display = 'block';
    }
  });

  // Cerrar resultados al hacer click fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      elements.searchResults.style.display = 'none';
      if (elements.searchResultsTab) {
        elements.searchResultsTab.style.display = 'none';
      }
      if (elements.festivalSearchResults) {
        elements.festivalSearchResults.style.display = 'none';
      }
    }
  });

  // Tabs
  elements.tabs?.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Busqueda de artistas en tab
  elements.artistSearchTab?.addEventListener('input', handleArtistSearchTab);
  elements.artistSearchTab?.addEventListener('focus', () => {
    if (elements.searchResultsTab?.innerHTML) {
      elements.searchResultsTab.style.display = 'block';
    }
  });

  // View toggle (Lista/Calendario)
  elements.viewBtns?.forEach(btn => {
    btn.addEventListener('click', () => switchFestivalsView(btn.dataset.view));
  });

  // Calendar navigation
  elements.prevMonth?.addEventListener('click', () => navigateCalendar(-1));
  elements.nextMonth?.addEventListener('click', () => navigateCalendar(1));

  // Region selector
  elements.regionBtns?.forEach(btn => {
    btn.addEventListener('click', () => switchRegion(btn.dataset.region));
  });

  // Cascade filters (Country/City)
  elements.countryFilter?.addEventListener('change', handleCountryChange);
  elements.cityFilter?.addEventListener('change', handleCityChange);

  // Busqueda de festivales favoritos
  elements.festivalSearch?.addEventListener('input', handleFestivalSearch);
  elements.festivalSearch?.addEventListener('focus', () => {
    if (elements.festivalSearchResults?.innerHTML) {
      elements.festivalSearchResults.style.display = 'block';
    }
  });
}

// ==========================================
// Navegacion
// ==========================================

function showSection(section) {
  elements.landing.style.display = section === 'landing' ? 'grid' : 'none';
  elements.loading.style.display = section === 'loading' ? 'flex' : 'none';
  elements.preferences.style.display = section === 'preferences' ? 'block' : 'none';
  elements.results.style.display = section === 'results' ? 'block' : 'none';
  elements.error.style.display = section === 'error' ? 'flex' : 'none';

  // Mostrar/ocultar info de usuario y logout
  const showUserUI = currentUser && (section === 'preferences' || section === 'results');
  elements.userInfo.style.display = showUserUI ? 'flex' : 'none';
  elements.logoutBtn.style.display = showUserUI ? 'block' : 'none';
}

// ==========================================
// Autenticacion
// ==========================================

async function checkAuth() {
  try {
    const response = await fetch('/auth/me', { credentials: 'include' });
    const data = await response.json();

    if (data.user) {
      currentUser = data.user;
      updateUserUI();
      await loadUserPreferences();
      showSection('preferences');
    } else {
      showSection('landing');
    }
  } catch (err) {
    console.error('Error checking auth:', err);
    showSection('landing');
  }
}

function loginWithGoogle() {
  window.location.href = '/auth/google';
}

async function logout() {
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch (err) {
    console.error('Error logging out:', err);
  }

  currentUser = null;
  isDemo = false;
  myArtists = [];
  myGenres = [];
  myFavoriteFestivals = [];
  showSection('landing');
}

function updateUserUI() {
  if (currentUser) {
    elements.userAvatar.src = currentUser.picture || '';
    elements.userName.textContent = currentUser.name || currentUser.email;
  }
}

// ==========================================
// Modo Demo
// ==========================================

async function startDemo() {
  isDemo = true;
  showSection('loading');

  try {
    const [artistsRes, festivalsRes] = await Promise.all([
      fetch('/api/demo/artists'),
      fetch(`/api/demo/festivals?region=${currentRegion}`),
    ]);

    const artistsData = await artistsRes.json();
    const festivalsData = await festivalsRes.json();

    renderUserArtists(artistsData.artists, true);
    renderFestivals(festivalsData.festivals);
    showSection('results');
  } catch (err) {
    console.error('Error loading demo:', err);
    showError('Error al cargar el modo demo');
  }
}

// ==========================================
// Preferencias de Usuario
// ==========================================

async function loadUserPreferences() {
  try {
    const [artistsRes, genresRes, availableGenresRes, favoriteFestivalsRes] = await Promise.all([
      fetch('/api/user/artists', { credentials: 'include' }),
      fetch('/api/user/genres', { credentials: 'include' }),
      fetch('/api/genres'),
      fetch('/api/user/favorite-festivals', { credentials: 'include' }),
    ]);

    const artistsData = await artistsRes.json();
    const genresData = await genresRes.json();
    const availableGenresData = await availableGenresRes.json();
    const favoriteFestivalsData = await favoriteFestivalsRes.json();

    myArtists = artistsData.artists || [];
    myGenres = genresData.genres || [];
    availableGenres = availableGenresData.genres || [];
    myFavoriteFestivals = (favoriteFestivalsData.festivals || []).map(f => f.festival_id);

    renderMyArtists();
    renderGenreSelector();
    renderMyGenres();
    renderMyFestivals();
  } catch (err) {
    console.error('Error loading preferences:', err);
  }
}

// ==========================================
// Busqueda de Artistas
// ==========================================

function handleArtistSearch(e) {
  const query = e.target.value.trim();

  clearTimeout(searchTimeout);

  if (query.length < 2) {
    elements.searchResults.style.display = 'none';
    return;
  }

  elements.searchResults.innerHTML = '<div class="search-loading">Buscando...</div>';
  elements.searchResults.style.display = 'block';

  searchTimeout = setTimeout(() => searchArtists(query), 300);
}

async function searchArtists(query) {
  try {
    const response = await fetch(`/api/search/artists?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.artists.length === 0) {
      elements.searchResults.innerHTML = '<div class="search-empty">No se encontraron artistas</div>';
      return;
    }

    elements.searchResults.innerHTML = data.artists
      .map(artist => `
        <div class="search-result-item" data-id="${artist.id}" data-name="${escapeHtml(artist.name)}">
          <div class="search-result-name">${escapeHtml(artist.name)}</div>
          ${artist.disambiguation || artist.country
            ? `<div class="search-result-info">${escapeHtml(artist.disambiguation || '')} ${artist.country ? `(${artist.country})` : ''}</div>`
            : ''
          }
        </div>
      `)
      .join('');

    // Event listeners para resultados
    elements.searchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        addArtist(item.dataset.name, item.dataset.id);
        elements.artistSearch.value = '';
        elements.searchResults.style.display = 'none';
      });
    });
  } catch (err) {
    console.error('Error searching artists:', err);
    elements.searchResults.innerHTML = '<div class="search-empty">Error al buscar</div>';
  }
}

async function addArtist(name, musicbrainzId) {
  // Verificar si ya existe
  if (myArtists.some(a => a.artist_name.toLowerCase() === name.toLowerCase())) {
    return;
  }

  try {
    const response = await fetch('/api/user/artists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ artistName: name, musicbrainzId }),
    });

    if (response.ok) {
      const data = await response.json();
      myArtists.push(data.artist);
      renderMyArtists();
    }
  } catch (err) {
    console.error('Error adding artist:', err);
  }
}

async function removeArtist(id) {
  try {
    const response = await fetch(`/api/user/artists/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (response.ok) {
      myArtists = myArtists.filter(a => a.id !== id);
      renderMyArtists();
    }
  } catch (err) {
    console.error('Error removing artist:', err);
  }
}

function renderMyArtists() {
  if (myArtists.length === 0) {
    elements.myArtists.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎵</div><p>Busca y agrega tus artistas favoritos</p></div>';
    return;
  }

  elements.myArtists.innerHTML = myArtists
    .map(artist => `
      <div class="tag">
        <span>${escapeHtml(artist.artist_name)}</span>
        <button class="tag-remove" data-id="${artist.id}">&times;</button>
      </div>
    `)
    .join('');

  elements.myArtists.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeArtist(parseInt(btn.dataset.id)));
  });
}

// ==========================================
// Generos
// ==========================================

function renderGenreSelector() {
  const userGenreNames = myGenres.map(g => g.genre.toLowerCase());

  elements.genreSelector.innerHTML = availableGenres
    .map(genre => {
      const isSelected = userGenreNames.includes(genre.toLowerCase());
      return `<button class="genre-option ${isSelected ? 'selected' : ''}" data-genre="${escapeHtml(genre)}">${escapeHtml(genre)}</button>`;
    })
    .join('');

  elements.genreSelector.querySelectorAll('.genre-option').forEach(btn => {
    btn.addEventListener('click', () => toggleGenre(btn.dataset.genre, btn));
  });
}

async function toggleGenre(genre, button) {
  const isSelected = button.classList.contains('selected');

  if (isSelected) {
    // Remover genero
    const genreObj = myGenres.find(g => g.genre.toLowerCase() === genre.toLowerCase());
    if (genreObj) {
      await removeGenre(genreObj.id);
      button.classList.remove('selected');
    }
  } else {
    // Agregar genero
    await addGenre(genre);
    button.classList.add('selected');
  }
}

async function addGenre(genre) {
  try {
    const response = await fetch('/api/user/genres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ genre }),
    });

    if (response.ok) {
      const data = await response.json();
      myGenres.push(data.genre);
      renderMyGenres();
    }
  } catch (err) {
    console.error('Error adding genre:', err);
  }
}

async function removeGenre(id) {
  try {
    const response = await fetch(`/api/user/genres/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (response.ok) {
      myGenres = myGenres.filter(g => g.id !== id);
      renderMyGenres();
    }
  } catch (err) {
    console.error('Error removing genre:', err);
  }
}

function renderMyGenres() {
  if (myGenres.length === 0) {
    elements.myGenres.innerHTML = '';
    return;
  }

  elements.myGenres.innerHTML = myGenres
    .map(genre => `
      <div class="tag">
        <span>${escapeHtml(genre.genre)}</span>
      </div>
    `)
    .join('');
}

// ==========================================
// Festivales Favoritos (Preferencias)
// ==========================================

// Cache de todos los festivales para búsqueda
let allFestivalsCache = null;

async function loadAllFestivalsForSearch() {
  if (allFestivalsCache) return allFestivalsCache;

  try {
    // Cargar festivales de todas las regiones
    const [europeRes, usaRes, latamRes] = await Promise.all([
      fetch('/api/festivals?region=europe'),
      fetch('/api/festivals?region=usa'),
      fetch('/api/festivals?region=latam'),
    ]);

    const europeData = await europeRes.json();
    const usaData = await usaRes.json();
    const latamData = await latamRes.json();

    allFestivalsCache = [
      ...(europeData.festivals || []),
      ...(usaData.festivals || []),
      ...(latamData.festivals || []),
    ];

    return allFestivalsCache;
  } catch (err) {
    console.error('Error loading festivals for search:', err);
    return [];
  }
}

async function handleFestivalSearch(e) {
  const query = e.target.value.trim().toLowerCase();

  clearTimeout(festivalSearchTimeout);

  if (query.length < 2) {
    elements.festivalSearchResults.style.display = 'none';
    return;
  }

  elements.festivalSearchResults.innerHTML = '<div class="search-loading">Buscando...</div>';
  elements.festivalSearchResults.style.display = 'block';

  festivalSearchTimeout = setTimeout(async () => {
    const allFestivals = await loadAllFestivalsForSearch();

    // Filtrar festivales por nombre
    const results = allFestivals.filter(f =>
      f.name.toLowerCase().includes(query) ||
      f.location.toLowerCase().includes(query)
    );

    if (results.length === 0) {
      elements.festivalSearchResults.innerHTML = '<div class="search-empty">No se encontraron festivales</div>';
      return;
    }

    elements.festivalSearchResults.innerHTML = results
      .slice(0, 10)
      .map(festival => {
        const isAlreadyFavorite = myFavoriteFestivals.includes(festival.id);
        return `
          <div class="search-result-item ${isAlreadyFavorite ? 'already-added' : ''}"
               data-id="${festival.id}"
               data-name="${escapeHtml(festival.name)}">
            <div class="search-result-name">
              ${isAlreadyFavorite ? '♥️ ' : ''}${escapeHtml(festival.name)}
            </div>
            <div class="search-result-info">
              ${getCountryFlag(festival.country)} ${escapeHtml(festival.location)}
            </div>
          </div>
        `;
      })
      .join('');

    // Event listeners para resultados
    elements.festivalSearchResults.querySelectorAll('.search-result-item:not(.already-added)').forEach(item => {
      item.addEventListener('click', async () => {
        await addFestivalToFavorites(item.dataset.id);
        elements.festivalSearch.value = '';
        elements.festivalSearchResults.style.display = 'none';
      });
    });
  }, 200);
}

async function addFestivalToFavorites(festivalId) {
  if (myFavoriteFestivals.includes(festivalId)) return;

  try {
    const response = await fetch('/api/user/favorite-festivals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ festivalId }),
    });

    if (response.ok) {
      myFavoriteFestivals.push(festivalId);
      renderMyFestivals();
      // Si estamos en la vista de resultados, actualizar el grid
      if (elements.results.style.display !== 'none') {
        const filtered = filterFestivals(festivalsData);
        renderFestivalsGrid(filtered);
      }
    }
  } catch (err) {
    console.error('Error adding festival to favorites:', err);
  }
}

async function removeFestivalFromFavorites(festivalId) {
  try {
    const response = await fetch(`/api/user/favorite-festivals/${encodeURIComponent(festivalId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (response.ok) {
      myFavoriteFestivals = myFavoriteFestivals.filter(id => id !== festivalId);
      renderMyFestivals();
      // Si estamos en la vista de resultados, actualizar el grid
      if (elements.results.style.display !== 'none') {
        const filtered = filterFestivals(festivalsData);
        renderFestivalsGrid(filtered);
      }
    }
  } catch (err) {
    console.error('Error removing festival from favorites:', err);
  }
}

async function toggleFestivalFavorite(festivalId) {
  if (myFavoriteFestivals.includes(festivalId)) {
    await removeFestivalFromFavorites(festivalId);
  } else {
    await addFestivalToFavorites(festivalId);
  }
}

async function renderMyFestivals() {
  if (!elements.myFestivals) return;

  if (myFavoriteFestivals.length === 0) {
    elements.myFestivals.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎪</div><p>Busca y agrega tus festivales favoritos</p></div>';
    return;
  }

  // Cargar info de festivales si no la tenemos
  const allFestivals = await loadAllFestivalsForSearch();

  elements.myFestivals.innerHTML = myFavoriteFestivals
    .map(festivalId => {
      const festival = allFestivals.find(f => f.id === festivalId);
      const name = festival ? festival.name : festivalId;
      const flag = festival ? getCountryFlag(festival.country) : '';
      return `
        <div class="tag festival-tag">
          <span>${flag} ${escapeHtml(name)}</span>
          <button class="tag-remove" data-id="${festivalId}">&times;</button>
        </div>
      `;
    })
    .join('');

  elements.myFestivals.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFestivalFromFavorites(btn.dataset.id));
  });
}

// ==========================================
// Festivales
// ==========================================

async function loadUserFestivals() {
  showSection('loading');

  try {
    const [artistsRes, festivalsRes] = await Promise.all([
      fetch('/api/user/artists', { credentials: 'include' }),
      fetch(`/api/user/festivals?region=${currentRegion}`, { credentials: 'include' }),
    ]);

    const artistsData = await artistsRes.json();
    const festivalsData = await festivalsRes.json();

    const artists = artistsData.artists.map(a => ({
      name: a.artist_name,
      image: null,
    }));

    renderUserArtists(artists, false);
    renderFestivals(festivalsData.festivals);
    showSection('results');
  } catch (err) {
    console.error('Error loading festivals:', err);
    showError('Error al cargar los festivales');
  }
}

// Cargar solo festivales (para cambio de región)
async function loadFestivals() {
  // Mostrar loading en el grid
  elements.festivalsGrid.innerHTML = `
    <div class="loading-festivals">
      <div class="mini-loader"></div>
      <span>Cargando festivales...</span>
    </div>
  `;

  try {
    const endpoint = isDemo
      ? `/api/demo/festivals?region=${currentRegion}`
      : `/api/user/festivals?region=${currentRegion}`;

    const response = await fetch(endpoint, isDemo ? {} : { credentials: 'include' });
    const data = await response.json();

    renderFestivals(data.festivals);
  } catch (err) {
    console.error('Error loading festivals:', err);
    elements.festivalsGrid.innerHTML = '<div class="error-state">Error al cargar los festivales</div>';
  }
}

function renderUserArtists(artists, isDemoMode) {
  const demoNotice = isDemoMode
    ? '<div class="demo-badge">Modo Demo - Artistas de ejemplo</div>'
    : '';

  if (artists.length === 0) {
    elements.artistsList.innerHTML = demoNotice + '<div class="empty-state"><p>Agrega artistas para ver tu compatibilidad</p></div>';
    return;
  }

  elements.artistsList.innerHTML = demoNotice + artists
    .slice(0, 15)
    .map(artist => `
      <div class="artist-tag">
        ${artist.image ? `<img src="${artist.image}" alt="${escapeHtml(artist.name)}" onerror="this.style.display='none'">` : ''}
        ${escapeHtml(artist.name)}
      </div>
    `)
    .join('');

  if (artists.length > 15) {
    elements.artistsList.innerHTML += `
      <div class="artist-tag" style="background: transparent; color: var(--text-muted);">
        +${artists.length - 15} mas
      </div>
    `;
  }
}

function renderFestivals(festivals) {
  // Guardar datos originales (sin filtrar)
  festivalsData = festivals;

  // Actualizar opciones de filtros
  updateCountryOptions();
  updateCityOptions();

  // Aplicar filtros y renderizar
  const filtered = filterFestivals(festivals);
  renderFestivalsGrid(filtered);
}

function renderFestivalsGrid(festivals) {
  const statusConfig = {
    'confirmed': { label: 'Lineup confirmado', class: 'confirmed' },
    'partial': { label: 'Lineup parcial', class: 'partial' },
    'unannounced': { label: 'Lineup por anunciar', class: 'unannounced' },
    'hiatus': { label: 'Sin edición 2026', class: 'hiatus' }
  };

  elements.festivalsGrid.innerHTML = festivals
    .map(festival => {
      const status = statusConfig[festival.lineupStatus] || statusConfig['unannounced'];
      const isUnannounced = festival.lineupStatus === 'unannounced';
      const isHiatus = festival.lineupStatus === 'hiatus';
      const noMatch = isUnannounced || isHiatus;
      const matchDisplay = noMatch ? 'N/A' : `${festival.matchPercentage}%`;
      const matchBarWidth = noMatch ? 0 : festival.matchPercentage;
      const isFavorite = myFavoriteFestivals.includes(festival.id);

      return `
      <div class="festival-card">
        <div class="festival-image-container">
          <img class="festival-image" src="${festival.image}" alt="${escapeHtml(festival.name)}"
               onerror="this.src='https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800'">
          ${!isDemo ? `
            <button class="favorite-btn ${isFavorite ? 'active' : ''}"
                    data-festival-id="${festival.id}"
                    title="${isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}">
              ${isFavorite ? '♥️' : '♡'}
            </button>
          ` : ''}
        </div>
        <div class="festival-content">
          <div class="festival-header">
            <div>
              <h3 class="festival-name">
                ${escapeHtml(festival.name)}
                <a href="${festival.website}" target="_blank" rel="noopener" class="festival-link-icon" title="Ir al sitio oficial">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                  </svg>
                </a>
              </h3>
              <p class="festival-location">
                <span class="flag">${getCountryFlag(festival.country)}</span>
                ${escapeHtml(festival.location)}
              </p>
            </div>
            <div class="festival-meta">
              <span class="lineup-status ${status.class}">${status.label}</span>
              <span class="festival-dates">${escapeHtml(festival.dates)}</span>
            </div>
          </div>

          <div class="match-container">
            <div class="match-header">
              <span class="match-label">Compatibilidad</span>
              <span class="match-percentage ${isUnannounced ? 'na' : ''}">${matchDisplay}</span>
            </div>
            <div class="match-bar">
              <div class="match-bar-fill" style="width: ${matchBarWidth}%"></div>
            </div>
          </div>

          ${isHiatus ? `
          <div class="artists-common hiatus-note">
            <p class="no-match">${festival.note || 'Sin edición este año'}</p>
          </div>
          ` : isUnannounced ? `
          <div class="artists-common">
            <p class="no-match">Lineup pendiente de anunciar</p>
          </div>
          ` : `
          <div class="artists-common">
            <p class="artists-common-title">
              ${festival.matchedArtists > 0
                ? `${festival.matchedArtists} artista${festival.matchedArtists > 1 ? 's' : ''} en comun:`
                : 'Sin artistas en comun'}
            </p>
            ${festival.artistsInCommon.length > 0
              ? `<div class="artists-common-list">
                  ${festival.artistsInCommon.slice(0, 8).map(artist =>
                    `<span class="artist-common-tag">${escapeHtml(artist)}</span>`
                  ).join('')}
                  ${festival.artistsInCommon.length > 8
                    ? `<span class="artist-common-tag">+${festival.artistsInCommon.length - 8}</span>`
                    : ''}
                </div>`
              : '<p class="no-match">Quizas descubras nuevos artistas</p>'
            }
          </div>
          `}

          <a href="${festival.website}" target="_blank" rel="noopener" class="festival-link">
            Ver mas info
          </a>
        </div>
      </div>
    `})
    .join('');

  // Event listeners para botones de favoritos
  elements.festivalsGrid.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFestivalFavorite(btn.dataset.festivalId);
    });
  });
}

// ==========================================
// Tabs
// ==========================================

function switchTab(tabName) {
  // Actualizar botones de tabs
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Mostrar/ocultar contenido
  elements.tabFestivals.classList.toggle('active', tabName === 'festivals');
  elements.tabArtists.classList.toggle('active', tabName === 'artists');

  // Si es tab de artistas, cargar tour dates
  if (tabName === 'artists') {
    loadArtistsTours();
  }
}

// ==========================================
// Region Selector
// ==========================================

function switchRegion(region) {
  if (region === currentRegion) return;

  currentRegion = region;

  // Reset filtros en cascada
  currentCountry = '';
  currentCity = '';
  if (elements.countryFilter) elements.countryFilter.value = '';
  if (elements.cityFilter) elements.cityFilter.value = '';

  // Actualizar botones
  elements.regionBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.region === region);
  });

  // Recargar datos con la nueva región
  if (currentUser || isDemo) {
    // Recargar festivales
    loadFestivals();

    // Limpiar cache de tours y recargar si estamos en tab de artistas
    artistTourData = {};
    if (elements.tabArtists.classList.contains('active')) {
      loadArtistsTours();
    }
  }
}

// Obtener nombre de región para mostrar
function getRegionDisplayName(region) {
  const names = {
    europe: 'Europa',
    usa: 'USA',
    latam: 'Latinoamérica'
  };
  return names[region] || region;
}

// ==========================================
// Filtros en Cascada (País/Ciudad)
// ==========================================

function updateCountryOptions() {
  if (!elements.countryFilter || !festivalsData.length) return;

  // Obtener países únicos de los festivales cargados
  const countries = [...new Set(festivalsData.map(f => f.country))].sort();

  // Contar festivales por país
  const countByCountry = {};
  festivalsData.forEach(f => {
    countByCountry[f.country] = (countByCountry[f.country] || 0) + 1;
  });

  // Generar opciones
  let html = '<option value="">Todos los países</option>';
  countries.forEach(code => {
    const info = COUNTRY_INFO[code] || { name: code, flag: '🏳️' };
    const count = countByCountry[code];
    html += `<option value="${code}">${info.flag} ${info.name} (${count})</option>`;
  });

  elements.countryFilter.innerHTML = html;
}

function updateCityOptions() {
  if (!elements.cityFilter || !festivalsData.length) return;

  // Filtrar por país si está seleccionado
  const filtered = currentCountry
    ? festivalsData.filter(f => f.country === currentCountry)
    : festivalsData;

  // Obtener ciudades únicas
  const cities = [...new Set(filtered.map(f => f.city))].sort();

  // Contar festivales por ciudad
  const countByCity = {};
  filtered.forEach(f => {
    countByCity[f.city] = (countByCity[f.city] || 0) + 1;
  });

  // Generar opciones
  let html = '<option value="">Todas las ciudades</option>';
  cities.forEach(city => {
    const count = countByCity[city];
    html += `<option value="${city}">${city} (${count})</option>`;
  });

  elements.cityFilter.innerHTML = html;
}

function handleCountryChange() {
  currentCountry = elements.countryFilter.value;
  currentCity = ''; // Reset ciudad al cambiar país
  if (elements.cityFilter) elements.cityFilter.value = '';

  updateCityOptions();
  applyFiltersAndRender();
}

function handleCityChange() {
  currentCity = elements.cityFilter.value;
  applyFiltersAndRender();
}

function filterFestivals(festivals) {
  return festivals.filter(f => {
    if (currentCountry && f.country !== currentCountry) return false;
    if (currentCity && f.city !== currentCity) return false;
    return true;
  });
}

function applyFiltersAndRender() {
  const filtered = filterFestivals(festivalsData);
  renderFestivalsGrid(filtered);
  renderCalendar(); // Actualizar calendario también
}

// ==========================================
// Calendario de Festivales
// ==========================================

function switchFestivalsView(view) {
  // Actualizar botones
  elements.viewBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Mostrar/ocultar vistas
  elements.festivalsListView?.classList.toggle('active', view === 'list');
  elements.festivalsCalendarView?.classList.toggle('active', view === 'calendar');

  // Si es calendario, renderizar
  if (view === 'calendar' && festivalsData.length > 0) {
    renderCalendar();
  }
}

function navigateCalendar(direction) {
  calendarMonth += direction;

  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  } else if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  }

  renderCalendar();
}

function renderCalendar() {
  if (!elements.calendarGrid) return;

  const monthNames = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];

  const dayNames = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

  // Actualizar titulo
  elements.calendarMonthTitle.textContent = `${monthNames[calendarMonth]} ${calendarYear}`;

  // Obtener primer día del mes y cantidad de días
  const firstDay = new Date(calendarYear, calendarMonth, 1);
  const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Ajustar para que lunes sea 0
  let startDayOfWeek = firstDay.getDay() - 1;
  if (startDayOfWeek < 0) startDayOfWeek = 6;

  // Parsear fechas de festivales (aplicando filtros)
  const filteredFestivals = filterFestivals(festivalsData);
  const festivalEvents = parseFestivalDates(filteredFestivals);

  // Construir grid
  let html = '';

  // Headers de días
  dayNames.forEach(day => {
    html += `<div class="calendar-day-header">${day}</div>`;
  });

  // Días vacíos al inicio
  for (let i = 0; i < startDayOfWeek; i++) {
    html += '<div class="calendar-day empty"></div>';
  }

  // Días del mes
  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(calendarYear, calendarMonth, day);
    const isToday = date.toDateString() === today.toDateString();
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Encontrar festivales en este día
    const dayFestivals = festivalEvents.filter(f => {
      const start = new Date(f.startDate);
      const end = new Date(f.endDate);
      return date >= start && date <= end;
    });

    html += `
      <div class="calendar-day ${isToday ? 'today' : ''}">
        <div class="calendar-day-number">${day}</div>
        <div class="calendar-events">
          ${dayFestivals.slice(0, 3).map(f => {
            const matchClass = getMatchClass(f.matchPercentage, f.lineupStatus);
            const flag = getCountryFlag(f.country);
            return `
              <a href="${f.website}" target="_blank" rel="noopener"
                 class="calendar-event ${matchClass}"
                 title="${f.name} - ${f.location}">
                <span class="calendar-event-name">${f.name}</span>
                <span class="calendar-event-location">${flag} ${f.location}</span>
              </a>
            `;
          }).join('')}
          ${dayFestivals.length > 3 ? `<span class="calendar-event low-match">+${dayFestivals.length - 3} más</span>` : ''}
        </div>
      </div>
    `;
  }

  // Días vacíos al final para completar la semana
  const totalCells = startDayOfWeek + daysInMonth;
  const remainingCells = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < remainingCells; i++) {
    html += '<div class="calendar-day empty"></div>';
  }

  elements.calendarGrid.innerHTML = html;

  // Renderizar leyenda
  renderCalendarLegend();
}

function parseFestivalDates(festivals) {
  const events = [];

  festivals.forEach(festival => {
    const dates = festival.dates;

    // Parsear diferentes formatos de fecha
    // "3-7 Junio 2026" -> startDate, endDate
    // "17-19 & 24-26 Julio 2026" -> múltiples rangos
    // "27 Junio - 4 Julio 2026" -> rango entre meses
    // "Mayo 2026" -> mes completo

    const monthMap = {
      'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3,
      'mayo': 4, 'junio': 5, 'julio': 6, 'agosto': 7,
      'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
    };

    // Caso: "Mayo 2026" (solo mes)
    const monthOnlyMatch = dates.match(/^(\w+)\s+(\d{4})$/i);
    if (monthOnlyMatch) {
      const month = monthMap[monthOnlyMatch[1].toLowerCase()];
      const year = parseInt(monthOnlyMatch[2]);
      if (month !== undefined) {
        events.push({
          ...festival,
          startDate: new Date(year, month, 1),
          endDate: new Date(year, month + 1, 0)
        });
      }
      return;
    }

    // Caso: "27 Junio - 4 Julio 2026" (rango entre meses)
    const crossMonthMatch = dates.match(/(\d+)\s+(\w+)\s*-\s*(\d+)\s+(\w+)\s+(\d{4})/i);
    if (crossMonthMatch) {
      const startDay = parseInt(crossMonthMatch[1]);
      const startMonth = monthMap[crossMonthMatch[2].toLowerCase()];
      const endDay = parseInt(crossMonthMatch[3]);
      const endMonth = monthMap[crossMonthMatch[4].toLowerCase()];
      const year = parseInt(crossMonthMatch[5]);

      if (startMonth !== undefined && endMonth !== undefined) {
        events.push({
          ...festival,
          startDate: new Date(year, startMonth, startDay),
          endDate: new Date(year, endMonth, endDay)
        });
      }
      return;
    }

    // Caso: "17-19 & 24-26 Julio 2026" (múltiples rangos)
    if (dates.includes('&')) {
      const parts = dates.split('&');
      const yearMatch = dates.match(/(\d{4})/);
      const monthMatch = dates.match(/(\w+)\s+\d{4}/i);

      if (yearMatch && monthMatch) {
        const year = parseInt(yearMatch[1]);
        const month = monthMap[monthMatch[1].toLowerCase()];

        if (month !== undefined) {
          parts.forEach(part => {
            const rangeMatch = part.trim().match(/(\d+)-(\d+)/);
            if (rangeMatch) {
              events.push({
                ...festival,
                startDate: new Date(year, month, parseInt(rangeMatch[1])),
                endDate: new Date(year, month, parseInt(rangeMatch[2]))
              });
            }
          });
        }
      }
      return;
    }

    // Caso: "3-7 Junio 2026" (rango simple)
    const simpleRangeMatch = dates.match(/(\d+)-(\d+)\s+(\w+)\s+(\d{4})/i);
    if (simpleRangeMatch) {
      const startDay = parseInt(simpleRangeMatch[1]);
      const endDay = parseInt(simpleRangeMatch[2]);
      const month = monthMap[simpleRangeMatch[3].toLowerCase()];
      const year = parseInt(simpleRangeMatch[4]);

      if (month !== undefined) {
        events.push({
          ...festival,
          startDate: new Date(year, month, startDay),
          endDate: new Date(year, month, endDay)
        });
      }
      return;
    }

    // Caso: "26-28 Junio 2026" (otro formato simple)
    const altRangeMatch = dates.match(/(\d+)-(\d+)\s+(\w+)\s+(\d{4})/i);
    if (altRangeMatch) {
      const startDay = parseInt(altRangeMatch[1]);
      const endDay = parseInt(altRangeMatch[2]);
      const month = monthMap[altRangeMatch[3].toLowerCase()];
      const year = parseInt(altRangeMatch[4]);

      if (month !== undefined) {
        events.push({
          ...festival,
          startDate: new Date(year, month, startDay),
          endDate: new Date(year, month, endDay)
        });
      }
    }
  });

  return events;
}

function getMatchClass(matchPercentage, lineupStatus) {
  if (lineupStatus === 'unannounced') return 'unannounced';
  if (lineupStatus === 'hiatus') return 'hiatus';
  if (matchPercentage >= 20) return 'high-match';
  if (matchPercentage >= 5) return 'medium-match';
  return 'low-match';
}

function renderCalendarLegend() {
  if (!elements.calendarLegend) return;

  elements.calendarLegend.innerHTML = `
    <div class="legend-item">
      <div class="legend-color high"></div>
      <span>Alta compatibilidad (20%+)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color medium"></div>
      <span>Media compatibilidad (5-20%)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color low"></div>
      <span>Baja compatibilidad (&lt;5%)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color unannounced"></div>
      <span>Lineup por anunciar</span>
    </div>
  `;
}

// ==========================================
// Artistas con Tour Dates
// ==========================================

function handleArtistSearchTab(e) {
  const query = e.target.value.trim();

  clearTimeout(searchTimeoutTab);

  if (query.length < 2) {
    elements.searchResultsTab.style.display = 'none';
    return;
  }

  elements.searchResultsTab.innerHTML = '<div class="search-loading">Buscando...</div>';
  elements.searchResultsTab.style.display = 'block';

  searchTimeoutTab = setTimeout(() => searchArtistsForTab(query), 300);
}

async function searchArtistsForTab(query) {
  try {
    const response = await fetch(`/api/search/artists?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.artists.length === 0) {
      elements.searchResultsTab.innerHTML = '<div class="search-empty">No se encontraron artistas</div>';
      return;
    }

    elements.searchResultsTab.innerHTML = data.artists
      .map(artist => `
        <div class="search-result-item" data-id="${artist.id}" data-name="${escapeHtml(artist.name)}">
          <div class="search-result-name">${escapeHtml(artist.name)}</div>
          ${artist.disambiguation || artist.country
            ? `<div class="search-result-info">${escapeHtml(artist.disambiguation || '')} ${artist.country ? `(${artist.country})` : ''}</div>`
            : ''
          }
        </div>
      `)
      .join('');

    // Event listeners para resultados
    elements.searchResultsTab.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', async () => {
        await addArtist(item.dataset.name, item.dataset.id);
        elements.artistSearchTab.value = '';
        elements.searchResultsTab.style.display = 'none';
        // Recargar lista de artistas con tours
        loadArtistsTours();
      });
    });
  } catch (err) {
    console.error('Error searching artists:', err);
    elements.searchResultsTab.innerHTML = '<div class="search-empty">Error al buscar</div>';
  }
}

async function loadArtistsTours() {
  // Usar artistas del usuario o demo
  const artists = isDemo ? demoArtistNames : myArtists.map(a => a.artist_name);

  if (artists.length === 0) {
    elements.artistsTours.innerHTML = `
      <div class="artists-empty">
        <div class="artists-empty-icon">🎤</div>
        <p class="artists-empty-title">No tienes artistas guardados</p>
        <p class="artists-empty-text">Busca y agrega artistas para ver sus fechas de gira</p>
      </div>
    `;
    return;
  }

  // Renderizar cards con loading state
  elements.artistsTours.innerHTML = artists.map(artistName => `
    <div class="artist-tour-card" data-artist="${escapeHtml(artistName)}">
      <div class="artist-tour-header">
        <div class="artist-tour-info">
          <span class="artist-tour-icon">🎸</span>
          <span class="artist-tour-name">${escapeHtml(artistName)}</span>
        </div>
        ${!isDemo ? `<button class="artist-tour-remove" data-name="${escapeHtml(artistName)}" title="Eliminar artista">&times;</button>` : ''}
      </div>
      <div class="artist-tour-content">
        <div class="tour-dates-loading">
          <div class="mini-loader"></div>
          <span>Buscando conciertos en ${getRegionDisplayName(currentRegion)}...</span>
        </div>
      </div>
    </div>
  `).join('');

  // Agregar event listeners para eliminar
  if (!isDemo) {
    elements.artistsTours.querySelectorAll('.artist-tour-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const artistName = btn.dataset.name;
        const artist = myArtists.find(a => a.artist_name === artistName);
        if (artist) {
          await removeArtist(artist.id);
          loadArtistsTours();
        }
      });
    });
  }

  // Cargar tour dates para cada artista
  for (const artistName of artists) {
    await loadArtistTourDates(artistName);
  }
}

async function loadArtistTourDates(artistName) {
  // Buscar la card comparando directamente (evita problemas con & y otros caracteres especiales)
  const cards = elements.artistsTours.querySelectorAll('.artist-tour-card');
  const card = Array.from(cards).find(c => c.dataset.artist === artistName);
  if (!card) return;

  const contentDiv = card.querySelector('.artist-tour-content');
  const regionName = getRegionDisplayName(currentRegion);

  try {
    const response = await fetch(`/api/artist-events/${encodeURIComponent(artistName)}?region=${currentRegion}`);
    const data = await response.json();

    artistTourData[artistName] = data;

    let html = '';

    // Mostrar tour dates si hay
    if (data.events && data.events.length > 0) {
      html += `
        <p class="tour-dates-title">Próximos conciertos en ${regionName}</p>
        <div class="tour-dates-list">
          ${data.events.slice(0, 5).map(event => `
            <div class="tour-date-item">
              <span class="tour-date-date">${formatTourDate(event.date)}</span>
              <div class="tour-date-venue">
                <div class="tour-date-venue-name">${escapeHtml(event.venue)}</div>
                <div class="tour-date-location">
                  <span class="flag">${getCountryFlagByName(event.country)}</span>
                  ${escapeHtml(event.city)}, ${escapeHtml(event.country)}
                </div>
              </div>
              ${event.url ? `<a href="${event.url}" target="_blank" rel="noopener" class="tour-date-link">Tickets</a>` : ''}
            </div>
          `).join('')}
        </div>
        ${data.totalRegionEvents > 5 ? `
          <a href="${data.bandsintownUrl || `https://www.bandsintown.com/a/${encodeURIComponent(artistName)}`}" target="_blank" rel="noopener" class="tour-dates-view-all">
            Ver los ${data.totalRegionEvents} conciertos →
          </a>
        ` : ''}
      `;
    }

    // Mostrar festivales si hay
    if (data.festivalAppearances && data.festivalAppearances.length > 0) {
      html += `
        <div class="festival-appearances ${data.events?.length > 0 ? 'has-tours' : ''}">
          <p class="tour-dates-title">🎪 En festivales ${currentYear}</p>
          <div class="festival-appearances-list">
            ${data.festivalAppearances.map(fest => `
              <a href="${fest.website}" target="_blank" rel="noopener" class="festival-appearance-item">
                <span class="festival-appearance-name">${escapeHtml(fest.name)}</span>
                <span class="festival-appearance-info">${escapeHtml(fest.dates)} • ${escapeHtml(fest.location)}</span>
              </a>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Si no hay nada en la región seleccionada
    if (!html) {
      // Ver si tiene tours en otras regiones
      const otherRegionsHtml = data.otherRegionsWithEvents && data.otherRegionsWithEvents.length > 0
        ? `<div class="other-regions-info">
            🌍 En tour por: ${data.otherRegionsWithEvents.map(r => getRegionDisplayName(r)).join(', ')}
           </div>`
        : '';

      html = `
        <div class="no-tour-dates">
          <span class="no-tour-dates-icon">📅</span>
          <div class="no-tour-dates-text">
            <span>Sin fechas encontradas en ${regionName}</span>
            ${otherRegionsHtml}
            <a href="https://www.google.com/search?q=${encodeURIComponent(artistName + ' tour ' + currentYear)}" target="_blank" rel="noopener" class="search-tour-link">
              Buscar tour →
            </a>
          </div>
        </div>
      `;
    }

    contentDiv.innerHTML = html;

  } catch (err) {
    console.error(`Error loading tour dates for ${artistName}:`, err);
    contentDiv.innerHTML = `
      <div class="no-tour-dates">
        <span class="no-tour-dates-icon">⚠️</span>
        <div class="no-tour-dates-text">
          <span>No se pudieron cargar las fechas</span>
          <a href="https://www.google.com/search?q=${encodeURIComponent(artistName + ' tour 2026')}" target="_blank" rel="noopener" class="search-tour-link">
            Buscar tour →
          </a>
        </div>
      </div>
    `;
  }
}

// Lista de artistas demo para tour dates
const demoArtistNames = [
  'Charli XCX', 'Dua Lipa', 'Fred Again..', 'Bicep', 'The 1975',
  'Arctic Monkeys', 'Tame Impala', 'Disclosure', 'Fontaines D.C.', 'Jamie xx'
];

function formatTourDate(dateString) {
  const date = new Date(dateString);
  const options = { day: 'numeric', month: 'short' };
  return date.toLocaleDateString('es-ES', options);
}

function getCountryFlagByName(countryName) {
  const flags = {
    'Germany': '🇩🇪', 'France': '🇫🇷', 'Spain': '🇪🇸', 'Italy': '🇮🇹',
    'Netherlands': '🇳🇱', 'Belgium': '🇧🇪', 'Portugal': '🇵🇹',
    'United Kingdom': '🇬🇧', 'Ireland': '🇮🇪', 'Denmark': '🇩🇰',
    'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Finland': '🇫🇮', 'Poland': '🇵🇱',
    'Austria': '🇦🇹', 'Switzerland': '🇨🇭', 'Czech Republic': '🇨🇿',
    'Czechia': '🇨🇿', 'Hungary': '🇭🇺', 'Croatia': '🇭🇷', 'Serbia': '🇷🇸',
    'Greece': '🇬🇷', 'Romania': '🇷🇴', 'Bulgaria': '🇧🇬',
    'Slovakia': '🇸🇰', 'Slovenia': '🇸🇮', 'Estonia': '🇪🇪',
    'Latvia': '🇱🇻', 'Lithuania': '🇱🇹', 'Luxembourg': '🇱🇺',
    'Iceland': '🇮🇸', 'Turkey': '🇹🇷', 'Ukraine': '🇺🇦', 'Russia': '🇷🇺',
  };
  return flags[countryName] || '🌍';
}

// ==========================================
// Utilidades
// ==========================================

function showError(message) {
  elements.errorMessage.textContent = message;
  showSection('error');
}

function getErrorMessage(error) {
  const messages = {
    'access_denied': 'Acceso denegado. Necesitas autorizar la aplicacion.',
    'auth_failed': 'Error de autenticacion. Intentalo de nuevo.',
    'token_error': 'Error de autenticacion. Intentalo de nuevo.',
  };
  return messages[error] || 'Ocurrio un error inesperado.';
}

function getCountryFlag(countryCode) {
  const flags = {
    'ES': '🇪🇸', 'BE': '🇧🇪', 'DE': '🇩🇪', 'GB': '🇬🇧',
    'HU': '🇭🇺', 'RS': '🇷🇸', 'DK': '🇩🇰', 'NL': '🇳🇱',
    'PT': '🇵🇹', 'FI': '🇫🇮', 'PL': '🇵🇱', 'HR': '🇭🇷',
  };
  return flags[countryCode] || '🌍';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
