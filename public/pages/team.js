// Team: members (role, permissions, suspend) and invitations (invite, resend, revoke). Managers only.
import { t } from '../i18n.js';
import {
  state, $, $$, esc, bdi, api, icon, avatar, openDialog, closeDialog, confirmDialog, field, input, select, formData, submitting,
  toast, tHtml, fmtDate, fmtDateTime, fmtNum, relTime, copyText, errorText, emptyHtml, reloadMeta, ltr,
} from '../ui.js';

const ROLES = ['manager', 'sales', 'viewer'];
const OTHER_PERMS = ['leads.create', 'leads.edit_own', 'leads.edit_all', 'leads.assign', 'leads.delete', 'channels.manage', 'audit.view'];

function roleDefaults(role) {
  const viewAll = state.settings.default_lead_access === 'all' ? ['leads.view_all'] : [];
  if (role === 'sales') return [...viewAll, 'leads.create', 'leads.edit_own'];
  if (role === 'viewer') return [...viewAll];
  return [];
}

const accessLabel = (perms, role) => (role === 'manager' || perms.includes('leads.view_all') ? t('access.all') : t('access.assigned'));

export async function teamPage(ctx) {
  const tab = ctx.arg === 'invitations' ? 'invitations' : 'members';
  const v = ctx.view;
  const [users, invites] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/invitations')]);
  if (!ctx.alive()) return;
  const pending = invites.items.filter((i) => i.status === 'pending').length;

  v.innerHTML = `
    <header class="page-head">
      <div><h1>${esc(t('nav.team'))}</h1><p class="muted">${esc(t('team.sub'))}</p></div>
      <button class="btn primary" data-act="invite">${icon('send')}${esc(t('invite.new'))}</button>
    </header>
    <nav class="tabs">
      <a class="tab${tab === 'members' ? ' on' : ''}" href="#/team">${esc(t('team.members'))}<span class="count">${fmtNum(users.users.filter((u) => u.active).length)}</span></a>
      <a class="tab${tab === 'invitations' ? ' on' : ''}" href="#/team/invitations">${esc(t('team.invitations'))}<span class="count">${fmtNum(pending)}</span></a>
    </nav>
    <div id="team-body"></div>`;
  const body = $('#team-body', v);
  if (tab === 'members') renderMembers(body, users.users);
  else renderInvites(body, invites.items, 'all');

  v.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    const id = Number(el.dataset.id);
    try {
      if (a === 'invite') openInviteDialog(ctx);
      else if (a === 'edit-member') openMemberDialog(users.users.find((u) => u.id === id), ctx);
      else if (a === 'inv-filter') renderInvites(body, invites.items, el.dataset.f);
      else if (a === 'inv-resend') openResendDialog(invites.items.find((i) => i.id === id), ctx);
      else if (a === 'inv-edit') openInviteRoleDialog(invites.items.find((i) => i.id === id), ctx);
      else if (a === 'inv-revoke') {
        const inv = invites.items.find((i) => i.id === id);
        if (await confirmDialog({ title: t('invite.revoke_title'), body: t('invite.revoke_body', { who: inv.email || inv.phone }), confirmLabel: t('invite.revoke') })) {
          await api('POST', `/api/invitations/${id}/revoke`); toast(t('invite.revoked')); ctx.rerender();
        }
      }
    } catch (err) { toast(errorText(err), 'error'); }
  });
}

