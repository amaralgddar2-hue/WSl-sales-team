// Shared UI helpers: state, API client, escaping, time formatting (system time zone), icons, dialogs, toasts, forms.
import { t, getLang } from './i18n.js';

export const state = {
  me: null,          // { id, name, role, perms, language, ... }
  settings: null,    // { timezone, ... }
  channels: [],
  users: [],         // team members (id, name, role, active, can_own)
  caps: { email: false, sms: false },
  grantable: [],
};

export const can = (perm) => !!state.me?.perms?.includes(perm);

/** Re-fetch shared reference data (me, channels, team list, settings) after changes. */
export async function reloadMeta() {
  const b = await api('GET', '/api/bootstrap');
  Object.assign(state, { me: b.me, settings: b.settings, channels: b.channels, users: b.users, caps: b.capabilities, grantable: b.grantable });
  return b;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** User-entered text: isolate its direction so mixed Arabic/English renders correctly. */
export const bdi = (v) => `<bdi>${esc(v)}</bdi>`;
export const ltr = (v) => `<span dir="ltr" class="ltr">${esc(v)}</span>`;

/** Translate with HTML-escaped text where every placeholder value is direction-isolated (names, dates…). */
export function tHtml(key, vars = {}) {
  const marks = {};
  const safe = {};
  Object.keys(vars).forEach((k, i) => { safe[k] = `\u0000${i}\u0000`; marks[i] = `<bdi>${esc(vars[k])}</bdi>`; });
  return esc(t(key, safe)).replace(/\u0000(\d+)\u0000/g, (_, i) => marks[i]);
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data || {};
    this.fields = data?.fields || null;
  }
}

let onUnauthenticated = () => {};
export const setUnauthenticatedHandler = (fn) => { onUnauthenticated = fn; };

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const code = data?.error || 'server_error';
    if (res.status === 401 && code === 'unauthenticated') onUnauthenticated();
    throw new ApiError(res.status, code, data);
  }
  return data;
}

export function errorText(e) {
  const key = `err.${e?.code}`;
  const s = t(key);
  return s === key ? t('err.server_error') : s;
}

// ---------- time (always in the system time zone) ----------
const LOCALE = () => (getLang() === 'ar' ? 'ar-u-nu-latn' : 'en-GB');
const tz = () => state.settings?.timezone || 'UTC';

