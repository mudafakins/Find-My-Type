'use strict';
/*
 * Find My Type — preview a company name in every font you have.
 *
 * Runs in three environments:
 *   1. The native Mac app (native/FindMyType.swift) — provides window.nativeFontCatalog
 *      and window.nativeDownload bridges.
 *   2. serve.py in any browser — provides /api/local-fonts.
 *   3. Chrome/Edge with the Local Font Access API (window.queryLocalFonts).
 */

/* =========================================================================
   Constants
   ========================================================================= */

const STORAGE_KEY = 'typefolio'; // kept from the MVP so saved favourites survive
const HISTORY_KEY = 'find-my-type-font-history';
const PAGE_SIZE = 24;
const DEFAULT_WORD = 'Forma';
const ALL = 'All fonts';
const FAVOURITES = 'Favourites';
const CATEGORIES = [ALL, FAVOURITES, 'Serif', 'Sans serif', 'Display', 'Handwriting', 'Monospace', 'Condensed', 'Tall', 'Bold', 'Variable'];

// Google fonts shown first, in this order. Everything else follows alphabetically.
const FEATURED = ['DM Sans', 'Playfair Display', 'Space Grotesk', 'Bodoni Moda', 'Cormorant Garamond', 'Montserrat', 'Bebas Neue', 'Manrope', 'Libre Baskerville', 'Oswald', 'Italiana', 'Lora'];

// One icon set: 24×24 grid, 1.75 stroke, round caps — matches the icons in index.html.
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// Default card colours for each theme (applied when the theme changes).
const CARD_COLOURS = {
  light: { ink: '#1a1a1a', paper: '#ffffff' },
  dark: { ink: '#f0f0f0', paper: '#242424' },
};

const ICONS = {
  shuffle: svg('<path d="M3 6h3c5 0 7 12 12 12h3M18 15l3 3-3 3M3 18h3c2 0 4-2 5-4M14 9c1-2 3-3 4-3h3M18 3l3 3-3 3"/>'),
  download: svg('<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-9.2-9.1C1.7 7.8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.3 3.3 4.2 6.4C19.5 15.4 12 20 12 20Z"/>'),
  reset: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 3.5v4.5H8"/>'),
  italic: svg('<path d="M10 4h9M5 20h9M15 4 9 20"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
};

/* =========================================================================
   DOM helpers
   ========================================================================= */

const $ = (selector) => document.querySelector(selector);

/**
 * Tiny element builder. Children are appended first so that properties like a
 * <select>'s value can refer to them. Keys starting with "on" become listeners;
 * keys the element knows become properties; anything else becomes an attribute.
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  node.append(...children);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  return node;
}

const el = {
  word: $('#word'),
  ink: $('#ink'),
  paper: $('#paper'),
  size: $('#size'),
  sizeValue: $('#sizevalue'),
  search: $('#search'),
  filters: $('#filters'),
  sortControls: $('#sort-controls'),
  count: $('#count'),
  grid: $('#grid'),
  sentinel: $('#sentinel'),
  status: $('#status'),
  exportButton: $('#export'),
  theme: $('#theme'),
  connect: $('#connect'),
  import: $('#import'),
  files: $('#files'),
  clearFavourites: $('#clear-favourites'),
  clearSearch: $('#clear-search'),
};

const message = (text) => { el.status.textContent = text; };

/* =========================================================================
   State + persistence
   ========================================================================= */

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

const saved = loadSaved();

const state = {
  favorites: new Set(saved.favorites || []),
  settings: saved.settings || {}, // per-font { weight, italic, spacing }
  source: 'local',                 // 'google' | 'local'
  filter: ALL,
  view: saved.view === 'list' ? 'list' : 'grid', // 'grid' | 'list'
  sort: 'suggested',               // 'suggested' | 'shuffle' | 'newest'
  randomOrder: null,               // Map<fontId, rank> while shuffled
  googleFonts: [],
  localFonts: [],
  visible: [],
  page: 0,
};

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      favorites: [...state.favorites],
      settings: state.settings,
      word: el.word.value,
      ink: el.ink.value,
      paper: el.paper.value,
      size: el.size.value,
      dark: document.body.classList.contains('dark'),
      view: state.view,
    }));
  } catch { /* storage full or unavailable — non-fatal */ }
}

for (const key of ['word', 'ink', 'paper', 'size']) if (saved[key]) el[key].value = saved[key];

// Theme: use the saved choice, otherwise follow the system on first launch.
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
if (saved.dark ?? systemDark) document.body.classList.add('dark');
if (saved.dark === undefined) {
  const colours = CARD_COLOURS[systemDark ? 'dark' : 'light'];
  if (!saved.ink) el.ink.value = colours.ink;
  if (!saved.paper) el.paper.value = colours.paper;
}
el.sizeValue.textContent = el.size.value;

/* =========================================================================
   Font model helpers
   ========================================================================= */

const fontId = (f) => f.source + ':' + f.family;
const isDark = () => document.body.classList.contains('dark');
const previewWord = () => el.word.value || DEFAULT_WORD;
const currentList = () => (state.source === 'google' ? state.googleFonts : state.localFonts);
const cssFamily = (f) => JSON.stringify(f.alias || f.family);

