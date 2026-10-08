// App shell: language/theme, sign-in state, sidebar navigation, router, notifications, keyboard shortcuts.
import { t, getLang, setLang } from './i18n.js';
import {
  state, can, $, $$, esc, bdi, api, ApiError, setUnauthenticatedHandler, toast, closeDialog, initDialog, icon, avatar,
  loadingHtml, errorHtml, relTime, fmtNum,
} from './ui.js';
import { loginPage, joinPage, invitePage } from './pages/auth.js';
import { leadsPage, openNewLead } from './pages/leads.js';
import { leadPage } from './pages/lead.js';
import { channelsPage } from './pages/channels.js';
import { teamPage } from './pages/team.js';
import { logPage, settingsPage, accountPage } from './pages/admin.js';
import { helpPage } from './pages/help.js';

// ---------- language & theme ----------
function readPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writePref(key, v) { try { localStorage.setItem(key, v); } catch { /* storage blocked */ } }

export function applyLang() {
  const l = getLang();
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  document.title = t('app.name');
}
function applyTheme() {
  const th = readPref('theme');
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  writePref('theme', cur === 'dark' ? 'light' : 'dark');
  applyTheme();
}
export async function setLanguage(l) {
  setLang(l);
  writePref('lang', l);
  applyLang();
  if (state.me) {
    state.me.language = l;
    api('PATCH', '/api/me', { language: l }).catch(() => {});
    renderShell();
  }
  route();
}

// ---------- boot ----------
export async function boot() {
  try {
    const b = await api('GET', '/api/bootstrap');
    Object.assign(state, { me: b.me, settings: b.settings, channels: b.channels, users: b.users, caps: b.capabilities, grantable: b.grantable });
    if (b.me.language && b.me.language !== getLang()) { setLang(b.me.language); writePref('lang', b.me.language); applyLang(); }
  } catch (e) {
    state.me = null;
    if (!(e instanceof ApiError && e.status === 401)) {
      $('#app').innerHTML = `<div class="center-wrap">${errorHtml(e)}</div>`;
      $('#app [data-action=retry]')?.addEventListener('click', boot);
      return;
    }
  }
  if (state.me) { renderShell(); startPolling(); }
  route();
}

// ---------- shell ----------
function navItems() {
  const items = [
    ['leads', 'nav.leads', 'leads'],
    ['channels', 'nav.channels', 'channels'],
  ];
  if (can('team.manage')) items.push(['team', 'nav.team', 'team']);
  if (can('audit.view')) items.push(['log', 'nav.log', 'log']);
  if (can('settings.manage')) items.push(['settings', 'nav.settings', 'settings']);
  items.push(['help', 'nav.help', 'help']);
  return items;
}

