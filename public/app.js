'use strict';

/* global window, document, localStorage, fetch, navigator, requestAnimationFrame */

const SNIPPET =
  "(() => { let t = localStorage.getItem('token'); if (!t) return console.warn('No token in localStorage. Use the Network tab method instead.'); try { t = JSON.parse(t); } catch {} console.log(t); })()";

const STORAGE = {
  selection: 'dee.selection.v1',
  size: 'dee.size.v1',
};

const $ = (id) => document.getElementById(id);

const dom = {
  boot: $('boot'),
  loginView: $('login-view'),
  browserView: $('browser-view'),
  loginForm: $('login-form'),
  tokenInput: $('token-input'),
  tokenVisibility: $('token-visibility'),
  pasteToken: $('paste-token'),
  loginError: $('login-error'),
  connectBtn: $('connect-btn'),
  detectBtn: $('detect-btn'),
  detectLabel: $('detect-label'),
  tokenSnippet: $('token-snippet'),
  copySnippet: $('copy-snippet'),
  tokenHelp: $('token-help'),

  account: $('account'),
  accountAvatar: $('account-avatar'),
  accountName: $('account-name'),
  accountHandle: $('account-handle'),
  refreshBtn: $('refresh-btn'),
  logoutBtn: $('logout-btn'),

  sidebar: $('sidebar'),
  sidebarBackdrop: $('sidebar-backdrop'),
  sidebarToggle: $('sidebar-toggle'),
  sidebarSelected: $('sidebar-selected'),
  sidebarDownload: $('sidebar-download'),
  guildSearch: $('guild-search'),
  guildList: $('guild-list'),
  guildTotal: $('guild-total'),

  notice: $('notice'),
  noticeText: $('notice-text'),
  noticeClose: $('notice-close'),

  search: $('search'),
  kindFilter: $('kind-filter'),
  animatedFilter: $('animated-filter'),
  sizeSelect: $('size-select'),
  selectAll: $('select-all'),
  resultCount: $('result-count'),
  updatedAt: $('updated-at'),
  clearSelection: $('clear-selection'),
  downloadBtn: $('download-btn'),
  downloadLabel: $('download-label'),

  loading: $('loading'),
  loadingText: $('loading-text'),
  grid: $('grid'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  emptyReset: $('empty-reset'),

  modal: $('download-modal'),
  modalTitle: $('modal-title'),
  modalClose: $('modal-close'),
  progress: $('job-progress'),
  progressBar: $('job-progress-bar'),
  jobStatus: $('job-status'),
  jobCurrent: $('job-current'),
  jobFailures: $('job-failures'),
  jobFailuresSummary: $('job-failures-summary'),
  jobFailuresList: $('job-failures-list'),
  jobCancel: $('job-cancel'),
  jobDownload: $('job-download'),
  jobDone: $('job-done'),

  toasts: $('toasts'),
};

const state = {
  user: null,
  items: [],
  itemsByKey: new Map(),
  cards: new Map(),
  guilds: [],
  errors: [],
  selected: new Set(),
  visible: [],
  filter: { guildId: 'all', kind: 'all', animated: false, search: '' },
  size: 256,
  job: null,
  jobTimer: null,
  renderToken: 0,
  rendering: false,
  loading: false,
};

const numberFmt = new Intl.NumberFormat('en');
const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function formatCount(value) {
  const number = Number(value) || 0;
  return number >= 10000 ? compactFmt.format(number) : numberFmt.format(number);
}

function formatBytes(bytes) {
  const number = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = number;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function timeAgo(ms) {
  if (!ms || ms < 45000) return 'just now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function toast(message, type = 'info', options = {}) {
  const el = document.createElement('div');
  el.className = `toast${type === 'info' ? '' : ` ${type}`}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  if (options.href) {
    const link = document.createElement('a');
    link.href = options.href;
    link.textContent = options.label || 'Open';
    if (options.download) link.setAttribute('download', options.download);
    el.appendChild(link);
  }

  dom.toasts.appendChild(el);
  const duration = options.duration || 5200;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, duration);
  return el;
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    const err = new Error('Cannot reach the local app. Is the server still running?');
    err.status = 0;
    throw err;
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const err = new Error(data.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

function isJobActive(job = state.job) {
  return Boolean(job && (job.status === 'running' || job.status === 'cancelling'));
}

/* ------------------------------------------------------------------ *
 * Session / views
 * ------------------------------------------------------------------ */

function showLogin() {
  dom.boot.hidden = true;
  dom.loginView.hidden = false;
  dom.browserView.hidden = true;
  dom.account.hidden = true;
  dom.refreshBtn.hidden = true;
  dom.logoutBtn.hidden = true;
  setSidebar(false);
  setLoginBusy(false);
}

function showBrowser() {
  dom.boot.hidden = true;
  dom.loginView.hidden = true;
  dom.browserView.hidden = false;
  dom.account.hidden = false;
  dom.refreshBtn.hidden = false;
  dom.logoutBtn.hidden = false;
}

function setAccount(user) {
  state.user = user;
  if (!user) return;
  dom.accountAvatar.src = user.avatar || '';
  dom.accountAvatar.alt = '';
  dom.accountName.textContent = user.globalName || user.username;
  dom.accountHandle.textContent = user.bot ? 'Bot account' : `@${user.username}`;
}

function setLoginError(message) {
  dom.loginError.textContent = message || '';
  dom.loginError.hidden = !message;
}

function setLoginBusy(busy, action = 'connect') {
  dom.connectBtn.disabled = busy;
  dom.detectBtn.disabled = busy;
  dom.pasteToken.disabled = busy;
  if (action === 'detect') {
    dom.detectLabel.textContent = busy ? 'Searching this computer…' : 'Use the saved Discord login';
    dom.connectBtn.textContent = 'Connect';
  } else {
    dom.detectLabel.textContent = 'Use the saved Discord login';
    dom.connectBtn.textContent = busy ? 'Connecting…' : 'Connect';
  }
}

function showLoading(text) {
  state.renderToken += 1;
  state.rendering = false;
  state.cards.clear();
  dom.grid.textContent = '';
  dom.empty.hidden = true;
  dom.resultCount.textContent = '';
  dom.loading.hidden = false;
  dom.loadingText.textContent = text;
}

function showGridError(message) {
  dom.loading.hidden = true;
  dom.grid.textContent = '';
  state.cards.clear();
  dom.empty.hidden = false;
  dom.emptyTitle.textContent = 'Could not load your servers';
  dom.emptyText.textContent = message;
  dom.emptyReset.hidden = true;
  dom.updatedAt.textContent = '';
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function loadData(force) {
  if (state.loading || state.rendering) return false;
  state.loading = true;
  dom.refreshBtn.disabled = true;
  dom.refreshBtn.classList.add('spinning');
  setLoginError('');
  showLoading(force ? 'Refreshing your servers…' : 'Reading your servers…');

  try {
    const data = await api(`/api/data${force ? '?refresh=1' : ''}`);
    if (data.user) setAccount(data.user);
    state.guilds = Array.isArray(data.guilds) ? data.guilds : [];
    state.errors = Array.isArray(data.errors) ? data.errors : [];
    state.items = (Array.isArray(data.items) ? data.items : [])
      .filter((item) => item && /^\d{5,25}$/.test(String(item.id)) && (item.kind === 'emoji' || item.kind === 'sticker'))
      .map((item) => ({ ...item, key: `${item.kind}:${item.id}` }));
    state.itemsByKey = new Map(state.items.map((item) => [item.key, item]));

    loadSelection();
    pruneSelection();
    if (state.filter.guildId !== 'all' && !state.guilds.some((g) => g.id === state.filter.guildId)) {
      state.filter.guildId = 'all';
    }

    renderGuilds();
    renderNotice();
    updateMeta(data);
    hideLoading();
    renderCards();
    return true;
  } catch (err) {
    if (err.status === 401 || err.code === 'unauthorized') {
      clearLocalSession();
      showLogin();
      setLoginError(err.message || 'Your Discord session expired. Please connect again.');
      toast('Your session expired. Connect again to continue.', 'error');
    } else if (state.items.length > 0) {
      hideLoading();
      toast(`Refresh failed: ${err.message}`, 'error');
    } else {
      showGridError(err.message);
    }
    return false;
  } finally {
    state.loading = false;
    dom.refreshBtn.disabled = false;
    dom.refreshBtn.classList.remove('spinning');
  }
}

function hideLoading() {
  dom.loading.hidden = true;
}

function updateMeta(data) {
  const fetchedAt = Number(data.fetchedAt) || Date.now();
  const date = new Date(fetchedAt);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const serverCount = state.guilds.length;
  const pieces = [`${formatCount(serverCount)} server${serverCount === 1 ? '' : 's'}`];

  if (data.source === 'cache') {
    pieces.push(`cached ${timeAgo(Number(data.cacheAge))} ago`);
  } else {
    pieces.push(`updated ${time}`);
  }

  dom.updatedAt.textContent = pieces.join(' · ');
  dom.updatedAt.title = date.toLocaleString();
}

function renderNotice() {
  if (state.errors.length === 0) {
    dom.notice.hidden = true;
    return;
  }

  const guilds = new Set();
  for (const error of state.errors) {
    if (error && error.guildName) guilds.add(error.guildName);
  }
  const names = [...guilds];
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  dom.noticeText.textContent = `Couldn't read all data from ${names.length} server${names.length === 1 ? '' : 's'}: ${shown}${more}. Everything else loaded normally.`;
  dom.noticeText.title = state.errors.map((e) => `${e.guildName} (${e.kind}): ${e.message}`).join('\n');
  dom.notice.hidden = false;
}

/* ------------------------------------------------------------------ *
 * Selection storage
 * ------------------------------------------------------------------ */

let selectionOwner = null;

function loadSelection() {
  if (!state.user) return;
  if (selectionOwner === state.user.id) return;
  selectionOwner = state.user.id;
  state.selected = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.selection) || 'null');
    if (raw && raw.userId === state.user.id && Array.isArray(raw.keys)) {
      state.selected = new Set(raw.keys.filter((key) => typeof key === 'string'));
    }
  } catch {
    state.selected = new Set();
  }
}