function defaultSettings(f) {
  return { weight: f.weights.includes(400) ? 400 : f.weights[0], italic: false, spacing: 0 };
}

function settingsFor(f) {
  const key = fontId(f);
  if (!state.settings[key]) state.settings[key] = defaultSettings(f);
  return state.settings[key];
}

/** Filter tags (cached per font). Condensed/Tall are guesses from the family name. */
function tags(f) {
  if (f._tags) return f._tags;
  const result = f._tags = [f.category];
  if (/condensed|narrow|compressed/i.test(f.family)) result.push('Condensed');
  if (/tall|bebas|oswald|anton|condensed/i.test(f.family)) result.push('Tall');
  if (f.weights.some((w) => w >= 700)) result.push('Bold');
  if (f.variable) result.push('Variable');
  return result;
}

/** Local fonts have no category metadata, so estimate it from the name. */
function inferCategory(name) {
  if (/mono|courier|console|menlo/i.test(name)) return 'Monospace';
  if (/script|hand|brush|chancery/i.test(name)) return 'Handwriting';
  if (/serif|times|georgia|baskerville|didot|garamond|palatino/i.test(name) && !/sans/i.test(name)) return 'Serif';
  return 'Sans serif';
}

function weightFromStyle(style) {
  if (/black|heavy/i.test(style)) return 900;
  if (/extra.*bold/i.test(style)) return 800;
  if (/semi.*bold|demi/i.test(style)) return 600;
  if (/bold/i.test(style)) return 700;
  if (/medium/i.test(style)) return 500;
  if (/extra.*light/i.test(style)) return 200;
  if (/light/i.test(style)) return 300;
  if (/thin/i.test(style)) return 100;
  return 400;
}

