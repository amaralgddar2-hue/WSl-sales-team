// Sign-in, session, the signed-in user's own profile, and the app bootstrap payload.
import { db, audit, allSettings } from '../db.js';
import {
  verifyPassword, verifyAgainstDummy, createSession, destroySession, destroyUserSessions, requireAuth,
  hashPassword, limited, resetLimit,
} from '../auth.js';
import { GRANTABLE } from '../permissions.js';
import { parse, ValidationError, HttpError, checkPassword, normalizePhone, phoneKey, EMAIL_RE } from '../validate.js';
import { capabilities } from '../delivery.js';
import { utcToZoned } from '../time.js';

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, language: u.language,
  email_notifications: !!u.email_notifications, perms: u.perms,
});

export function registerAccountRoutes(app) {
  app.post('/api/login', (req, res) => {
    const { identifier, password } = req.body || {};
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password || password.length > 200) {
      throw new HttpError(400, 'invalid_credentials');
    }
    const id = identifier.trim();
    const key = `login:${req.ip}:${id.toLowerCase()}`;
    if (limited(`login-ip:${req.ip}`, 60, 15 * 60_000) || limited(key, 10, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');

    let user = null;
    if (EMAIL_RE.test(id)) user = db.prepare('SELECT * FROM users WHERE email = ?').get(id.toLowerCase());
    else {
      // Match phones written differently (+218 91… / 091…) by their last 9 digits.
      const key = phoneKey(normalizePhone(id));
      if (key) {
        const matches = db.prepare('SELECT * FROM users WHERE phone IS NOT NULL').all().filter((u) => phoneKey(u.phone) === key);
        if (matches.length === 1) user = matches[0];
      }
    }
    const ok = user ? verifyPassword(password, user.password_hash) : (verifyAgainstDummy(password), false);
    if (!ok || !user.active) throw new HttpError(401, 'invalid_credentials');
    resetLimit(key);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    createSession(res, user.id);
    res.json({ ok: true, language: user.language });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  /** Everything the UI needs after sign-in. */
  app.get('/api/bootstrap', requireAuth, (req, res) => {
    const s = allSettings();
    const channels = db.prepare('SELECT * FROM channels ORDER BY active DESC, sort, id').all();
    const users = db.prepare('SELECT id, name, role, permissions, active FROM users ORDER BY active DESC, name').all()
      .map((u) => {
        let p = [];
        try { p = JSON.parse(u.permissions); } catch { /* none */ }
        const canOwn = u.active && (u.role === 'manager' || p.includes('leads.edit_own') || p.includes('leads.edit_all'));
        return { id: u.id, name: u.name, role: u.role, active: u.active, can_own: !!canOwn };
      });
    res.json({
      me: publicUser(req.user),
      settings: {
        timezone: s.timezone,
        default_lead_access: s.default_lead_access,
        remind_before_minutes: Number(s.remind_before_minutes),
        manager_overdue_hours: Number(s.manager_overdue_hours),
        today: utcToZoned(Date.now(), s.timezone).date,
      },
      channels,
      users,
      grantable: GRANTABLE,
      capabilities: capabilities(),
      server_now: Date.now(),
    });
  });

  app.patch('/api/me', requireAuth, (req, res) => {
    const d = parse(req.body, {
      language: { type: 'enum', values: ['ar', 'en'] },
      email_notifications: { type: 'bool' },
      name: { type: 'text', max: 80 },
    }, { partial: true });
    if ('name' in d && !d.name) throw new ValidationError({ name: 'required' });
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(d)) {
      if (v === null) continue;
      sets.push(`${k} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/me/password', requireAuth, (req, res) => {
    const { current } = req.body || {};
    const next = checkPassword(req.body?.next, 'next');
    if (limited(`pw:${req.user.id}`, 10, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (typeof current !== 'string' || !verifyPassword(current, row.password_hash)) throw new ValidationError({ current: 'invalid' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    destroyUserSessions(req.user.id, req);
    audit(req.user, 'user.password', 'user', req.user.id);
    res.json({ ok: true });
  });
}