function pruneSelection() {
  let changed = false;
  for (const key of state.selected) {
    if (!state.itemsByKey.has(key)) {
      state.selected.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

let persistTimer = null;

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSelection, 250);
}

function persistSelection() {
  if (!state.user) return;
  try {
    localStorage.setItem(
      STORAGE.selection,
      JSON.stringify({ userId: state.user.id, keys: [...state.selected] }),
    );
  } catch {
    /* storage might be full or disabled */
  }
}

function clearLocalSession() {
  clearTimeout(state.jobTimer);
  selectionOwner = null;
  state.user = null;
  state.items = [];
  state.itemsByKey = new Map();
  state.cards = new Map();
  state.guilds = [];
  state.errors = [];
  state.selected = new Set();
  state.visible = [];
  state.job = null;
  try {
    localStorage.removeItem(STORAGE.selection);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Login actions
 * ------------------------------------------------------------------ */

async function connect(token) {
  const value = String(token || '').trim();
  if (!value) {
    setLoginError('Paste a token first, or use the saved login button.');
    dom.tokenInput.focus();
    return;
  }

  setLoginError('');
  setLoginBusy(true, 'connect');
  try {
    const res = await api('/api/login', { method: 'POST', body: { token: value } });
    dom.tokenInput.value = '';
    dom.tokenInput.type = 'password';
    dom.tokenVisibility.textContent = 'Show';
    dom.tokenVisibility.setAttribute('aria-label', 'Show token');
    setAccount(res.user);
    showBrowser();
    const loaded = await loadData(true);
    if (loaded) {
      toast(`Connected as ${res.user.globalName || res.user.username}`, 'success');
    } else if (state.user) {
      toast('Connected, but loading your servers failed.', 'error');
    }
  } catch (err) {
    setLoginError(err.message);
  } finally {
    setLoginBusy(false);
  }
}

async function detectToken() {
  setLoginError('');
  setLoginBusy(true, 'detect');
  try {
    const res = await api('/api/login/detect', { method: 'POST' });
    setAccount(res.user);
    showBrowser();
    const loaded = await loadData(true);
    if (loaded) {
      toast(`Connected as ${res.user.globalName || res.user.username}`, 'success');
    } else if (state.user) {
      toast('Connected, but loading your servers failed.', 'error');
    }
  } catch (err) {
    let message = err.message;
    const checked = err.data && Array.isArray(err.data.checked) ? err.data.checked : [];
    if (err.status === 404 && checked.length > 0) {
      message += `\nProfiles checked:\n${checked.slice(0, 4).join('\n')}`;
    }
    setLoginError(message);
    if (err.status === 404) {
      dom.tokenHelp.open = true;
      dom.tokenHelp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } finally {
    setLoginBusy(false);
  }
}

async function logout() {
  const job = state.job;
  if (isJobActive(job) && job) {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    } catch {
      /* ignore */
    }
  }
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  clearLocalSession();
  showLogin();
  setLoginError('');
  toast('Logged out.');
}

/* ------------------------------------------------------------------ *
 * Guild list & rendering
 * ------------------------------------------------------------------ */

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

function renderGuilds() {
  dom.guildList.textContent = '';
  const search = dom.guildSearch.value.trim().toLowerCase();
  const rows = [
    { id: 'all', name: 'All servers', count: state.items.length, icon: null, error: null },
    ...state.guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      count: (guild.emojiCount || 0) + (guild.stickerCount || 0),
      icon: guild.icon,
      error: guild.error,
    })),
  ];

  for (const row of rows) {
    if (row.id !== 'all' && search && !row.name.toLowerCase().includes(search)) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'guild-row';
    if (state.filter.guildId === row.id) button.classList.add('active');
    if (row.error) {
      button.title = `Some data could not be loaded from this server: ${row.error}`;
    }

    const icon = document.createElement('span');
    icon.className = `guild-icon${row.id === 'all' ? ' all' : ''}`;
    if (row.icon) {
      const img = document.createElement('img');
      img.src = row.icon;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        icon.textContent = row.id === 'all' ? '✦' : initials(row.name);
      });
      icon.appendChild(img);
    } else {
      icon.textContent = row.id === 'all' ? '✦' : initials(row.name);
    }

    const name = document.createElement('span');
    name.className = 'guild-name';
    name.textContent = row.name;

    const count = document.createElement('span');
    count.className = 'guild-count';
    count.textContent = formatCount(row.count);

    button.append(icon, name, count);
    button.addEventListener('click', () => selectGuild(row.id));
    dom.guildList.appendChild(button);
  }

  dom.guildTotal.textContent = String(state.guilds.length);
}

