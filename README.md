# Sales CRM · نظام إدارة المبيعات

Internal website for a sales team: leads, sales channels, communication log, follow-ups with reminders, and invitation-only team access. Fully bilingual (Arabic RTL / English LTR), light and dark, desktop and mobile.

موقع داخلي لفريق المبيعات: العملاء المحتملون، القنوات، سجل التواصل، المتابعات مع التذكيرات، ودخول الفريق بالدعوة فقط. عربي وإنجليزي بالكامل، فاتح وداكن، للكمبيوتر والهاتف.

---

## 1. Run it · التشغيل

Requires **Node.js 22.13+**. No database server or paid service is needed to start.

```bash
npm install
cp .env.example .env      # then set at least ADMIN_EMAIL and APP_URL
npm start                 # http://127.0.0.1:3000
```

**First manager account.** The database starts empty: no leads, no demo accounts, no public sign-up. On first start the server prints a one-time **manager invitation** (link + code) in the terminal for `ADMIN_EMAIL`:

```
┌─ First manager account ─────────────────────────────
│ Open:  http://localhost:3000/#/invite/…
│ or enter invitation code K7QM-2XRP on the sign-in page.
│ The verification code will be sent to you@yourcompany.com…
```

Open it, choose your name and password, enter the 6-digit verification code, and you're in. If email isn't configured yet, that first code is printed in the terminal (only the person running the server sees it). Every other account is created by invitation from inside the app.

**أول مدير:** عند أول تشغيل يطبع الخادم رابط وكود دعوة مدير لبريد `ADMIN_EMAIL`. افتحه، اختر اسمك وكلمة المرور، وأدخل كود التحقق. إذا لم يكن البريد مُعدًّا بعد، يُطبع الكود في الطرفية.

Local testing without email/SMS: add `DEV_DELIVERY=console` to `.env` — invitations and codes are printed in the terminal instead of being sent (refused in production).

Tests: `npm test` (invitations, verification, permissions, visibility, duplicates, time zones, reminders, audit).

---

## 2. External services · الخدمات الخارجية

