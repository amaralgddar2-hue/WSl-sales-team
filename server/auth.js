// Password hashing (scrypt), random tokens, cookie sessions, auth middleware and rate limiting.
import crypto from 'node:crypto';
import { db } from './db.js';
import { effectivePermissions } from './permissions.js';

const SESSION_DAYS = 14;
const COOKIE = 'sid';
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));
export const verifyAgainstDummy = (password) => verifyPassword(password, DUMMY_HASH);

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** Short human-friendly invitation code, e.g. "K7QM-2XRP" (no ambiguous characters). */
export function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const randomOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createSession(res, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`);
}

export function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
}

export function destroyUserSessions(userId, exceptReq) {
  const keep = exceptReq ? readCookie(exceptReq, COOKIE) : null;
  if (keep) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keep));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Attach req.user (with effective permissions) when a valid session cookie is present. */
export function loadUser(req, _res, next) {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db.prepare(
      `SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    ).get(sha256(token));
    if (row && row.session_expires > Date.now() && row.active) {
      req.user = {
        id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role, language: row.language,
        email_notifications: !!row.email_notifications, permissions: row.permissions,
      };
      req.user.perms = effectivePermissions(row);
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

export const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!perms.every((p) => req.user.perms.includes(p))) return res.status(403).json({ error: 'forbidden' });
  next();
};

// ---------- simple in-memory rate limiting ----------
const buckets = new Map();
/** Returns true when the action identified by `key` exceeded `max` events within `windowMs`. */
export function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) { buckets.set(key, { start: now, count: 1 }); return false; }
  b.count += 1;
  return b.count > max;
}
export const resetLimit = (key) => buckets.delete(key);

setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  for (const [k, v] of buckets) if (now - v.start > 3600_000) buckets.delete(k);
}, 10 * 60_000).unref();