function selectGuild(id) {
  state.filter.guildId = id;
  renderGuilds();
  applyFilters();
  setSidebar(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function makeCard(item) {
  const card = document.createElement('label');
  card.className = 'card';
  card.dataset.key = item.key;
  card.dataset.kind = item.kind;
  card.setAttribute('role', 'listitem');
  const kindLabel = item.kind === 'sticker' ? 'sticker' : 'emoji';
  card.title = `${item.name} — ${item.animated ? 'animated ' : ''}${kindLabel} from ${item.guildName}`;
  card.classList.toggle('selected', state.selected.has(item.key));
  if (item.available === false) card.classList.add('unavailable');

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'card-input';
  input.checked = state.selected.has(item.key);
  input.setAttribute(
    'aria-label',
    `${item.name}, ${item.animated ? 'animated ' : ''}${kindLabel} from ${item.guildName}${item.available === false ? ', currently unavailable' : ''}`,
  );
  input.addEventListener('change', () => setSelected(item.key, input.checked));

  const check = document.createElement('span');
  check.className = 'card-check';
  check.setAttribute('aria-hidden', 'true');

  const thumb = document.createElement('span');
  thumb.className = 'thumb';

  const fallback = document.createElement('span');
  fallback.className = 'thumb-fallback';
  fallback.textContent = initials(item.name).charAt(0) || '?';

  const fallbackSources = [];
  if (item.preview) {
    const addFallback = (source) => {
      if (source && source !== item.preview && !fallbackSources.includes(source)) {
        fallbackSources.push(source);
      }
    };
    if (item.preview.includes('media.discordapp.net')) {
      addFallback(item.preview.replace('media.discordapp.net', 'cdn.discordapp.com'));
    }
    if (item.kind === 'emoji' && item.animated && item.preview.includes('.webp?size=96')) {
      addFallback(item.preview.replace('.webp?size=96', '.gif?size=96'));
    }
  }

  if (item.preview) {
    const img = document.createElement('img');
    img.src = item.preview;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => {
      const next = fallbackSources.shift();
      if (next) {
        img.src = next;
        return;
      }
      thumb.classList.add('failed');
    });
    thumb.appendChild(img);
  } else {
    thumb.classList.add('failed');
  }
  thumb.appendChild(fallback);

  let badgeText = '';
  if (item.kind === 'sticker') badgeText = item.animated ? '▶ Sticker' : 'Sticker';
  else if (item.animated) badgeText = '▶ Animated';

  if (badgeText) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = badgeText;
    thumb.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = item.name;
  name.title = item.name;

  const sub = document.createElement('span');
  sub.className = 'card-sub';
  sub.textContent = item.guildName;
  sub.title = `${item.kind} from ${item.guildName}`;

  card.append(input, check, thumb, name, sub);
  return card;
}

function renderCards() {
  state.renderToken += 1;
  const token = state.renderToken;
  state.rendering = true;
  dom.grid.textContent = '';
  state.cards.clear();
  dom.empty.hidden = true;

  const items = state.items;
  if (items.length === 0) {
    state.rendering = false;
    applyFilters();
    return;
  }

  let index = 0;
  dom.resultCount.textContent = `Rendering 0 of ${formatCount(items.length)}…`;

  const step = () => {
    if (token !== state.renderToken) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + 240, items.length);
    for (; index < end; index += 1) {
      const item = items[index];
      const card = makeCard(item);
      state.cards.set(item.key, card);
      fragment.appendChild(card);
    }
    dom.grid.appendChild(fragment);

    if (index < items.length) {
      dom.resultCount.textContent = `Rendering ${formatCount(index)} of ${formatCount(items.length)}…`;
      requestAnimationFrame(step);
    } else {
      state.rendering = false;
      applyFilters();
    }
  };

  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ *
 * Filtering, selection & empty states
 * ------------------------------------------------------------------ */

function applyFilters() {
  const search = state.filter.search.trim().toLowerCase();
  const visible = [];

  for (const item of state.items) {
    let matches = true;
    if (state.filter.guildId !== 'all' && item.guildId !== state.filter.guildId) matches = false;
    else if (state.filter.kind !== 'all' && item.kind !== state.filter.kind) matches = false;
    else if (state.filter.animated && !item.animated) matches = false;
    else if (search) {
      matches =
        item.name.toLowerCase().includes(search) || item.guildName.toLowerCase().includes(search);
    }

    if (matches) visible.push(item);
    const card = state.cards.get(item.key);
    if (card && card.hidden === matches) card.hidden = !matches;
  }

  state.visible = visible;
  dom.resultCount.textContent = `${formatCount(visible.length)} of ${formatCount(state.items.length)} items`;
  updateEmptyState();
  updateSelectionUI();
}

function updateEmptyState() {
  if (state.items.length === 0) {
    dom.empty.hidden = false;
    dom.emptyTitle.textContent = 'No emojis or stickers found';
    dom.emptyText.textContent =
      state.errors.length > 0
        ? 'Discord did not return any custom emojis. Check the warning above, then try refreshing.'
        : "None of your servers seem to have custom emojis or stickers yet. That's a good excuse to make some.";
    dom.emptyReset.hidden = true;
    return;
  }

  if (state.visible.length === 0) {
    dom.empty.hidden = false;
    const guild = state.guilds.find((g) => g.id === state.filter.guildId);
    if (state.filter.guildId !== 'all' && guild && (guild.emojiCount || 0) + (guild.stickerCount || 0) === 0) {
      dom.emptyTitle.textContent = 'Nothing in this server';
      dom.emptyText.textContent = `${guild.name} does not have any custom emojis or stickers.`;
    } else {
      dom.emptyTitle.textContent = 'Nothing matches';
      dom.emptyText.textContent = 'Try a different search, or loosen the filters.';
    }
    dom.emptyReset.hidden = false;
    return;
  }

  dom.empty.hidden = true;
}

function setSelected(key, selected) {
  if (selected) state.selected.add(key);
  else state.selected.delete(key);

  const card = state.cards.get(key);
  if (card) {
    card.classList.toggle('selected', selected);
    const input = card.querySelector('.card-input');
    if (input && input.checked !== selected) input.checked = selected;
  }

  updateSelectionUI();
  schedulePersist();
}

function syncCards() {
  for (const [key, card] of state.cards) {
    const checked = state.selected.has(key);
    card.classList.toggle('selected', checked);
    const input = card.querySelector('.card-input');
    if (input && input.checked !== checked) input.checked = checked;
  }
}

function updateSelectionUI() {
  const count = state.selected.size;
  const active = isJobActive();
  const label = count > 0 ? `Download ZIP (${formatCount(count)})` : 'Download ZIP';

  dom.downloadLabel.textContent = label;
  dom.downloadBtn.disabled = count === 0 || active;
  dom.sidebarDownload.disabled = count === 0 || active;
  dom.sidebarDownload.textContent = count > 0 ? `Download ${formatCount(count)}` : 'Download';
  dom.clearSelection.disabled = count === 0;
  dom.sidebarSelected.textContent =
    count > 0 ? `${formatCount(count)} selected` : 'Nothing selected';

  let selectedVisible = 0;
  for (const item of state.visible) {
    if (state.selected.has(item.key)) selectedVisible += 1;
  }
  dom.selectAll.disabled = state.visible.length === 0;
  dom.selectAll.checked = state.visible.length > 0 && selectedVisible === state.visible.length;
  dom.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < state.visible.length;
}

function clearSelection() {
  if (state.selected.size === 0) return;
  state.selected.clear();
  syncCards();
  updateSelectionUI();
  schedulePersist();
}

function toggleSelectAll() {
  const target = dom.selectAll.checked;
  for (const item of state.visible) {
    if (target) state.selected.add(item.key);
    else state.selected.delete(item.key);
  }
  syncCards();
  updateSelectionUI();
  schedulePersist();
}

/* ------------------------------------------------------------------ *
 * Download jobs
 * ------------------------------------------------------------------ */

function selectedItems() {
  const items = [];
  for (const key of state.selected) {
    const item = state.itemsByKey.get(key);
    if (!item) continue;
    items.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      guildId: item.guildId,
      guildName: item.guildName,
      animated: Boolean(item.animated),
      format: item.format,
      formatType: item.formatType,
    });
  }
  return items;
}

