import { db, DB_FILE, tx, audit } from './db.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { capabilities } from './delivery.js';
import { createInvitation } from './routes/invitations.js';
import { ALL_PERMISSIONS } from './permissions.js';
import { inviteLink } from './messages.js';
import { EMAIL_RE, normalizePhone } from './validate.js';

/**
 * First run: there are no accounts and no public sign-up, so the server creates a one-time
 * manager invitation and prints it here (only the person running the server sees it).
 * Re-generated on each start until it is accepted.
 */
function bootstrapManagerInvite() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const phone = normalizePhone(process.env.ADMIN_PHONE || '') || '';
  if (!EMAIL_RE.test(email) && !phone) {
    console.log('\n  No accounts yet. Set ADMIN_EMAIL (or ADMIN_PHONE) in .env and restart to get the first manager invitation.\n');
    return;
  }
  const verifyVia = EMAIL_RE.test(email) ? 'email' : 'sms';
  const c = tx(() => {
    db.prepare("UPDATE invitations SET status = 'revoked', revoked_at = ? WHERE is_bootstrap = 1 AND status = 'pending'").run(Date.now());
    const created = createInvitation({
      inviter: null, name: process.env.ADMIN_NAME || '', email: verifyVia === 'email' ? email : null, phone: phone || null,
      role: 'manager', permissions: ALL_PERMISSIONS, verifyVia, bootstrap: true,
    });
    audit(null, 'invitation.create', 'invitation', created.id, { role: 'manager', bootstrap: true });
    return created;
  });
  const caps = capabilities();
  console.log('\n  ┌─ First manager account ───────────────────────────────────────────');
  console.log(`  │ Open:  ${inviteLink(c.token)}`);
  console.log(`  │ or enter invitation code ${c.code} on the sign-in page.`);
  console.log(`  │ The verification code will be sent to ${verifyVia === 'email' ? email : phone}${caps[verifyVia] ? '' : ' — delivery is not configured, so it will be printed here instead'}.`);
  console.log('  └────────────────────────────────────────────────────────────────────\n');
}

bootstrapManagerInvite();

const caps = capabilities();
if (caps.mode === 'console') console.log('  DEV_DELIVERY=console: emails/SMS are printed in this terminal, not sent.');
else {
  if (!caps.email) console.log('  Email (SMTP) is not configured: invitations by email, email verification and email reminders are disabled.');
  if (!caps.sms) console.log('  SMS (Twilio) is not configured: phone verification by SMS is disabled.');
}

startScheduler();

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
createApp().listen(port, host, () => {
  console.log(`  Sales CRM running at http://${host}:${port}  (db: ${DB_FILE})\n`);
});
