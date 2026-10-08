// Bilingual texts for outbound email / SMS / WhatsApp share messages.
import { formatDateTime } from './time.js';

const appName = () => process.env.APP_NAME || 'Sales';
export const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
export const inviteLink = (token) => `${appUrl()}/#/invite/${token}`;

const ROLE = {
  ar: { manager: 'مدير', sales: 'مسؤول مبيعات', viewer: 'مشاهد' },
  en: { manager: 'Manager', sales: 'Sales representative', viewer: 'Viewer' },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function html(lang, paragraphs, button) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><body style="margin:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Tahoma,sans-serif;color:#111">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e5e5">
<p style="font-weight:700;font-size:16px;margin:0 0 16px">${esc(appName())}</p>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${p}</p>`).join('')}
${button ? `<p style="margin:20px 0"><a href="${esc(button.href)}" style="background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(button.label)}</a></p>` : ''}
</div></body></html>`;
}

/** Invitation text (both languages so the invitee can read it whatever their preference). */
export function invitationMessage({ inviterName, role, token, code, expiresAt }) {
  const link = inviteLink(token);
  const days = Math.max(1, Math.round((expiresAt - Date.now()) / 86400000));
  const ar = `دعاك ${inviterName} للانضمام إلى ${appName()} بدور «${ROLE.ar[role]}». افتح الرابط لإنشاء حسابك: ${link} — أو استخدم كود الدعوة: ${code}. الدعوة صالحة ${days} أيام.`;
  const en = `${inviterName} invited you to join ${appName()} as ${ROLE.en[role]}. Open this link to create your account: ${link} — or use invitation code ${code}. The invitation is valid for ${days} days.`;
  return {
    subject: `${appName()} — دعوة للانضمام · Invitation`,
    text: `${ar}\n\n${en}`,
    html: html('ar', [esc(ar), `<span dir="ltr" style="display:block;text-align:left">${esc(en)}</span>`], { href: link, label: 'قبول الدعوة · Accept invitation' }),
    share: `${ar}\n\n${en}`,
  };
}

export function verificationMessage({ code, lang }) {
  const t = lang === 'en'
    ? `Your ${appName()} verification code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this message.`
    : `كود التحقق الخاص بك في ${appName()} هو ${code}. صالح لمدة 10 دقائق. إذا لم تطلبه فتجاهل هذه الرسالة.`;
  return { subject: lang === 'en' ? `${appName()} verification code` : `كود التحقق — ${appName()}`, text: t, html: html(lang === 'en' ? 'en' : 'ar', [esc(t)]) };
}

/** Follow-up reminder email for one notification. */
export function reminderMessage({ kind, leadName, note, dueAt, tz, lang, leadId, ownerName }) {
  const when = formatDateTime(dueAt, tz, lang);
  const L = lang === 'en' ? 'en' : 'ar';
  const T = {
    ar: {
      followup_upcoming: `تذكير: متابعة «${leadName}» مستحقة ${when}.`,
      followup_due: `حان موعد متابعة «${leadName}» (${when}).`,
      followup_overdue_manager: `متابعة «${leadName}» متأخرة منذ ${when}${ownerName ? ` — المسؤول: ${ownerName}` : ''}.`,
      open: 'فتح العميل',
    },
    en: {
      followup_upcoming: `Reminder: follow-up with “${leadName}” is due ${when}.`,
      followup_due: `Follow-up with “${leadName}” is due now (${when}).`,
      followup_overdue_manager: `Follow-up with “${leadName}” has been overdue since ${when}${ownerName ? ` — owner: ${ownerName}` : ''}.`,
      open: 'Open lead',
    },
  }[L];
  const line = T[kind];
  const link = `${appUrl()}/#/leads/${leadId}`;
  const parts = [esc(line)];
  if (note) parts.push(`<b>→</b> ${esc(note)}`);
  return {
    subject: line.slice(0, 120),
    text: `${line}${note ? `\n→ ${note}` : ''}\n${link}`,
    html: html(L, parts, { href: link, label: T.open }),
  };
}