async function startDownload() {
  if (state.selected.size === 0) {
    toast('Select at least one emoji or sticker first.', 'error');
    return;
  }
  if (isJobActive()) {
    openModal();
    return;
  }

  const items = selectedItems();
  if (items.length === 0) {
    toast('Your selection is out of date. Refresh and try again.', 'error');
    return;
  }

  try {
    const job = await api('/api/jobs', { method: 'POST', body: { size: state.size, items } });
    state.job = job;
    openModal();
    renderJob(job);
    scheduleJobPoll(job.id);
    updateSelectionUI();
  } catch (err) {
    if (err.status === 401) {
      clearLocalSession();
      showLogin();
      setLoginError(err.message);
      return;
    }
    toast(err.message, 'error');
  }
}

function openModal() {
  dom.modal.hidden = false;
  dom.modalTitle.textContent = 'Building your ZIP';
  document.body.classList.add('modal-open');
  dom.modalClose.focus({ preventScroll: true });
}

function closeModal() {
  dom.modal.hidden = true;
  document.body.classList.remove('modal-open');
  if (isJobActive()) {
    toast('The export keeps running in the background. It will download when ready.');
  }
}

function scheduleJobPoll(id) {
  clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(() => pollJob(id), 450);
}

async function pollJob(id) {
  if (!state.job || state.job.id !== id) return;

  let job;
  try {
    job = await api(`/api/jobs/${id}`);
  } catch (err) {
    if (state.job && state.job.id === id) {
      state.job.status = 'error';
      state.job.error = err.message;
      renderJob(state.job);
      updateSelectionUI();
    }
    toast(err.message, 'error');
    return;
  }

  state.job = job;
  renderJob(job);
  updateSelectionUI();

  if (job.status === 'running' || job.status === 'cancelling') {
    scheduleJobPoll(id);
    return;
  }

  if (job.status === 'done') {
    triggerDownload(job);
    if (dom.modal.hidden) {
      toast(
        `ZIP ready — ${formatCount(job.total - job.failed)} file${job.total - job.failed === 1 ? '' : 's'} (${formatBytes(job.bytes)})`,
        'success',
        { href: job.downloadUrl, label: 'Save ZIP', download: job.zipName, duration: 15000 },
      );
    }
  } else if (job.status === 'cancelled') {
    toast('Export cancelled.');
  } else if (job.status === 'error') {
    toast(`Export failed: ${job.error || 'unknown error'}`, 'error');
  }
}

