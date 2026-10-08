// Follow-up reminders. Runs inside the server every minute: creates in-app notifications
// (always) and sends email copies when SMTP is configured and the user has email notifications on.
import { db, getSetting } from './db.js';
import { capabilities, send } from './delivery.js';
import { reminderMessage } from './messages.js';

function notify(userId, kind, fu, extra = {}) {
  const r = db.prepare(
    'INSERT INTO notifications (user_id, kind, lead_id, followup_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, kind, fu.lead_id, fu.id, JSON.stringify({ due_at: fu.due_at, note: fu.note, ...extra }), Date.now());
  return Number(r.lastInsertRowid);
}

/** One pass over open follow-ups. Returns the notifications created (used by tests). */
export function runReminders(now = Date.now()) {
  const before = Number(getSetting('remind_before_minutes') || 0) * 60_000;
  const mgrHours = Number(getSetting('manager_overdue_hours') || 0);
  const created = [];
  const managers = db.prepare("SELECT id FROM users WHERE role = 'manager' AND active = 1").all().map((u) => u.id);

  const open = db.prepare(
    `SELECT f.*, l.name AS lead_name, l.status AS lead_status, o.name AS owner_name, o.active AS owner_active
       FROM followups f JOIN leads l ON l.id = f.lead_id LEFT JOIN users o ON o.id = f.assigned_to
      WHERE f.status = 'open' AND l.status NOT IN ('won','lost')
        AND (f.reminded_due = 0 OR f.reminded_managers = 0) AND f.due_at <= ?`
  ).all(now + Math.max(before, 0));

  for (const fu of open) {
    const owner = fu.assigned_to && fu.owner_active ? fu.assigned_to : null;
    const ownerTargets = owner ? [owner] : managers; // unassigned follow-ups go to managers

    if (fu.due_at > now) {
      if (before > 0 && !fu.reminded_upcoming) {
        for (const uid of ownerTargets) created.push({ id: notify(uid, 'followup_upcoming', fu), user_id: uid, kind: 'followup_upcoming' });
        db.prepare('UPDATE followups SET reminded_upcoming = 1 WHERE id = ?').run(fu.id);
      }
      continue;
    }

    if (!fu.reminded_due) {
      for (const uid of ownerTargets) created.push({ id: notify(uid, 'followup_due', fu), user_id: uid, kind: 'followup_due' });
      db.prepare('UPDATE followups SET reminded_due = 1, reminded_upcoming = 1 WHERE id = ?').run(fu.id);
    }

    if (mgrHours > 0 && !fu.reminded_managers && fu.due_at <= now - mgrHours * 3600_000) {
      for (const uid of managers) {
        if (uid === owner) continue;
        created.push({ id: notify(uid, 'followup_overdue_manager', fu, { owner_name: fu.owner_name }), user_id: uid, kind: 'followup_overdue_manager' });
      }
      db.prepare('UPDATE followups SET reminded_managers = 1 WHERE id = ?').run(fu.id);
    } else if (mgrHours <= 0 && !fu.reminded_managers) {
      db.prepare('UPDATE followups SET reminded_managers = 1 WHERE id = ?').run(fu.id);
    }
  }
  return created;
}

/** Email copies of unsent notifications (only when email delivery is available). */
export async function emailPending() {
  if (!capabilities().email) return 0;
  const tz = getSetting('timezone');
  const rows = db.prepare(
    `SELECT n.*, u.email, u.language, u.email_notifications, l.name AS lead_name
       FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN leads l ON l.id = n.lead_id
      WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND n.created_at > ? LIMIT 50`
  ).all(Date.now() - 6 * 3600_000);
  let sent = 0;
  for (const n of rows) {
    db.prepare('UPDATE notifications SET emailed_at = ? WHERE id = ?').run(Date.now(), n.id); // mark first: never double-send
    if (!n.email || !n.email_notifications || !n.lead_id) continue;
    let data = {};
    try { data = JSON.parse(n.data); } catch { /* ignore */ }
    const m = reminderMessage({
      kind: n.kind, leadName: n.lead_name, note: data.note, dueAt: data.due_at, tz, lang: n.language, leadId: n.lead_id, ownerName: data.owner_name,
    });
    const r = await send({ channel: 'email', to: n.email, subject: m.subject, text: m.text, html: m.html });
    if (r.ok) sent += 1;
  }
  return sent;
}

export function startScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      runReminders();
      await emailPending();
    } catch (e) {
      console.error('Reminder job failed:', e);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, 60_000);
}