| Feature | Works without setup | Needs |
|---|---|---|
| In-app notifications (bell) | ✅ | — |
| Invite by **WhatsApp** / copy link or code | ✅ (opens the manager's own WhatsApp with a ready message) | — |
| Invite by **email** + **email verification code** + reminder emails | — | SMTP |
| Invite by **SMS** + **phone verification code** | — | Twilio |

**Why these choices**

- **Invitations:** email is the most reliable, auditable channel and costs nothing with an existing mailbox. WhatsApp is how most teams in the region actually talk, so the manager can share the invitation from their own WhatsApp with one click — no WhatsApp Business API approval, templates or fees. Link + short code always work as a fallback.
- **Verification:** a 6-digit code sent to the invited address proves the person controls that email/phone before the account exists. Codes expire after 10 minutes, are stored hashed, and lock after 5 wrong attempts. Phone codes use SMS via Twilio because the WhatsApp Business API requires approved message templates and business verification; that can be added later on the same delivery interface (`server/delivery.js`).
- **Reminders:** a job inside the server checks open follow-ups every minute. It notifies the owner *before* the follow-up (default 60 min) and *when it's due*, and alerts managers when it stays overdue (default 24 h). Both delays are in **Settings**. Notifications always appear in-app; with SMTP each user can also receive an email copy (toggle in **My account**).

**Email (SMTP)** — any provider. Example with a Google Workspace / Gmail account: enable 2-step verification, create an *App password*, then:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@yourcompany.com
SMTP_PASS=the-16-char-app-password
SMTP_FROM="Sales <you@yourcompany.com>"
```

For volume or better deliverability use a transactional provider (Brevo, Mailgun, SendGrid, Amazon SES…) with its SMTP credentials, and set SPF/DKIM on your domain.

**SMS (Twilio)** — create a Twilio account, buy a number (or a Messaging Service that can send to your country), then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`. Check Twilio's country rules for Libya / your market (sender ID registration may be required).

If a service isn't configured, the related option is shown as unavailable with the reason (never a dead button). **Settings → Connected services** shows the current status.

---

## 3. Roles & permissions · الأدوار والصلاحيات

| Permission | Manager | Sales rep (default) | Viewer (default) |
|---|---|---|---|
| See leads | all | all **or** assigned only* | all **or** assigned only* |
| Add leads | ✅ | ✅ | — |
| Edit own leads, log activities & follow-ups | ✅ | ✅ | — |
| Edit all leads | ✅ | optional | optional |
| Assign leads to others | ✅ | optional | optional |
| Delete leads | ✅ | optional | optional |
| Manage channels | ✅ | optional | optional |
| View activity log | ✅ | optional | optional |
| Invite & manage team, settings | ✅ (manager only) | — | — |

\* Chosen per person when inviting (default comes from **Settings → Default lead access**) and changeable later.

- Managers choose the role **and** can tick individual permissions before sending an invitation; they're applied the moment the invitation is accepted.
- Everything is enforced on the server; the interface only hides what you can't use. Hidden leads return 404.
- Managers can't demote or suspend themselves, and the last active manager can't be removed. Suspending someone ends their sessions immediately.

---

## 4. What's in the app · محتوى الموقع

- **Sign in / invitations** — sign in with email or phone + password. Invitee opens the link (or enters the code on *Have an invitation code?*), sets name + password, verifies with the 6-digit code, then lands on *How to use*. Managers see pending / accepted / expired / revoked invitations and can edit the role, resend (new link + code, old ones stop working) or revoke.
- **Leads dashboard** — views *All / Mine / Due today / Overdue* with counts, search (`/`), filters by status, owner, channel and follow-up date, sorting. Overdue in red, today in amber. Keyboard: `C` new lead.
- **Lead page** — properties (status and owner editable inline), next step with due time, notes, **Activity** (calls, messages, meetings, outcomes) and **History** (every change: who, what, when).
- **Add lead** — only the name is required; creation date, status *New* and creator are automatic. Warns on matching phone (last 9 digits, so `+218 91…` = `091…`) or email, with a link to the existing lead. After saving, a *Next steps* card sets owner + first follow-up.
- **Channels** — Instagram, Facebook, WhatsApp, Phone, Email, Website, Referral, Ads, and *Other* (asks for the channel name). Managers add, rename and disable.
- **How to use** — step-by-step guide in both languages, in the main navigation.
- **Team** — members (role, lead access, open leads, who invited them, last permission change) and invitations.
- **Activity log** — leads, follow-ups, invitations, permission changes, channels and settings.
- **Settings** — system time zone (all dates/times use it), default lead access, reminder timing, connected-services status.
- **My account** — language (remembered per user), email reminders, password.

---

## 5. Technical notes · ملاحظات تقنية

- **Stack:** Node.js + Express 5, SQLite via the built-in `node:sqlite` (single file `data/crm.db`), plain HTML/CSS/JS modules (no build step), `nodemailer` for SMTP, Twilio via its REST API (no SDK).
- **Security:** scrypt password hashes; random session tokens stored hashed, `HttpOnly` + `SameSite=Lax` cookies; custom-header CSRF check on every write; strict Content-Security-Policy; rate limits on sign-in, invitation lookup, code sending and code checks; invitation tokens/codes and verification codes stored only as hashes. No secrets in the code — everything comes from `.env`.
- **Time:** timestamps stored in UTC; follow-up date/time entered and displayed in the system time zone (Settings).
- **Data model:**

```
users(id, name, email?, phone?, password_hash, role, permissions[json], language, email_notifications, active, invited_by→users, created_at, last_login_at)
invitations(id, token_hash, code_hash, name, email?, phone?, role, permissions[json], verify_via, status pending|accepted|revoked, invited_by, expires_at,
            last_sent_at, send_count, accepted_user_id, revoked_by, …pending acceptance + hashed code)
sessions(token_hash, user_id, expires_at)
channels(id, key?, name_ar, name_en, is_other, active, sort)
leads(id, name, company, phone, phone_key, email, channel_id→channels, channel_other, owner_id→users, status, notes, created_by, updated_by, created_at, updated_at)
followups(id, lead_id→leads, due_at, note, assigned_to→users, status open|done|canceled, reminder flags…)   -- one open per lead
activities(id, lead_id→leads, type, outcome, note, occurred_at, created_by)
notifications(id, user_id, kind, lead_id, followup_id, data, created_at, read_at, emailed_at)
audit_log(id, user_id, user_name, action, entity, entity_id, lead_id, details[json], created_at)
settings(key, value)
```

- **Deploy:** run behind HTTPS (Caddy/Nginx), set `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `APP_URL=https://your-domain`. Keep the process running with systemd/pm2. Back up `data/` (e.g. `sqlite3 data/crm.db ".backup backup.db"`).
- **Upgrading from the earlier prototype:** its database format is different (it only held demo data). The server refuses to open it — delete or move `data/crm.db` and start again.

## 6. Not in this version · خارج هذه النسخة

Password reset ("forgot password") — not included yet; it's the recommended next addition. Also not included: WhatsApp Business API delivery, browser push notifications, CSV import/export, and a public lead-capture endpoint for landing pages (planned next).
