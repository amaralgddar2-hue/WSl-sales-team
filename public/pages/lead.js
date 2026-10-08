// Lead details: properties, next step / follow-up, notes, communication log, change history.
import { t } from '../i18n.js';
import {
  state, can, $, $$, esc, bdi, api, icon, avatar, statusIcon, statusLabel, dueChip, leadChannel, fmtDate, fmtDateTime, relTime,
  openDialog, closeDialog, confirmDialog, toast, field, input, textarea, select, segmented, formData, submitting, errorText,
  ymdInTz, hmInTz, addDays, tHtml, phoneLink, emailLink, userName, emptyHtml, loadingHtml, channelById, channelName, showFieldErrors,
} from '../ui.js';
import { openLeadForm } from './leadform.js';

const STATUSES = ['new', 'attempted', 'interested', 'follow_up', 'won', 'lost'];
const TYPES = [['call', 'phone'], ['message', 'message'], ['meeting', 'meeting'], ['email', 'email'], ['other', 'other']];
const OUTCOMES = ['positive', 'neutral', 'negative', 'no_answer'];

export async function leadPage(ctx, id) {
  let data;
  try {
    data = await api('GET', `/api/leads/${id}`);
  } catch (e) {
    if (e.status === 404) {
      ctx.view.innerHTML = `${crumbs()}${emptyHtml(t('lead.not_found'), t('lead.not_found_hint'), `<a class="btn" href="#/leads">${esc(t('nav.leads'))}</a>`, 'search')}`;
      return;
    }
    throw e;
  }
  if (!ctx.alive()) return;
  render(ctx, data, ctx.query.has('new'));
}

const crumbs = (name) => `<nav class="crumbs"><a href="#/leads">${esc(t('nav.leads'))}</a>${name ? `${icon('chevron', 'flip')}<span>${bdi(name)}</span>` : ''}</nav>`;