// ---------- members ----------
function renderMembers(box, users) {
  box.innerHTML = `<ul class="rows plain" role="list">${users.map((u) => `<li class="row static member${u.active ? '' : ' off'}">
    ${avatar(u.name)}
    <span class="r-main"><span class="r-name">${bdi(u.name)}${u.id === state.me.id ? ` <span class="chip ghost">${esc(t('team.you'))}</span>` : ''}</span>
      <span class="r-company">${u.email ? ltr(u.email) : ''}${u.email && u.phone ? ' · ' : ''}${u.phone ? ltr(u.phone) : ''}</span></span>
    <span class="r-tags"><span class="chip">${esc(t(`role.${u.role}`))}</span><span class="chip ghost">${esc(accessLabel(u.perms, u.role))}</span>${u.active ? '' : `<span class="chip warn">${esc(t('team.suspended'))}</span>`}</span>
    <span class="r-meta muted small">${esc(t('team.open_leads', { n: fmtNum(u.open_leads) }))}<br>
      ${u.invited_by_name ? tHtml('team.invited_by', { name: u.invited_by_name, date: fmtDate(u.created_at) }) : esc(t('team.first_manager'))}
      ${u.perms_changed_by ? `<br>${tHtml('team.perms_changed', { name: u.perms_changed_by, date: fmtDate(u.perms_changed_at) })}` : ''}</span>
    <span class="r-actions"><button class="btn small ghost" data-act="edit-member" data-id="${u.id}">${esc(t('edit'))}</button></span>
  </li>`).join('')}</ul>`;
}

/** Role + lead access + individual permissions editor (shared by invites and members). */
function permsEditor(role, perms) {
  const hasView = perms.includes('leads.view_all');
  return `
    ${field('role', t('field.role'), select('role', ROLES.map((r) => [r, t(`role.${r}`)]), role))}
    <p class="hint role-desc" data-role-desc>${esc(t(`role.desc.${role}`))}</p>
    <div class="perm-area"${role === 'manager' ? ' hidden' : ''}>
      <div class="field"><label>${esc(t('access.title'))}</label>
        <div class="radio-list">
          <label class="radio"><input type="radio" name="access" value="all"${hasView ? ' checked' : ''}><span><b>${esc(t('access.all'))}</b><small>${esc(t('access.all_desc'))}</small></span></label>
          <label class="radio"><input type="radio" name="access" value="assigned"${hasView ? '' : ' checked'}><span><b>${esc(t('access.assigned'))}</b><small>${esc(t('access.assigned_desc'))}</small></span></label>
        </div></div>
      <details class="perm-details"><summary>${esc(t('perm.customize'))}</summary>
        <div class="checks">${OTHER_PERMS.map((p) => `<label class="check"><input type="checkbox" name="perms" data-multi="1" value="${p}"${perms.includes(p) ? ' checked' : ''}><span>${esc(t(`perm.${p}`))}</span></label>`).join('')}</div>
      </details>
    </div>
    <p class="hint manager-note"${role === 'manager' ? '' : ' hidden'}>${esc(t('perm.manager_all'))}</p>`;
}

function wirePermsEditor(form) {
  form.elements.role.addEventListener('change', () => {
    const role = form.elements.role.value;
    const defs = roleDefaults(role);
    $('.perm-area', form).hidden = role === 'manager';
    $('.manager-note', form).hidden = role !== 'manager';
    $('[data-role-desc]', form).textContent = t(`role.desc.${role}`);
    $$('input[name=perms]', form).forEach((c) => { c.checked = defs.includes(c.value); });
    const access = defs.includes('leads.view_all') ? 'all' : 'assigned';
    $$('input[name=access]', form).forEach((r) => { r.checked = r.value === access; });
  });
}

function collectPerms(d) {
  if (d.role === 'manager') return [];
  return [...(d.access === 'all' ? ['leads.view_all'] : []), ...(d.perms || [])];
}

