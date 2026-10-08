import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.APP_TIMEZONE = 'Africa/Tripoli';

const { db } = await import('../server/db.js');
const { setTestSink } = await import('../server/delivery.js');
const { createApp } = await import('../server/app.js');
const { createInvitation } = await import('../server/routes/invitations.js');
const { ALL_PERMISSIONS } = await import('../server/permissions.js');
const { runReminders } = await import('../server/scheduler.js');

const outbox = [];
setTestSink((m) => outbox.push(m));
const lastTo = (to) => [...outbox].reverse().find((m) => m.to === to);
const otpFor = (to) => lastTo(to)?.text.match(/\b(\d{6})\b/)?.[1];

const PW = 'correct-horse-battery';
let server, base;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(cookie && { cookie }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  return call;
}

/** Accept an invitation end to end (link token → name/password → code → account). */
async function join(token, name, contact) {
  const c = client();
  assert.equal((await c('POST', '/api/invitations/lookup', { token })).status, 200);
  const acc = await c('POST', '/api/invitations/accept', { token, name, password: PW, language: 'en' });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const otp = otpFor(contact);
  assert.ok(otp, 'verification code was sent');
  const v = await c('POST', '/api/invitations/verify', { token, otp });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return c;
}

const tokenOf = (link) => link.split('/invite/')[1];
let mgr, rep, rep2, viewer;
const ids = {};

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('database starts empty: no users, no leads; only built-in channels and settings', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  const keys = db.prepare('SELECT key FROM channels').all().map((r) => r.key);
  for (const k of ['instagram', 'facebook', 'whatsapp', 'phone', 'email', 'website', 'referral', 'ads', 'other']) assert.ok(keys.includes(k), k);
});

test('there is no open registration and nothing works without a session', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/register', { email: 'x@t.test' })).status, 404);
  assert.equal((await c('POST', '/api/users', { email: 'x@t.test' })).status, 404);
  assert.equal((await c('GET', '/api/leads')).status, 401);
  assert.equal((await c('POST', '/api/invitations', { email: 'x@t.test', role: 'manager' })).status, 401);
  assert.equal((await c('POST', '/api/invitations/lookup', { token: 'x'.repeat(43) })).status, 404);
});

