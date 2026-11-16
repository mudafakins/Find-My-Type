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
  newestFirst: false,
  randomOrder: null,               // Map<fontId, index> while shuffled
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

/** Filter tags. Condensed/Tall are guesses from the family name. */
function tags(f) {
  const result = [f.category];
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

const loadedGoogleFamilies = new Set();

function googleFontLink(f) {
  if (f.source !== 'google' || loadedGoogleFamilies.has(f.family)) return null;
  loadedGoogleFamilies.add(f.family);
  const family = encodeURIComponent(f.family).replace(/%20/g, '+');
  const link = h('link', {
    rel: 'stylesheet',
    href: `https://fonts.googleapis.com/css2?family=${family}:wght@${f.weights.join(';')}&display=swap`,
  });
  link.addEventListener('error', () => loadedGoogleFamilies.delete(f.family));
  document.head.append(link);
  return link;
}

// Load a card's Google font when it scrolls near the viewport.
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const card = entry.target;
    const link = googleFontLink(card._font);
    link?.addEventListener('error', () => {
      card.querySelector('.card-foot span').textContent = 'Font unavailable · check connection';
    });
    cardObserver.unobserve(card);
  }
}, { rootMargin: '350px' });

/* =========================================================================
   Toolbar: category filters + sorting
   ========================================================================= */

function renderToolbar() {
  el.filters.replaceChildren(...CATEGORIES.map((category) => h('button', {
    innerHTML: category === FAVOURITES ? ICONS.heart + '<span>Favourites</span>' : '',
    textContent: category === FAVOURITES ? undefined : category,
    className: category === state.filter ? 'active' : '',
    onClick: () => { state.filter = category; renderToolbar(); render(); },
  })));

  const random = h('button', {
    innerHTML: ICONS.shuffle + '<span>Random</span>',
    title: 'Shuffle fonts matching the current filter and search',
    className: 'random-sort' + (state.randomOrder ? ' active' : ''),
    onClick: shuffle,
  });
  const newest = h('button', {
    innerHTML: ICONS.clock + '<span>Newly installed</span>',
    className: state.newestFirst ? 'active' : '',
    title: 'Newest local fonts first; file creation dates are estimates. Fonts without dates use first detection after the initial scan.',
    onClick: toggleNewest,
  });
  el.sortControls.replaceChildren(random, newest);
}

function shuffle() {
  state.newestFirst = false;
  const order = currentList().map(fontId);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  state.randomOrder = new Map(order.map((key, i) => [key, i]));
  renderToolbar();
  render();
}

function toggleNewest() {
  state.newestFirst = !state.newestFirst;
  state.randomOrder = null;
  renderToolbar();
  setSource('local'); // newest only makes sense for installed fonts
}

function setSource(source) {
  state.source = source;
  document.querySelectorAll('[data-source]').forEach((b) => b.classList.toggle('active', b.dataset.source === source));
  moveTabIndicator();
  render();
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
  const query = el.search.value.toLowerCase();
  state.visible = currentList().filter((f) => matchesFilters(f, query));

  if (state.newestFirst) {
    state.visible.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0) || a.family.localeCompare(b.family));
  } else if (state.randomOrder) {
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

function createCard(f) {
  const key = fontId(f);
  const s = settingsFor(f);
  const card = h('article', { className: 'card' });
  card._font = f;

  const save = () => { updateCard(card); persist(); };

  // Header: name + favourite
  const heart = h('button', { className: 'heart', innerHTML: ICONS.heart, 'aria-label': 'Favourite ' + f.family });
  const syncHeart = () => {
    const on = state.favorites.has(key);
    heart.classList.toggle('saved', on);
    heart.setAttribute('aria-pressed', on);
  };
  heart.addEventListener('click', () => {
    if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
    persist();
    if (state.filter === FAVOURITES) render(); else syncHeart();
    heart.classList.toggle('pop', state.favorites.has(key)); // animate only on click
  });
  syncHeart();
  const head = h('div', { className: 'card-head' }, h('strong', { textContent: f.family }), heart);

  // Preview: uppercase + lowercase lines
  const sample = h('div', { className: 'sample' }, h('div'), h('div'));

  // Footer: category + weight count
  const foot = h('div', { className: 'card-foot' },
    h('span', { textContent: f.category.toUpperCase() }),
    h('span', { textContent: `${f.weights.length} ${f.weights.length === 1 ? 'weight' : 'weights'}${f.variable ? ' · Variable' : ''}` }),
  );

  // Per-font options: weight, italic, tracking, reset
  const weight = h('select', {
    'aria-label': f.family + ' weight',
    onChange: () => { s.weight = +weight.value; save(); },
  }, ...f.weights.map((w) => h('option', { value: w, textContent: w + (w === 400 ? ' Regular' : w === 700 ? ' Bold' : '') })));
  weight.value = s.weight;

  const italic = h('button', {
    className: 'italic',
    innerHTML: ICONS.italic,
    title: 'Italic (may be synthesized)',
    'aria-label': 'Toggle italics for ' + f.family,
    'aria-pressed': s.italic,
    onClick: () => { s.italic = !s.italic; italic.setAttribute('aria-pressed', s.italic); save(); },
  });

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
      italic.setAttribute('aria-pressed', false);
      save();
    },
  });

  const options = h('div', { className: 'options' }, weight, italic, h('label', {}, 'Tracking ', spacing), reset);

  card.append(head, sample, foot, options);
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

  // Shrink lines that overflow the card.
  requestAnimationFrame(() => {
    const available = sample.clientWidth - 24;
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

function waitForStylesheet(link) {
  if (link.sheet) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Font stylesheet timeout')), 20000);
    link.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    link.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Font stylesheet failed')); }, { once: true });
  });
}

/** Make sure every favourite face is loaded before drawing it on canvas. */
async function prepareFonts(list, word) {
  for (const f of list) googleFontLink(f); // favourites that were never scrolled into view
  const links = [...document.querySelectorAll('link[href*="fonts.googleapis.com/css2"]')];
  await Promise.all(links.map(waitForStylesheet));
  await document.fonts.ready;
  for (const f of list) {
    const s = settingsFor(f);
    await document.fonts.load(`${s.italic ? 'italic ' : ''}${s.weight} 40px ${cssFamily(f)}`, word);
  }
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

  function position() {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    panel.style.top = '0px';
    const height = panel.offsetHeight;
    const below = rect.bottom + 8 + height < window.innerHeight;
    panel.style.top = Math.max(12, below ? rect.bottom + 8 : rect.top - height - 8) + 'px';
  }

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
   Wiring
   ========================================================================= */

for (const key of ['word', 'ink', 'paper', 'size']) {
  el[key].addEventListener('input', () => {
    el.sizeValue.textContent = el.size.value;
    refreshAllCards();
    persist();
  });
}

el.search.addEventListener('input', render);

el.theme.addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  const colours = CARD_COLOURS[dark ? 'dark' : 'light'];
  el.ink.value = colours.ink;
  el.paper.value = colours.paper;
  el.ink.dispatchEvent(new Event('input'));   // updates swatch, cards, storage
  el.paper.dispatchEvent(new Event('input'));
  colourPicker.refresh();
});

document.querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.source)));

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

renderToolbar();
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