function openMemberDialog(u, ctx) {
  const self = u.id === state.me.id;
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${bdi(u.name)}</h2>
    ${permsEditor(u.role, u.perms)}
    ${self ? `<p class="hint">${esc(t('team.self_note'))}</p>` : `<label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}><span>${esc(t('team.active'))}</span></label>`}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button></div></form>`, { wide: true });
  const form = dlg.querySelector('form');
  if (self) form.elements.role.disabled = true;
  wirePermsEditor(form);
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = self ? { permissions: collectPerms({ ...d, role: u.role }) } : { role: d.role, permissions: collectPerms(d), active: !!d.active };
    try {
      await submitting(form, () => api('PATCH', `/api/users/${u.id}`, body));
      await reloadMeta();
      closeDialog(); toast(t('saved')); ctx.rerender();
    } catch { /* shown */ }
  });
}

// ---------- invitations ----------
function renderInvites(box, items, filter) {
  const F = ['all', 'pending', 'accepted', 'expired', 'revoked'];
  const list = filter === 'all' ? items : items.filter((i) => i.status === filter);
  box.innerHTML = `
    <div class="chips-row">${F.map((f) => `<button class="chip-btn${f === filter ? ' on' : ''}" data-act="inv-filter" data-f="${f}">${esc(t(`inv.status.${f}`))}<span>${fmtNum(f === 'all' ? items.length : items.filter((i) => i.status === f).length)}</span></button>`).join('')}</div>
    ${list.length ? `<ul class="rows plain" role="list">${list.map((i) => `<li class="row static invite">
      <span class="inv-ic">${icon(i.email ? 'email' : 'phone')}</span>
      <span class="r-main"><span class="r-name">${i.name ? bdi(i.name) : ltr(i.email || i.phone)}</span>
        <span class="r-company">${i.name ? ltr(i.email || i.phone) : ''}${i.email && i.phone ? ` · ${ltr(i.phone)}` : ''}</span></span>
      <span class="r-tags"><span class="chip">${esc(t(`role.${i.role}`))}</span><span class="chip st-${i.status}">${esc(t(`inv.status.${i.status}`))}</span></span>
      <span class="r-meta muted small">${i.invited_by_name ? tHtml('inv.by', { name: i.invited_by_name, date: fmtDate(i.created_at) }) : esc(t('inv.bootstrap'))}<br>
        ${esc(inviteWhen(i))}</span>
      <span class="r-actions">
        ${i.status === 'pending' && !i.is_bootstrap ? `<button class="btn small ghost" data-act="inv-edit" data-id="${i.id}">${esc(t('edit'))}</button>` : ''}
        ${(i.status === 'pending' || i.status === 'expired') && !i.is_bootstrap ? `<button class="btn small ghost" data-act="inv-resend" data-id="${i.id}">${esc(t('invite.resend'))}</button>` : ''}
        ${i.status === 'pending' ? `<button class="btn small ghost danger-text" data-act="inv-revoke" data-id="${i.id}">${esc(t('invite.revoke'))}</button>` : ''}
      </span></li>`).join('')}</ul>`
      : emptyHtml(t('inv.empty'), filter === 'all' ? t('inv.empty_hint') : '', '', 'send')}`;
}

function inviteWhen(i) {
  if (i.status === 'accepted') return t('inv.accepted_on', { date: fmtDateTime(i.accepted_at) });
  if (i.status === 'revoked') return t('inv.revoked_on', { date: fmtDateTime(i.revoked_at), name: i.revoked_by_name || '' });
  if (i.status === 'expired') return t('inv.expired_on', { date: fmtDateTime(i.expires_at) });
  return `${t('inv.expires', { when: relTime(i.expires_at) })}${i.last_sent_at ? ` · ${t('inv.sent', { when: relTime(i.last_sent_at), n: i.send_count })}` : ''}`;
}

function sendViaOptions(email, phone) {
  const opts = [];
  if (email) opts.push(['email', t('send.email'), state.caps.email]);
  if (phone) opts.push(['sms', t('send.sms'), state.caps.sms]);
  opts.push(['manual', t('send.manual'), true]);
  return opts;
}

function openInviteDialog(ctx) {
  const defaults = roleDefaults('sales');
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(t('invite.new'))}</h2>
    <p class="muted small">${esc(t('invite.sub'))}</p>
    ${field('name', t('invite.name'), input('name', '', 'maxlength="80" autocomplete="off"'), { optional: true })}
    <div class="cols">
      ${field('email', t('field.email'), input('email', '', 'type="email" dir="ltr" autocomplete="off" maxlength="254"'))}
      ${field('phone', t('field.phone'), input('phone', '', 'type="tel" dir="ltr" autocomplete="off" maxlength="25" placeholder="+218…"'))}
    </div>
    <p class="hint">${esc(t('invite.contact_hint'))}</p>
    ${permsEditor('sales', defaults)}
    <div class="field" data-field="verify_via" hidden><label>${esc(t('invite.verify_via'))}</label><div class="seg" data-verify></div><p class="err" role="alert"></p></div>
    <div class="field" data-field="send_via"><label>${esc(t('invite.send_via'))}</label><div class="radio-list" data-send></div><p class="err" role="alert"></p></div>
    <p class="notice warn" data-caps-note hidden></p>
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('invite.create'))}</button></div></form>`, { wide: true });
  const form = dlg.querySelector('form');
  wirePermsEditor(form);
  form.querySelector('[data-close]').addEventListener('click', closeDialog);

  const sync = () => {
    const email = form.elements.email.value.trim();
    const phone = form.elements.phone.value.trim();
    // Verification channel
    const vbox = form.querySelector('[data-field=verify_via]');
    vbox.hidden = !(email && phone);
    const curVerify = form.querySelector('input[name=verify_via]:checked')?.value || (state.caps.email ? 'email' : 'sms');
    form.querySelector('[data-verify]').innerHTML = [['email', t('verify.email'), state.caps.email], ['sms', t('verify.sms'), state.caps.sms]]
      .map(([v, l, ok]) => `<label class="seg-i"><input type="radio" name="verify_via" value="${v}"${v === curVerify ? ' checked' : ''}${ok ? '' : ' disabled'}><span>${esc(l)}</span></label>`).join('');
    // Delivery
    const cur = form.querySelector('input[name=send_via]:checked')?.value;
    const opts = sendViaOptions(email, phone);
    const pick = opts.find(([v, , ok]) => v === cur && ok) ? cur : (opts.find(([, , ok]) => ok)?.[0] || 'manual');
    form.querySelector('[data-send]').innerHTML = opts.map(([v, l, ok]) => `<label class="radio${ok ? '' : ' disabled'}"><input type="radio" name="send_via" value="${v}"${v === pick ? ' checked' : ''}${ok ? '' : ' disabled'}><span><b>${esc(l)}</b><small>${esc(ok ? t(`send.${v}_desc`) : t(`send.${v}_off`))}</small></span></label>`).join('');
    // Capability note for verification
    const verify = email && phone ? (form.querySelector('input[name=verify_via]:checked')?.value || 'email') : email ? 'email' : phone ? 'sms' : null;
    const note = form.querySelector('[data-caps-note]');
    const missing = verify && !state.caps[verify];
    note.hidden = !missing;
    note.textContent = missing ? t(`caps.verify_off.${verify}`) : '';
  };
  form.elements.email.addEventListener('input', sync);
  form.elements.phone.addEventListener('input', sync);
  form.addEventListener('change', (e) => { if (e.target.name === 'verify_via') sync(); });
  sync();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!d.email && !d.phone) {
      form.querySelector('.form-error').textContent = t('invite.need_contact');
      form.elements.email.focus();
      return;
    }
    const body = {
      name: d.name, email: d.email, phone: d.phone, role: d.role, permissions: collectPerms(d),
      verify_via: d.email && d.phone ? d.verify_via : undefined, send_via: d.send_via || 'manual',
    };
    try {
      const r = await submitting(form, () => api('POST', '/api/invitations', body));
      showInviteResult(r, ctx);
    } catch { /* shown */ }
  });
}

