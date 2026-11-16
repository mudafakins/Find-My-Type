'use strict';
/*
 * Find My Type — preview a company name in every font you have.
 *
 * This is the UI of the macOS app. native/FindMyType.swift hosts it in a WKWebView
 * and provides two bridges:
 *   window.nativeFontCatalog(fresh) → installed font faces (cached on disk by the app)
 *   window.nativeDownload(dataURL, name) → save a file with the macOS save panel
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
  theme: $('#theme'),
  rescan: $('#rescan'),
  import: $('#import'),
  files: $('#files'),
  clearFavourites: $('#clear-favourites'),
  clearSearch: $('#clear-search'),
};

/* =========================================================================
   Toasts — short messages at the bottom of the window
   ========================================================================= */

/**
 * message(text, options) shows a toast and returns a handle { update(text), dismiss() }.
 * options:
 *   tone      'info' | 'success' | 'error' | 'progress'  (icon; progress = spinner, stays open)
 *   action    { label, onClick }  optional button, e.g. Undo
 *   duration  ms before auto-dismiss (0 = stay until dismissed)
 *   id        reuse/replace a toast with the same id (e.g. 'export')
 */
const message = (() => {
  const region = h('div', { className: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(region);
  const byId = new Map();
  const TONE_ICONS = {
    success: '<path d="M5 12.5 10 17 19 7.5"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  };
  const MAX = 3;

  return function show(text, { tone = 'info', action, duration, id } = {}) {
    if (id && byId.has(id)) byId.get(id).dismiss(true);
    const icon = h('span', { className: 'toast-icon', 'aria-hidden': 'true' });
    icon.innerHTML = tone === 'progress' ? '<span class="spinner"></span>' : svg(TONE_ICONS[tone] || TONE_ICONS.info);
    const label = h('span', { className: 'toast-text', textContent: text });
    const node = h('div', { className: `toast toast-${tone}` }, icon, label);

    let timer = null;
    const handle = {
      update(next) { label.textContent = next; },
      dismiss(instant = false) {
        clearTimeout(timer);
        if (id && byId.get(id) === handle) byId.delete(id);
        if (instant) { node.remove(); return; }
        node.classList.add('leaving');
        node.addEventListener('animationend', () => node.remove(), { once: true });
        setTimeout(() => node.remove(), 400); // fallback when animations are off
      },
    };

    if (action) {
      node.append(h('button', {
        className: 'toast-action', type: 'button', textContent: action.label,
        onClick: () => { handle.dismiss(); action.onClick(); },
      }));
    }
    node.append(h('button', {
      className: 'toast-close', type: 'button', 'aria-label': 'Dismiss', innerHTML: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
      onClick: () => handle.dismiss(),
    }));

    const ms = duration ?? (tone === 'progress' ? 0 : action ? 6000 : tone === 'error' ? 7000 : 4000);
    const arm = () => { if (ms) timer = setTimeout(() => handle.dismiss(), ms); };
    node.addEventListener('pointerenter', () => clearTimeout(timer)); // pause while hovered
    node.addEventListener('pointerleave', arm);
    arm();

    if (id) byId.set(id, handle);
    region.append(node);
    while (region.children.length > MAX) region.firstElementChild.remove();
    return handle;
  };
})();

/** Put a button into a busy state (spinner + label). Returns a function that restores it. */
function setBusy(button, label) {
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add('busy');
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${label}</span>`;
  return () => { button.disabled = false; button.classList.remove('busy'); button.innerHTML = original; };
}

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
  fontsConnected: !!saved.fontsConnected, // user agreed once → reconnect automatically at launch
  fontsPrompted: !!saved.fontsPrompted,   // first-launch prompt already answered
  localStatus: 'idle',                    // 'idle' | 'loading' | 'ready'
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
      fontsConnected: state.fontsConnected,
      fontsPrompted: state.fontsPrompted,
    }));
  } catch { /* storage full or unavailable — non-fatal */ }
  onFavouritesChanged(); // keep the shortlist badge/drawer current
}

/** Replaced by the shortlist drawer once it's set up. */
let onFavouritesChanged = () => {};

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
  if (f.condensed || /condensed|narrow|compressed/i.test(f.family)) result.push('Condensed');
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
    // Font files can be slow; after 8s reveal anyway (a fallback shows, then the font swaps in).
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

  if (!state.visible.length) el.grid.append(emptyState(query));
  appendPage();
}

const EMPTY_ICONS = {
  connect: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.1C1.7 7.8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.3 3.3 4.2 6.4C19.5 15.4 12 20 12 20Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
};

/** Build the empty-grid message for the current situation. */
function emptyState(query) {
  const view = (icon, title, body, actions) => h('div', { className: 'empty' },
    h('div', { className: 'empty-icon', innerHTML: svg(EMPTY_ICONS[icon]) }),
    h('h2', { className: 'empty-title', textContent: title }),
    h('p', { className: 'empty-body', textContent: body }),
    h('div', { className: 'empty-actions' }, ...actions.map(({ label, primary, onClick }) =>
      h('button', { type: 'button', className: primary ? 'btn-primary' : 'btn-secondary', textContent: label, onClick }))),
  );

  if (state.source === 'local' && state.localStatus === 'loading' && !state.localFonts.length) {
    const loading = view('connect', 'Loading your fonts…', 'Reading the fonts installed on this computer. The first scan can take a minute.', []);
    loading.querySelector('.empty-icon').innerHTML = '<span class="spinner spinner-lg"></span>';
    return loading;
  }
  if (state.source === 'local' && !state.localFonts.length) {
    return view('connect', 'Connect your fonts',
      'See your company name in every font installed on this Mac. Fonts are read locally and never leave your computer. The first scan can take a minute.',
      [
        { label: 'Connect installed fonts', primary: true, onClick: (e) => connectLocalFonts({ trigger: e.currentTarget }) },
        { label: 'Import font files', onClick: () => el.files.click() },
        { label: 'Browse Google Fonts', onClick: () => setSource('google') },
      ]);
  }
  if (state.filter === FAVOURITES && !query) {
    return view('heart', 'No favourites yet',
      'Tap the heart on any font to add it to your shortlist. Open Shortlist to compare them and export PNG or PDF.',
      [{ label: 'Browse all fonts', primary: true, onClick: () => { state.filter = ALL; render(); } }]);
  }
  const actions = [];
  if (query) actions.push({ label: 'Clear search', primary: true, onClick: () => { clearSearch(); el.search.focus(); } });
  if (state.filter !== ALL) actions.push({ label: 'Show all categories', primary: !query, onClick: () => { state.filter = ALL; render(); } });
  return view('search',
    query ? `No fonts match “${el.search.value.trim()}”` : `No ${state.filter.toLowerCase()} fonts here`,
    query ? 'Check the spelling, or search across all categories and sources.' : 'Try another category, or switch between Google and local fonts.',
    actions);
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
    const removing = state.favorites.has(key);
    if (removing) state.favorites.delete(key); else state.favorites.add(key);
    persist();
    if (state.filter === FAVOURITES) {
      render(); // the card disappears, so offer a way back
      if (removing) {
        message(`Removed ${f.family} from favourites.`, {
          id: 'favourites',
          action: { label: 'Undo', onClick: () => { state.favorites.add(key); persist(); render(); } },
        });
      }
    } else syncHeart();
    heart.classList.toggle('pop', state.favorites.has(key)); // animate only on click
  });
  syncHeart();

  const details = [f.category, `${f.weights.length} ${f.weights.length === 1 ? 'weight' : 'weights'}`];
  if (f.variable) details.push('Variable');
  const head = h('div', { className: 'card-head' },
    h('div', { className: 'card-title' },
      h('strong', { textContent: f.family, title: f.family }),
      h('span', { className: 'card-meta', textContent: details.join(' · '), title: CATEGORY_SOURCES[f.categorySource] || '' }),
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

const CATEGORY_SOURCES = {
  font: 'Category read from the font file',
  catalog: 'Category from the Google Fonts catalogue',
  name: 'Category estimated from the font’s name',
  shape: 'Category estimated from the letter shapes',
};

/**
 * Pick a family's category from the best evidence available:
 *   1. declared in the font file (OS/2 class / PANOSE)  2. Google Fonts catalogue
 *   3. unmistakable name words (Script, Mono…)          4. letter-shape analysis
 *   5. any other hint in the name
 */
function resolveCategory(family, declared, shape) {
  if (declared) return [declared, 'font'];
  const google = googleCategories().get(family.toLowerCase());
  if (google) return [google, 'catalog'];
  if (/script|hand(writ)?|brush|callig|signature/i.test(family)) return ['Handwriting', 'name'];
  if (/\bmono\b|mono$|courier|console|code/i.test(family)) return ['Monospace', 'name'];
  if (shape) return [shape, 'shape'];
  return [inferCategory(family), 'name'];
}

let googleCategoryMap = null;
function googleCategories() {
  googleCategoryMap ||= new Map(state.googleFonts.map((g) => [g.family.toLowerCase(), g.category]));
  return googleCategoryMap;
}

/**
 * Ask the app for installed font faces and group them into families.
 * Each face: family, style, fullName, postscriptName, file, extension, installedAt,
 * plus (from the font data) weight, italic, width, variable, category / shapeCategory.
 * Every face is registered under a private alias so previews use exactly that file.
 */
async function readInstalledFonts(fresh) {
  const faces = await window.nativeFontCatalog(fresh);

  const map = new Map();
  const rules = [];
  for (const face of faces) {
    if (!map.has(face.family)) {
      map.set(face.family, {
        family: face.family,
        alias: 'LocalFont' + map.size,
        source: 'local',
        weights: [],
        variable: false,
        installedAt: face.installedAt || 0,
        _declared: null, _shape: null, _widths: [],
      });
    }
    const f = map.get(face.family);
    f.installedAt = Math.max(f.installedAt || 0, face.installedAt || 0);
    f._declared ||= face.category || null;
    f._shape ||= face.shapeCategory || null;
    f.variable ||= !!face.variable;

    // Weight: the font's own value, unless it's the default and the style name says otherwise.
    const named = weightFromStyle(face.style);
    const weight = face.weight && face.weight !== 400 ? face.weight : named;
    if (!f.weights.includes(weight)) f.weights.push(weight);
    const italic = face.italic ?? /italic|oblique/i.test(face.style);
    if (!italic) f._widths.push(face.width || 'normal');

    const sources = [`local(${JSON.stringify(face.postscriptName)})`, `local(${JSON.stringify(face.fullName)})`];
    if (['.ttf', '.otf', '.woff', '.woff2'].includes(face.extension)) sources.push(`url(${JSON.stringify(face.file)})`);
    rules.push(`@font-face{font-family:${JSON.stringify(f.alias)};src:${sources.join(',')};font-weight:${weight};font-style:${italic ? 'italic' : 'normal'};font-display:swap;}`);
  }

  for (const f of map.values()) {
    [f.category, f.categorySource] = resolveCategory(f.family, f._declared, f._shape);
    // Condensed when the family's upright faces are (mostly) condensed.
    f.condensed = f._widths.length > 0 && f._widths.filter((w) => w === 'condensed').length / f._widths.length >= 0.5;
    delete f._declared; delete f._shape; delete f._widths;
  }

  let style = $('#local-font-faces');
  if (!style) document.head.append(style = h('style', { id: 'local-font-faces' }));
  style.textContent = rules.join('\n');
  return sortFamilies(map);
}

/**
 * Connect (or reconnect) the fonts installed on this computer.
 *   silent  — automatic reconnect at launch: no toasts unless something useful to say
 *   fresh   — ignore the Mac app's saved font list and scan again (Rescan)
 *   trigger — button to show a spinner on
 */
async function connectLocalFonts({ silent = false, fresh = false, trigger = null } = {}) {
  if (state.localStatus === 'loading') return;
  state.localStatus = 'loading';
  const restore = trigger ? setBusy(trigger, trigger === el.rescan ? '' : 'Reading fonts…') : null;
  if (state.source === 'local') render(); // shows the loading state
  const progress = silent ? null : message(
    fresh ? 'Rescanning installed fonts…' : 'Reading installed fonts… the first scan can take a minute.',
    { tone: 'progress', id: 'connect' });

  try {
    const families = await readInstalledFonts(fresh);
    const imported = state.localFonts.filter((f) => f.imported); // keep this session's imports
    state.localFonts = [...families, ...imported];
    state.localStatus = 'ready';
    state.fontsConnected = true;
    persist();
    syncConnectedUI();
    progress?.dismiss(true);
    if (!silent) {
      message(fresh
        ? `Rescan complete — ${families.length.toLocaleString()} installed font families.`
        : `Connected ${families.length.toLocaleString()} installed font families. They’ll load automatically from now on.`, { tone: 'success', id: 'connect' });
    }
    if (state.source === 'local' || !silent) setSource('local');
  } catch {
    state.localStatus = 'idle';
    progress?.dismiss(true);
    if (!silent) {
      message('Couldn’t read your installed fonts. Quit and reopen Find My Type, then try again.', { tone: 'error' });
    }
    if (state.source === 'local') render();
  } finally {
    if (restore && trigger.isConnected) restore();
  }
}

/** Show the rescan button only once fonts are connected. */
function syncConnectedUI() {
  el.rescan.hidden = !(state.fontsConnected && state.localStatus === 'ready');
}

/* ---- First-launch prompt ---- */

function showConnectPrompt() {
  const dialog = h('dialog', { className: 'modal', 'aria-labelledby': 'connect-title' });
  dialog.innerHTML = `
    <div class="modal-icon" aria-hidden="true">${svg(EMPTY_ICONS.connect)}</div>
    <h2 id="connect-title" class="modal-title">Use the fonts on this Mac?</h2>
    <p class="modal-body">Find My Type can preview your company name in every font installed on this computer.
      Fonts are read locally and never leave your Mac.</p>
    <p class="modal-note">You’ll only be asked once — after this, your fonts load automatically.</p>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" data-choice="later">Not now</button>
      <button type="button" class="btn-primary" data-choice="connect">Connect fonts</button>
    </div>`;
  document.body.append(dialog);

  const close = (choice) => {
    state.fontsPrompted = true;
    persist();
    dialog.classList.add('leaving');
    setTimeout(() => dialog.remove(), 180);
    dialog.close();
    if (choice === 'connect') {
      connectLocalFonts();
    } else {
      setSource('google');
      message('No problem — you can connect your fonts any time from the Local Fonts tab.');
    }
  };
  dialog.addEventListener('click', (e) => {
    const choice = e.target.closest('[data-choice]')?.dataset.choice;
    if (choice) close(choice);
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close('later'); }); // Esc
  dialog.showModal();
  dialog.querySelector('[data-choice="connect"]').focus();
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
      const [category, categorySource] = resolveCategory(family, null, null);
      state.localFonts.push({ family, alias, category, categorySource, source: 'local', weights: [400], variable: false, imported: true });
      imported++;
    } catch {
      message('Couldn’t read ' + file.name + ' — is it a .ttf, .otf, .woff or .woff2 file?', { tone: 'error' });
    }
  }
  setSource('local');
  if (imported) message(`Imported ${imported} ${imported === 1 ? 'font' : 'fonts'} for this session. You’ll need to import them again after quitting.`, { tone: 'success' });
}

/* =========================================================================
   Shortlist data
   ========================================================================= */

/** Favourites in the order they were added: { list: loaded fonts, missing: keys not loaded }. */
function shortlist() {
  const byId = new Map([...state.googleFonts, ...state.localFonts].map((f) => [fontId(f), f]));
  const list = [];
  const missing = [];
  for (const key of state.favorites) {
    const f = byId.get(key);
    if (f) list.push(f); else missing.push(key);
  }
  return { list, missing };
}

const weightLabel = (w) => `${w} ${weightName(w)}`.trim();
const styleSummary = (f, s) => [weightLabel(s.weight), s.italic ? 'Italic' : null, s.spacing ? `${formatTracking(s.spacing)} tracking` : null].filter(Boolean).join(' · ');

/* =========================================================================
   Export (PNG sheets + TXT, or one PDF)
   ========================================================================= */

/** Hand a file to the Mac app, which shows a save panel for it. */
function downloadFile(blob, name) {
  const reader = new FileReader();
  reader.onload = () => window.nativeDownload(reader.result, name);
  reader.readAsDataURL(blob);
}

/** Make sure every favourite face is loaded before drawing it on canvas. */
async function prepareFonts(list, word) {
  // Includes favourites that were never scrolled into view.
  await withTimeout(Promise.all(list.map(loadGoogleStylesheet)), 20000, 'Font stylesheet timeout');
  await document.fonts.ready;
  for (const f of list) await document.fonts.load(fontSpec(f, settingsFor(f)), word);
}

/** Draw one line of the wordmark centred at (centerX, y), shrinking it to fit. */
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

/* ---- Sheet layout (all sizes in CSS px; drawn at 2× for crisp output) ---- */
const SHEET = {
  cols: 3, cardW: 480, cardH: 330, gap: 20, margin: 48, headerH: 104, footerH: 48, scale: 2, perSheet: 12,
  uiFont: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
};
const sheetColours = () => (isDark()
  ? { page: '#141414', text: '#f0f0f0', muted: '#8f8f8f', line: '#2e2e2e' }
  : { page: '#f4f4f4', text: '#1a1a1a', muted: '#6e6e6e', line: '#e2e2e2' });

function sheetWidth() { return SHEET.cols * SHEET.cardW + (SHEET.cols - 1) * SHEET.gap + SHEET.margin * 2; }

function createSheetCanvas(height) {
  const width = sheetWidth();
  const canvas = h('canvas', { width: width * SHEET.scale, height: height * SHEET.scale });
  const ctx = canvas.getContext('2d');
  ctx.scale(SHEET.scale, SHEET.scale);
  const c = sheetColours();
  ctx.fillStyle = c.page;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx, width, colours: c };
}

/** Title block at the top of every page. */
function drawSheetHeader(ctx, width, colours, { name, title, pageLabel }) {
  const { margin, uiFont } = SHEET;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = colours.text;
  ctx.font = `600 30px ${uiFont}`;
  ctx.fillText(name, margin, margin + 30, width - margin * 2 - 220);
  ctx.fillStyle = colours.muted;
  ctx.font = `400 14px ${uiFont}`;
  ctx.fillText(title, margin, margin + 56);
  ctx.textAlign = 'right';
  ctx.fillText(pageLabel, width - margin, margin + 30);
  ctx.fillStyle = colours.line;
  ctx.fillRect(margin, margin + SHEET.headerH - 24, width - margin * 2, 1);
}

function drawSheetFooter(ctx, width, height, colours) {
  ctx.fillStyle = colours.muted;
  ctx.font = `400 12px ${SHEET.uiFont}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Made with Find My Type', width - SHEET.margin, height - SHEET.margin / 2 - 4);
}

function roundedRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, r); else ctx.rect(x, y, w, hgt);
  ctx.fill();
}

/** One page of font cards. */
function drawCardsSheet(group, startIndex, opts) {
  const { cols, cardW, cardH, gap, margin, headerH, footerH, uiFont } = SHEET;
  const rows = Math.ceil(group.length / cols);
  const height = margin + headerH + rows * cardH + (rows - 1) * gap + footerH + margin / 2;
  const { canvas, ctx, width, colours } = createSheetCanvas(height);
  drawSheetHeader(ctx, width, colours, opts.header);

  group.forEach((f, i) => {
    const s = settingsFor(f);
    const x = margin + (i % cols) * (cardW + gap);
    const y = margin + headerH + Math.floor(i / cols) * (cardH + gap);

    ctx.fillStyle = opts.paper;
    roundedRect(ctx, x, y, cardW, cardH, 16);

    // Number + family name, then details
    ctx.fillStyle = opts.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 15px ${uiFont}`;
    ctx.fillText(`${startIndex + i + 1}.  ${f.family}`, x + 24, y + 38, cardW - 48);
    ctx.globalAlpha = 0.55;
    ctx.font = `400 12px ${uiFont}`;
    ctx.fillText(`${f.category} · ${styleSummary(f, s)}`, x + 24, y + 58, cardW - 48);
    ctx.globalAlpha = 1;

    // Wordmark: uppercase + lowercase
    ctx.textBaseline = 'middle';
    drawWordmark(ctx, f, s, opts.name.toUpperCase(), x + cardW / 2, y + 160, cardW - 56, opts.size);
    drawWordmark(ctx, f, s, opts.name.toLowerCase(), x + cardW / 2, y + 250, cardW - 56, opts.size);
  });

  drawSheetFooter(ctx, width, height, colours);
  return canvas;
}

/** A table of every font and its settings (last PDF page). */
function drawDetailsSheet(list, opts) {
  const { margin, headerH, footerH, uiFont } = SHEET;
  const rowH = 44;
  const height = margin + headerH + 32 + list.length * rowH + footerH + margin / 2;
  const { canvas, ctx, width, colours } = createSheetCanvas(height);
  drawSheetHeader(ctx, width, colours, { ...opts.header, title: 'Font details' });

  const cols = [margin, margin + 360, margin + 560, margin + 860, margin + 1120];
  const headY = margin + headerH + 8;
  ctx.font = `600 12px ${uiFont}`;
  ctx.fillStyle = colours.muted;
  ctx.textAlign = 'left';
  ['FONT', 'SOURCE', 'STYLE', 'AVAILABLE WEIGHTS', 'CATEGORY'].forEach((t, i) => ctx.fillText(t, cols[i], headY));

  list.forEach((f, i) => {
    const s = settingsFor(f);
    const y = headY + 32 + i * rowH;
    ctx.fillStyle = colours.line;
    ctx.fillRect(margin, y - 22, width - margin * 2, 1);
    ctx.fillStyle = colours.text;
    ctx.font = `600 14px ${uiFont}`;
    ctx.fillText(`${i + 1}.  ${f.family}`, cols[0], y, 340);
    ctx.font = `400 13px ${uiFont}`;
    ctx.fillText(f.source === 'google' ? 'Google Fonts' : 'Local / imported', cols[1], y, 190);
    ctx.fillText(styleSummary(f, s), cols[2], y, 290);
    ctx.fillText(f.weights.join(', ') + (f.variable ? ' (variable)' : ''), cols[3], y, 250);
    ctx.fillText(f.category, cols[4], y, width - margin - cols[4]);
  });

  ctx.fillStyle = colours.muted;
  ctx.font = `400 12px ${uiFont}`;
  ctx.fillText(`Card colours: text ${opts.ink} on ${opts.paper} · Preview size ${opts.size}px`, margin, height - margin / 2 - 4);
  drawSheetFooter(ctx, width, height, colours);
  return canvas;
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image creation failed'))), type, quality));

function shortlistDetails(list, { name, paper, ink, size }) {
  const lines = [
    'FIND MY TYPE — FONT SHORTLIST',
    'Company: ' + name,
    'Text colour: ' + ink,
    'Card background: ' + paper,
    'Preview size: ' + size + 'px',
    'Fonts: ' + list.length,
    '',
  ];
  list.forEach((f, i) => {
    const s = settingsFor(f);
    lines.push(
      `${i + 1}. ${f.family}`,
      '   Source: ' + (f.source === 'google' ? 'Google Fonts' : 'Local / imported'),
      '   Category: ' + f.category,
      '   Style: ' + styleSummary(f, s) + (s.italic ? ' (italic may be synthesized)' : ''),
      '   Available weights: ' + f.weights.join(', ') + (f.variable ? ' (variable font)' : ''),
      '',
    );
  });
  return lines.join('\n');
}

/**
 * Minimal PDF writer: one page per JPEG image, page size matching the image.
 * images: [{ bytes: Uint8Array (JPEG), pxWidth, pxHeight, ptWidth, ptHeight }]
 */
function makePdf(images) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const bytes = typeof data === 'string' ? enc.encode(data) : data; chunks.push(bytes); length += bytes.length; };
  const obj = (n, ...parts) => { offsets[n] = length; push(`${n} 0 obj\n`); parts.forEach(push); push('\nendobj\n'); };

  push('%PDF-1.4\n%âãÏÓ\n');
  const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`);
  images.forEach((img, i) => {
    const page = 3 + i * 3, content = page + 1, image = page + 2;
    const w = img.ptWidth.toFixed(2), hh = img.ptHeight.toFixed(2);
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${hh}] /Resources << /XObject << /Im${i} ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const draw = `q ${w} 0 0 ${hh} 0 0 cm /Im${i} Do Q`;
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(image, `<< /Type /XObject /Subtype /Image /Width ${img.pxWidth} /Height ${img.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`, img.bytes, '\nendstream');
  });

  const count = 2 + images.length * 3;
  const xref = length;
  push(`xref\n0 ${count + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

let exporting = false;

/** Export the shortlist. format: 'png' (sheets + TXT) or 'pdf' (one file). */
async function exportShortlist(format = 'png', trigger = null) {
  if (exporting) return;
  const { list, missing } = shortlist();
  if (missing.length) {
    message(`${missing.length} of your favourites ${missing.length === 1 ? 'is' : 'are'} local fonts that aren’t loaded. Connect your fonts (or re-import the files), then export again.`, {
      tone: 'error',
      action: { label: 'Connect fonts', onClick: () => connectLocalFonts() },
    });
    return;
  }
  if (!list.length) {
    message('Your shortlist is empty. Tap the heart on fonts you like, then export.');
    return;
  }

  exporting = true;
  const restore = trigger ? setBusy(trigger, 'Exporting…') : null;
  const progress = message(`Loading ${list.length} ${list.length === 1 ? 'font' : 'fonts'}…`, { tone: 'progress', id: 'export' });
  try {
    const name = previewWord();
    const opts = { name, paper: el.paper.value, ink: el.ink.value, size: +el.size.value };
    const total = Math.ceil(list.length / SHEET.perSheet);
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const header = (page, pages) => ({ name, title: `Typeface shortlist · ${list.length} ${list.length === 1 ? 'font' : 'fonts'} · ${date}`, pageLabel: pages > 1 ? `${page} / ${pages}` : '' });
    await prepareFonts(list, name);

    const slug = name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'wordmark';
    const pages = format === 'pdf' ? total + 1 : total;
    const canvases = [];
    for (let i = 0; i < total; i++) {
      progress.update(total > 1 ? `Drawing page ${i + 1} of ${total}…` : 'Drawing your sheet…');
      await delay(0); // let the toast repaint
      canvases.push(drawCardsSheet(list.slice(i * SHEET.perSheet, (i + 1) * SHEET.perSheet), i * SHEET.perSheet, { ...opts, header: header(i + 1, pages) }));
    }

    if (format === 'pdf') {
      progress.update('Building PDF…');
      canvases.push(drawDetailsSheet(list, { ...opts, header: header(pages, pages) }));
      const images = [];
      for (const canvas of canvases) {
        const bytes = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
        images.push({ bytes, pxWidth: canvas.width, pxHeight: canvas.height, ptWidth: canvas.width / SHEET.scale * 0.75, ptHeight: canvas.height / SHEET.scale * 0.75 });
        canvas.width = canvas.height = 0; // free memory (Safari)
      }
      downloadFile(makePdf(images), `${slug}-shortlist.pdf`);
      progress.dismiss(true);
      message(`Exported a ${images.length}-page PDF of ${list.length} ${list.length === 1 ? 'font' : 'fonts'}.`, { tone: 'success' });
    } else {
      for (let i = 0; i < canvases.length; i++) {
        const blob = await canvasBlob(canvases[i], 'image/png');
        canvases[i].width = canvases[i].height = 0;
        downloadFile(blob, `${slug}-shortlist${canvases.length > 1 ? '-' + (i + 1) : ''}.png`);
      }
      downloadFile(new Blob([shortlistDetails(list, opts)], { type: 'text/plain;charset=utf-8' }), `${slug}-font-details.txt`);
      progress.dismiss(true);
      message(`Exported ${list.length} ${list.length === 1 ? 'font' : 'fonts'}: ${canvases.length} PNG ${canvases.length === 1 ? 'sheet' : 'sheets'} + a details file.`, { tone: 'success' });
    }
  } catch (error) {
    progress.dismiss(true);
    message('Export didn’t finish — some fonts may not have loaded. Check your connection and try again.', {
      tone: 'error',
      action: { label: 'Retry', onClick: () => exportShortlist(format) },
    });
    console.error(error);
  } finally {
    exporting = false;
    restore?.();
  }
}

/* =========================================================================
   Shortlist drawer — compare favourites side by side
   ========================================================================= */

const drawer = (() => {
  const panel = $('#shortlist');
  const list = $('#shortlist-list');
  const count = $('#shortlist-count');
  const badge = $('#shortlist-badge');
  const toggle = $('#shortlist-button');
  let caseMode = 'both'; // 'both' | 'upper' | 'lower'
  let queued = false;

  const isOpen = () => !panel.hidden;

  function open() {
    panel.hidden = false;
    document.body.classList.add('drawer-open');
    toggle.setAttribute('aria-expanded', 'true');
    renderList();
    requestAnimationFrame(() => panel.classList.add('open'));
    $('#shortlist-close').focus({ preventScroll: true });
  }
  function close() {
    panel.classList.remove('open');
    document.body.classList.remove('drawer-open');
    toggle.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = true; }, 260);
  }

  function row(f, index) {
    const s = settingsFor(f);
    loadGoogleStylesheet(f).catch(() => {});
    const sample = h('div', { className: 'sl-sample' });
    sample.style.background = el.paper.value;
    sample.style.color = el.ink.value;
    Object.assign(sample.style, { fontFamily: cssFamily(f) + ', sans-serif', fontWeight: s.weight, fontStyle: s.italic ? 'italic' : 'normal', letterSpacing: s.spacing + 'px' });
    const word = previewWord();
    const lines = caseMode === 'upper' ? [word.toUpperCase()] : caseMode === 'lower' ? [word.toLowerCase()] : [word.toUpperCase(), word.toLowerCase()];
    sample.append(...lines.map((t) => h('div', { textContent: t })));

    const remove = h('button', {
      className: 'sl-remove', type: 'button', innerHTML: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
      title: 'Remove from shortlist', 'aria-label': 'Remove ' + f.family + ' from shortlist',
      onClick: () => {
        const key = fontId(f);
        state.favorites.delete(key);
        persist();
        render();
        message(`Removed ${f.family} from favourites.`, {
          id: 'favourites',
          action: { label: 'Undo', onClick: () => { state.favorites.add(key); persist(); render(); } },
        });
      },
    });
    return h('li', { className: 'sl-row' },
      h('div', { className: 'sl-head' },
        h('span', { className: 'sl-num', textContent: index + 1 }),
        h('div', { className: 'sl-title' },
          h('strong', { textContent: f.family }),
          h('span', { textContent: `${f.category} · ${styleSummary(f, s)}` })),
        remove),
      sample);
  }

  /** Shrink each preview line to fit the drawer width. */
  function fit() {
    const size = Math.min(+el.size.value, 56);
    for (const sample of list.querySelectorAll('.sl-sample')) {
      const available = sample.clientWidth - 32;
      for (const line of sample.children) {
        line.style.fontSize = size + 'px';
        if (line.scrollWidth > available) line.style.fontSize = Math.max(9, size * available / line.scrollWidth) + 'px';
      }
    }
  }

  function renderList() {
    const { list: fonts, missing } = shortlist();
    const n = fonts.length + missing.length;
    count.textContent = `${n} ${n === 1 ? 'font' : 'fonts'}`;
    $('#shortlist-footer').hidden = n === 0;
    if (!n) {
      list.replaceChildren(h('li', { className: 'sl-empty' },
        h('div', { className: 'empty-icon', innerHTML: svg(EMPTY_ICONS.heart) }),
        h('strong', { textContent: 'Nothing here yet' }),
        h('span', { textContent: 'Tap the heart on any font card to add it. Your shortlist appears here so you can compare them side by side.' })));
      return;
    }
    list.replaceChildren(
      ...fonts.map(row),
      ...missing.map((key) => h('li', { className: 'sl-row sl-missing' },
        h('div', { className: 'sl-head' },
          h('span', { className: 'sl-num', textContent: '–' }),
          h('div', { className: 'sl-title' }, h('strong', { textContent: key.replace(/^\w+:/, '') }), h('span', { textContent: 'Local font not loaded — connect or re-import it' })))))
    );
    requestAnimationFrame(fit);
    document.fonts.ready.then(() => requestAnimationFrame(fit));
  }

  /** Called whenever favourites or preview settings change. */
  function sync() {
    const n = state.favorites.size;
    badge.textContent = n;
    badge.hidden = n === 0;
    if (!isOpen() || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; renderList(); });
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  $('#shortlist-close').addEventListener('click', close);
  document.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', () => {
    caseMode = b.dataset.case;
    document.querySelectorAll('[data-case]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderList();
  }));
  $('#export-png').addEventListener('click', (e) => exportShortlist('png', e.currentTarget));
  $('#export-pdf').addEventListener('click', (e) => exportShortlist('pdf', e.currentTarget));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !document.querySelector('.colour-popover:not([hidden]), dialog[open]')) close();
  });
  window.addEventListener('resize', () => isOpen() && fit());

  onFavouritesChanged = sync;
  sync();
  return { sync, open, close, toggle: () => (isOpen() ? close() : open()) };
})();

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

// ⌘K anywhere, or "/" when not typing, focuses search.
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if ((e.metaKey && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
});

el.theme.addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  const colours = CARD_COLOURS[dark ? 'dark' : 'light'];
  setCardColours(colours.ink, colours.paper);
  window.nativeSetTheme?.(dark);
});

document.querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.source)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

el.rescan.addEventListener('click', () => connectLocalFonts({ fresh: true, trigger: el.rescan }));
el.import.addEventListener('click', () => el.files.click());
el.files.addEventListener('change', async (e) => { await importFontFiles(e.target.files); e.target.value = ''; });
el.clearFavourites.addEventListener('click', () => {
  const previous = [...state.favorites];
  if (!previous.length) { message('You don’t have any favourites yet.'); return; }
  state.favorites.clear();
  persist();
  render();
  message(`Cleared ${previous.length} ${previous.length === 1 ? 'favourite' : 'favourites'}.`, {
    id: 'favourites',
    action: {
      label: 'Undo',
      onClick: () => {
        previous.forEach((key) => state.favorites.add(key));
        persist();
        render();
        message('Favourites restored.', { tone: 'success', id: 'favourites' });
      },
    },
  });
});

window.addEventListener('resize', () => { refreshAllCards(); moveTabIndicator(); });
document.fonts.addEventListener('loadingdone', refreshAllCards);

/* =========================================================================
   Boot
   ========================================================================= */

buildToolbar();
setView(state.view);
moveTabIndicator();
// Enable the slide animation only after the first placement (no slide-in on load).
requestAnimationFrame(() => requestAnimationFrame(() => tabIndicator?.classList.add('ready')));
document.fonts.ready.then(moveTabIndicator); // tab widths can change once fonts settle

if (Array.isArray(window.FONT_CATALOG)) {
  const rank = (f) => { const i = FEATURED.indexOf(f.family); return i < 0 ? 999 : i; };
  state.googleFonts = [...window.FONT_CATALOG].sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family));
  // Start on Google Fonts unless local fonts are (or will be) connected.
  if (!state.fontsConnected) state.source = 'google';
  setSource(state.source);
} else {
  render();
  message('The Google Fonts list didn’t load. Reload the page to try again.', { tone: 'error', duration: 0 });
}

// Local fonts: reconnect automatically if the user agreed before; otherwise ask once.
if (state.fontsConnected) connectLocalFonts({ silent: true });
else if (!state.fontsPrompted) setTimeout(showConnectPrompt, 400);

/* =========================================================================
   Mac app integration: menu commands, File › Import, drag & drop, native feel
   ========================================================================= */

const DEFAULT_SIZE = 42;
function setPreviewSize(px) {
  el.size.value = Math.max(+el.size.min, Math.min(+el.size.max, px));
  el.size.dispatchEvent(new Event('input'));
}

/** Called by the menu bar (native/FindMyType.swift). */
window.appCommand = (command) => {
  switch (command) {
    case 'export-pdf': exportShortlist('pdf'); break;
    case 'export-png': exportShortlist('png'); break;
    case 'rescan': connectLocalFonts({ fresh: state.fontsConnected }); break;
    case 'find': el.search.focus(); el.search.select(); break;
    case 'edit-name': el.word.focus(); el.word.select(); break;
    case 'source-google': setSource('google'); break;
    case 'source-local': setSource('local'); break;
    case 'shortlist': drawer.toggle(); break;
    case 'view-grid': setView('grid'); break;
    case 'view-list': setView('list'); break;
    case 'shuffle': setSort('shuffle'); break;
    case 'size-up': setPreviewSize(+el.size.value + 4); break;
    case 'size-down': setPreviewSize(+el.size.value - 4); break;
    case 'size-reset': setPreviewSize(DEFAULT_SIZE); break;
    case 'toggle-theme': el.theme.click(); break;
    default: break;
  }
};

/** File › Import Font Files… hands us [{ name, data: base64 }]. */
window.importFontData = (files) => importFontFiles(files.map(({ name, data }) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new File([bytes], name);
}));

// Drop font files anywhere on the window to import them.
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
document.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dropping');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const fonts = [...e.dataTransfer.files].filter((f) => FONT_FILE.test(f.name));
  if (fonts.length) importFontFiles(fonts);
  else message('Drop .ttf, .otf, .woff or .woff2 files to preview them.', { tone: 'error' });
});

// Feel like a Mac app: no web context menu outside text fields.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) e.preventDefault();
});

if (window.isMacApp) document.body.classList.add('mac-app');
window.nativeSetTheme?.(document.body.classList.contains('dark'));