function sortFamilies(map) {
  return [...map.values()]
    .map((f) => ({ ...f, weights: f.weights.sort((a, b) => a - b) }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Remember when each local family was first seen, so "Newly installed" works
 * for fonts without a file date. Families present on the very first scan get 0.
 */
function trackLocalFontDates() {
  if (!state.localFonts.length) return;
  let history;
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null'); } catch { history = null; }
  const firstScan = history === null;
  history = history || {};
  for (const f of state.localFonts) {
    if (!(f.family in history)) history[f.family] = firstScan ? 0 : Date.now();
    if (!f.installedAt) f.installedAt = history[f.family];
  }
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* non-fatal */ }
}

/* =========================================================================
   Google Fonts loading
   ========================================================================= */

const googleStylesheets = new Map(); // family -> Promise that settles when its CSS has loaded

/** Add the Google Fonts stylesheet for a family once; resolves when it has loaded. */
function loadGoogleStylesheet(f) {
  if (f.source !== 'google') return Promise.resolve();
  if (!googleStylesheets.has(f.family)) {
    const family = encodeURIComponent(f.family).replace(/%20/g, '+');
    const link = h('link', {
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?family=${family}:wght@${f.weights.join(';')}&display=swap`,
    });
    const ready = new Promise((resolve, reject) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => {
        googleStylesheets.delete(f.family); // allow a retry later
        link.remove();
        reject(new Error('Font stylesheet failed: ' + f.family));
      }, { once: true });
    });
    googleStylesheets.set(f.family, ready);
    document.head.append(link);
  }
  return googleStylesheets.get(f.family);
}

const fontSpec = (f, s, px = 40) => `${s.italic ? 'italic ' : ''}${s.weight} ${px}px ${cssFamily(f)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms, message = 'Timed out') {
  return Promise.race([promise, delay(ms).then(() => { throw new Error(message); })]);
}

/** Show a placeholder until the card's face is ready, then reveal the sample. */
async function loadCardFont(card) {
  const f = card._font;
  try {
    await withTimeout(loadGoogleStylesheet(f), 15000);
    // Font files can be slow; after 8s reveal anyway (browser falls back, then swaps in).
    await Promise.race([document.fonts.load(fontSpec(f, settingsFor(f)), previewWord()), delay(8000)]);
  } catch {
    card.classList.add('failed');
    card.querySelector('.card-meta').textContent = 'Font unavailable · check connection';
  }
  card.classList.remove('loading');
  updateCard(card);
}

// Start loading a card's font when it scrolls near the viewport.
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    cardObserver.unobserve(entry.target);
    loadCardFont(entry.target);
  }
}, { rootMargin: '350px' });

/* =========================================================================
   Toolbar: category filters + sorting
   ========================================================================= */

const SORTS = [
  { id: 'suggested', label: 'Suggested', title: 'Popular picks first, then A–Z (local fonts: A–Z)' },
  { id: 'shuffle', label: 'Shuffle', icon: 'shuffle', title: 'Random order — click again to reshuffle' },
  { id: 'newest', label: 'Newest', icon: 'clock', title: 'Newest installed local fonts first. Dates are estimates; fonts without dates use first detection after the initial scan.' },
];

const filterButtons = new Map(); // category -> { button, count }

/** Build the category chips and sort control once; render() keeps them in sync. */
function buildToolbar() {
  for (const category of CATEGORIES) {
    const count = h('span', { className: 'count' });
    const label = category === FAVOURITES ? h('span', { innerHTML: ICONS.heart + '<span>Favourites</span>', className: 'chip-label' }) : h('span', { textContent: category });
    const button = h('button', {
      'aria-pressed': false,
      onClick: () => { state.filter = category; render(); },
    }, label, count);
    filterButtons.set(category, { button, count });
    el.filters.append(button);
  }

  el.sortControls.append(...SORTS.map((sort) => h('button', {
    innerHTML: (sort.icon ? ICONS[sort.icon] : '') + `<span>${sort.label}</span>`,
    title: sort.title,
    'data-sort': sort.id,
    onClick: () => setSort(sort.id),
  })));
}

/** Update chip counts (for the current source + search) and active states. */
function syncToolbar(query) {
  const counts = new Map(CATEGORIES.map((c) => [c, 0]));
  for (const f of currentList()) {
    if (!f.family.toLowerCase().includes(query)) continue;
    counts.set(ALL, counts.get(ALL) + 1);
    if (state.favorites.has(fontId(f))) counts.set(FAVOURITES, counts.get(FAVOURITES) + 1);
    for (const tag of tags(f)) if (counts.has(tag)) counts.set(tag, counts.get(tag) + 1);
  }
  for (const [category, { button, count }] of filterButtons) {
    const active = category === state.filter;
    const n = counts.get(category);
    button.classList.toggle('active', active);
    button.classList.toggle('empty-chip', n === 0 && !active);
    button.setAttribute('aria-pressed', active);
    count.textContent = n.toLocaleString();
  }
  for (const button of el.sortControls.children) {
    const on = button.dataset.sort === state.sort;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', on);
  }
}

function shuffleOrder() {
  // Rank every font in both sources, so switching source keeps a shuffled order.
  const ids = [...state.googleFonts, ...state.localFonts].map(fontId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  state.randomOrder = new Map(ids.map((key, i) => [key, i]));
}

function setSort(sort) {
  state.sort = sort;
  state.randomOrder = null;
  if (sort === 'shuffle') shuffleOrder(); // clicking Shuffle again reshuffles
  if (sort === 'newest' && state.source !== 'local') {
    setSource('local'); // newest only makes sense for installed fonts
    message('Showing your newest installed fonts first.');
    return;
  }
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setSource(source) {
  state.source = source;
  document.querySelectorAll('[data-source]').forEach((b) => b.classList.toggle('active', b.dataset.source === source));
  moveTabIndicator();
  render();
}

/* =========================================================================
   Grid / list view
   ========================================================================= */

function setView(view) {
  state.view = view;
  el.grid.classList.toggle('list', view === 'list');
  document.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
  refreshAllCards();
  persist();
}

/* =========================================================================
   Shell: sliding tab indicator, condensing header
   ========================================================================= */

const tabIndicator = $('.tab-indicator');

/** Slide the indicator under the active source tab. */
function moveTabIndicator() {
  const active = $('.source-tabs button.active');
  if (!active || !tabIndicator) return;
  tabIndicator.style.width = active.offsetWidth + 'px';
  tabIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

// Condense the sticky header once the page scrolls past the top.
new IntersectionObserver(([entry]) => {
  $('.app-header').classList.toggle('condensed', !entry.isIntersecting);
}).observe($('#top-sentinel'));

/* =========================================================================
   Grid rendering
   ========================================================================= */

function matchesFilters(f, query) {
  const inCategory = state.filter === ALL
    || (state.filter === FAVOURITES && state.favorites.has(fontId(f)))
    || tags(f).includes(state.filter);
  return inCategory && f.family.toLowerCase().includes(query);
}

function render() {
  trackLocalFontDates();
  const query = el.search.value.trim().toLowerCase();
  syncToolbar(query);
  syncSearch();
  state.visible = currentList().filter((f) => matchesFilters(f, query));

  if (state.sort === 'newest') {
    state.visible.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0) || a.family.localeCompare(b.family));
  } else if (state.sort === 'shuffle' && state.randomOrder) {
    const rank = (f) => state.randomOrder.get(fontId(f)) ?? Number.MAX_SAFE_INTEGER;
    state.visible.sort((a, b) => rank(a) - rank(b));
  }

  el.count.textContent = `${state.visible.length} font families · ${state.source === 'google' ? 'Google Fonts' : 'Local fonts'}`;
  el.grid.replaceChildren();
  state.page = 0;

  if (!state.visible.length) {
    el.grid.append(h('div', {
      className: 'empty',
      textContent: state.source === 'local' && !state.localFonts.length
        ? 'Connect your installed fonts, or import font files to get started.'
        : 'No fonts match. Try another filter or search.',
    }));
  }
  appendPage();
}

function appendPage() {
  for (const f of state.visible.slice(state.page, state.page + PAGE_SIZE)) {
    const card = createCard(f);
    el.grid.append(card);
    updateCard(card);
    cardObserver.observe(card);
  }
  state.page += PAGE_SIZE;
}

// Infinite scroll
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.page < state.visible.length) appendPage();
}, { rootMargin: '400px' }).observe(el.sentinel);

const weightName = (w) => ({ 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' })[w] || '';
const formatTracking = (v) => (v > 0 ? '+' : '') + v.toFixed(1);
const isDefault = (f, s) => { const d = defaultSettings(f); return s.weight === d.weight && s.italic === d.italic && s.spacing === d.spacing; };

function createCard(f) {
  const key = fontId(f);
  const s = settingsFor(f);
  const card = h('article', { className: 'card loading' });
  card._font = f;

  // Header: name, details, favourite
  const heart = h('button', { className: 'heart', innerHTML: ICONS.heart, 'aria-label': 'Favourite ' + f.family });
  const syncHeart = () => {
    const on = state.favorites.has(key);
    heart.classList.toggle('saved', on);
    heart.setAttribute('aria-pressed', on);
    heart.title = on ? 'Remove from favourites' : 'Add to favourites';
  };
  heart.addEventListener('click', () => {
    if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
    persist();
    if (state.filter === FAVOURITES) render(); else syncHeart();
    heart.classList.toggle('pop', state.favorites.has(key)); // animate only on click
  });
  syncHeart();

  const details = [f.category, `${f.weights.length} ${f.weights.length === 1 ? 'weight' : 'weights'}`];
  if (f.variable) details.push('Variable');
  const head = h('div', { className: 'card-head' },
    h('div', { className: 'card-title' },
      h('strong', { textContent: f.family, title: f.family }),
      h('span', { className: 'card-meta', textContent: details.join(' · ') }),
    ),
    heart,
  );

  // Preview: uppercase + lowercase lines
  const sample = h('div', { className: 'sample' }, h('div'), h('div'));

  // Per-font options: weight, italic, tracking, reset
  const weight = h('select', {
    'aria-label': f.family + ' weight',
    disabled: f.weights.length < 2,
    onChange: () => { s.weight = +weight.value; save(); },
  }, ...f.weights.map((w) => h('option', { value: w, textContent: `${w} ${weightName(w)}`.trim() })));
  weight.value = s.weight;

  const italic = h('button', {
    className: 'italic',
    innerHTML: ICONS.italic,
    title: 'Italic (may be synthesized)',
    'aria-label': 'Toggle italics for ' + f.family,
    'aria-pressed': s.italic,
    onClick: () => { s.italic = !s.italic; save(); },
  });

  const trackingValue = h('output', { className: 'tracking-value' });
  const spacing = h('input', {
    type: 'range', min: -3, max: 12, step: 0.5, value: s.spacing,
    'aria-label': f.family + ' letter spacing',
    onInput: () => { s.spacing = +spacing.value; save(); },
  });

  const reset = h('button', {
    innerHTML: ICONS.reset,
    title: 'Reset weight, italic and tracking',
    'aria-label': 'Reset ' + f.family,
    onClick: () => {
      Object.assign(s, defaultSettings(f));
      weight.value = s.weight;
      spacing.value = 0;
      save();
    },
  });

  // Keep controls in sync with settings.
  function syncControls() {
    italic.setAttribute('aria-pressed', s.italic);
    trackingValue.textContent = formatTracking(s.spacing);
    reset.disabled = isDefault(f, s);
  }
  function save() { syncControls(); updateCard(card); persist(); }
  syncControls();

  const options = h('div', { className: 'options' },
    h('span', { className: 'select' }, weight),
    italic,
    h('label', { className: 'tracking', title: 'Letter spacing (px)' }, h('span', { textContent: 'Tracking' }), spacing, trackingValue),
    reset,
  );

  card.append(head, sample, options);
  return card;
}

/** Apply colours, font settings and shrink-to-fit to one card. */
function updateCard(card) {
  const f = card._font;
  const s = settingsFor(f);
  const size = +el.size.value;
  const word = previewWord();

  card.style.background = el.paper.value;
  card.style.color = el.ink.value;
  card.style.setProperty('--card-paper', el.paper.value);

  const sample = card.querySelector('.sample');
  Object.assign(sample.style, {
    fontFamily: cssFamily(f) + ', sans-serif',
    fontWeight: s.weight,
    fontStyle: s.italic ? 'italic' : 'normal',
    letterSpacing: s.spacing + 'px',
    fontSize: size + 'px',
  });
  sample.children[0].textContent = word.toUpperCase();
  sample.children[1].textContent = word.toLowerCase();

  // Shrink lines that overflow. In list view the two lines sit side by side.
  requestAnimationFrame(() => {
    const gap = parseFloat(getComputedStyle(sample).columnGap) || 0;
    const sideBySide = state.view === 'list' && getComputedStyle(sample).flexDirection === 'row';
    const available = sideBySide ? (sample.clientWidth - gap) / 2 - 24 : sample.clientWidth - 24;
    for (const line of sample.children) {
      line.style.fontSize = size + 'px';
      if (line.scrollWidth > available) line.style.fontSize = Math.max(9, size * available / line.scrollWidth) + 'px';
    }
  });
}

const refreshAllCards = () => document.querySelectorAll('.card').forEach(updateCard);

/* =========================================================================
   Local fonts: connect + import
   ========================================================================= */

/** Chrome/Edge: Local Font Access API. Everything else: Mac app or serve.py. */
async function connectLocalFonts() {
  if (!window.queryLocalFonts) return connectMacFonts();
  try {
    const data = await window.queryLocalFonts();
    const map = new Map();
    for (const font of data) {
      if (!map.has(font.family)) {
        map.set(font.family, { family: font.family, category: inferCategory(font.family), source: 'local', weights: [], variable: false });
      }
      const f = map.get(font.family);
      const w = weightFromStyle(font.style);
      if (!f.weights.includes(w)) f.weights.push(w);
    }
    state.localFonts = sortFamilies(map);
    setSource('local');
    message(`Connected ${state.localFonts.length} installed families. Local categories are estimated from font names.`);
  } catch {
    message('Font access was not granted. Try again or import font files.');
  }
}

async function fetchMacFaces() {
  if (window.nativeFontCatalog) return window.nativeFontCatalog();
  const response = await fetch('/api/local-fonts');
  if (!response.ok) throw new Error('Font service unavailable');
  return response.json();
}

/** Read installed Mac fonts and register each face under a private alias. */
async function connectMacFonts() {
  el.connect.disabled = true;
  message('Reading installed Mac fonts… This can take a minute on the first connection.');
  try {
    const faces = await fetchMacFaces();
    const map = new Map();
    const rules = [];

    for (const face of faces) {
      if (!map.has(face.family)) {
        map.set(face.family, {
          family: face.family,
          alias: 'MacLocal' + map.size,
          category: inferCategory(face.family),
          source: 'local',
          weights: [],
          variable: false,
          installedAt: face.installedAt || 0,
        });
      }
      const f = map.get(face.family);
      f.installedAt = Math.max(f.installedAt || 0, face.installedAt || 0);
      const weight = weightFromStyle(face.style);
      if (!f.weights.includes(weight)) f.weights.push(weight);

      const italic = /italic|oblique/i.test(face.style);
      const sources = [`local(${JSON.stringify(face.postscriptName)})`, `local(${JSON.stringify(face.fullName)})`];
      if (['.ttf', '.otf', '.woff', '.woff2'].includes(face.extension)) sources.push(`url(${JSON.stringify(face.file)})`);
      rules.push(`@font-face{font-family:${JSON.stringify(f.alias)};src:${sources.join(',')};font-weight:${weight};font-style:${italic ? 'italic' : 'normal'};font-display:swap;}`);
    }

    let style = $('#mac-local-faces');
    if (!style) document.head.append(style = h('style', { id: 'mac-local-faces' }));
    style.textContent = rules.join('\n');

    state.localFonts = sortFamilies(map);
    setSource('local');
    message(`Connected ${state.localFonts.length} installed Mac font families.`);
  } catch {
    message(window.nativeFontCatalog
      ? 'Could not connect to the Mac font service. Quit and reopen Find My Type, then try again.'
      : 'Could not connect to the Mac font service. Restart Find My Type with Launch Find My Type.command, then try again.');
  } finally {
    el.connect.disabled = false;
  }
}

/** Imported files live only for this session (FontFace objects aren't persisted). */
async function importFontFiles(files) {
  let imported = 0;
  for (const file of files) {
    try {
      const alias = 'Imported' + Date.now() + imported;
      const face = new FontFace(alias, await file.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      const family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
      state.localFonts.push({ family, alias, category: inferCategory(family), source: 'local', weights: [400], variable: false });
      imported++;
    } catch {
      message('Could not read ' + file.name);
    }
  }
  setSource('local');
  message(`Imported ${imported} fonts for this session. Re-import files after reloading.`);
}

/* =========================================================================
   Export shortlist (PNG sheets + TXT details)
   ========================================================================= */

/** Mac app: hand data to the native save panel. Browser: normal download. */
function downloadFile(blob, name) {
  if (window.nativeDownload) {
    const reader = new FileReader();
    reader.onload = () => window.nativeDownload(reader.result, name);
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Make sure every favourite face is loaded before drawing it on canvas. */
async function prepareFonts(list, word) {
  // Includes favourites that were never scrolled into view.
  await withTimeout(Promise.all(list.map(loadGoogleStylesheet)), 20000, 'Font stylesheet timeout');
  await document.fonts.ready;
  for (const f of list) await document.fonts.load(fontSpec(f, settingsFor(f)), word);
}

/** Draw one line of the wordmark centred in a card, shrinking it to fit. */
function drawWordmark(ctx, f, s, text, centerX, y, maxWidth, size) {
  const tracking = +s.spacing || 0;
  const chars = Array.from(text);
  let px = size;
  const setFont = () => { ctx.font = `${s.italic ? 'italic ' : ''}${s.weight} ${px}px ${cssFamily(f)}`; };
  setFont();
  const natural = ctx.measureText(text).width + Math.max(0, chars.length - 1) * tracking;
  if (natural > maxWidth) { px = Math.max(8, px * maxWidth / natural); setFont(); }

  ctx.textAlign = 'center';
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = tracking + 'px';
    ctx.fillText(text, centerX, y, maxWidth);
    ctx.letterSpacing = '0px';
  } else if (tracking === 0) {
    ctx.fillText(text, centerX, y, maxWidth);
  } else {
    // Older WebKit: place characters manually to apply tracking.
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * tracking;
    let pos = centerX - total / 2;
    ctx.textAlign = 'left';
    chars.forEach((c, i) => { ctx.fillText(c, pos, y); pos += widths[i] + tracking; });
  }
}

async function renderSheet(group, { name, bg, ink, size }) {
  const cols = Math.min(3, group.length);
  const cw = 480, ch = 350, gap = 20, margin = 24, scale = 2;
  const rows = Math.ceil(group.length / cols);
  const width = cols * cw + (cols - 1) * gap + margin * 2;
  const height = rows * ch + (rows - 1) * gap + margin * 2;

  const canvas = h('canvas', { width: width * scale, height: height * scale });
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = isDark() ? '#141414' : '#f4f4f4';
  ctx.fillRect(0, 0, width, height);

  group.forEach((f, i) => {
    const s = settingsFor(f);
    const x = margin + (i % cols) * (cw + gap);
    const y = margin + Math.floor(i / cols) * (ch + gap);

    ctx.fillStyle = bg;
    ctx.fillRect(x, y, cw, ch);
    ctx.strokeStyle = '#88888855';
    ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);

    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(f.family, x + 20, y + 27, cw - 70);
    ctx.textAlign = 'right';
    ctx.fillText('♥', x + cw - 20, y + 27);

    drawWordmark(ctx, f, s, name.toUpperCase(), x + cw / 2, y + 130, cw - 40, size);
    drawWordmark(ctx, f, s, name.toLowerCase(), x + cw / 2, y + 230, cw - 40, size);

    ctx.textAlign = 'left';
    ctx.font = '11px Arial';
    ctx.fillText(f.category.toUpperCase(), x + 20, y + ch - 45);
    ctx.fillText(`Weight ${s.weight} · ${s.italic ? 'Italic' : 'Normal'} · Tracking ${s.spacing}px`, x + 20, y + ch - 22);
  });

  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG creation failed'))), 'image/png'));
  canvas.width = canvas.height = 0; // free canvas memory (Safari)
  return blob;
}

function shortlistDetails(list, { name, bg, ink, size }) {
  const lines = [
    'FIND MY TYPE — FAVOURITE FONT SHORTLIST',
    'Company: ' + name,
    'Uppercase: ' + name.toUpperCase(),
    'Lowercase: ' + name.toLowerCase(),
    'Text colour: ' + ink,
    'Card background: ' + bg,
    'Preview size: ' + size + 'px',
    'Font families: ' + list.length,
    '', '',
  ];
  list.forEach((f, i) => {
    const s = settingsFor(f);
    lines.push(
      `${i + 1}. ${f.family}`,
      'Source: ' + (f.source === 'google' ? 'Google Fonts' : 'Local / imported'),
      'Category: ' + f.category,
      'Weight: ' + s.weight,
      'Style: ' + (s.italic ? 'Italic (native or synthesized)' : 'Normal'),
      'Letter spacing: ' + s.spacing + 'px',
      'Available weights: ' + f.weights.join(', '),
      'Variable font: ' + (f.variable ? 'Yes' : 'No / unknown for local fonts'),
      '',
    );
  });
  return lines.join('\n');
}

const PER_SHEET = 18; // keeps canvas sizes and memory bounded

async function exportShortlist() {
  const list = [...state.googleFonts, ...state.localFonts].filter((f) => state.favorites.has(fontId(f)));
  const missing = [...state.favorites].filter((key) => !list.some((f) => fontId(f) === key));
  if (missing.length) {
    message(`Reconnect local fonts or re-import your font files before exporting: ${missing.length} favourite families are unavailable.`);
    return;
  }
  if (!list.length) { message('Favourite a few fonts to export your shortlist.'); return; }

  const button = el.exportButton;
  button.disabled = true;
  button.textContent = 'Preparing export…';
  try {
    const name = previewWord();
    const options = { name, bg: el.paper.value, ink: el.ink.value, size: +el.size.value };
    await prepareFonts(list, name);

    const sheets = [];
    for (let start = 0; start < list.length; start += PER_SHEET) {
      sheets.push(await renderSheet(list.slice(start, start + PER_SHEET), options));
    }

    const slug = name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'wordmark';
    sheets.forEach((blob, i) => downloadFile(blob, `${slug}-favourites${sheets.length > 1 ? '-' + (i + 1) : ''}.png`));
    downloadFile(new Blob([shortlistDetails(list, options)], { type: 'text/plain;charset=utf-8' }), `${slug}-font-details.txt`);
    message(`Exported ${sheets.length} PNG ${sheets.length === 1 ? 'sheet' : 'sheets'} and font details TXT. Allow multiple downloads if your browser asks.`);
  } catch (error) {
    message('Export could not finish. Check that your favourite fonts have loaded, then try again.');
    console.error(error);
  } finally {
    button.disabled = false;
    button.innerHTML = ICONS.download + '<span>Export shortlist</span>';
  }
}

/* =========================================================================
   Popover helpers
   ========================================================================= */

/** Place a fixed popover under its anchor (or above it if there's no room). */
function placePopover(panel, anchor, maxWidth) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(maxWidth, window.innerWidth - 24);
  panel.style.width = width + 'px';
  panel.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
  panel.style.top = '0px';
  const height = panel.offsetHeight;
  const below = rect.bottom + 8 + height < window.innerHeight;
  panel.style.top = Math.max(12, below ? rect.bottom + 8 : rect.top - height - 8) + 'px';
}

/** Set both card colours at once (updates swatches, cards and storage). */
function setCardColours(ink, paper) {
  el.ink.value = ink;
  el.paper.value = paper;
  el.ink.dispatchEvent(new Event('input'));
  el.paper.dispatchEvent(new Event('input'));
  colourPicker.refresh();
}

/* =========================================================================
   Colour picker (app-owned so native WebKit popovers can't detach from the swatch)
   ========================================================================= */

const colourPicker = (() => {
  const PRESETS = ['#000000', '#262626', '#666666', '#999999', '#cccccc', '#ffffff', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#8b5e3c'];

  const panel = h('div', { className: 'colour-popover', hidden: true, role: 'dialog', 'aria-label': 'Card colour picker' });
  panel.innerHTML = `
    <div class="picker-title"></div>
    <div class="picker-presets"></div>
    <label class="picker-field">Hue<input class="picker-hue" type="range" min="0" max="360"></label>
    <label class="picker-field">Saturation<input class="picker-sat" type="range" min="0" max="100"></label>
    <label class="picker-field">Brightness<input class="picker-val" type="range" min="0" max="100"></label>
    <label class="picker-field">Hex<input class="picker-hex" type="text" maxlength="7" spellcheck="false" aria-label="Hex colour"></label>
    <button class="picker-done">Done</button>`;
  document.body.append(panel);

  const q = (s) => panel.querySelector(s);
  const ui = { title: q('.picker-title'), presets: q('.picker-presets'), hue: q('.picker-hue'), sat: q('.picker-sat'), val: q('.picker-val'), hex: q('.picker-hex'), done: q('.picker-done') };

  let active = null; // hidden <input> being edited
  let anchor = null; // swatch button that opened the panel
  let hue = 0, sat = 0, val = 100;

  function hsvToHex(hh, ss, vv) {
    ss /= 100; vv /= 100;
    const c = vv * ss, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = vv - c;
    const rgb = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  function readHex(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    hue = d === 0 ? 0 : max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    sat = max === 0 ? 0 : (d / max) * 100;
    val = max * 100;
  }

  function sync() {
    ui.hue.value = hue; ui.sat.value = sat; ui.val.value = val;
    ui.hex.value = active.value;
    anchor.querySelector('.colour-chip').style.background = active.value;
  }

  function setValue(hex) {
    active.value = hex;
    active.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function apply(hex) { setValue(hex); readHex(hex); sync(); }

  const position = () => anchor && placePopover(panel, anchor, 260);

  function close() {
    panel.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
  }

  function open(input, button, title) {
    if (anchor === button && !panel.hidden) { close(); return; }
    close();
    active = input;
    anchor = button;
    ui.title.textContent = title;
    readHex(input.value);
    sync();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    position();
  }

  // Replace each native colour input with a swatch button.
  for (const [key, label] of [['ink', 'Text'], ['paper', 'Background']]) {
    const input = el[key];
    const wrapper = input.closest('label');
    input.type = 'hidden';
    const button = h('button', {
      type: 'button',
      className: 'colour-trigger',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      innerHTML: `<span class="colour-chip" aria-hidden="true"></span><span>${label}</span>`,
      onClick: () => open(input, button, label + ' colour'),
    });
    const chip = button.querySelector('.colour-chip');
    chip.style.background = input.value;
    input.addEventListener('input', () => { chip.style.background = input.value; });
    wrapper.replaceWith(h('span', { className: 'colour-control' }, button, input));
  }

  PRESETS.forEach((hex) => ui.presets.append(h('button', {
    type: 'button', className: 'picker-preset', 'aria-label': hex, onClick: () => apply(hex),
  })));
  [...ui.presets.children].forEach((b, i) => { b.style.background = PRESETS[i]; });

  for (const slider of [ui.hue, ui.sat, ui.val]) {
    slider.addEventListener('input', () => {
      hue = +ui.hue.value; sat = +ui.sat.value; val = +ui.val.value;
      setValue(hsvToHex(hue, sat, val));
      sync();
    });
  }
  ui.hex.addEventListener('input', (e) => {
    let hex = e.target.value;
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[a-f0-9]{6}$/i.test(hex)) apply(hex);
  });
  ui.done.addEventListener('click', () => { close(); anchor.focus(); });

  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !anchor.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { close(); anchor.focus(); }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);

  /** Called after something else changed the colours (e.g. theme toggle). */
  function refresh() {
    if (!panel.hidden) { readHex(active.value); sync(); }
  }

  return { refresh };
})();

/* =========================================================================
   Card palette presets
   ========================================================================= */

const PALETTES = [
  { name: 'Ink', ink: '#1a1a1a', paper: '#ffffff' },
  { name: 'Reverse', ink: '#ffffff', paper: '#1a1a1a' },
  { name: 'Graphite', ink: '#e6e6e6', paper: '#3a3a3a' },
  { name: 'Stone', ink: '#2a2a2a', paper: '#d9d9d9' },
  { name: 'Newsprint', ink: '#2b2b2b', paper: '#efebe3' },
  { name: 'Midnight', ink: '#f5e9c8', paper: '#1f2547' },
  { name: 'Forest', ink: '#eef3e8', paper: '#1f3b2d' },
  { name: 'Clay', ink: '#4a2a1d', paper: '#f1ddd0' },
  { name: 'Blueprint', ink: '#ffffff', paper: '#1d4ed8' },
  { name: 'Signal', ink: '#111111', paper: '#ffd400' },
];

(() => {
  const trigger = $('#palette-presets');
  const panel = h('div', { className: 'colour-popover palette-popover', hidden: true, role: 'dialog', 'aria-label': 'Card palette presets' },
    h('div', { className: 'picker-title', textContent: 'Card palettes' }));
  const grid = h('div', { className: 'palette-grid' });
  panel.append(grid);
  document.body.append(panel);

  const buttons = PALETTES.map((p) => {
    const swatch = h('span', { className: 'palette-swatch', textContent: 'Aa' });
    swatch.style.background = p.paper;
    swatch.style.color = p.ink;
    const button = h('button', {
      type: 'button', className: 'palette-option', title: `${p.name}: ${p.ink} on ${p.paper}`,
      onClick: () => { setCardColours(p.ink, p.paper); sync(); },
    }, swatch, h('span', { textContent: p.name }));
    button._palette = p;
    grid.append(button);
    return button;
  });

  function sync() {
    for (const b of buttons) {
      b.setAttribute('aria-pressed', b._palette.ink === el.ink.value.toLowerCase() && b._palette.paper === el.paper.value.toLowerCase());
    }
  }
  const position = () => !panel.hidden && placePopover(panel, trigger, 340);
  function close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }

  trigger.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    sync();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    buttons[0].focus({ preventScroll: true });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !trigger.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { close(); trigger.focus(); }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
})();

$('#swap-colours').addEventListener('click', () => setCardColours(el.paper.value, el.ink.value));

/* =========================================================================
   Wiring
   ========================================================================= */

for (const key of ['word', 'ink', 'paper', 'size']) {
  el[key].addEventListener('input', () => {
    el.sizeValue.textContent = el.size.value;
    refreshAllCards();
    persist();
  });
}

/* ---- Search ---- */
function syncSearch() {
  $('.search-wrap').classList.toggle('has-value', el.search.value.length > 0);
}

function clearSearch() {
  el.search.value = '';
  render();
}

el.search.addEventListener('input', render);
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (el.search.value) clearSearch(); else el.search.blur();
    e.stopPropagation();
  }
});
el.clearSearch.addEventListener('click', (e) => { e.preventDefault(); clearSearch(); el.search.focus(); });