function openResendDialog(inv, ctx) {
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(t('invite.resend'))}</h2>
    <p class="muted small">${esc(t('invite.resend_note'))}</p>
    <div class="field" data-field="send_via"><label>${esc(t('invite.send_via'))}</label><div class="radio-list">
      ${sendViaOptions(inv.email, inv.phone).map(([v, l, ok], i, arr) => `<label class="radio${ok ? '' : ' disabled'}"><input type="radio" name="send_via" value="${v}"${(arr.find(([, , o]) => o)?.[0] === v) ? ' checked' : ''}${ok ? '' : ' disabled'}><span><b>${esc(l)}</b><small>${esc(ok ? t(`send.${v}_desc`) : t(`send.${v}_off`))}</small></span></label>`).join('')}
    </div><p class="err" role="alert"></p></div>
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('invite.resend'))}</button></div></form>`);
  const form = dlg.querySelector('form');
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await submitting(form, () => api('POST', `/api/invitations/${inv.id}/resend`, { send_via: formData(form).send_via }));
      showInviteResult(r, ctx);
    } catch { /* shown */ }
  });
}

function openInviteRoleDialog(inv, ctx) {
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(t('invite.edit'))}</h2><p class="muted small" dir="ltr">${esc(inv.email || inv.phone)}</p>
    ${permsEditor(inv.role, inv.permissions)}
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button></div></form>`, { wide: true });
  const form = dlg.querySelector('form');
  wirePermsEditor(form);
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await submitting(form, () => api('PATCH', `/api/invitations/${inv.id}`, { role: d.role, permissions: collectPerms(d) }));
      closeDialog(); toast(t('saved')); ctx.rerender();
    } catch { /* shown */ }
  });
}

