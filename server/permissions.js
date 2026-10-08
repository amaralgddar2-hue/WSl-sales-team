// Roles, permission keys and lead-scope helpers. Enforced server-side on every route.

export const ROLES = ['manager', 'sales', 'viewer'];

/** Permissions a manager can grant or remove per employee. */
export const GRANTABLE = [
  'leads.view_all',   // see every lead (otherwise only leads assigned to them)
  'leads.create',
  'leads.edit_own',   // edit leads assigned to them + log activities / follow-ups on them
  'leads.edit_all',   // edit any lead they can see
  'leads.assign',     // change a lead's owner
  'leads.delete',
  'channels.manage',
  'audit.view',
];

/** Manager-only capabilities (never grantable, so a non-manager can never take over the team). */
export const MANAGER_ONLY = ['team.manage', 'settings.manage'];
export const ALL_PERMISSIONS = [...GRANTABLE, ...MANAGER_ONLY];

/** Default permissions per role. `leads.view_all` for reps/viewers follows the team default setting. */
export function roleDefaults(role, defaultLeadAccess = 'all') {
  const viewAll = defaultLeadAccess === 'all' ? ['leads.view_all'] : [];
  switch (role) {
    case 'manager': return [...ALL_PERMISSIONS];
    case 'sales': return [...viewAll, 'leads.create', 'leads.edit_own'];
    case 'viewer': return [...viewAll];
    default: return [];
  }
}

/** Sanitise a requested permission list for a role. Managers always get everything. */
export function normalizePermissions(role, perms) {
  if (role === 'manager') return [...ALL_PERMISSIONS];
  const set = new Set(Array.isArray(perms) ? perms.filter((p) => GRANTABLE.includes(p)) : []);
  if (set.has('leads.edit_all')) set.add('leads.edit_own');
  return GRANTABLE.filter((p) => set.has(p));
}

export function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === 'manager') return [...ALL_PERMISSIONS];
  try { return normalizePermissions(user.role, JSON.parse(user.permissions || '[]')); } catch { return []; }
}

export const can = (user, perm) => !!user && user.perms.includes(perm);

/** SQL fragment restricting visible leads (table alias `l`). */
export function leadScope(user) {
  if (can(user, 'leads.view_all')) return { sql: '1 = 1', params: [] };
  return { sql: 'l.owner_id = ?', params: [user.id] };
}

export const canSeeLead = (user, lead) => can(user, 'leads.view_all') || lead.owner_id === user.id;

export const canEditLead = (user, lead) =>
  canSeeLead(user, lead) && (can(user, 'leads.edit_all') || (can(user, 'leads.edit_own') && lead.owner_id === user.id));