function render(ctx, data, justCreated) {
  const { lead: l, activities, can: perm } = data;
  const v = ctx.view;
  const ownerOptions = state.users.filter((u) => u.can_own || u.id === l.owner_id);
  const closed = l.status === 'won' || l.status === 'lost';

  v.innerHTML = `
    ${crumbs(l.name)}
    <header class="lead-head">
      <div class="lead-title">
        <h1>${bdi(l.name)}</h1>
        ${l.company ? `<p class="muted">${bdi(l.company)}</p>` : ''}
      </div>
      <div class="actions">
        ${perm.edit ? `<button class="btn primary" data-act="log">${icon('plus')}${esc(t('lead.log'))}</button>
          <button class="btn" data-act="edit">${icon('edit')}${esc(t('edit'))}</button>` : `<span class="chip">${esc(t('lead.read_only'))}</span>`}
      </div>
    </header>

    <div class="lead-grid">
      <div class="lead-main">
        ${justCreated && perm.edit && !closed ? setupCard(l, perm, ownerOptions) : nextStepCard(l, perm, closed)}
        <section class="card">
          <h3>${esc(t('field.notes'))}</h3>
          ${l.notes ? `<p class="notes">${bdi(l.notes)}</p>` : `<p class="muted">${esc(t('lead.no_notes'))}</p>`}
        </section>
        <section class="card">
          <div class="tabs small" role="tablist">
            <button class="tab on" role="tab" aria-selected="true" data-tab="activity">${esc(t('lead.activity'))}<span class="count">${activities.length}</span></button>
            <button class="tab" role="tab" aria-selected="false" data-tab="history">${esc(t('lead.history'))}</button>
          </div>
          <div id="tab-body">${activityHtml(activities, perm.edit)}</div>
        </section>
      </div>

      <aside class="lead-side card">
        <dl class="props">
          <dt>${esc(t('field.status'))}</dt>
          <dd>${perm.edit
            ? `<label class="prop-select">${statusIcon(l.status)}<select data-prop="status" aria-label="${esc(t('field.status'))}">${STATUSES.map((s) => `<option value="${s}"${s === l.status ? ' selected' : ''}>${esc(t(`status.${s}`))}</option>`).join('')}</select></label>`
            : statusLabel(l.status)}</dd>
          <dt>${esc(t('field.owner'))}</dt>
          <dd>${perm.assign
            ? `<label class="prop-select">${avatar(l.owner_name, 'xs')}<select data-prop="owner_id" aria-label="${esc(t('field.owner'))}"><option value="">${esc(t('unassigned'))}</option>${ownerOptions.map((u) => `<option value="${u.id}"${u.id === l.owner_id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>`
            : `<span class="who">${avatar(l.owner_name, 'xs')}${l.owner_name ? bdi(l.owner_name) : `<span class="muted">${esc(t('unassigned'))}</span>`}</span>`}</dd>
          <dt>${esc(t('field.channel'))}</dt>
          <dd>${leadChannel(l) ? bdi(leadChannel(l)) : '<span class="muted">—</span>'}</dd>
          <dt>${esc(t('field.phone'))}</dt>
          <dd>${l.phone ? phoneLink(l.phone) : '<span class="muted">—</span>'}</dd>
          <dt>${esc(t('field.email'))}</dt>
          <dd>${l.email ? emailLink(l.email) : '<span class="muted">—</span>'}</dd>
          <dt>${esc(t('field.company'))}</dt>
          <dd>${l.company ? bdi(l.company) : '<span class="muted">—</span>'}</dd>
        </dl>
        <div class="props-meta">
          <p>${tHtml('lead.created_by', { name: l.created_by_name || t('unknown'), date: fmtDateTime(l.created_at) })}</p>
          <p>${tHtml('lead.updated_by', { name: l.updated_by_name || t('unknown'), date: fmtDateTime(l.updated_at) })}</p>
          <p class="tz">${icon('globe')}${esc(state.settings.timezone)}</p>
        </div>
        ${perm.delete ? `<button class="btn danger ghost small" data-act="delete">${esc(t('lead.delete'))}</button>` : ''}
      </aside>
    </div>`;

  wire(ctx, data);
}

// ---------- next step ----------
function nextStepCard(l, perm, closed) {
  const f = l.followup;
  if (f) {
    return `<section class="card next-step ${f.due_at < Date.now() ? 'is-overdue' : ''}">
      <div class="card-head"><h3>${icon('clock')}${esc(t('lead.next_step'))}</h3>${dueChip(f.due_at)}</div>
      ${f.note ? `<p class="next-note">${bdi(f.note)}</p>` : ''}
      <p class="muted small"><bdi>${esc(fmtDateTime(f.due_at))}</bdi> · ${tHtml('lead.assigned_to', { name: userName(f.assigned_to) || t('unassigned') })}</p>
      ${perm.edit ? `<div class="row-actions">
        <button class="btn small" data-act="fu-done">${icon('check')}${esc(t('fu.mark_done'))}</button>
        <button class="btn small" data-act="fu-reschedule">${esc(t('fu.reschedule'))}</button>
        <button class="btn small ghost" data-act="fu-clear">${esc(t('fu.clear'))}</button></div>` : ''}
    </section>`;
  }
  if (closed) return `<section class="card next-step"><h3>${icon('check')}${esc(t(`lead.closed.${l.status}`))}</h3></section>`;
  if (!perm.edit) return `<section class="card next-step"><h3>${icon('clock')}${esc(t('lead.next_step'))}</h3><p class="muted">${esc(t('lead.no_followup'))}</p></section>`;
  return `<section class="card next-step empty-next">
    <div class="card-head"><h3>${icon('clock')}${esc(t('lead.next_step'))}</h3></div>
    <p class="muted small">${esc(t('lead.no_followup_hint'))}</p>
    <form data-form="followup" novalidate>${followupFields({})}<p class="form-error" role="alert"></p>
      <div class="row-actions"><button class="btn primary small" type="submit">${esc(t('fu.schedule'))}</button></div></form>
  </section>`;
}

/** Shown right after a lead is created: pick an owner and a follow-up date in one step. */
function setupCard(l, perm, owners) {
  return `<section class="card next-step setup">
    <div class="card-head"><h3>${icon('check')}${esc(t('lead.setup.title'))}</h3>
      <button class="link-btn" data-act="skip-setup">${esc(t('lead.setup.skip'))}</button></div>
    <p class="muted small">${esc(t('lead.setup.hint'))}</p>
    <form data-form="setup" novalidate>
      ${perm.assign ? field('owner_id', t('field.owner'), select('owner_id', [['', t('unassigned')], ...owners.map((u) => [u.id, u.name])], l.owner_id ?? '')) : ''}
      ${followupFields({})}
      <p class="form-error" role="alert"></p>
      <div class="row-actions"><button class="btn primary small" type="submit">${esc(t('save'))}</button></div>
    </form>
  </section>`;
}

/** Date + time (system time zone) + note, with quick picks. */
export function followupFields({ date = '', time = '10:00', note = '', prefix = '' }) {
  const today = ymdInTz();
  const n = (k) => `${prefix}${k}`;
  return `<div class="cols three">
      ${field(n('date'), t('fu.date'), input(n('date'), date, `type="date" min="${today}"`))}
      ${field(n('time'), t('fu.time'), input(n('time'), time, 'type="time" step="300"'))}
      ${field(n('note'), t('fu.note'), input(n('note'), note, `maxlength="300" placeholder="${esc(t('fu.note_ph'))}"`), { optional: true })}
    </div>
    <div class="quick" data-quick="${prefix}">
      ${[[0, 'fu.q.today'], [1, 'fu.q.tomorrow'], [3, 'fu.q.3days'], [7, 'fu.q.week']].map(([d, k]) => `<button type="button" class="chip-btn" data-days="${d}">${esc(t(k))}</button>`).join('')}
      <span class="hint">${icon('globe')}${esc(state.settings.timezone)}</span>
    </div>`;
}

export function wireQuickDates(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick] [data-days]');
    if (!b) return;
    const prefix = b.closest('[data-quick]').dataset.quick;
    const form = b.closest('form');
    const days = Number(b.dataset.days);
    if (days === 0) {
      // "Today": about an hour from now, rounded up to the next half hour (may roll past midnight).
      const step = 30 * 60_000;
      const target = Math.ceil((Date.now() + 3600_000) / step) * step;
      form.elements[`${prefix}date`].value = ymdInTz(target);
      form.elements[`${prefix}time`].value = hmInTz(target);
    } else {
      form.elements[`${prefix}date`].value = addDays(ymdInTz(), days);
    }
  });
}

// ---------- activity & history ----------
function activityHtml(items, canEdit) {
  if (!items.length) {
    return `<div class="tab-empty"><p class="muted">${esc(t('lead.no_activity'))}</p>${canEdit ? `<button class="btn small" data-act="log">${icon('plus')}${esc(t('lead.log'))}</button>` : ''}</div>`;
  }
  const ic = Object.fromEntries(TYPES);
  return `<ol class="feed">${items.map((a) => `<li>
    <span class="feed-ic o-${a.outcome}">${icon(ic[a.type])}</span>
    <div class="feed-body">
      <div class="feed-head"><b>${esc(t(`type.${a.type}`))}</b><span class="pill o-${a.outcome}">${esc(t(`outcome.${a.outcome}`))}</span>
        <span class="muted small"><bdi>${esc(fmtDateTime(a.occurred_at))}</bdi> · ${bdi(a.created_by_name || t('unknown'))}</span></div>
      ${a.note ? `<p>${bdi(a.note)}</p>` : ''}
    </div></li>`).join('')}</ol>`;
}

function historyText(h) {
  const d = h.details || {};
  const who = h.user_name;
  const st = (s) => t(`status.${s}`);
  switch (h.action) {
    case 'lead.create': return tHtml('hist.created', { who });
    case 'lead.assign': return tHtml('hist.assigned', { who, to: userName(d.owner_id?.[1]) || t('unassigned') });
    case 'lead.update': {
      const parts = [];
      if (d.status) parts.push(t('hist.status', { from: st(d.status[0]), to: st(d.status[1]) }));
      if (d.owner_id) parts.push(t('hist.owner', { to: userName(d.owner_id[1]) || t('unassigned') }));
      if (d.channel_id) parts.push(t('hist.channel', { to: channelName(channelById(d.channel_id[1])) || t('none') }));
      const other = Object.keys(d).filter((k) => !['status', 'owner_id', 'channel_id', 'phone_key'].includes(k));
      if (other.length) parts.push(t('hist.fields', { fields: other.map((k) => t(`field.${k}`)).join(t('list_sep')) }));
      return `${tHtml('hist.updated', { who })}: ${esc(parts.join(t('list_sep')))}`;
    }
    case 'activity.create': {
      let s = tHtml('hist.logged', { who, type: t(`type.${d.type}`), outcome: t(`outcome.${d.outcome}`) });
      if (d.status) s += ` · ${esc(t('hist.status', { from: st(d.status[0]), to: st(d.status[1]) }))}`;
      return s;
    }
    case 'followup.schedule': return tHtml('hist.fu_scheduled', { who, when: fmtDateTime(d.due_at) });
    case 'followup.reschedule': return tHtml('hist.fu_rescheduled', { who, when: fmtDateTime(d.due_at?.[1]) });
    case 'followup.complete': return tHtml('hist.fu_done', { who });
    case 'followup.cancel': return tHtml('hist.fu_canceled', { who });
    default: return esc(`${who}: ${h.action}`);
  }
}

async function showHistory(box, leadId) {
  box.innerHTML = loadingHtml();
  try {
    const { items } = await api('GET', `/api/leads/${leadId}/history`);
    box.innerHTML = items.length
      ? `<ol class="history">${items.map((h) => `<li><span class="dot" aria-hidden="true"></span><span>${historyText(h)}</span><time class="muted" title="${esc(fmtDateTime(h.created_at))}">${esc(relTime(h.created_at))}</time></li>`).join('')}</ol>`
      : `<p class="muted">${esc(t('lead.no_history'))}</p>`;
  } catch (e) {
    box.innerHTML = `<p class="notice error">${esc(errorText(e))}</p>`;
  }
}

// ---------- events ----------
function wire(ctx, data) {
  const v = ctx.view;
  const l = data.lead;
  const reload = () => { if (ctx.query.has('new')) history.replaceState(null, '', `#/leads/${l.id}`); ctx.rerender(); };
  wireQuickDates(v);

  v.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      $$('[data-tab]', v).forEach((b) => { const on = b === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      const box = $('#tab-body', v);
      if (tab.dataset.tab === 'history') showHistory(box, l.id);
      else box.innerHTML = activityHtml(data.activities, data.can.edit);
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    try {
      if (a === 'log') openLogDialog(l, reload);
      else if (a === 'edit') openLeadForm(l, { onSaved: reload });
      else if (a === 'skip-setup') reload();
      else if (a === 'fu-done') { await api('POST', `/api/leads/${l.id}/followup/complete`); toast(t('fu.done_toast')); reload(); }
      else if (a === 'fu-clear') {
        if (await confirmDialog({ title: t('fu.clear_title'), body: t('fu.clear_body'), confirmLabel: t('fu.clear') })) {
          await api('DELETE', `/api/leads/${l.id}/followup`); reload();
        }
      } else if (a === 'fu-reschedule') openRescheduleDialog(l, reload);
      else if (a === 'delete') {
        if (await confirmDialog({ title: t('lead.delete_title'), body: t('lead.delete_body', { name: l.name }), confirmLabel: t('lead.delete') })) {
          await api('DELETE', `/api/leads/${l.id}`); toast(t('lead.deleted')); location.hash = '#/leads';
        }
      }
    } catch (err) { toast(errorText(err), 'error'); }
  });

  // Inline property edits (status, owner) save immediately.
  v.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-prop]');
    if (!sel) return;
    const prop = sel.dataset.prop;
    const value = prop === 'owner_id' ? (sel.value ? Number(sel.value) : null) : sel.value;
    sel.disabled = true;
    try {
      await api('PATCH', `/api/leads/${l.id}`, { [prop]: value });
      toast(t('saved'));
      reload();
    } catch (err) {
      sel.disabled = false;
      sel.value = String(l[prop] ?? '');
      toast(errorText(err), 'error');
    }
  });

  v.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = formData(form);
    if (form.dataset.form === 'followup' && !d.date) { showFieldErrors(form, { date: 'required' }); return; }
    try {
      await submitting(form, async () => {
        if (form.dataset.form === 'setup' && 'owner_id' in d && Number(d.owner_id || 0) !== (l.owner_id || 0)) {
          await api('PATCH', `/api/leads/${l.id}`, { owner_id: d.owner_id ? Number(d.owner_id) : null });
        }
        if (d.date) await api('PUT', `/api/leads/${l.id}/followup`, { date: d.date, time: d.time, note: d.note });
      });
      toast(t('saved'));
      reload();
    } catch { /* shown */ }
  });
}

