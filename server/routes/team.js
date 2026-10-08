// Team members: list, change role / permissions, suspend. Manager only.
import { db, tx, audit } from '../db.js';
import { requirePerm, destroyUserSessions } from '../auth.js';
import { ROLES, normalizePermissions, effectivePermissions } from '../permissions.js';
import { parse, HttpError } from '../validate.js';

export function registerTeamRoutes(app) {
  app.get('/api/users', requirePerm('team.manage'), (_req, res) => {
    const rows = db.prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.permissions, u.active, u.created_at, u.last_login_at, u.invited_by,
              ib.name AS invited_by_name,
              (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.status NOT IN ('won','lost')) AS open_leads,
              (SELECT a.user_name FROM audit_log a WHERE a.entity = 'user' AND a.entity_id = u.id AND a.action = 'user.permissions' ORDER BY a.id DESC LIMIT 1) AS perms_changed_by,
              (SELECT a.created_at FROM audit_log a WHERE a.entity = 'user' AND a.entity_id = u.id AND a.action = 'user.permissions' ORDER BY a.id DESC LIMIT 1) AS perms_changed_at
         FROM users u LEFT JOIN users ib ON ib.id = u.invited_by
        ORDER BY u.active DESC, u.name`
    ).all();
    res.json({ users: rows.map(({ permissions, ...u }) => ({ ...u, perms: effectivePermissions({ ...u, permissions }) })) });
  });

  app.patch('/api/users/:id', requirePerm('team.manage'), (req, res) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target) throw new HttpError(404, 'not_found');
    const d = parse(req.body, { role: { type: 'enum', values: ROLES }, active: { type: 'bool' } }, { partial: true });
    const nextRole = d.role ?? target.role;
    const nextActive = 'active' in d && d.active !== null ? (d.active ? 1 : 0) : target.active;

    if (target.id === req.user.id && (nextRole !== 'manager' || !nextActive)) throw new HttpError(409, 'cannot_demote_self');
    if (target.role === 'manager' && target.active && (nextRole !== 'manager' || !nextActive)) {
      const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id != ?").get(target.id).n;
      if (!others) throw new HttpError(409, 'last_manager');
    }

    const beforePerms = effectivePermissions(target);
    const nextPerms = Array.isArray(req.body?.permissions) || d.role
      ? normalizePermissions(nextRole, Array.isArray(req.body?.permissions) ? req.body.permissions : beforePerms)
      : beforePerms;

    const permChanges = {};
    if (nextRole !== target.role) permChanges.role = [target.role, nextRole];
    if (JSON.stringify(nextPerms) !== JSON.stringify(beforePerms)) permChanges.permissions = [beforePerms, nextPerms];

    tx(() => {
      db.prepare('UPDATE users SET role = ?, permissions = ?, active = ? WHERE id = ?').run(nextRole, JSON.stringify(nextPerms), nextActive, target.id);
      if (Object.keys(permChanges).length) audit(req.user, 'user.permissions', 'user', target.id, { name: target.name, ...permChanges });
      if (nextActive !== target.active) {
        audit(req.user, nextActive ? 'user.reactivate' : 'user.suspend', 'user', target.id, { name: target.name });
        if (!nextActive) destroyUserSessions(target.id);
      }
      // A member who can no longer own leads keeps them until reassigned; nothing is deleted.
    });
    res.json({ ok: true });
  });
}
