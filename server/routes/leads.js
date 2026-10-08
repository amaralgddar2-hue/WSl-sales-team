// Leads, activities (communication log), follow-ups and lead history.
import { db, tx, audit, getSetting, STATUSES, CLOSED_STATUSES, ACTIVITY_TYPES, OUTCOMES } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { can, leadScope, canSeeLead, canEditLead, effectivePermissions } from '../permissions.js';
import { parse, ValidationError, HttpError, phoneKey } from '../validate.js';
import { zonedToUtc, dayBounds } from '../time.js';

const now = () => Date.now();
const tz = () => getSetting('timezone');

const LEAD_SELECT = `
  SELECT l.*, o.name AS owner_name, cb.name AS created_by_name, ub.name AS updated_by_name,
         c.key AS channel_key, c.name_ar AS channel_name_ar, c.name_en AS channel_name_en, c.is_other AS channel_is_other,
         f.id AS fu_id, f.due_at AS fu_due_at, f.note AS fu_note, f.assigned_to AS fu_assigned_to
    FROM leads l
    LEFT JOIN users o  ON o.id  = l.owner_id
    LEFT JOIN users cb ON cb.id = l.created_by
    LEFT JOIN users ub ON ub.id = l.updated_by
    LEFT JOIN channels c ON c.id = l.channel_id
    LEFT JOIN followups f ON f.lead_id = l.id AND f.status = 'open'`;

const shape = (r) => {
  if (!r) return r;
  const { fu_id, fu_due_at, fu_note, fu_assigned_to, phone_key, ...rest } = r;
  return { ...rest, followup: fu_id ? { id: fu_id, due_at: fu_due_at, note: fu_note, assigned_to: fu_assigned_to } : null };
};

const leadSpec = {
  name: { type: 'text', required: true, max: 120 },
  company: { type: 'text', max: 120 },
  phone: { type: 'phone' },
  email: { type: 'email' },
  channel_id: { type: 'id' },
  channel_other: { type: 'text', max: 80 },
  owner_id: { type: 'id' },
  status: { type: 'enum', values: STATUSES },
  notes: { type: 'text', max: 4000 },
};

function checkChannel(data, current = {}) {
  const channelId = 'channel_id' in data ? data.channel_id : current.channel_id;
  if (!channelId) { data.channel_other = ''; return; }
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch || (!ch.active && channelId !== current.channel_id)) throw new ValidationError({ channel_id: 'invalid' });
  if (ch.is_other) {
    const other = 'channel_other' in data ? data.channel_other : current.channel_other;
    if (!other) throw new ValidationError({ channel_other: 'required' });
  } else {
    data.channel_other = '';
  }
}

function checkOwner(ownerId) {
  if (!ownerId) return;
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(ownerId);
  const perms = u ? effectivePermissions(u) : [];
  if (!u || !(perms.includes('leads.edit_own') || perms.includes('leads.edit_all'))) throw new ValidationError({ owner_id: 'invalid' });
}

/** Leads with the same phone (last 9 digits) or email. Hidden leads are reported without details. */
function findDuplicates(user, { phone, email }, excludeId = 0) {
  const key = phoneKey(phone);
  const clauses = [];
  const params = [];
  if (key) { clauses.push('l.phone_key = ?'); params.push(key); }
  if (email) { clauses.push('l.email = ? COLLATE NOCASE'); params.push(email); }
  if (!clauses.length) return [];
  const rows = db.prepare(
    `SELECT l.id, l.name, l.company, l.owner_id, l.phone_key, l.email, o.name AS owner_name
       FROM leads l LEFT JOIN users o ON o.id = l.owner_id
      WHERE (${clauses.join(' OR ')}) AND l.id != ? LIMIT 5`
  ).all(...params, excludeId);
  return rows.map((r) => {
    const match = key && r.phone_key === key ? 'phone' : 'email';
    return canSeeLead(user, r)
      ? { id: r.id, name: r.name, company: r.company, owner_name: r.owner_name, match, visible: true }
      : { match, visible: false, owner_name: r.owner_name };
  });
}

function loadLead(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead || !canSeeLead(req.user, lead)) throw new HttpError(404, 'not_found'); // 404 also hides existence
  return lead;
}

function loadEditableLead(req) {
  const lead = loadLead(req);
  if (!canEditLead(req.user, lead)) throw new HttpError(403, 'forbidden');
  return lead;
}

/** Parse a date+time pair (wall clock in the system time zone) into UTC ms. */
function parseWhen(body, dateKey, timeKey, { required = false } = {}) {
  const d = parse(body, { [dateKey]: { type: 'date', required }, [timeKey]: { type: 'time' } });
  if (!d[dateKey]) return null;
  return zonedToUtc(d[dateKey], d[timeKey] || '09:00', tz());
}

