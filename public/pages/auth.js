// Public pages: sign in, join with an invitation code, accept an invitation (+ verification code).
import { t, getLang } from '../i18n.js';
import {
  $, esc, api, ApiError, field, input, formData, submitting, showFormError, showFieldErrors, errorText, loadingHtml, icon,
} from '../ui.js';

function frame(inner) {
  $('#app').innerHTML = `
  <div class="auth-wrap">
    <div class="auth-top">
      <button class="icon-btn" data-auth="theme" aria-label="${esc(t('theme.toggle'))}" title="${esc(t('theme.toggle'))}">${icon('sun')}</button>
      <button class="lang-btn" data-auth="lang">${esc(t('lang.switch'))}</button>
    </div>
    <div class="auth-card">${inner}</div>
  </div>`;
  const root = $('#app .auth-wrap');
  root.querySelector('[data-auth=lang]').addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('app:lang', { detail: getLang() === 'ar' ? 'en' : 'ar' })));
  root.querySelector('[data-auth=theme]').addEventListener('click', () => document.dispatchEvent(new Event('app:theme')));
  return root.querySelector('.auth-card');
}

const head = (title, sub = '') => `<span class="logo big" aria-hidden="true"></span><h1>${esc(title)}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}`;

// ---------- sign in ----------
export function loginPage() {
  const card = frame(`
    ${head(t('auth.signin.title'), esc(t('auth.signin.sub')))}
    <form novalidate>
      ${field('identifier', t('auth.identifier'), input('identifier', '', 'autocomplete="username" dir="ltr" required autofocus inputmode="email"'))}
      ${field('password', t('auth.password'), input('password', '', 'type="password" autocomplete="current-password" dir="ltr" required'))}
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">${esc(t('auth.signin.submit'))}</button>
    </form>
    <div class="auth-alt"><a href="#/join">${esc(t('auth.have_code'))}</a></div>
    <p class="hint center">${esc(t('auth.no_signup'))}</p>`);
  const form = card.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!d.identifier.trim() || !d.password) return showFormError(form, t('err.invalid_credentials'));
    try {
      await submitting(form, () => api('POST', '/api/login', { identifier: d.identifier, password: d.password }));
      if (!location.hash.startsWith('#/leads')) location.hash = '#/leads';
      document.dispatchEvent(new Event('app:signed-in'));
    } catch { /* message shown */ }
  });
}

// ---------- join with code ----------
export function joinPage() {
  const card = frame(`
    ${head(t('auth.join.title'), esc(t('auth.join.sub')))}
    <form novalidate>
      ${field('code', t('auth.code'), input('code', '', 'dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required autofocus class="code-input"'))}
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">${esc(t('continue'))}</button>
    </form>
    <div class="auth-alt"><a href="#/login">${esc(t('auth.back_signin'))}</a></div>`);
  const form = card.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = formData(form).code;
    if (!code.trim()) return showFormError(form, t('val.required'));
    try {
      const r = await submitting(form, () => api('POST', '/api/invitations/lookup', { code }));
      acceptStep({ code }, r.invitation);
    } catch (err) {
      if (err instanceof ApiError && err.code.startsWith('invite_')) showFormError(form, t(`err.${err.code}`));
    }
  });
}

// ---------- invitation link ----------
export async function invitePage(token) {
  const card = frame(loadingHtml());
  try {
    const r = await api('POST', '/api/invitations/lookup', { token });
    acceptStep({ token }, r.invitation);
  } catch (e) {
    card.innerHTML = `${head(t('auth.invite.problem'))}
      <p class="notice error">${esc(errorText(e))}</p>
      <p class="muted">${esc(t('auth.invite.ask_new'))}</p>
      <div class="auth-alt"><a href="#/login">${esc(t('auth.back_signin'))}</a></div>`;
  }
}

function acceptStep(key, inv) {
  const who = inv.inviter ? t('auth.invite.by', { name: inv.inviter, role: t(`role.${inv.role}`) }) : t('auth.invite.as', { role: t(`role.${inv.role}`) });
  const dest = inv.verify_via === 'email' ? inv.email : inv.phone;
  const card = frame(`
    ${head(t('auth.invite.title'), esc(who))}
    <p class="contact-pill">${icon(inv.verify_via === 'email' ? 'email' : 'phone')}<span dir="ltr">${esc(inv.email || inv.phone)}</span></p>
    <form novalidate>
      ${field('name', t('auth.your_name'), input('name', inv.name, 'autocomplete="name" required maxlength="80" autofocus'))}
      ${field('password', t('auth.new_password'), input('password', '', 'type="password" autocomplete="new-password" dir="ltr" required maxlength="200"'), { hint: esc(t('auth.password_hint')) })}
      ${field('confirm', t('auth.confirm_password'), input('confirm', '', 'type="password" autocomplete="new-password" dir="ltr" required maxlength="200"'))}
      <p class="hint">${esc(t(`auth.verify_note.${inv.verify_via}`, { dest }))}</p>
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">${esc(t('auth.invite.create'))}</button>
    </form>`);
  const form = card.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const bad = {};
    if (!d.name.trim()) bad.name = 'required';
    if (d.password.length < 10) bad.password = d.password ? 'too_short' : 'required';
    else if (d.password !== d.confirm) bad.confirm = 'mismatch';
    if (Object.keys(bad).length) return showFieldErrors(form, bad);
    try {
      const r = await submitting(form, () => api('POST', '/api/invitations/accept', { ...key, name: d.name, password: d.password, language: getLang() }));
      verifyStep(key, r);
    } catch { /* shown */ }
  });
}

function verifyStep(key, info) {
  const card = frame(`
    ${head(t('auth.verify.title'), esc(t(`auth.verify.sub.${info.verify_via}`, { dest: info.destination })))}
    <form novalidate>
      ${field('otp', t('auth.verify.code'), input('otp', '', 'inputmode="numeric" autocomplete="one-time-code" dir="ltr" maxlength="6" pattern="[0-9]*" required autofocus class="otp-input"'))}
      <p class="form-error" role="alert"></p>
      <button class="btn primary block" type="submit">${esc(t('auth.verify.submit'))}</button>
    </form>
    <div class="auth-alt"><button class="link-btn" data-resend disabled></button></div>`);
  const form = card.querySelector('form');
  const resend = card.querySelector('[data-resend]');
  let left = 60;
  const tick = () => {
    if (!document.body.contains(resend)) return clearInterval(timer);
    left -= 1;
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? t('auth.verify.resend_in', { s: left }) : t('auth.verify.resend');
    if (left <= 0) clearInterval(timer);
  };
  let timer = setInterval(tick, 1000);
  left += 1; tick();

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      await api('POST', '/api/invitations/resend-code', key);
      showFormError(form, '');
      left = 61; tick(); timer = setInterval(tick, 1000);
      card.querySelector('.form-error').textContent = t('auth.verify.resent');
    } catch (e) {
      showFormError(form, e.code === 'wait_before_resend' ? t('auth.verify.resend_in', { s: e.data.retry_after }) : errorText(e));
      resend.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const otp = formData(form).otp.replace(/\D/g, '');
    if (otp.length !== 6) return showFormError(form, t('val.otp.invalid'));
    try {
      await submitting(form, () => api('POST', '/api/invitations/verify', { ...key, otp }));
      clearInterval(timer);
      location.hash = '#/help';
      document.dispatchEvent(new Event('app:signed-in'));
    } catch (err) {
      if (err.code === 'otp_locked' || err.code === 'otp_expired') resend.disabled = false;
    }
  });
}
