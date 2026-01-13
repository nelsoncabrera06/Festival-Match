// i18n.js - Sistema de internacionalización para Festival Match

const I18N = {
  // Idiomas disponibles
  LANGUAGES: {
    es: { code: 'es', name: 'Español', flag: '🇪🇸' },
    en: { code: 'en', name: 'English', flag: '🇬🇧' },
    fi: { code: 'fi', name: 'Suomi', flag: '🇫🇮' }
  },

  // Idioma actual
  currentLang: 'es',

  // Cache de traducciones
  translations: {},

  // Inicializar el sistema i18n
  async init() {
    // Detectar idioma guardado o del navegador
    const savedLang = localStorage.getItem('festival-match-lang');
    if (savedLang && this.LANGUAGES[savedLang]) {
      this.currentLang = savedLang;
    } else {
      // Detectar del navegador
      const browserLang = navigator.language.split('-')[0];
      if (this.LANGUAGES[browserLang]) {
        this.currentLang = browserLang;
      } else {
        this.currentLang = 'es'; // Default español
      }
    }

    // Cargar traducciones
    await this.loadTranslations(this.currentLang);

    // Aplicar traducciones al DOM
    this.updateDOM();

    // Renderizar selector de idioma
    this.renderLanguageSelector();
  },

  // Cargar archivo de traducciones
  async loadTranslations(lang) {
    if (this.translations[lang]) {
      return; // Ya está cargado
    }

    try {
      const response = await fetch(`/i18n/${lang}.json`);
      if (response.ok) {
        this.translations[lang] = await response.json();
      } else {
        console.error(`Failed to load translations for ${lang}`);
        // Fallback a español
        if (lang !== 'es') {
          await this.loadTranslations('es');
          this.translations[lang] = this.translations['es'];
        }
      }
    } catch (err) {
      console.error(`Error loading translations for ${lang}:`, err);
      // Fallback vacío
      this.translations[lang] = {};
    }
  },

  // Obtener una traducción por key (ej: 't("landing.title")')
  t(key, params = {}) {
    const keys = key.split('.');
    let value = this.translations[this.currentLang];

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        // Fallback a español si no existe
        value = this.getFromFallback(key);
        break;
      }
    }

    // Si es string, reemplazar parámetros {param}
    if (typeof value === 'string') {
      for (const [param, val] of Object.entries(params)) {
        value = value.replace(new RegExp(`{${param}}`, 'g'), val);
      }
    }

    return value || key; // Retornar key si no se encuentra
  },

  // Obtener traducción del idioma fallback (español)
  getFromFallback(key) {
    const keys = key.split('.');
    let value = this.translations['es'];

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return null;
      }
    }

    return value;
  },

  // Cambiar idioma
  async setLanguage(lang) {
    if (!this.LANGUAGES[lang]) {
      console.error(`Language ${lang} not supported`);
      return;
    }

    this.currentLang = lang;
    localStorage.setItem('festival-match-lang', lang);

    // Cargar traducciones si no están cargadas
    await this.loadTranslations(lang);

    // Actualizar el DOM
    this.updateDOM();

    // Actualizar el atributo lang del HTML
    document.documentElement.lang = lang;

    // Actualizar selector de idioma
    this.updateLanguageSelector();

    // Disparar evento personalizado para que app.js pueda reaccionar
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
  },

  // Actualizar elementos del DOM con data-i18n
  updateDOM() {
    // Elementos con data-i18n (contenido de texto)
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translation = this.t(key);
      if (translation) {
        // Si tiene HTML (ej: spans con clase), usar innerHTML, sino textContent
        if (translation.includes('<')) {
          el.innerHTML = translation;
        } else {
          el.textContent = translation;
        }
      }
    });

    // Elementos con data-i18n-placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translation = this.t(key);
      if (translation) {
        el.placeholder = translation;
      }
    });

    // Elementos con data-i18n-title (para tooltips)
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translation = this.t(key);
      if (translation) {
        el.title = translation;
      }
    });

    // Actualizar titulo de la página
    const appTitle = this.t('app.title');
    const appSubtitle = this.t('app.subtitle');
    if (appTitle && appSubtitle) {
      document.title = `${appTitle} - ${appSubtitle}`;
    }
  },

  // Renderizar selector de idioma en el header
  renderLanguageSelector() {
    const nav = document.querySelector('.nav');
    if (!nav) return;

    // Crear contenedor del selector dropdown
    const selector = document.createElement('div');
    selector.className = 'language-selector';
    selector.id = 'language-selector';

    // Botón que muestra el globo
    const currentLang = this.LANGUAGES[this.currentLang];
    selector.innerHTML = `
      <button class="lang-toggle" title="Change language">
        🌐
      </button>
      <div class="lang-dropdown">
        <button class="lang-option ${this.currentLang === 'es' ? 'active' : ''}" data-lang="es">Spanish</button>
        <button class="lang-option ${this.currentLang === 'en' ? 'active' : ''}" data-lang="en">English</button>
        <button class="lang-option ${this.currentLang === 'fi' ? 'active' : ''}" data-lang="fi">Finnish</button>
      </div>
    `;

    // Insertar al final del nav (al lado de logout)
    nav.appendChild(selector);

    // Event listener para toggle del dropdown
    const toggleBtn = selector.querySelector('.lang-toggle');
    const dropdown = selector.querySelector('.lang-dropdown');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Event listeners para opciones
    selector.querySelectorAll('.lang-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        this.setLanguage(lang);
        dropdown.classList.remove('open');
      });
    });

    // Cerrar dropdown al hacer click fuera
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
    });
  },

  // Actualizar estado visual del selector
  updateLanguageSelector() {
    const selector = document.getElementById('language-selector');
    if (!selector) return;

    selector.querySelectorAll('.lang-option').forEach(btn => {
      const lang = btn.getAttribute('data-lang');
      btn.classList.toggle('active', lang === this.currentLang);
    });
  },

  // Obtener idioma actual
  getLang() {
    return this.currentLang;
  },

  // Obtener información del idioma actual
  getCurrentLanguageInfo() {
    return this.LANGUAGES[this.currentLang];
  }
};

// Alias global para uso fácil
function t(key, params) {
  return I18N.t(key, params);
}

// Exponer globalmente
window.I18N = I18N;
window.t = t;