export function ymdInTz(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function hmInTz(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

export const fmtDate = (ms) => (ms ? new Intl.DateTimeFormat(LOCALE(), { timeZone: tz(), dateStyle: 'medium' }).format(new Date(ms)) : '');
export const fmtTime = (ms) => new Intl.DateTimeFormat(LOCALE(), { timeZone: tz(), timeStyle: 'short' }).format(new Date(ms));
export const fmtDateTime = (ms) => (ms ? new Intl.DateTimeFormat(LOCALE(), { timeZone: tz(), dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '');
export const fmtShortDate = (ms) => new Intl.DateTimeFormat(LOCALE(), { timeZone: tz(), month: 'short', day: 'numeric' }).format(new Date(ms));
export const fmtNum = (n) => new Intl.NumberFormat(LOCALE()).format(n);

/** "Today · 2:30 PM", "Tomorrow · 10:00", "Overdue · Oct 7, 4:00 PM" … */
export function dueLabel(ms, now = Date.now()) {
  const diff = dayDiff(ymdInTz(ms), ymdInTz(now));
  const time = fmtTime(ms);
  if (ms < now) return { cls: 'overdue', text: `${t('due.overdue')} · ${diff === 0 ? time : `${fmtShortDate(ms)} ${time}`}` };
  if (diff === 0) return { cls: 'today', text: `${t('due.today')} · ${time}` };
  if (diff === 1) return { cls: 'soon', text: `${t('due.tomorrow')} · ${time}` };
  return { cls: '', text: `${fmtShortDate(ms)} · ${time}` };
}
export const dueChip = (ms) => {
  if (!ms) return '';
  const d = dueLabel(ms);
  return `<span class="due ${d.cls}">${icon(d.cls === 'overdue' ? 'alert' : 'clock')}${esc(d.text)}</span>`;
};

export function relTime(ms) {
  const diff = (ms - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(ms);
}

// ---------- names ----------
export const channelName = (c) => (c ? (getLang() === 'ar' ? c.name_ar || c.name_en : c.name_en || c.name_ar) : '');
export const channelById = (id) => state.channels.find((c) => c.id === id);
export function leadChannel(l) {
  if (!l.channel_id) return '';
  const name = getLang() === 'ar' ? l.channel_name_ar : l.channel_name_en;
  return l.channel_is_other && l.channel_other ? l.channel_other : name;
}
export const userName = (id) => state.users.find((u) => u.id === id)?.name || '';
export const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
};
export const avatar = (name, size = '') => (name ? `<span class="avatar ${size}" title="${esc(name)}" aria-hidden="true">${esc(initials(name))}</span>` : `<span class="avatar empty ${size}" aria-hidden="true"></span>`);

// ---------- icons (inline SVG, currentColor) ----------
const P = {
  leads: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  channels: '<path d="M4 7l8-4 8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.5a3 3 0 010 6M21 20c0-2.6-1.5-4.4-3.7-5.1"/>',
  log: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 014.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16z"/><path d="M10 20a2 2 0 004 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  alert: '<path d="M12 4l9 16H3l9-16z"/><path d="M12 10v4M12 17h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 005.9 5.9l1.5-2 4 1.5v3a2 2 0 01-2 2A16.5 16.5 0 014.5 5.5a2 2 0 012-2z"/>',
  message: '<path d="M4 5h16v11H8l-4 4V5z"/>',
  meeting: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  email: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  other: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
  logout: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  whatsapp: '<path d="M4 20l1.2-4A8 8 0 1112 20a8 8 0 01-4-1.1L4 20z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 01-1.8-1.8l.8-1-1-2L9 9.5z"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  inbox: '<path d="M4 13l2-8h12l2 8v6H4v-6z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
};
export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

/** Lead status icon: shape carries meaning (works without colour). */
export function statusIcon(s) {
  const c = 'cx="8" cy="8"';
  const body = {
    new: `<circle ${c} r="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2"/>`,
    attempted: `<circle ${c} r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8V2.8A5.2 5.2 0 0113.2 8z" fill="currentColor"/>`,
    interested: `<circle ${c} r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2.8a5.2 5.2 0 010 10.4z" fill="currentColor"/>`,
    follow_up: `<circle ${c} r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8V2.8A5.2 5.2 0 118 13.2 5.2 5.2 0 012.8 8z" fill="currentColor"/>`,
    won: `<circle ${c} r="7" fill="currentColor"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--bg)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
    lost: `<circle ${c} r="7" fill="currentColor"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round"/>`,
  }[s] || '';
  return `<svg class="st st-${s}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}
export const statusLabel = (s) => `<span class="status">${statusIcon(s)}<span>${esc(t(`status.${s}`))}</span></span>`;

// ---------- toasts ----------
export function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 5000 : 2600);
  setTimeout(() => el.remove(), kind === 'error' ? 5400 : 3000);
}

// ---------- dialog ----------
let dialogCleanup = null;
export function openDialog(html, { wide = false, onClose } = {}) {
  const dlg = $('#dlg');
  dialogCleanup?.();
  dlg.className = wide ? 'wide' : '';
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dialogCleanup = () => { dialogCleanup = null; onClose?.(); };
  const first = dlg.querySelector('[autofocus]') || dlg.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea');
  first?.focus();
  return dlg;
}
export function closeDialog() {
  const d = $('#dlg');
  if (d.open) d.close();
}
export function initDialog() {
  const d = $('#dlg');
  d.addEventListener('close', () => { d.innerHTML = ''; dialogCleanup?.(); });
  d.addEventListener('click', (e) => { if (e.target === d) closeDialog(); });
}

export function confirmDialog({ title, body, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const dlg = openDialog(`<div class="dlg-body">
      <h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>
      <div class="dlg-actions">
        <button class="btn" data-confirm="no">${esc(t('cancel'))}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm="yes">${esc(confirmLabel)}</button>
      </div></div>`, { onClose: () => { if (!done) resolve(false); } });
    dlg.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', () => {
      done = true; resolve(b.dataset.confirm === 'yes'); closeDialog();
    }));
  });
}

// ---------- forms ----------
export function field(name, label, control, { hint = '', optional = false, cls = '' } = {}) {
  return `<div class="field ${cls}" data-field="${esc(name)}">
    <label for="f-${esc(name)}">${esc(label)}${optional ? ` <span class="opt">${esc(t('optional'))}</span>` : ''}</label>
    ${control}
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <p class="err" role="alert"></p>
  </div>`;
}
export const input = (name, value = '', attrs = '') => `<input id="f-${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrs}>`;
export const textarea = (name, value = '', rows = 3, attrs = '') => `<textarea id="f-${esc(name)}" name="${esc(name)}" rows="${rows}" ${attrs}>${esc(value)}</textarea>`;
export function select(name, options, selected, attrs = '') {
  return `<select id="f-${esc(name)}" name="${esc(name)}" ${attrs}>${options
    .map(([v, label, dis]) => `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}${dis ? ' disabled' : ''}>${esc(label)}</option>`)
    .join('')}</select>`;
}
export function segmented(name, options, selected) {
  return `<div class="seg" role="radiogroup">${options.map(([v, label, ic]) =>
    `<label class="seg-i"><input type="radio" name="${esc(name)}" value="${esc(v)}"${String(v) === String(selected) ? ' checked' : ''}><span>${ic ? icon(ic) : ''}${esc(label)}</span></label>`).join('')}</div>`;
}

export function clearErrors(form) {
  $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid'));
  $$('.field .err', form).forEach((p) => { p.textContent = ''; });
  const fe = $('.form-error', form);
  if (fe) fe.textContent = '';
}
export function showFieldErrors(form, fields = {}) {
  let first = null;
  let unmatched = false;
  for (const [name, code] of Object.entries(fields)) {
    const wrap = form.querySelector(`.field[data-field="${CSS.escape(name)}"]`);
    if (!wrap) { unmatched = true; continue; }
    wrap.classList.add('invalid');
    const msg = t(`val.${name}.${code}`) !== `val.${name}.${code}` ? t(`val.${name}.${code}`) : t(`val.${code}`);
    wrap.querySelector('.err').textContent = msg;
    first ??= wrap.querySelector('input, select, textarea');
  }
  first?.focus();
  return !unmatched;
}
export function showFormError(form, message) {
  const box = $('.form-error', form);
  if (box) box.textContent = message;
}
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    if (el.type === 'checkbox') {
      if (el.dataset.multi) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); } else out[el.name] = el.checked;
      continue;
    }
    out[el.name] = el.value;
  }
  return out;
}

