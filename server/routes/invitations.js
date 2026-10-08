// Invitation-only account creation: manager invites → invitee opens link / enters code →
// sets name + password → verifies email (code by email) or phone (code by SMS) → account is created.
import { db, tx, audit, getSetting } from '../db.js';
import {
  requirePerm, hashPassword, sha256, randomToken, randomCode, normalizeCode, randomOtp, safeEqual,
  createSession, limited,
} from '../auth.js';
import { ROLES, normalizePermissions, roleDefaults } from '../permissions.js';
import { parse, ValidationError, HttpError, checkPassword } from '../validate.js';
import { capabilities, send } from '../delivery.js';
import { invitationMessage, verificationMessage, inviteLink } from '../messages.js';

const INVITE_DAYS = Number(process.env.INVITE_DAYS) || 7;
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

const now = () => Date.now();
export const inviteStatus = (inv, t = now()) => (inv.status === 'pending' && inv.expires_at <= t ? 'expired' : inv.status);

export const maskEmail = (e) => {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(u.length - 1, 6)))}@${d}`;
};
export const maskPhone = (p) => (p ? `${p.startsWith('+') ? '+' : ''}${'•'.repeat(Math.max(0, p.replace(/\D/g, '').length - 3))}${p.slice(-3)}` : null);

function contactInUse(email, phone, ignoreInviteId = 0) {
  const errors = {};
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) errors.email = 'exists';
  if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) errors.phone = 'exists';
  const t = now();
  if (email && db.prepare("SELECT 1 FROM invitations WHERE email = ? AND status = 'pending' AND expires_at > ? AND id != ?").get(email, t, ignoreInviteId)) errors.email ??= 'invited';
  if (phone && db.prepare("SELECT 1 FROM invitations WHERE phone = ? AND status = 'pending' AND expires_at > ? AND id != ?").get(phone, t, ignoreInviteId)) errors.phone ??= 'invited';
  return errors;
}

/** Create an invitation row. Returns the plain token and code (only ever shown once). */
export function createInvitation({ inviter, name = '', email = null, phone = null, role, permissions, verifyVia, bootstrap = false }) {
  const token = randomToken();
  const code = randomCode();
  const t = now();
  const r = db.prepare(
    `INSERT INTO invitations (token_hash, code_hash, name, email, phone, role, permissions, verify_via, is_bootstrap, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sha256(token), sha256(normalizeCode(code)), name, email, phone, role, JSON.stringify(permissions), verifyVia,
        bootstrap ? 1 : 0, inviter?.id ?? null, t, t + INVITE_DAYS * 86400_000);
  return { id: Number(r.lastInsertRowid), token, code };
}

/** Regenerate the secret link + code (old ones stop working) and extend the expiry. */
function refreshInvitation(id) {
  const token = randomToken();
  const code = randomCode();
  const t = now();
  db.prepare(
    `UPDATE invitations SET token_hash = ?, code_hash = ?, expires_at = ?, pending_name = NULL, pending_password_hash = NULL,
       otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_sent_at = NULL WHERE id = ?`
  ).run(sha256(token), sha256(normalizeCode(code)), t + INVITE_DAYS * 86400_000, id);
  return { token, code };
}

async function deliverInvitation(inv, inviterName, token, code, via) {
  if (via !== 'email' && via !== 'sms') return { ok: true, skipped: true };
  const to = via === 'email' ? inv.email : inv.phone;
  if (!to) return { ok: false, error: 'no_destination' };
  const m = invitationMessage({ inviterName, role: inv.role, token, code, expiresAt: inv.expires_at });
  const r = await send({ channel: via, to, subject: m.subject, text: via === 'sms' ? m.text.split('\n\n')[0] : m.text, html: m.html });
  if (r.ok) db.prepare('UPDATE invitations SET last_sent_at = ?, send_count = send_count + 1 WHERE id = ?').run(now(), inv.id);
  return r;
}

