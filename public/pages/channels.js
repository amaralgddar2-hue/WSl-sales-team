// Sales channels: ready-made (Instagram, Facebook, WhatsApp…) plus custom ones. Managers add / edit / disable.
import { t, getLang } from '../i18n.js';
import {
  can, esc, bdi, api, icon, openDialog, closeDialog, field, input, formData, submitting, toast, fmtNum, reloadMeta, errorText,
} from '../ui.js';

export async function channelsPage(ctx) {
  const { items } = await api('GET', '/api/channels');
  if (!ctx.alive()) return;
  const manage = can('channels.manage');
  const v = ctx.view;
  const name = (c) => (getLang() === 'ar' ? c.name_ar : c.name_en);
  const other = (c) => (getLang() === 'ar' ? c.name_en : c.name_ar);

  v.innerHTML = `
    <header class="page-head">
      <div><h1>${esc(t('nav.channels'))}</h1><p class="muted">${esc(t('channels.sub'))}</p></div>
      ${manage ? `<button class="btn primary" data-act="add">${icon('plus')}${esc(t('channels.add'))}</button>` : ''}
    </header>
    <ul class="rows plain" role="list">
      ${items.map((c) => `<li class="row static${c.active ? '' : ' off'}">
        <span class="ch-ic">${icon('channels')}</span>
        <span class="r-main"><span class="r-name">${bdi(name(c))}</span><span class="r-company" dir="auto">${bdi(other(c))}</span></span>
        <span class="r-tags">${c.is_other ? `<span class="chip">${esc(t('channels.other_hint'))}</span>` : ''}${c.key ? `<span class="chip ghost">${esc(t('channels.builtin'))}</span>` : ''}${c.active ? '' : `<span class="chip">${esc(t('channels.inactive'))}</span>`}</span>
        <span class="r-count muted">${esc(t('channels.leads', { n: fmtNum(c.lead_count) }))}</span>
        ${manage ? `<span class="r-actions">
          <button class="btn small ghost" data-act="edit" data-id="${c.id}">${esc(t('edit'))}</button>
          <button class="btn small ghost" data-act="toggle" data-id="${c.id}">${esc(t(c.active ? 'channels.disable' : 'channels.enable'))}</button></span>` : ''}
      </li>`).join('')}
    </ul>
    ${manage ? '' : `<p class="hint">${esc(t('channels.managers_only'))}</p>`}`;

  v.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const ch = items.find((c) => c.id === Number(el.dataset.id));
    if (el.dataset.act === 'add') openChannelForm(null, ctx);
    else if (el.dataset.act === 'edit') openChannelForm(ch, ctx);
    else if (el.dataset.act === 'toggle') {
      try {
        await api('PATCH', `/api/channels/${ch.id}`, { active: !ch.active });
        await reloadMeta(); ctx.rerender();
      } catch (err) { toast(errorText(err), 'error'); }
    }
  });
}

function openChannelForm(ch, ctx) {
  const dlg = openDialog(`<form class="dlg-form" novalidate>
    <h2>${esc(ch ? t('channels.edit') : t('channels.add'))}</h2>
    <div class="cols">
      ${field('name_ar', t('channels.name_ar'), input('name_ar', ch?.name_ar, 'required maxlength="60" dir="rtl" autofocus'))}
      ${field('name_en', t('channels.name_en'), input('name_en', ch?.name_en, 'required maxlength="60" dir="ltr"'))}
    </div>
    <p class="form-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>
      <button type="submit" class="btn primary">${esc(t('save'))}</button></div></form>`);
  const form = dlg.querySelector('form');
  form.querySelector('[data-close]').addEventListener('click', closeDialog);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      await submitting(form, () => (ch ? api('PATCH', `/api/channels/${ch.id}`, d) : api('POST', '/api/channels', d)));
      await reloadMeta();
      closeDialog(); toast(t('saved')); ctx.rerender();
    } catch { /* shown */ }
  });
}
