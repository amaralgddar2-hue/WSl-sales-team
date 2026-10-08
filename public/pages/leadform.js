// Add / edit lead dialog, with duplicate warnings (same phone or email).
import { t } from '../i18n.js';
import {
  state, can, esc, bdi, api, ApiError, openDialog, closeDialog, field, input, textarea, select, formData, submitting,
  toast, channelName, showFormError,
} from '../ui.js';

const STATUSES = ['new', 'attempted', 'interested', 'follow_up', 'won', 'lost'];

function channelOptions(current) {
  return state.channels
    .filter((c) => c.active || c.id === current)
    .map((c) => [c.id, channelName(c) + (c.active ? '' : ` (${t('channels.inactive')})`)]);
}

function formHtml(lead) {
  const L = lead || { status: 'new' };
  const isOther = (id) => !!state.channels.find((c) => c.id === Number(id))?.is_other;
  return `<form class="dlg-form" novalidate>
    <h2>${esc(lead ? t('leadform.edit') : t('leads.new'))}</h2>
    ${field('name', t('field.name'), input('name', L.name, 'required maxlength="120" autofocus autocomplete="off"'))}
    <div class="cols">
      ${field('phone', t('field.phone'), input('phone', L.phone, 'type="tel" dir="ltr" maxlength="25" autocomplete="off"'), { optional: true })}
      ${field('email', t('field.email'), input('email', L.email, 'type="email" dir="ltr" maxlength="254" autocomplete="off"'), { optional: true })}
    </div>
    <div class="dup-box" hidden></div>
    <div class="cols">
      ${field('company', t('field.company'), input('company', L.company, 'maxlength="120" autocomplete="off"'), { optional: true })}
      ${field('channel_id', t('field.channel'), select('channel_id', [['', t('none')], ...channelOptions(L.channel_id)], L.channel_id))}
    </div>
    ${field('channel_other', t('field.channel_other'), input('channel_other', L.channel_other, 'maxlength="80"'), { cls: isOther(L.channel_id) ? '' : 'hidden' })}
    ${lead ? field('status', t('field.status'), select('status', STATUSES.map((s) => [s, t(`status.${s}`)]), L.status)) : ''}
    ${field('notes', t('field.notes'), textarea('notes', L.notes, 3, 'maxlength="4000"'), { optional: true })}
    ${lead ? '' : `<p class="hint">${esc(t('leadform.auto_note'))}</p>`}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions">
      <button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="button" class="btn warn" data-save-anyway hidden>${esc(t('leadform.save_anyway'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button>
    </div>
  </form>`;
}

function dupHtml(matches) {
  return `<div class="notice warn">
    <b>${esc(t('dup.title'))}</b>
    <ul>${matches.map((m) => `<li>${esc(t(`dup.by_${m.match}`))}: ${m.visible
      ? `<a href="#/leads/${m.id}" target="_blank" rel="noopener">${bdi(m.name)}</a>${m.company ? ` · ${bdi(m.company)}` : ''}${m.owner_name ? ` · ${bdi(m.owner_name)}` : ''}`
      : esc(t('dup.hidden', { owner: m.owner_name || t('unassigned') }))}</li>`).join('')}</ul>
  </div>`;
}

/** Open the add (lead = null) or edit dialog. Resolves after save with the lead id. */
export function openLeadForm(lead = null, { onSaved } = {}) {
  const dlg = openDialog(formHtml(lead));
  const form = dlg.querySelector('form');
  const dupBox = form.querySelector('.dup-box');
  const saveAnyway = form.querySelector('[data-save-anyway]');
  form.querySelector('[data-close]').addEventListener('click', closeDialog);

  const channelSel = form.elements.channel_id;
  const otherField = form.querySelector('[data-field=channel_other]');
  channelSel.addEventListener('change', () => {
    const other = !!state.channels.find((c) => c.id === Number(channelSel.value))?.is_other;
    otherField.classList.toggle('hidden', !other);
    if (other) form.elements.channel_other.focus();
  });

  // Live duplicate check on phone / email.
  let checkSeq = 0;
  const check = async () => {
    const phone = form.elements.phone.value.trim();
    const email = form.elements.email.value.trim();
    if ((!phone || phone.replace(/\D/g, '').length < 6) && !/@.+\./.test(email)) { dupBox.hidden = true; return; }
    const my = ++checkSeq;
    const qs = new URLSearchParams();
    if (phone && phone.replace(/\D/g, '').length >= 6) qs.set('phone', phone);
    if (/@.+\./.test(email)) qs.set('email', email);
    if (lead) qs.set('exclude', lead.id);
    try {
      const { matches } = await api('GET', `/api/leads/duplicates?${qs}`);
      if (my !== checkSeq) return;
      const relevant = lead ? matches.filter((m) => (m.match === 'phone' && phone !== lead.phone) || (m.match === 'email' && email !== lead.email)) : matches;
      dupBox.hidden = !relevant.length;
      dupBox.innerHTML = relevant.length ? dupHtml(relevant) : '';
    } catch { /* invalid format: validation will explain on save */ }
  };
  form.elements.phone.addEventListener('blur', check);
  form.elements.email.addEventListener('blur', check);

  const save = async (confirmDuplicate) => {
    const d = formData(form);
    if (!d.name.trim()) {
      form.querySelector('[data-field=name]').classList.add('invalid');
      form.querySelector('[data-field=name] .err').textContent = t('val.required');
      form.elements.name.focus();
      return;
    }
    const body = {
      name: d.name, phone: d.phone, email: d.email, company: d.company, notes: d.notes,
      channel_id: d.channel_id ? Number(d.channel_id) : null, channel_other: d.channel_other,
    };
    if (lead) body.status = d.status;
    if (confirmDuplicate) body.confirm_duplicate = true;
    try {
      const r = await submitting(form, () => (lead ? api('PATCH', `/api/leads/${lead.id}`, body) : api('POST', '/api/leads', body)));
      closeDialog();
      toast(t(lead ? 'lead.updated' : 'lead.created'));
      const id = lead ? lead.id : r.id;
      if (onSaved) onSaved(id);
      else if (!lead) location.hash = `#/leads/${id}?new`;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate') {
        dupBox.hidden = false;
        dupBox.innerHTML = dupHtml(e.data.matches);
        saveAnyway.hidden = false;
        showFormError(form, t('dup.confirm'));
      }
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
  saveAnyway.addEventListener('click', () => save(true));
}

export function openNewLead() {
  if (!can('leads.create')) return;
  openLeadForm(null);
}