/** Find a usable invitation from a link token or a typed code. */
function findInvitation(body) {
  let inv = null;
  if (typeof body?.token === 'string' && body.token.length >= 20 && body.token.length <= 100) {
    inv = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(sha256(body.token));
  } else if (typeof body?.code === 'string' && normalizeCode(body.code).length === 8) {
    inv = db.prepare('SELECT * FROM invitations WHERE code_hash = ?').get(sha256(normalizeCode(body.code)));
  }
  if (!inv) throw new HttpError(404, 'invite_invalid');
  const st = inviteStatus(inv);
  if (st !== 'pending') throw new HttpError(410, `invite_${st}`);
  return inv;
}

const publicView = (inv) => ({
  name: inv.name,
  email: maskEmail(inv.email),
  phone: maskPhone(inv.phone),
  role: inv.role,
  verify_via: inv.verify_via,
  expires_at: inv.expires_at,
  inviter: inv.invited_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(inv.invited_by)?.name ?? null : null,
  awaiting_code: !!inv.pending_password_hash,
});

async function sendOtp(inv, lang) {
  const t = now();
  if (inv.otp_sent_at && t - inv.otp_sent_at < OTP_RESEND_SECONDS * 1000) {
    throw new HttpError(429, 'wait_before_resend', { retry_after: Math.ceil((OTP_RESEND_SECONDS * 1000 - (t - inv.otp_sent_at)) / 1000) });
  }
  if (limited(`otp-send:${inv.id}`, 5, 3600_000)) throw new HttpError(429, 'too_many_attempts');
  const otp = randomOtp();
  db.prepare('UPDATE invitations SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0, otp_sent_at = ? WHERE id = ?')
    .run(sha256(`${inv.id}:${otp}`), t + OTP_MINUTES * 60_000, t, inv.id);
  const m = verificationMessage({ code: otp, lang });
  const to = inv.verify_via === 'email' ? inv.email : inv.phone;
  const r = await send({ channel: inv.verify_via, to, subject: m.subject, text: m.text, html: m.html }, { forceConsole: !!inv.is_bootstrap });
  if (!r.ok) throw new HttpError(503, r.error || 'delivery_failed');
}

function invitationRow(inv) {
  const t = now();
  return {
    id: inv.id, name: inv.name, email: inv.email, phone: inv.phone, role: inv.role,
    permissions: normalizePermissions(inv.role, safeJson(inv.permissions, [])),
    verify_via: inv.verify_via, status: inviteStatus(inv, t), is_bootstrap: !!inv.is_bootstrap,
    invited_by: inv.invited_by, invited_by_name: inv.invited_by_name ?? null,
    created_at: inv.created_at, expires_at: inv.expires_at, last_sent_at: inv.last_sent_at, send_count: inv.send_count,
    accepted_at: inv.accepted_at, accepted_user_id: inv.accepted_user_id, revoked_at: inv.revoked_at,
    revoked_by_name: inv.revoked_by_name ?? null,
  };
}