function triggerDownload(job) {
  if (!job.downloadUrl) return;
  const link = document.createElement('a');
  link.href = job.downloadUrl;
  link.download = job.zipName || 'guildmoji.zip';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function renderJob(job) {
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  dom.progressBar.style.width = `${percent}%`;
  dom.progress.setAttribute('aria-valuenow', String(percent));

  let status = 'Starting…';
  let detail = job.current || '';

  if (job.status === 'running') {
    status = `Exporting ${formatCount(job.done)} of ${formatCount(job.total)}…`;
  } else if (job.status === 'cancelling') {
    status = 'Cancelling…';
    detail = 'Waiting for the current downloads to stop.';
  } else if (job.status === 'cancelled') {
    status = 'Export cancelled';
    detail = 'The partial ZIP file was deleted.';
  } else if (job.status === 'error') {
    status = 'Export failed';
    detail = job.error || 'Something went wrong.';
  } else if (job.status === 'done') {
    const exported = Math.max(0, job.total - job.failed);
    status = `Done — ${formatCount(exported)} of ${formatCount(job.total)} files exported`;
    detail = `${formatBytes(job.bytes)}${job.failed > 0 ? ` · ${formatCount(job.failed)} skipped` : ''}`;
  }

  dom.modalTitle.textContent =
    job.status === 'done' ? 'Export ready' : job.status === 'error' ? 'Export failed' : 'Building your ZIP';
  dom.jobStatus.textContent = status;
  dom.jobCurrent.textContent = detail;
  dom.jobCurrent.title = detail;

  dom.jobCancel.hidden = job.status !== 'running';
  dom.jobCancel.disabled = job.status !== 'running';
  dom.jobCancel.textContent = 'Cancel export';
  dom.jobDownload.hidden = job.status !== 'done' || !job.downloadUrl;
  if (job.downloadUrl) {
    dom.jobDownload.href = job.downloadUrl;
    dom.jobDownload.setAttribute('download', job.zipName || '');
  }
  dom.jobDone.hidden = job.status === 'running' || job.status === 'cancelling';

  if (job.failed > 0 && Array.isArray(job.failures) && job.failures.length > 0) {
    dom.jobFailures.hidden = false;
    dom.jobFailuresSummary.textContent = `${formatCount(job.failed)} file${job.failed === 1 ? '' : 's'} could not be exported`;
    dom.jobFailuresList.textContent = '';
    for (const failure of job.failures) {
      const li = document.createElement('li');
      li.textContent = `${failure.guild} / ${failure.name}: ${failure.reason}`;
      dom.jobFailuresList.appendChild(li);
    }
  } else {
    dom.jobFailures.hidden = true;
    dom.jobFailuresList.textContent = '';
  }
}

async function cancelJob() {
  const job = state.job;
  if (!job || job.status !== 'running') return;
  dom.jobCancel.disabled = true;
  dom.jobCancel.textContent = 'Cancelling…';
  try {
    const updated = await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    state.job = updated;
    renderJob(updated);
    scheduleJobPoll(job.id);
  } catch (err) {
    toast(err.message, 'error');
    dom.jobCancel.disabled = false;
    dom.jobCancel.textContent = 'Cancel export';
  }
}

/* ------------------------------------------------------------------ *
 * Sidebar (mobile)
 * ------------------------------------------------------------------ */

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  dom.sidebarToggle.setAttribute('aria-expanded', String(open));
  dom.sidebarBackdrop.hidden = !open;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bindEvents() {
  dom.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    connect(dom.tokenInput.value);
  });

  dom.tokenVisibility.addEventListener('click', () => {
    const show = dom.tokenInput.type === 'password';
    dom.tokenInput.type = show ? 'text' : 'password';
    dom.tokenVisibility.textContent = show ? 'Hide' : 'Show';
    dom.tokenVisibility.setAttribute('aria-label', show ? 'Hide token' : 'Show token');
    dom.tokenInput.focus();
  });

  dom.pasteToken.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('empty');
      dom.tokenInput.value = text.trim();
      dom.tokenInput.focus();
      toast('Token pasted into the field.');
    } catch {
      toast('Could not read the clipboard. Paste with Ctrl+V instead.', 'error');
    }
  });

  dom.copySnippet.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      toast('Snippet copied to the clipboard.', 'success');
    } catch {
      toast('Copy failed — select the snippet manually.', 'error');
    }
  });

  dom.detectBtn.addEventListener('click', detectToken);
  dom.logoutBtn.addEventListener('click', logout);
  dom.refreshBtn.addEventListener('click', () => loadData(true));

  dom.guildSearch.addEventListener('input', renderGuilds);

  let searchTimer = null;
  dom.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.search = dom.search.value;
      applyFilters();
    }, 120);
  });

  dom.kindFilter.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]');
    if (!button) return;
    const kind = button.dataset.kind;
    if (!['all', 'emoji', 'sticker'].includes(kind)) return;
    state.filter.kind = kind;
    for (const candidate of dom.kindFilter.querySelectorAll('button')) {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', String(active));
    }
    applyFilters();
  });

  dom.animatedFilter.addEventListener('click', () => {
    state.filter.animated = !state.filter.animated;
    dom.animatedFilter.setAttribute('aria-pressed', String(state.filter.animated));
    applyFilters();
  });

  dom.sizeSelect.addEventListener('change', () => {
    state.size = Number(dom.sizeSelect.value) || 256;
    try {
      localStorage.setItem(STORAGE.size, String(state.size));
    } catch {
      /* ignore */
    }
  });

  dom.selectAll.addEventListener('change', toggleSelectAll);
  dom.clearSelection.addEventListener('click', clearSelection);
  dom.downloadBtn.addEventListener('click', startDownload);
  dom.sidebarDownload.addEventListener('click', startDownload);

  dom.emptyReset.addEventListener('click', () => {
    state.filter = { guildId: 'all', kind: 'all', animated: false, search: '' };
    dom.search.value = '';
    dom.animatedFilter.setAttribute('aria-pressed', 'false');
    for (const button of dom.kindFilter.querySelectorAll('button')) {
      const active = button.dataset.kind === 'all';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderGuilds();
    applyFilters();
  });

  dom.noticeClose.addEventListener('click', () => {
    dom.notice.hidden = true;
  });

  dom.sidebarToggle.addEventListener('click', () => {
    setSidebar(!document.body.classList.contains('sidebar-open'));
  });
  dom.sidebarBackdrop.addEventListener('click', () => setSidebar(false));

  dom.modalClose.addEventListener('click', closeModal);
  dom.jobDone.addEventListener('click', closeModal);
  dom.jobCancel.addEventListener('click', cancelJob);
  dom.modal.addEventListener('click', (event) => {
    if (event.target === dom.modal) closeModal();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!dom.modal.hidden) {
        closeModal();
        return;
      }
      if (document.body.classList.contains('sidebar-open')) setSidebar(false);
      return;
    }

    if (event.key === '/') {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (!typing) {
        event.preventDefault();
        dom.search.focus();
      }
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) setSidebar(false);
  });

  window.addEventListener('pagehide', persistSelection);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  dom.tokenSnippet.textContent = SNIPPET;

  try {
    const savedSize = Number(localStorage.getItem(STORAGE.size));
    if ([128, 256, 512].includes(savedSize)) state.size = savedSize;
  } catch {
    /* ignore */
  }
  dom.sizeSelect.value = String(state.size);

  bindEvents();

  try {
    const info = await api('/api/state');
    if (info.authenticated && info.user) {
      setAccount(info.user);
      showBrowser();
      await loadData(false);
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
    setLoginError(err.message);
  }
}

boot();