export function renderShell() {
  const me = state.me;
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="${esc(t('nav.main'))}">
      <div class="side-head">
        <a class="brand" href="#/leads"><span class="logo" aria-hidden="true"></span><span>${esc(t('app.name'))}</span></a>
        <button class="icon-btn bell" data-action="notifications" aria-label="${esc(t('notif.title'))}" title="${esc(t('notif.title'))}">
          ${icon('bell')}<span class="badge-count" id="unread" hidden></span></button>
      </div>
      ${can('leads.create') ? `<button class="new-btn" data-action="new-lead">${icon('plus')}<span>${esc(t('leads.new'))}</span><kbd>C</kbd></button>` : ''}
      <nav class="nav">
        ${navItems().map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k}">${icon(ic)}<span>${esc(t(label))}</span></a>`).join('')}
      </nav>
      <div class="side-foot">
        <button class="icon-btn" data-action="theme" title="${esc(t('theme.toggle'))}" aria-label="${esc(t('theme.toggle'))}">${icon('sun')}</button>
        <button class="lang-btn" data-action="lang" lang="${getLang() === 'ar' ? 'en' : 'ar'}">${esc(t('lang.switch'))}</button>
        <details class="menu">
          <summary class="me" aria-label="${esc(t('nav.account'))}">${avatar(me.name, 'sm')}<span class="me-name">${bdi(me.name)}</span></summary>
          <div class="menu-pop">
            <div class="menu-head">${bdi(me.name)}<small>${esc(t(`role.${me.role}`))}</small></div>
            <a href="#/account">${icon('user')}${esc(t('nav.account'))}</a>
            <button data-action="logout">${icon('logout')}${esc(t('nav.logout'))}</button>
          </div>
        </details>
      </div>
    </aside>
    <div class="scrim" data-action="close-nav"></div>
    <div class="main-col">
      <header class="mobile-bar">
        <button class="icon-btn" data-action="open-nav" aria-label="${esc(t('nav.menu'))}">${icon('menu')}</button>
        <a class="brand" href="#/leads"><span class="logo" aria-hidden="true"></span><span>${esc(t('app.name'))}</span></a>
        <span class="grow"></span>
        <button class="icon-btn bell" data-action="notifications" aria-label="${esc(t('notif.title'))}">${icon('bell')}<span class="badge-count" id="unread-m" hidden></span></button>
        ${can('leads.create') ? `<button class="icon-btn" data-action="new-lead" aria-label="${esc(t('leads.new'))}">${icon('plus')}</button>` : ''}
      </header>
      <main id="view" class="view" tabindex="-1"></main>
    </div>
    <div class="notif-pop" id="notif-pop" hidden></div>
  </div>`;
  const app = $('#app');
  app.addEventListener('click', onShellClick);
  refreshUnread();
}

async function onShellClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.sidebar, .mobile-bar, .scrim, .notif-pop')) return;
  const a = el.dataset.action;
  if (a === 'theme') toggleTheme();
  else if (a === 'lang') setLanguage(getLang() === 'ar' ? 'en' : 'ar');
  else if (a === 'logout') {
    await api('POST', '/api/logout').catch(() => {});
    stopPolling(); state.me = null; location.hash = '#/login'; $('#app').innerHTML = ''; route();
  } else if (a === 'new-lead') { closeNav(); openNewLead(); }
  else if (a === 'open-nav') document.body.classList.add('nav-open');
  else if (a === 'close-nav') closeNav();
  else if (a === 'notifications') toggleNotifications(el);
  else if (a === 'notif-open') openNotification(el);
  else if (a === 'notif-read-all') {
    await api('POST', '/api/notifications/read', { ids: 'all' }).catch(() => {});
    refreshUnread(); toggleNotifications(null, true);
  }
}
const closeNav = () => document.body.classList.remove('nav-open');

function markNav(name) {
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

// ---------- notifications ----------
let pollTimer = null;
function startPolling() { stopPolling(); pollTimer = setInterval(refreshUnread, 60_000); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

async function refreshUnread() {
  if (!state.me) return;
  try {
    const { unread } = await api('GET', '/api/notifications/unread');
    for (const id of ['unread', 'unread-m']) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.hidden = !unread;
      b.textContent = unread > 9 ? '9+' : fmtNum(unread);
    }
    document.title = unread ? `(${unread}) ${t('app.name')}` : t('app.name');
  } catch { /* offline: try again next tick */ }
}

const notifText = (n) => {
  const name = n.lead_name || t('notif.deleted_lead');
  return t(`notif.${n.kind}`, { lead: name, owner: n.data?.owner_name || t('unassigned') });
};

async function toggleNotifications(anchor, forceOpen = false) {
  const pop = $('#notif-pop');
  if (!pop.hidden && !forceOpen) { pop.hidden = true; return; }
  pop.hidden = false;
  pop.innerHTML = loadingHtml();
  try {
    const { items } = await api('GET', '/api/notifications');
    pop.innerHTML = `
      <div class="pop-head"><h3>${esc(t('notif.title'))}</h3>
        ${items.some((n) => !n.read_at) ? `<button class="link-btn" data-action="notif-read-all">${esc(t('notif.read_all'))}</button>` : ''}</div>
      ${items.length ? `<ul class="notif-list">${items.map((n) => `<li class="${n.read_at ? '' : 'unread'}">
        <button data-action="notif-open" data-id="${n.id}" data-lead="${n.lead_id ?? ''}">
          <span class="dot" aria-hidden="true"></span>
          <span class="nt">${esc(notifText(n))}${n.data?.note ? `<small>${bdi(n.data.note)}</small>` : ''}</span>
          <time>${esc(relTime(n.created_at))}</time></button></li>`).join('')}</ul>`
        : `<p class="muted pad">${esc(t('notif.empty'))}</p>`}
      ${!state.caps.email ? `<p class="hint pad">${esc(t('notif.email_off'))}</p>` : ''}`;
  } catch (e) {
    pop.innerHTML = errorHtml(e);
  }
}
async function openNotification(el) {
  $('#notif-pop').hidden = true;
  closeNav();
  api('POST', '/api/notifications/read', { ids: [Number(el.dataset.id)] }).then(refreshUnread, () => {});
  if (el.dataset.lead) location.hash = `#/leads/${el.dataset.lead}`;
}
document.addEventListener('click', (e) => {
  const pop = $('#notif-pop');
  if (pop && !pop.hidden && !e.target.closest('#notif-pop, [data-action=notifications]')) pop.hidden = true;
  const menu = $('.menu[open]');
  if (menu && (!e.target.closest('.menu') || e.target.closest('.menu-pop a, .menu-pop button'))) menu.removeAttribute('open');
});

