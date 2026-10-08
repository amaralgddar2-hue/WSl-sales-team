// Activity log (audit trail), system settings, and the signed-in user's account.
import { t, getLang } from '../i18n.js';
import {
  state, esc, bdi, tHtml, api, icon, field, input, select, formData, submitting, toast, fmtDateTime, fmtNum, userName,
  channelById, channelName, emptyHtml, reloadMeta,
} from '../ui.js';

// ---------- activity log ----------
const GROUPS = ['all', 'leads', 'team', 'channels', 'settings'];
const logState = { group: 'all', page: 1 };

function permList(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.length ? arr.map((p) => t(`perm.${p}`)).join(t('list_sep')) : t('perm.none');
}

function auditText(a) {
  const d = a.details || {};
  const who = a.user_name === 'system' ? t('log.system') : a.user_name;
  const lead = a.lead_name || d.name || '';
  const contact = d.email || d.phone || '';
  switch (a.action) {
    case 'lead.create': return tHtml('audit.lead.create', { who, lead });
    case 'lead.update': return tHtml('audit.lead.update', { who, lead, fields: Object.keys(d).map((k) => t(`field.${k}`)).join(t('list_sep')) });
    case 'lead.assign': return tHtml('audit.lead.assign', { who, lead, to: userName(d.owner_id?.[1]) || t('unassigned') });
    case 'lead.delete': return tHtml('audit.lead.delete', { who, lead: d.name });
    case 'activity.create': return tHtml('audit.activity', { who, lead, type: t(`type.${d.type}`) });
    case 'followup.schedule': return tHtml('audit.fu.schedule', { who, lead, when: fmtDateTime(d.due_at) });
    case 'followup.reschedule': return tHtml('audit.fu.reschedule', { who, lead, when: fmtDateTime(d.due_at?.[1]) });
    case 'followup.complete': return tHtml('audit.fu.complete', { who, lead });
    case 'followup.cancel': return tHtml('audit.fu.cancel', { who, lead });
    case 'invitation.create': return d.bootstrap ? tHtml('audit.inv.bootstrap') : tHtml('audit.inv.create', { who, contact, role: t(`role.${d.role}`), perms: permList(d.permissions) });
    case 'invitation.update': return tHtml('audit.inv.update', { who, role: t(`role.${d.role?.[1]}`), perms: permList(d.permissions?.[1]) });
    case 'invitation.resend': return tHtml('audit.inv.resend', { who, contact });
    case 'invitation.revoke': return tHtml('audit.inv.revoke', { who, contact });
    case 'invitation.accept': return tHtml('audit.inv.accept', { who, role: t(`role.${d.role}`) });
    case 'user.permissions': {
      const parts = [];
      if (d.role) parts.push(t('audit.role_change', { from: t(`role.${d.role[0]}`), to: t(`role.${d.role[1]}`) }));
      if (d.permissions) parts.push(t('audit.perm_change', { to: permList(d.permissions[1]) }));
      return tHtml('audit.user.permissions', { who, name: d.name, changes: parts.join(' · ') });
    }
    case 'user.suspend': return tHtml('audit.user.suspend', { who, name: d.name });
    case 'user.reactivate': return tHtml('audit.user.reactivate', { who, name: d.name });
    case 'user.password': return tHtml('audit.user.password', { who });
    case 'channel.create': return tHtml('audit.channel.create', { who, name: getLang() === 'ar' ? d.name_ar : d.name_en });
    case 'channel.update': return tHtml('audit.channel.update', { who, name: channelName(channelById(a.entity_id)) || d.name_en });
    case 'settings.update': return tHtml('audit.settings', { who, keys: Object.keys(d).map((k) => t(`setting.${k}`)).join(t('list_sep')) });
    default: return esc(`${who} · ${a.action}`);
  }
}