/** Create or replace the single open follow-up of a lead. */
function scheduleFollowup(user, lead, dueAt, note) {
  const open = db.prepare("SELECT * FROM followups WHERE lead_id = ? AND status = 'open'").get(lead.id);
  if (open) {
    db.prepare(
      'UPDATE followups SET due_at = ?, note = ?, assigned_to = ?, reminded_upcoming = 0, reminded_due = 0, reminded_managers = 0 WHERE id = ?'
    ).run(dueAt, note, lead.owner_id, open.id);
    audit(user, 'followup.reschedule', 'followup', open.id, { due_at: [open.due_at, dueAt], note: note || undefined }, lead.id);
    return open.id;
  }
  const r = db.prepare(
    'INSERT INTO followups (lead_id, due_at, note, assigned_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(lead.id, dueAt, note, lead.owner_id, user.id, now());
  const id = Number(r.lastInsertRowid);
  audit(user, 'followup.schedule', 'followup', id, { due_at: dueAt, note: note || undefined }, lead.id);
  return id;
}

function closeFollowup(user, leadId, status) {
  const open = db.prepare("SELECT * FROM followups WHERE lead_id = ? AND status = 'open'").get(leadId);
  if (!open) return false;
  db.prepare('UPDATE followups SET status = ?, closed_at = ?, closed_by = ? WHERE id = ?').run(status, now(), user.id, open.id);
  audit(user, status === 'done' ? 'followup.complete' : 'followup.cancel', 'followup', open.id, { due_at: open.due_at }, leadId);
  return true;
}

const touch = (user, id) => db.prepare('UPDATE leads SET updated_by = ?, updated_at = ? WHERE id = ?').run(user.id, now(), id);

export function registerLeadRoutes(app) {
  // ---------- list ----------
  app.get('/api/leads', requireAuth, (req, res) => {
    const sc = leadScope(req.user);
    const where = [sc.sql];
    const params = [...sc.params];
    const q = req.query;
    const { start, end, weekEnd } = dayBounds(tz());
    const t = now();

    if (typeof q.q === 'string' && q.q.trim()) {
      const like = `%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(l.name LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\' OR l.phone LIKE ? ESCAPE '\\' OR l.email LIKE ? ESCAPE '\\' OR l.notes LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    if (q.status) {
      const list = String(q.status).split(',');
      if (!list.every((s) => STATUSES.includes(s))) throw new ValidationError({ status: 'invalid' });
      where.push(`l.status IN (${list.map(() => '?').join(',')})`); params.push(...list);
    } else if (q.open === '1') {
      where.push("l.status NOT IN ('won','lost')");
    }
    if (q.owner) {
      if (q.owner === 'none') where.push('l.owner_id IS NULL');
      else if (q.owner === 'me') { where.push('l.owner_id = ?'); params.push(req.user.id); }
      else { where.push('l.owner_id = ?'); params.push(Number(q.owner) || 0); }
    }
    if (q.channel) { where.push('l.channel_id = ?'); params.push(Number(q.channel) || 0); }
    switch (q.followup) {
      case 'overdue': where.push('f.due_at < ?'); params.push(t); break;
      case 'today': where.push('f.due_at >= ? AND f.due_at < ?'); params.push(t, end); break;
      case 'week': where.push('f.due_at >= ? AND f.due_at < ?'); params.push(start, weekEnd); break;
      case 'scheduled': where.push('f.id IS NOT NULL'); break;
      case 'none': where.push('f.id IS NULL'); break;
      case undefined: case '': break;
      default: throw new ValidationError({ followup: 'invalid' });
    }

    const SORTS = {
      updated: 'l.updated_at', created: 'l.created_at', name: 'l.name COLLATE NOCASE',
      followup: '(f.due_at IS NULL), f.due_at', status: "CASE l.status WHEN 'new' THEN 1 WHEN 'attempted' THEN 2 WHEN 'interested' THEN 3 WHEN 'follow_up' THEN 4 WHEN 'won' THEN 5 ELSE 6 END",
    };
    const orderBy = SORTS[q.sort] || SORTS.updated;
    const dir = q.dir === 'asc' ? 'ASC' : (q.dir === 'desc' ? 'DESC' : (q.sort === 'followup' || q.sort === 'name' ? 'ASC' : 'DESC'));
    const limit = 50;
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const whereSql = where.join(' AND ');

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM leads l LEFT JOIN followups f ON f.lead_id = l.id AND f.status = 'open' WHERE ${whereSql}`
    ).get(...params).n;
    const items = db.prepare(`${LEAD_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} ${dir}, l.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit).map(shape);
    res.json({ items, total, page, limit, now: t });
  });

  app.get('/api/leads/counts', requireAuth, (req, res) => {
    const sc = leadScope(req.user);
    const { end } = dayBounds(tz());
    const t = now();
    const base = `FROM leads l LEFT JOIN followups f ON f.lead_id = l.id AND f.status = 'open' WHERE ${sc.sql}`;
    const n = (extra, ...p) => db.prepare(`SELECT COUNT(*) AS n ${base} ${extra}`).get(...sc.params, ...p).n;
    res.json({
      all: n(''),
      mine: n('AND l.owner_id = ?', req.user.id),
      today: n('AND f.due_at >= ? AND f.due_at < ?', t, end),
      overdue: n('AND f.due_at < ?', t),
    });
  });

  app.get('/api/leads/duplicates', requireAuth, (req, res) => {
    const d = parse(req.query, { phone: { type: 'phone' }, email: { type: 'email' }, exclude: { type: 'id' } });
    res.json({ matches: findDuplicates(req.user, d, d.exclude || 0) });
  });

  // ---------- create ----------
  app.post('/api/leads', requirePerm('leads.create'), (req, res) => {
    const d = parse(req.body, leadSpec);
    d.status ??= 'new';
    checkChannel(d);
    if (d.owner_id && d.owner_id !== req.user.id && !can(req.user, 'leads.assign')) throw new HttpError(403, 'forbidden');
    // Default owner: the creator, when they can work on their own leads.
    if (!d.owner_id && !can(req.user, 'leads.assign') && can(req.user, 'leads.edit_own')) d.owner_id = req.user.id;
    checkOwner(d.owner_id);

    if (req.body?.confirm_duplicate !== true) {
      const matches = findDuplicates(req.user, d);
      if (matches.length) throw new HttpError(409, 'duplicate', { matches });
    }

    const id = tx(() => {
      const t = now();
      const r = db.prepare(
        `INSERT INTO leads (name, company, phone, phone_key, email, channel_id, channel_other, owner_id, status, notes, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(d.name, d.company ?? '', d.phone ?? '', phoneKey(d.phone), d.email ?? '', d.channel_id ?? null, d.channel_other ?? '',
            d.owner_id ?? null, d.status, d.notes ?? '', req.user.id, req.user.id, t, t);
      const newId = Number(r.lastInsertRowid);
      audit(req.user, 'lead.create', 'lead', newId, { name: d.name, status: d.status, owner_id: d.owner_id ?? null }, newId);
      return newId;
    });
    res.status(201).json({ id });
  });

  // ---------- read ----------
  app.get('/api/leads/:id', requireAuth, (req, res) => {
    const lead = loadLead(req);
    const full = shape(db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(lead.id));
    const activities = db.prepare(
      `SELECT a.*, u.name AS created_by_name FROM activities a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.lead_id = ? ORDER BY a.occurred_at DESC, a.id DESC`
    ).all(lead.id);
    res.json({
      lead: full,
      activities,
      can: { edit: canEditLead(req.user, lead), assign: can(req.user, 'leads.assign') && canEditLead(req.user, lead), delete: can(req.user, 'leads.delete') },
    });
  });

  app.get('/api/leads/:id/history', requireAuth, (req, res) => {
    const lead = loadLead(req);
    const items = db.prepare('SELECT * FROM audit_log WHERE lead_id = ? ORDER BY id DESC LIMIT 200').all(lead.id)
      .map((r) => ({ ...r, details: safeJson(r.details) }));
    res.json({ items });
  });

  // ---------- update ----------
  app.patch('/api/leads/:id', requireAuth, (req, res) => {
    const lead = loadEditableLead(req);
    const d = parse(req.body, leadSpec, { partial: true });
    if ('status' in d && !d.status) delete d.status;
    if ('name' in d && !d.name) throw new ValidationError({ name: 'required' });
    if ('owner_id' in d && (d.owner_id ?? null) !== lead.owner_id) {
      if (!can(req.user, 'leads.assign')) throw new HttpError(403, 'forbidden');
      checkOwner(d.owner_id);
    } else {
      delete d.owner_id;
    }
    if ('channel_id' in d || 'channel_other' in d) checkChannel(d, lead);

    if (('phone' in d || 'email' in d) && req.body?.confirm_duplicate !== true) {
      const matches = findDuplicates(req.user, { phone: d.phone ?? lead.phone, email: d.email ?? lead.email }, lead.id)
        .filter((m) => ('phone' in d && d.phone !== lead.phone && m.match === 'phone') || ('email' in d && d.email !== lead.email && m.match === 'email'));
      if (matches.length) throw new HttpError(409, 'duplicate', { matches });
    }

    const changes = {};
    for (const [k, v] of Object.entries(d)) {
      const next = v ?? (typeof lead[k] === 'string' ? '' : null);
      if (next !== lead[k]) changes[k] = [lead[k], next];
    }
    if (!Object.keys(changes).length) return res.json({ ok: true, changed: 0 });

    tx(() => {
      const sets = Object.keys(changes).map((k) => `${k} = ?`);
      const vals = Object.values(changes).map(([, n]) => n);
      if (changes.phone) { sets.push('phone_key = ?'); vals.push(phoneKey(changes.phone[1])); }
      db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...vals, req.user.id, now(), lead.id);
      if (changes.owner_id) db.prepare("UPDATE followups SET assigned_to = ? WHERE lead_id = ? AND status = 'open'").run(changes.owner_id[1], lead.id);
      if (changes.status && CLOSED_STATUSES.includes(changes.status[1])) closeFollowup(req.user, lead.id, 'canceled');
      audit(req.user, changes.owner_id && Object.keys(changes).length === 1 ? 'lead.assign' : 'lead.update', 'lead', lead.id, changes, lead.id);
    });
    res.json({ ok: true, changed: Object.keys(changes).length });
  });

  app.delete('/api/leads/:id', requirePerm('leads.delete'), (req, res) => {
    const lead = loadLead(req);
    tx(() => {
      db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
      audit(req.user, 'lead.delete', 'lead', lead.id, { name: lead.name, company: lead.company }, null);
    });
    res.json({ ok: true });
  });

  // ---------- activities (calls, messages, meetings…) ----------
  app.post('/api/leads/:id/activities', requireAuth, (req, res) => {
    const lead = loadEditableLead(req);
    const d = parse(req.body, {
      type: { type: 'enum', values: ACTIVITY_TYPES, required: true },
      outcome: { type: 'enum', values: OUTCOMES, required: true },
      note: { type: 'text', max: 2000 },
      status: { type: 'enum', values: STATUSES },
      next_note: { type: 'text', max: 300 },
    });
    const occurredAt = parseWhen(req.body, 'date', 'time') ?? now();
    if (occurredAt > now() + 5 * 60_000) throw new ValidationError({ date: 'invalid' });
    const nextAt = parseWhen(req.body, 'next_date', 'next_time');
    const newStatus = d.status || lead.status;
    if (nextAt && CLOSED_STATUSES.includes(newStatus)) throw new ValidationError({ next_date: 'invalid' });

    const id = tx(() => {
      const r = db.prepare(
        'INSERT INTO activities (lead_id, type, outcome, note, occurred_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(lead.id, d.type, d.outcome, d.note ?? '', occurredAt, req.user.id, now());
      const actId = Number(r.lastInsertRowid);
      const details = { type: d.type, outcome: d.outcome };
      if (newStatus !== lead.status) {
        db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(newStatus, lead.id);
        details.status = [lead.status, newStatus];
      }
      audit(req.user, 'activity.create', 'activity', actId, details, lead.id);
      if (CLOSED_STATUSES.includes(newStatus)) closeFollowup(req.user, lead.id, 'canceled');
      else if (nextAt) scheduleFollowup(req.user, lead, nextAt, d.next_note ?? '');
      else if (req.body?.complete_followup === true) closeFollowup(req.user, lead.id, 'done');
      touch(req.user, lead.id);
      return actId;
    });
    res.status(201).json({ id });
  });

  // ---------- follow-ups ----------
  app.put('/api/leads/:id/followup', requireAuth, (req, res) => {
    const lead = loadEditableLead(req);
    if (CLOSED_STATUSES.includes(lead.status)) throw new ValidationError({ date: 'invalid' });
    const dueAt = parseWhen(req.body, 'date', 'time', { required: true });
    const { note } = parse(req.body, { note: { type: 'text', max: 300 } });
    const id = tx(() => { const fid = scheduleFollowup(req.user, lead, dueAt, note ?? ''); touch(req.user, lead.id); return fid; });
    res.json({ id, due_at: dueAt });
  });

  app.post('/api/leads/:id/followup/complete', requireAuth, (req, res) => {
    const lead = loadEditableLead(req);
    const ok = tx(() => { const r = closeFollowup(req.user, lead.id, 'done'); if (r) touch(req.user, lead.id); return r; });
    if (!ok) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  app.delete('/api/leads/:id/followup', requireAuth, (req, res) => {
    const lead = loadEditableLead(req);
    const ok = tx(() => { const r = closeFollowup(req.user, lead.id, 'canceled'); if (r) touch(req.user, lead.id); return r; });
    if (!ok) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