export function registerInvitationRoutes(app) {
  // ===== public: invitee side =====
  app.post('/api/invitations/lookup', (req, res) => {
    if (limited(`inv-lookup:${req.ip}`, 30, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');
    res.json({ invitation: publicView(findInvitation(req.body)) });
  });

  app.post('/api/invitations/accept', async (req, res) => {
    if (limited(`inv-accept:${req.ip}`, 20, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');
    const inv = findInvitation(req.body);
    const d = parse(req.body, { name: { type: 'text', required: true, max: 80 }, language: { type: 'enum', values: ['ar', 'en'] } });
    const password = checkPassword(req.body?.password);
    const clash = contactInUse(inv.email, inv.phone, inv.id);
    if (clash.email === 'exists' || clash.phone === 'exists') throw new HttpError(409, 'contact_in_use');
    db.prepare('UPDATE invitations SET pending_name = ?, pending_password_hash = ?, pending_language = ? WHERE id = ?')
      .run(d.name, hashPassword(password), d.language || 'ar', inv.id);
    await sendOtp(db.prepare('SELECT * FROM invitations WHERE id = ?').get(inv.id), d.language || 'ar');
    res.json({ verify_via: inv.verify_via, destination: inv.verify_via === 'email' ? maskEmail(inv.email) : maskPhone(inv.phone) });
  });

  app.post('/api/invitations/resend-code', async (req, res) => {
    if (limited(`inv-accept:${req.ip}`, 20, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');
    const inv = findInvitation(req.body);
    if (!inv.pending_password_hash) throw new HttpError(409, 'start_over');
    await sendOtp(inv, inv.pending_language || 'ar');
    res.json({ ok: true });
  });

  app.post('/api/invitations/verify', (req, res) => {
    if (limited(`inv-verify:${req.ip}`, 30, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');
    const inv = findInvitation(req.body);
    const otp = String(req.body?.otp ?? '').replace(/\D/g, '');
    if (!inv.pending_password_hash || !inv.otp_hash) throw new HttpError(409, 'start_over');
    if (inv.otp_expires_at < now()) throw new HttpError(410, 'otp_expired');
    if (inv.otp_attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'otp_locked');
    if (otp.length !== 6 || !safeEqual(sha256(`${inv.id}:${otp}`), inv.otp_hash)) {
      db.prepare('UPDATE invitations SET otp_attempts = otp_attempts + 1 WHERE id = ?').run(inv.id);
      throw new ValidationError({ otp: 'invalid' });
    }
    const clash = contactInUse(inv.email, inv.phone, inv.id);
    if (clash.email === 'exists' || clash.phone === 'exists') throw new HttpError(409, 'contact_in_use');

    const user = tx(() => {
      const t = now();
      const perms = normalizePermissions(inv.role, safeJson(inv.permissions, []));
      const r = db.prepare(
        `INSERT INTO users (name, email, phone, password_hash, role, permissions, language, invited_by, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(inv.pending_name, inv.email, inv.phone, inv.pending_password_hash, inv.role, JSON.stringify(perms),
            inv.pending_language || 'ar', inv.invited_by, t, t);
      const userId = Number(r.lastInsertRowid);
      db.prepare(
        `UPDATE invitations SET status = 'accepted', accepted_at = ?, accepted_user_id = ?, pending_password_hash = NULL,
           otp_hash = NULL, otp_expires_at = NULL WHERE id = ?`
      ).run(t, userId, inv.id);
      const u = { id: userId, name: inv.pending_name };
      audit(u, 'invitation.accept', 'invitation', inv.id, { role: inv.role, permissions: perms, verified: inv.verify_via });
      return { ...u, role: inv.role, language: inv.pending_language || 'ar' };
    });
    createSession(res, user.id);
    res.json({ user });
  });

  // ===== manager side =====
  app.get('/api/invitations', requirePerm('team.manage'), (_req, res) => {
    const rows = db.prepare(
      `SELECT i.*, u.name AS invited_by_name, rb.name AS revoked_by_name FROM invitations i
         LEFT JOIN users u ON u.id = i.invited_by LEFT JOIN users rb ON rb.id = i.revoked_by
        ORDER BY i.id DESC LIMIT 300`
    ).all();
    res.json({ items: rows.map(invitationRow), capabilities: capabilities() });
  });

  app.post('/api/invitations', requirePerm('team.manage'), async (req, res) => {
    const d = parse(req.body, {
      name: { type: 'text', max: 80 },
      email: { type: 'email' },
      phone: { type: 'phone' },
      role: { type: 'enum', values: ROLES, required: true },
      verify_via: { type: 'enum', values: ['email', 'sms'] },
      send_via: { type: 'enum', values: ['email', 'sms', 'manual'] },
    });
    if (!d.email && !d.phone) throw new ValidationError({ email: 'required', phone: 'required' });
    const verifyVia = d.verify_via || (d.email ? 'email' : 'sms');
    if (verifyVia === 'email' && !d.email) throw new ValidationError({ email: 'required' });
    if (verifyVia === 'sms' && !d.phone) throw new ValidationError({ phone: 'required' });
    const caps = capabilities();
    if (!caps[verifyVia]) throw new ValidationError({ verify_via: 'not_configured' });
    const sendVia = d.send_via || 'manual';
    if (sendVia !== 'manual' && !caps[sendVia]) throw new ValidationError({ send_via: 'not_configured' });
    if (sendVia === 'email' && !d.email) throw new ValidationError({ email: 'required' });
    if (sendVia === 'sms' && !d.phone) throw new ValidationError({ phone: 'required' });

    const clash = contactInUse(d.email || null, d.phone || null);
    if (Object.keys(clash).length) throw new ValidationError(clash);

    const permissions = Array.isArray(req.body?.permissions)
      ? normalizePermissions(d.role, req.body.permissions)
      : normalizePermissions(d.role, roleDefaults(d.role, getSetting('default_lead_access')));

    const created = tx(() => {
      const c = createInvitation({
        inviter: req.user, name: d.name || '', email: d.email || null, phone: d.phone || null, role: d.role, permissions, verifyVia,
      });
      audit(req.user, 'invitation.create', 'invitation', c.id, {
        email: d.email || undefined, phone: d.phone || undefined, role: d.role, permissions, verify_via: verifyVia,
      });
      return c;
    });
    const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(created.id);
    const sent = await deliverInvitation(inv, req.user.name, created.token, created.code, sendVia);
    const msg = invitationMessage({ inviterName: req.user.name, role: inv.role, token: created.token, code: created.code, expiresAt: inv.expires_at });
    res.status(201).json({
      invitation: invitationRow(inv), link: inviteLink(created.token), code: created.code, share_text: msg.share, sent,
    });
  });

  app.patch('/api/invitations/:id', requirePerm('team.manage'), (req, res) => {
    const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(Number(req.params.id));
    if (!inv) throw new HttpError(404, 'not_found');
    if (inviteStatus(inv) !== 'pending' || inv.is_bootstrap) throw new HttpError(409, 'invite_not_pending');
    const d = parse(req.body, { role: { type: 'enum', values: ROLES, required: true } });
    const perms = normalizePermissions(d.role, req.body?.permissions);
    const before = { role: inv.role, permissions: normalizePermissions(inv.role, safeJson(inv.permissions, [])) };
    tx(() => {
      db.prepare('UPDATE invitations SET role = ?, permissions = ? WHERE id = ?').run(d.role, JSON.stringify(perms), inv.id);
      audit(req.user, 'invitation.update', 'invitation', inv.id, { role: [before.role, d.role], permissions: [before.permissions, perms] });
    });
    res.json({ ok: true });
  });

  app.post('/api/invitations/:id/resend', requirePerm('team.manage'), async (req, res) => {
    const inv0 = db.prepare('SELECT * FROM invitations WHERE id = ?').get(Number(req.params.id));
    if (!inv0) throw new HttpError(404, 'not_found');
    const st = inviteStatus(inv0);
    if (st !== 'pending' && st !== 'expired') throw new HttpError(409, 'invite_not_pending');
    const { send_via: sendVia = 'manual' } = parse(req.body, { send_via: { type: 'enum', values: ['email', 'sms', 'manual'] } });
    if (sendVia !== 'manual' && !capabilities()[sendVia]) throw new ValidationError({ send_via: 'not_configured' });
    const clash = contactInUse(inv0.email, inv0.phone, inv0.id);
    if (Object.keys(clash).length) throw new ValidationError(clash);
    const fresh = tx(() => {
      const f = refreshInvitation(inv0.id);
      audit(req.user, 'invitation.resend', 'invitation', inv0.id, { email: inv0.email || undefined, phone: inv0.phone || undefined });
      return f;
    });
    const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(inv0.id);
    const sent = await deliverInvitation(inv, req.user.name, fresh.token, fresh.code, sendVia);
    const msg = invitationMessage({ inviterName: req.user.name, role: inv.role, token: fresh.token, code: fresh.code, expiresAt: inv.expires_at });
    res.json({ invitation: invitationRow(inv), link: inviteLink(fresh.token), code: fresh.code, share_text: msg.share, sent });
  });

  app.post('/api/invitations/:id/revoke', requirePerm('team.manage'), (req, res) => {
    const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(Number(req.params.id));
    if (!inv) throw new HttpError(404, 'not_found');
    if (inv.status !== 'pending') throw new HttpError(409, 'invite_not_pending');
    tx(() => {
      db.prepare(
        "UPDATE invitations SET status = 'revoked', revoked_at = ?, revoked_by = ?, otp_hash = NULL, pending_password_hash = NULL WHERE id = ?"
      ).run(now(), req.user.id, inv.id);
      audit(req.user, 'invitation.revoke', 'invitation', inv.id, { email: inv.email || undefined, phone: inv.phone || undefined });
    });
    res.json({ ok: true });
  });
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