/** After creating / resending: delivery status + link, code, WhatsApp share and copy buttons. */
function showInviteResult(r, ctx) {
  const inv = r.invitation;
  const digits = (inv.phone || '').replace(/\D/g, '');
  const wa = `https://wa.me/${digits}?text=${encodeURIComponent(r.share_text)}`;
  const sentLine = r.sent?.skipped ? t('invite.result.manual')
    : r.sent?.ok ? t('invite.result.sent', { to: r.sent && inv.email && !inv.phone ? inv.email : (inv.email || inv.phone) })
      : t('invite.result.failed', { reason: t(`err.${r.sent?.error}`) });
  const dlg = openDialog(`<div class="dlg-body">
    <h2>${icon(r.sent?.ok && !r.sent?.skipped ? 'check' : 'send')}${esc(t('invite.result.title'))}</h2>
    <p class="${r.sent?.ok ? 'muted' : 'notice warn'}">${esc(sentLine)}</p>
    <div class="field"><label>${esc(t('invite.link'))}</label>
      <div class="copy-row"><input readonly dir="ltr" value="${esc(r.link)}" aria-label="${esc(t('invite.link'))}"><button class="btn small" data-copy="${esc(r.link)}">${icon('copy')}${esc(t('copy'))}</button></div></div>
    <div class="field"><label>${esc(t('invite.code'))}</label>
      <div class="copy-row"><input readonly dir="ltr" class="code-input" value="${esc(r.code)}" aria-label="${esc(t('invite.code'))}"><button class="btn small" data-copy="${esc(r.code)}">${icon('copy')}${esc(t('copy'))}</button></div></div>
    <p class="hint">${esc(t('invite.result.once'))}</p>
    <div class="dlg-actions">
      <a class="btn" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')}${esc(t('invite.whatsapp'))}</a>
      <button class="btn primary" data-done>${esc(t('done'))}</button>
    </div></div>`, { onClose: () => { if (location.hash === '#/team/invitations') ctx.rerender(); else location.hash = '#/team/invitations'; } });
  dlg.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    toast((await copyText(b.dataset.copy)) ? t('copied') : t('copy_failed'), 'ok');
  }));
  dlg.querySelector('[data-done]').addEventListener('click', closeDialog);
}