test('first manager joins through the one-time invitation and verifies email', async () => {
  const inv = createInvitation({ inviter: null, email: 'boss@t.test', role: 'manager', permissions: ALL_PERMISSIONS, verifyVia: 'email', bootstrap: true });
  const c = client();
  // cannot sign in before accepting
  assert.equal((await c('POST', '/api/login', { identifier: 'boss@t.test', password: PW })).status, 401);
  // wrong code is rejected and no account exists yet
  await c('POST', '/api/invitations/accept', { code: inv.code.toLowerCase(), name: 'Boss', password: PW });
  assert.equal((await c('POST', '/api/invitations/verify', { code: inv.code, otp: '000000' })).status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  // right code creates the account and signs in
  const v = await c('POST', '/api/invitations/verify', { code: inv.code, otp: otpFor('boss@t.test') });
  assert.equal(v.status, 200);
  const boot = await c('GET', '/api/bootstrap');
  assert.equal(boot.json.me.role, 'manager');
  assert.ok(boot.json.me.perms.includes('team.manage'));
  // the invitation cannot be reused
  assert.equal((await client()('POST', '/api/invitations/lookup', { code: inv.code })).status, 410);
  mgr = c;
});

test('code verification locks after 5 wrong attempts', async () => {
  const r = await mgr('POST', '/api/invitations', { email: 'locked@t.test', role: 'viewer' });
  const token = tokenOf(r.json.link);
  const c = client();
  await c('POST', '/api/invitations/accept', { token, name: 'L', password: PW });
  for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/invitations/verify', { token, otp: '111111' })).status, 422);
  assert.equal((await c('POST', '/api/invitations/verify', { token, otp: otpFor('locked@t.test') })).json.error, 'otp_locked');
  ids.lockedInvite = r.json.invitation.id;
});

test('manager invites with role + permissions chosen before joining; they apply on acceptance', async () => {
  const r = await mgr('POST', '/api/invitations', {
    name: 'Omar', email: 'omar@t.test', role: 'sales', permissions: ['leads.create', 'leads.edit_own'], send_via: 'email',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.sent.ok, true);
  assert.match(r.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(lastTo('omar@t.test').text.includes(r.json.code), 'invite email contains the code');
  rep = await join(tokenOf(r.json.link), 'Omar', 'omar@t.test');
  const me = (await rep('GET', '/api/bootstrap')).json.me;
  assert.deepEqual(me.perms.sort(), ['leads.create', 'leads.edit_own']);
  ids.rep = me.id;

  const r2 = await mgr('POST', '/api/invitations', { email: 'dina@t.test', role: 'sales' });
  rep2 = await join(tokenOf(r2.json.link), 'Dina', 'dina@t.test');
  ids.rep2 = (await rep2('GET', '/api/bootstrap')).json.me.id;

  const r3 = await mgr('POST', '/api/invitations', { phone: '+218 91 000 0000', role: 'viewer' });
  assert.equal(r3.status, 201);
  viewer = await join(tokenOf(r3.json.link), 'Vee', '+218910000000');
  ids.viewer = (await viewer('GET', '/api/bootstrap')).json.me.id;
});

test('duplicate contacts, revoke, expiry and resend', async () => {
  assert.equal((await mgr('POST', '/api/invitations', { email: 'omar@t.test', role: 'sales' })).json.fields.email, 'exists');
  const r = await mgr('POST', '/api/invitations', { email: 'temp@t.test', role: 'sales' });
  assert.equal((await mgr('POST', '/api/invitations', { email: 'temp@t.test', role: 'sales' })).json.fields.email, 'invited');

  await mgr('POST', `/api/invitations/${r.json.invitation.id}/revoke`);
  assert.equal((await client()('POST', '/api/invitations/lookup', { token: tokenOf(r.json.link) })).json.error, 'invite_revoked');

  const e = await mgr('POST', '/api/invitations', { email: 'late@t.test', role: 'viewer' });
  db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, e.json.invitation.id);
  assert.equal((await client()('POST', '/api/invitations/lookup', { token: tokenOf(e.json.link) })).json.error, 'invite_expired');
  const list = (await mgr('GET', '/api/invitations')).json.items;
  assert.equal(list.find((i) => i.id === e.json.invitation.id).status, 'expired');
  assert.equal(list.find((i) => i.id === r.json.invitation.id).status, 'revoked');

  const re = await mgr('POST', `/api/invitations/${e.json.invitation.id}/resend`, { send_via: 'email' });
  assert.equal(re.status, 200);
  assert.equal((await client()('POST', '/api/invitations/lookup', { token: tokenOf(e.json.link) })).status, 404, 'old link no longer works');
  assert.equal((await client()('POST', '/api/invitations/lookup', { token: tokenOf(re.json.link) })).status, 200);

  // non-managers cannot see or create invitations
  assert.equal((await rep('GET', '/api/invitations')).status, 403);
  assert.equal((await rep('POST', '/api/invitations', { email: 'x@t.test', role: 'manager' })).status, 403);
});

test('sign-in with email or phone; suspended members are signed out', async () => {
  assert.equal((await client()('POST', '/api/login', { identifier: 'OMAR@t.test', password: PW })).status, 200);
  assert.equal((await client()('POST', '/api/login', { identifier: '091 000 0000', password: PW })).status, 200, 'local phone format works');
  assert.equal((await client()('POST', '/api/login', { identifier: '+218910000000', password: PW })).status, 200);
});

test('leads: creation defaults, permissions, visibility, duplicates', async () => {
  const insta = db.prepare("SELECT id FROM channels WHERE key = 'instagram'").get().id;
  const other = db.prepare("SELECT id FROM channels WHERE key = 'other'").get().id;

  assert.equal((await viewer('POST', '/api/leads', { name: 'X' })).status, 403);
  assert.equal((await rep('POST', '/api/leads', { name: '' })).json.fields.name, 'required');
  assert.equal((await rep('POST', '/api/leads', { name: 'Y', channel_id: other })).json.fields.channel_other, 'required');

  const c = await rep('POST', '/api/leads', { name: 'Lead A', phone: '+218 92 123 4567', channel_id: insta });
  assert.equal(c.status, 201);
  ids.leadA = c.json.id;
  const a = (await rep('GET', `/api/leads/${ids.leadA}`)).json.lead;
  assert.equal(a.owner_id, ids.rep, 'creator owns it');
  assert.equal(a.created_by, ids.rep);
  assert.equal(a.status, 'new');
  assert.ok(a.created_at > 0);

  // reps cannot assign to others
  assert.equal((await rep('POST', '/api/leads', { name: 'B', owner_id: ids.rep2 })).status, 403);
  assert.equal((await rep('PATCH', `/api/leads/${ids.leadA}`, { owner_id: ids.rep2 })).status, 403);

  // rep (assigned-only, no view_all) cannot see Dina's lead; duplicate is reported without details
  const d = await mgr('POST', '/api/leads', { name: 'Lead D', phone: '0921234999', email: 'd@x.test', owner_id: ids.rep2 });
  ids.leadD = d.json.id;
  assert.equal((await rep('GET', `/api/leads/${ids.leadD}`)).status, 404);
  const dup = await rep('POST', '/api/leads', { name: 'Again', phone: '00218-92-1234999' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.matches[0].visible, false);
  assert.equal(dup.json.matches[0].name, undefined);
  const dupMgr = await mgr('POST', '/api/leads', { name: 'Again', email: 'D@X.test' });
  assert.equal(dupMgr.json.matches[0].id, ids.leadD);
  assert.equal((await mgr('POST', '/api/leads', { name: 'Again', email: 'D@X.test', confirm_duplicate: true })).status, 201);

  // list scope
  assert.equal((await rep('GET', '/api/leads')).json.total, 1);
  assert.ok((await mgr('GET', '/api/leads')).json.total >= 3);
  // viewer (default access = all) can read but not edit
  assert.equal((await viewer('GET', `/api/leads/${ids.leadA}`)).status, 200);
  assert.equal((await viewer('PATCH', `/api/leads/${ids.leadA}`, { notes: 'x' })).status, 403);
  // Dina sees all but cannot edit Omar's lead
  assert.equal((await rep2('GET', `/api/leads/${ids.leadA}`)).status, 200);
  assert.equal((await rep2('PATCH', `/api/leads/${ids.leadA}`, { notes: 'x' })).status, 403);

  // manager grants edit_all → now allowed; change is audited
  const u = await mgr('PATCH', `/api/users/${ids.rep2}`, { permissions: ['leads.view_all', 'leads.create', 'leads.edit_own', 'leads.edit_all'] });
  assert.equal(u.status, 200);
  assert.equal((await rep2('PATCH', `/api/leads/${ids.leadA}`, { notes: 'edited by Dina' })).status, 200);
  const audit = (await mgr('GET', '/api/audit?group=team')).json.items;
  const permChange = audit.find((x) => x.action === 'user.permissions' && x.entity_id === ids.rep2);
  assert.ok(permChange?.details.permissions, 'permission change recorded with before/after');

  // viewers cannot own leads
  assert.equal((await mgr('PATCH', `/api/leads/${ids.leadA}`, { owner_id: ids.viewer })).json.fields.owner_id, 'invalid');
});

test('activities and follow-ups use the system time zone; reminders notify owner and managers', async () => {
  const log = await rep('POST', `/api/leads/${ids.leadA}/activities`, {
    type: 'call', outcome: 'positive', note: 'Wants a quote', status: 'interested',
    next_date: '2030-01-15', next_time: '10:00', next_note: 'Send quote',
  });
  assert.equal(log.status, 201, JSON.stringify(log.json));
  let lead = (await rep('GET', `/api/leads/${ids.leadA}`)).json;
  assert.equal(lead.lead.status, 'interested');
  assert.equal(lead.lead.followup.due_at, Date.UTC(2030, 0, 15, 8, 0), '10:00 in Tripoli (UTC+2) = 08:00 UTC');
  assert.equal(lead.activities.length, 1);

  // make it overdue by 25 hours → owner gets "due", managers get "overdue"
  db.prepare("UPDATE followups SET due_at = ? WHERE lead_id = ? AND status = 'open'").run(Date.now() - 25 * 3600_000, ids.leadA);
  const created = runReminders();
  assert.ok(created.some((n) => n.user_id === ids.rep && n.kind === 'followup_due'));
  const mgrId = (await mgr('GET', '/api/bootstrap')).json.me.id;
  assert.ok(created.some((n) => n.user_id === mgrId && n.kind === 'followup_overdue_manager'));
  assert.equal(runReminders().length, 0, 'no duplicate reminders');

  const counts = (await rep('GET', '/api/leads/counts')).json;
  assert.equal(counts.overdue, 1);
  assert.equal((await rep('GET', '/api/leads?followup=overdue')).json.total, 1);
  const notes = (await rep('GET', '/api/notifications')).json;
  assert.equal(notes.unread, 1);
  await rep('POST', '/api/notifications/read', { ids: 'all' });
  assert.equal((await rep('GET', '/api/notifications/unread')).json.unread, 0);

  // reschedule, then complete
  assert.equal((await rep('PUT', `/api/leads/${ids.leadA}/followup`, { date: '2031-02-01', time: '09:30', note: 'Call back' })).status, 200);
  assert.equal((await rep('POST', `/api/leads/${ids.leadA}/followup/complete`)).status, 200);
  lead = (await rep('GET', `/api/leads/${ids.leadA}`)).json;
  assert.equal(lead.lead.followup, null);

  // upcoming reminder: due in 30 min with 60-min window
  await rep('PUT', `/api/leads/${ids.leadA}/followup`, { date: '2031-03-01', time: '09:00' });
  db.prepare("UPDATE followups SET due_at = ? WHERE lead_id = ? AND status = 'open'").run(Date.now() + 30 * 60_000, ids.leadA);
  assert.ok(runReminders().some((n) => n.kind === 'followup_upcoming' && n.user_id === ids.rep));

  // closing the lead cancels its follow-up
  await rep('PATCH', `/api/leads/${ids.leadA}`, { status: 'won' });
  assert.equal((await rep('GET', `/api/leads/${ids.leadA}`)).json.lead.followup, null);
});

test('lead history shows who changed what', async () => {
  const h = (await mgr('GET', `/api/leads/${ids.leadA}/history`)).json.items.map((x) => x.action);
  for (const a of ['lead.create', 'lead.update', 'activity.create', 'followup.schedule', 'followup.reschedule', 'followup.complete', 'followup.cancel']) {
    assert.ok(h.includes(a), a);
  }
});

test('managers cannot lock themselves out; suspension ends sessions', async () => {
  const mgrId = (await mgr('GET', '/api/bootstrap')).json.me.id;
  assert.equal((await mgr('PATCH', `/api/users/${mgrId}`, { role: 'sales' })).json.error, 'cannot_demote_self');
  assert.equal((await mgr('PATCH', `/api/users/${ids.viewer}`, { active: false })).status, 200);
  assert.equal((await viewer('GET', '/api/bootstrap')).status, 401);
  assert.equal((await client()('POST', '/api/login', { identifier: '+218910000000', password: PW })).status, 401);
});

test('channels: built-ins editable by managers only; new channel can be added', async () => {
  assert.equal((await rep('POST', '/api/channels', { name_ar: 'تيك توك', name_en: 'TikTok' })).status, 403);
  const c = await mgr('POST', '/api/channels', { name_ar: 'تيك توك', name_en: 'TikTok' });
  assert.equal(c.status, 201);
  assert.equal((await mgr('PATCH', `/api/channels/${c.json.id}`, { active: false })).status, 200);
  assert.equal((await rep('POST', '/api/leads', { name: 'Z', channel_id: c.json.id })).json.fields.channel_id, 'invalid');
});

test('settings: time zone validated; manager-only', async () => {
  assert.equal((await rep('PUT', '/api/settings', { timezone: 'UTC' })).status, 403);
  assert.equal((await mgr('PUT', '/api/settings', { timezone: 'Mars/Base' })).json.fields.timezone, 'invalid');
  assert.equal((await mgr('PUT', '/api/settings', { timezone: 'Africa/Tripoli', remind_before_minutes: 30 })).status, 200);
});
