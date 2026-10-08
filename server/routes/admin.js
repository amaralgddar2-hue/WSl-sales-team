// Channels, settings, activity log and in-app notifications.
import { db, tx, audit, allSettings, setSetting } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { parse, HttpError, ValidationError } from '../validate.js';
import { isValidTimeZone } from '../time.js';

export function registerAdminRoutes(app) {
  // ---------- channels ----------
  const channelSpec = {
    name_ar: { type: 'text', required: true, max: 60 },
    name_en: { type: 'text', required: true, max: 60 },
    active: { type: 'bool' },
  };

  app.get('/api/channels', requireAuth, (_req, res) => {
    const rows = db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM leads l WHERE l.channel_id = c.id) AS lead_count FROM channels c ORDER BY c.active DESC, c.sort, c.id`
    ).all();
    res.json({ items: rows });
  });

  app.post('/api/channels', requirePerm('channels.manage'), (req, res) => {
    const d = parse(req.body, channelSpec);
    const id = tx(() => {
      const r = db.prepare('INSERT INTO channels (name_ar, name_en, sort, created_at) VALUES (?, ?, 500, ?)').run(d.name_ar, d.name_en, Date.now());
      const newId = Number(r.lastInsertRowid);
      audit(req.user, 'channel.create', 'channel', newId, { name_ar: d.name_ar, name_en: d.name_en });
      return newId;
    });
    res.status(201).json({ id });
  });

  app.patch('/api/channels/:id', requirePerm('channels.manage'), (req, res) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id));
    if (!ch) throw new HttpError(404, 'not_found');
    const d = parse(req.body, channelSpec, { partial: true });
    if (('name_ar' in d && !d.name_ar) || ('name_en' in d && !d.name_en)) throw new ValidationError({ [d.name_ar ? 'name_en' : 'name_ar']: 'required' });
    if ('active' in d) d.active = d.active ? 1 : 0;
    const changes = {};
    for (const [k, v] of Object.entries(d)) if (v !== null && v !== ch[k]) changes[k] = [ch[k], v];
    if (!Object.keys(changes).length) return res.json({ ok: true });
    tx(() => {
      db.prepare(`UPDATE channels SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(changes).map(([, n]) => n), ch.id);
      audit(req.user, 'channel.update', 'channel', ch.id, { name_en: ch.name_en, ...changes });
    });
    res.json({ ok: true });
  });

  // ---------- settings ----------
  app.get('/api/settings', requirePerm('settings.manage'), (_req, res) => res.json(allSettings()));

  app.put('/api/settings', requirePerm('settings.manage'), (req, res) => {
    const d = parse(req.body, {
      timezone: { type: 'text', max: 64 },
      default_lead_access: { type: 'enum', values: ['all', 'assigned'] },
      remind_before_minutes: { type: 'int', min: 0, max: 1440 },
      manager_overdue_hours: { type: 'int', min: 0, max: 720 },
    }, { partial: true });
    if (d.timezone && !isValidTimeZone(d.timezone)) throw new ValidationError({ timezone: 'invalid' });
    const before = allSettings();
    const changes = {};
    for (const [k, v] of Object.entries(d)) if (v !== null && String(v) !== before[k]) changes[k] = [before[k], String(v)];
    tx(() => {
      for (const [k, [, v]] of Object.entries(changes)) setSetting(k, v);
      if (Object.keys(changes).length) audit(req.user, 'settings.update', 'settings', null, changes);
    });
    res.json(allSettings());
  });

  // ---------- activity log ----------
  app.get('/api/audit', requirePerm('audit.view'), (req, res) => {
    const limit = 50;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const groups = {
      leads: "entity IN ('lead','activity','followup')",
      team: "entity IN ('user','invitation')",
      channels: "entity = 'channel'",
      settings: "entity = 'settings'",
    };
    const where = groups[req.query.group] ? `WHERE ${groups[req.query.group]}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get().n;
    const rows = db.prepare(
      `SELECT a.*, l.name AS lead_name FROM audit_log a LEFT JOIN leads l ON l.id = a.lead_id ${where.replace('entity', 'a.entity')}
        ORDER BY a.id DESC LIMIT ? OFFSET ?`
    ).all(limit, (page - 1) * limit);
    res.json({ items: rows.map((r) => ({ ...r, details: safeJson(r.details) })), total, page, limit });
  });

  // ---------- in-app notifications (always available, no external service) ----------
  app.get('/api/notifications', requireAuth, (req, res) => {
    const items = db.prepare(
      `SELECT n.*, l.name AS lead_name FROM notifications n LEFT JOIN leads l ON l.id = n.lead_id
        WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`
    ).all(req.user.id).map((n) => ({ ...n, data: safeJson(n.data) }));
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ items, unread });
  });

  app.get('/api/notifications/unread', requireAuth, (req, res) => {
    res.json({ unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n });
  });

  app.post('/api/notifications/read', requireAuth, (req, res) => {
    const ids = req.body?.ids;
    if (ids === 'all') {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id);
    } else if (Array.isArray(ids) && ids.length <= 100 && ids.every((n) => Number.isInteger(n) && n > 0)) {
      const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      for (const id of ids) stmt.run(Date.now(), id, req.user.id);
    } else {
      throw new ValidationError({ ids: 'invalid' });
    }
    res.json({ ok: true });
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
