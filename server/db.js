// SQLite storage using Node's built-in `node:sqlite` (no native dependencies).
// All timestamps are stored as INTEGER milliseconds since the epoch (UTC).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_FILE = process.env.DB_PATH || path.join(root, 'data', 'crm.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export const SCHEMA_VERSION = 2;

// Refuse to run on a database from the earlier prototype (different schema, demo data only).
{
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (hasUsers && version !== SCHEMA_VERSION) {
    console.error(
      `\n  ${DB_FILE} was created by an older version of this app (prototype with demo data).\n` +
      '  Move or delete it, then start again to create a fresh, empty database.\n'
    );
    process.exit(1);
  }
}

export const STATUSES = ['new', 'attempted', 'interested', 'follow_up', 'won', 'lost'];
export const CLOSED_STATUSES = ['won', 'lost'];
export const ACTIVITY_TYPES = ['call', 'message', 'meeting', 'email', 'other'];
export const OUTCOMES = ['positive', 'neutral', 'negative', 'no_answer'];

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE COLLATE NOCASE,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('manager','sales','viewer')),
  permissions   TEXT NOT NULL DEFAULT '[]',
  language      TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en')),
  email_notifications INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  invited_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id            INTEGER PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  code_hash     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  email         TEXT COLLATE NOCASE,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('manager','sales','viewer')),
  permissions   TEXT NOT NULL DEFAULT '[]',
  verify_via    TEXT NOT NULL CHECK (verify_via IN ('email','sms')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  is_bootstrap  INTEGER NOT NULL DEFAULT 0,
  invited_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_sent_at  INTEGER,
  send_count    INTEGER NOT NULL DEFAULT 0,
  accepted_at   INTEGER,
  accepted_user_id INTEGER REFERENCES users(id),
  revoked_at    INTEGER,
  revoked_by    INTEGER REFERENCES users(id),
  -- in-progress acceptance (account is only created after the code is verified)
  pending_name          TEXT,
  pending_password_hash TEXT,
  pending_language      TEXT,
  otp_hash      TEXT,
  otp_expires_at INTEGER,
  otp_attempts  INTEGER NOT NULL DEFAULT 0,
  otp_sent_at   INTEGER,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invitations(status);

CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  key        TEXT UNIQUE,
  name_ar    TEXT NOT NULL,
  name_en    TEXT NOT NULL,
  is_other   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  company       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  phone_key     TEXT,
  email         TEXT NOT NULL DEFAULT '',
  channel_id    INTEGER REFERENCES channels(id),
  channel_other TEXT NOT NULL DEFAULT '',
  owner_id      INTEGER REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','attempted','interested','follow_up','won','lost')),
  notes         TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id),
  updated_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_owner   ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads(phone_key);
CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads(email COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS followups (
  id           INTEGER PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  due_at       INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  assigned_to  INTEGER REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','canceled')),
  created_by   INTEGER REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  closed_by    INTEGER REFERENCES users(id),
  reminded_upcoming INTEGER NOT NULL DEFAULT 0,
  reminded_due      INTEGER NOT NULL DEFAULT 0,
  reminded_managers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fu_open ON followups(status, due_at);
CREATE INDEX IF NOT EXISTS idx_fu_lead ON followups(lead_id);
-- At most one open follow-up per lead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fu_one_open ON followups(lead_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS activities (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('call','message','meeting','email','other')),
  outcome     TEXT NOT NULL CHECK (outcome IN ('positive','neutral','negative','no_answer')),
  note        TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  followup_id INTEGER REFERENCES followups(id) ON DELETE CASCADE,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,
  emailed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  user_name  TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  lead_id    INTEGER,
  details    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_lead    ON audit_log(lead_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

// System configuration defaults (not sample data).
const DEFAULT_SETTINGS = {
  timezone: process.env.APP_TIMEZONE || 'Africa/Tripoli',
  default_lead_access: 'all',          // 'all' | 'assigned' — preselected when inviting reps/viewers
  remind_before_minutes: '60',          // notify the owner this long before a follow-up is due
  manager_overdue_hours: '24',          // notify managers when a follow-up is overdue this long (0 = off)
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}

// Ready-to-use sales channels (configuration the manager can rename, disable or extend).
const BUILTIN_CHANNELS = [
  ['instagram', 'إنستغرام', 'Instagram'],
  ['facebook', 'فيسبوك', 'Facebook'],
  ['whatsapp', 'واتساب', 'WhatsApp'],
  ['phone', 'اتصال هاتفي', 'Phone'],
  ['email', 'البريد الإلكتروني', 'Email'],
  ['website', 'الموقع الإلكتروني', 'Website'],
  ['referral', 'إحالة', 'Referral'],
  ['ads', 'إعلانات', 'Ads'],
  ['other', 'أخرى', 'Other'],
];
BUILTIN_CHANNELS.forEach(([key, ar, en], i) => {
  db.prepare('INSERT OR IGNORE INTO channels (key, name_ar, name_en, is_other, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, ar, en, key === 'other' ? 1 : 0, key === 'other' ? 1000 : (i + 1) * 10, Date.now());
});

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
export const allSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

export function audit(user, action, entity, entityId, details = {}, leadId = null) {
  db.prepare(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, lead_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(user?.id ?? null, user?.name ?? 'system', action, entity, entityId ?? null, leadId, JSON.stringify(details), Date.now());
}