export async function logPage(ctx) {
  const qs = new URLSearchParams({ page: logState.page });
  if (logState.group !== 'all') qs.set('group', logState.group);
  const data = await api('GET', `/api/audit?${qs}`);
  if (!ctx.alive()) return;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  ctx.view.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.log'))}</h1><p class="muted">${esc(t('log.sub'))}</p></div></header>
    <div class="chips-row">${GROUPS.map((g) => `<button class="chip-btn${g === logState.group ? ' on' : ''}" data-g="${g}">${esc(t(`log.group.${g}`))}</button>`).join('')}</div>
    ${data.items.length ? `<ol class="history big">${data.items.map((a) => `<li><span class="dot" aria-hidden="true"></span>
      <span>${a.lead_id && a.lead_name ? `<a href="#/leads/${a.lead_id}">${auditText(a)}</a>` : auditText(a)}</span>
      <time class="muted">${esc(fmtDateTime(a.created_at))}</time></li>`).join('')}</ol>
      ${pages > 1 ? `<nav class="pager"><button class="btn small" data-p="-1"${logState.page <= 1 ? ' disabled' : ''}>${esc(t('prev'))}</button>
        <span class="muted">${esc(t('page_of', { page: fmtNum(logState.page), pages: fmtNum(pages) }))}</span>
        <button class="btn small" data-p="1"${logState.page >= pages ? ' disabled' : ''}>${esc(t('next'))}</button></nav>` : ''}`
      : emptyHtml(t('log.empty'), '', '', 'log')}`;
  ctx.view.addEventListener('click', (e) => {
    const g = e.target.closest('[data-g]');
    const p = e.target.closest('[data-p]');
    if (g) { logState.group = g.dataset.g; logState.page = 1; ctx.rerender(); }
    if (p) { logState.page += Number(p.dataset.p); ctx.rerender(); }
  });
}

// ---------- settings ----------
export async function settingsPage(ctx) {
  const s = await api('GET', '/api/settings');
  if (!ctx.alive()) return;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [s.timezone]; }
  if (!zones.includes(s.timezone)) zones.unshift(s.timezone);
  const caps = state.caps;
  const capRow = (key, ok) => `<li class="${ok ? 'ok' : 'off'}">${icon(ok ? 'check' : 'x')}<span><b>${esc(t(`caps.${key}`))}</b><small>${esc(t(`caps.${key}.${ok ? 'on' : 'off'}`))}</small></span></li>`;

  ctx.view.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.settings'))}</h1><p class="muted">${esc(t('settings.sub'))}</p></div></header>
    <form class="card narrow" novalidate>
      ${field('timezone', t('setting.timezone'), select('timezone', zones.map((z) => [z, z]), s.timezone), { hint: esc(t('setting.timezone_hint')) })}
      <div class="field"><label>${esc(t('setting.default_lead_access'))}</label>
        <div class="radio-list">
          <label class="radio"><input type="radio" name="default_lead_access" value="all"${s.default_lead_access === 'all' ? ' checked' : ''}><span><b>${esc(t('access.all'))}</b><small>${esc(t('access.all_desc'))}</small></span></label>
          <label class="radio"><input type="radio" name="default_lead_access" value="assigned"${s.default_lead_access === 'assigned' ? ' checked' : ''}><span><b>${esc(t('access.assigned'))}</b><small>${esc(t('access.assigned_desc'))}</small></span></label>
        </div>
        <p class="hint">${esc(t('setting.default_lead_access_hint'))}</p></div>
      <div class="cols">
        ${field('remind_before_minutes', t('setting.remind_before_minutes'), select('remind_before_minutes', [0, 15, 30, 60, 120, 1440].map((m) => [m, m ? t('minutes_before', { n: m }) : t('off')]), s.remind_before_minutes))}
        ${field('manager_overdue_hours', t('setting.manager_overdue_hours'), select('manager_overdue_hours', [0, 1, 4, 24, 48, 72].map((h) => [h, h ? t('hours_after', { n: h }) : t('off')]), s.manager_overdue_hours))}
      </div>
      <p class="form-error" role="alert"></p>
      <div class="dlg-actions start"><button class="btn primary" type="submit">${esc(t('save'))}</button></div>
    </form>
    <section class="card narrow">
      <h3>${esc(t('caps.title'))}</h3>
      <ul class="caps">${capRow('inapp', true)}${capRow('email', caps.email)}${capRow('sms', caps.sms)}</ul>
      ${caps.mode === 'console' ? `<p class="notice warn">${esc(t('caps.console'))}</p>` : ''}
      <p class="hint">${esc(t('caps.readme'))}</p>
    </section>`;

  const form = ctx.view.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await submitting(form, () => api('PUT', '/api/settings', {
        timezone: d.timezone, default_lead_access: d.default_lead_access,
        remind_before_minutes: Number(d.remind_before_minutes), manager_overdue_hours: Number(d.manager_overdue_hours),
      }));
      await reloadMeta();
      toast(t('saved'));
    } catch { /* shown */ }
  });
}