// ⌘K / Ctrl+K anywhere, or "/" when not typing, focuses search.
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
});

el.theme.addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  const colours = CARD_COLOURS[dark ? 'dark' : 'light'];
  setCardColours(colours.ink, colours.paper);
});

document.querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.source)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

el.connect.addEventListener('click', connectLocalFonts);
el.import.addEventListener('click', () => el.files.click());
el.files.addEventListener('change', async (e) => { await importFontFiles(e.target.files); e.target.value = ''; });
el.exportButton.addEventListener('click', exportShortlist);
el.clearFavourites.addEventListener('click', () => {
  state.favorites.clear();
  persist();
  render();
  message('Favourites cleared.');
});

window.addEventListener('resize', () => { refreshAllCards(); moveTabIndicator(); });
document.fonts.addEventListener('loadingdone', refreshAllCards);

/* =========================================================================
   Boot
   ========================================================================= */

if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('.search-hint').textContent = 'Ctrl K';
buildToolbar();
setView(state.view);
moveTabIndicator();
// Enable the slide animation only after the first placement (no slide-in on load).
requestAnimationFrame(() => requestAnimationFrame(() => tabIndicator?.classList.add('ready')));
document.fonts.ready.then(moveTabIndicator); // tab widths can change once fonts settle

if (Array.isArray(window.FONT_CATALOG)) {
  const rank = (f) => { const i = FEATURED.indexOf(f.family); return i < 0 ? 999 : i; };
  state.googleFonts = [...window.FONT_CATALOG].sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family));
  render();
  message('Explore the complete Google Fonts catalog. Fonts load as you scroll.');
} else {
  render();
  message('Could not load the font catalog. Reload to try again.');
}