// ---------- router ----------
let seq = 0;
export function route() {
  const s = ++seq;
  const [hash, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page = '', arg] = hash.split('/');

  if (!state.me) {
    if (page === 'invite' && arg) return invitePage(arg);
    if (page === 'join') return joinPage();
    return loginPage();
  }
  if (['login', 'join', 'invite', ''].includes(page)) { location.replace('#/leads'); return; }

  const view = $('#view');
  if (!view) return;
  // Fresh element per page so old listeners never leak.
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  fresh.innerHTML = loadingHtml();
  closeDialog();
  closeNav();
  const ctx = { view: fresh, alive: () => s === seq, arg, query: new URLSearchParams(query), rerender: route };

  const pages = {
    leads: () => (arg ? leadPage(ctx, Number(arg)) : leadsPage(ctx)),
    channels: () => channelsPage(ctx),
    team: () => (can('team.manage') ? teamPage(ctx) : forbidden(ctx)),
    log: () => (can('audit.view') ? logPage(ctx) : forbidden(ctx)),
    settings: () => (can('settings.manage') ? settingsPage(ctx) : forbidden(ctx)),
    account: () => accountPage(ctx),
    help: () => helpPage(ctx),
  };
  markNav(page in pages ? page : 'leads');
  const run = pages[page] || pages.leads;
  Promise.resolve().then(run).catch((e) => {
    if (!ctx.alive()) return;
    fresh.innerHTML = errorHtml(e);
    fresh.querySelector('[data-action=retry]')?.addEventListener('click', route);
  });
}
function forbidden(ctx) {
  ctx.view.innerHTML = `<div class="empty"><h3>${esc(t('err.forbidden'))}</h3><a class="btn" href="#/leads">${esc(t('nav.leads'))}</a></div>`;
}

// ---------- keyboard shortcuts (Linear-style) ----------
document.addEventListener('keydown', (e) => {
  if (!state.me || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable || $('#dlg').open) return;
  if ((e.key === 'c' || e.key === 'C') && can('leads.create')) { e.preventDefault(); openNewLead(); }
  else if (e.key === '/') {
    const s = $('#search');
    if (s) { e.preventDefault(); s.focus(); } else { location.hash = '#/leads'; setTimeout(() => $('#search')?.focus(), 150); }
  }
});

window.addEventListener('hashchange', route);
setUnauthenticatedHandler(() => {
  if (state.me) { stopPolling(); state.me = null; toast(t('err.unauthenticated'), 'error'); $('#app').innerHTML = ''; route(); }
});

// ---------- start ----------
{
  const saved = readPref('lang');
  setLang(saved === 'en' || saved === 'ar' ? saved : (navigator.language || '').startsWith('ar') ? 'ar' : 'ar');
  applyLang();
  applyTheme();
  initDialog();
  document.addEventListener('app:lang', (e) => setLanguage(e.detail));
  document.addEventListener('app:signed-in', () => boot());
  document.addEventListener('app:theme', toggleTheme);
  boot();
}