/** Submit helper: disables the button, shows field / form errors consistently. */
export async function submitting(form, fn) {
  clearErrors(form);
  const btn = $('button[type=submit]', form);
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.fields) {
      const allShown = showFieldErrors(form, e.fields);
      showFormError(form, allShown ? t('err.validation') : Object.entries(e.fields).map(([k, c]) => t(`val.${k}.${c}`) !== `val.${k}.${c}` ? t(`val.${k}.${c}`) : t(`val.${c}`)).join(' '));
    } else {
      showFormError(form, errorText(e));
    }
    throw e;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- states ----------
export const loadingHtml = () => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(t('loading'))}</div>`;
export const errorHtml = (e) => `<div class="empty error"><p>${esc(errorText(e))}</p><button class="btn" data-action="retry">${esc(t('retry'))}</button></div>`;
export const emptyHtml = (title, body = '', action = '', ic = 'inbox') =>
  `<div class="empty"><div class="empty-icon">${icon(ic)}</div><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}${action}</div>`;

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/** Contact value → safe link (tel:, mailto:, wa.me) in an LTR span. */
export function phoneLink(phone) {
  if (!phone) return '';
  const digits = phone.replace(/[^\d+]/g, '');
  return `<a href="tel:${esc(digits)}" dir="ltr">${esc(phone)}</a> <a class="mini-link" href="https://wa.me/${esc(digits.replace(/\D/g, ''))}" target="_blank" rel="noopener noreferrer" title="WhatsApp">${icon('whatsapp')}</a>`;
}
export const emailLink = (email) => (email ? `<a href="mailto:${esc(email)}" dir="ltr">${esc(email)}</a>` : '');