function openRescheduleDialog(l, done) {
  const f = l.followup;
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(t('fu.reschedule'))}</h2>
    ${followupFields({ date: ymdInTz(f.due_at), time: hmInTz(f.due_at), note: f.note })}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button></div></form>`);
  const form = dlg.querySelector('form');
  wireQuickDates(form);
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  form.querySelector('[name=date]').min = '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await submitting(form, () => api('PUT', `/api/leads/${l.id}/followup`, { date: d.date, time: d.time, note: d.note }));
      closeDialog(); toast(t('saved')); done();
    } catch { /* shown */ }
  });
}

/** Log a call / message / meeting, its outcome, the new status and the next follow-up. */
function openLogDialog(l, done) {
  const now = Date.now();
  const suggested = l.status === 'new' ? 'attempted' : l.status;
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(t('lead.log'))} <small class="muted">${bdi(l.name)}</small></h2>
    <div class="field"><label>${esc(t('log.type'))}</label>${segmented('type', TYPES.map(([v, ic]) => [v, t(`type.${v}`), ic]), 'call')}</div>
    <div class="field"><label>${esc(t('log.outcome'))}</label>${segmented('outcome', OUTCOMES.map((o) => [o, t(`outcome.${o}`)]), 'positive')}</div>
    ${field('note', t('log.note'), textarea('note', '', 2, `maxlength="2000" placeholder="${esc(t('log.note_ph'))}"`), { optional: true })}
    <div class="cols">
      ${field('date', t('log.when'), input('date', ymdInTz(now), `type="date" max="${ymdInTz(now)}"`))}
      ${field('time', t('fu.time'), input('time', hmInTz(now), 'type="time"'))}
    </div>
    ${field('status', t('log.status_after'), select('status', STATUSES.map((s) => [s, t(`status.${s}`)]), suggested))}
    <fieldset class="sub">
      <legend>${esc(t('log.next'))}</legend>
      ${followupFields({ prefix: 'next_', date: '', note: '' })}
      ${l.followup ? `<label class="check"><input type="checkbox" name="complete_followup" checked> ${esc(t('log.complete_current'))}</label>` : ''}
    </fieldset>
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button></div>
  </form>`, { wide: true });
  const form = dlg.querySelector('form');
  wireQuickDates(form);
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  const statusSel = form.elements.status;
  const nextSet = form.querySelector('fieldset.sub');
  const syncClosed = () => nextSet.classList.toggle('dim', ['won', 'lost'].includes(statusSel.value));
  statusSel.addEventListener('change', syncClosed);
  syncClosed();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const closedNow = ['won', 'lost'].includes(d.status);
    const body = {
      type: d.type, outcome: d.outcome, note: d.note, date: d.date, time: d.time, status: d.status,
      next_date: closedNow ? null : d.next_date || null, next_time: d.next_time, next_note: d.next_note,
      complete_followup: !!d.complete_followup && !d.next_date,
    };
    try {
      await submitting(form, () => api('POST', `/api/leads/${l.id}/activities`, body));
      closeDialog(); toast(t('log.saved')); done();
    } catch { /* shown */ }
  });
}
