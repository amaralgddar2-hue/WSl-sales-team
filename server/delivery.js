// Outbound messages: email via SMTP (nodemailer) and SMS via Twilio's REST API.
// Nothing is hard-coded: every credential comes from environment variables (see .env.example).
import nodemailer from 'nodemailer';

const env = process.env;
const PRODUCTION = env.NODE_ENV === 'production';
const CONSOLE_MODE = env.DEV_DELIVERY === 'console' && !PRODUCTION;
if (env.DEV_DELIVERY === 'console' && PRODUCTION) {
  console.warn('DEV_DELIVERY=console is ignored when NODE_ENV=production.');
}

const smtpConfigured = !!(env.SMTP_HOST && env.SMTP_FROM);
const twilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);

let transporter = null;
if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

let testSink = null;
/** Tests capture outgoing messages instead of sending them. */
export const setTestSink = (fn) => { testSink = fn; };

export function capabilities() {
  if (testSink) return { email: true, sms: true, mode: 'test' };
  if (CONSOLE_MODE) return { email: true, sms: true, mode: 'console' };
  return { email: smtpConfigured, sms: twilioConfigured, mode: 'live' };
}

function printToConsole(msg) {
  console.log(`\n──── [${msg.channel.toUpperCase()} → ${msg.to}] ${msg.subject || ''}\n${msg.text}\n────\n`);
}

/**
 * Send a message. `forceConsole` is only used for the first-run manager invitation,
 * whose details are meant for whoever runs the server.
 */
export async function send(msg, { forceConsole = false } = {}) {
  if (testSink) { testSink(msg); return { ok: true }; }
  const caps = capabilities();
  if (forceConsole && !caps[msg.channel]) { printToConsole(msg); return { ok: true, console: true }; }
  if (caps.mode === 'console') { printToConsole(msg); return { ok: true, console: true }; }

  if (msg.channel === 'email') {
    if (!smtpConfigured) return { ok: false, error: 'email_not_configured' };
    try {
      await transporter.sendMail({ from: env.SMTP_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { ok: true };
    } catch (e) {
      console.error('Email delivery failed:', e.message);
      return { ok: false, error: 'delivery_failed' };
    }
  }

  if (msg.channel === 'sms') {
    if (!twilioConfigured) return { ok: false, error: 'sms_not_configured' };
    const from = env.TWILIO_SMS_FROM;
    const form = new URLSearchParams({ To: msg.to, Body: msg.text });
    form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      if (!r.ok) {
        console.error('SMS delivery failed:', r.status, (await r.text()).slice(0, 300));
        return { ok: false, error: 'delivery_failed' };
      }
      return { ok: true };
    } catch (e) {
      console.error('SMS delivery failed:', e.message);
      return { ok: false, error: 'delivery_failed' };
    }
  }
  return { ok: false, error: 'delivery_failed' };
}