// ---------- account ----------
export async function accountPage(ctx) {
  const me = state.me;
  const emailAvailable = state.caps.email && !!me.email;
  ctx.view.innerHTML = `
    <header class="page-head"><h1>${esc(t('nav.account'))}</h1></header>
    <section class="card narrow">
      <div class="me-card"><span class="avatar lg">${esc((me.name || '?').slice(0, 1))}</span>
        <div><b>${bdi(me.name)}</b><br><span class="muted small">${esc(t(`role.${me.role}`))} · <span dir="ltr">${esc(me.email || me.phone)}</span></span></div></div>
      <h3>${esc(t('account.language'))}</h3>
      <div class="seg">${['ar', 'en'].map((l) => `<button type="button" class="seg-i${getLang() === l ? ' on' : ''}" data-lang="${l}"><span>${esc(t(`lang.${l}`))}</span></button>`).join('')}</div>
      <h3 class="spaced">${esc(t('account.notifications'))}</h3>
      <label class="check"><input type="checkbox" data-email-notif${me.email_notifications ? ' checked' : ''}${emailAvailable ? '' : ' disabled'}><span>${esc(t('account.email_notif'))}</span></label>
      <p class="hint">${esc(emailAvailable ? t('account.email_notif_hint') : !me.email ? t('account.email_notif_noemail') : t('account.email_notif_off'))}</p>
      <h3 class="spaced">${esc(t('account.my_permissions'))}</h3>
      <ul class="perm-list">${me.perms.filter((p) => !['team.manage', 'settings.manage'].includes(p) || me.role === 'manager').map((p) => `<li>${icon('check')}${esc(t(`perm.${p}`))}</li>`).join('') || `<li class="muted">${esc(t('perm.read_only'))}</li>`}</ul>
    </section>
    <form class="card narrow" data-form="password" novalidate>
      <h3>${esc(t('account.password'))}</h3>
      ${field('current', t('account.current'), input('current', '', 'type="password" autocomplete="current-password" dir="ltr" required'))}
      ${field('next', t('account.new'), input('next', '', 'type="password" autocomplete="new-password" dir="ltr" required maxlength="200"'), { hint: esc(t('auth.password_hint')) })}
      <p class="form-error" role="alert"></p>
      <div class="dlg-actions start"><button class="btn primary" type="submit">${esc(t('save'))}</button></div>
    </form>`;

  const v = ctx.view;
  v.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b && b.dataset.lang !== getLang()) document.dispatchEvent(new CustomEvent('app:lang', { detail: b.dataset.lang }));
  });
  v.querySelector('[data-email-notif]').addEventListener('change', async (e) => {
    try {
      await api('PATCH', '/api/me', { email_notifications: e.target.checked });
      state.me.email_notifications = e.target.checked;
      toast(t('saved'));
    } catch { e.target.checked = !e.target.checked; }
  });
  const form = v.querySelector('form[data-form=password]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await submitting(form, () => api('POST', '/api/me/password', { current: d.current, next: d.next }));
      form.reset(); toast(t('account.password_saved'));
    } catch { /* shown */ }
  });
}

