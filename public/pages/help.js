// "How to use" guide for new employees, in Arabic and English.
import { getLang, t } from '../i18n.js';
import { state, can, esc, icon, statusIcon } from '../ui.js';

const STATUSES = ['new', 'attempted', 'interested', 'follow_up', 'won', 'lost'];

const GUIDE = {
  ar: {
    title: 'طريقة الاستخدام',
    intro: 'دليل سريع لأهم ما تحتاجه يوميًا. يكفيك قراءته مرة واحدة، وتقدر ترجع له من القائمة الجانبية في أي وقت.',
    sections: [
      { icon: 'plus', title: 'إضافة عميل', steps: [
        'اضغط «عميل جديد» في أعلى القائمة الجانبية، أو اضغط حرف C على لوحة المفاتيح.',
        'الاسم هو الحقل الوحيد المطلوب. أضف الهاتف أو البريد إن وُجد، واختر القناة التي جاء منها العميل.',
        'إذا كان الرقم أو البريد مسجّلًا من قبل، سيظهر تنبيه برابط للعميل الموجود. افتحه بدل إنشاء نسخة مكررة، أو اختر «حفظ رغم ذلك» إذا كان شخصًا مختلفًا.',
        'تاريخ الإضافة والحالة «جديد» واسمك كمُضيف تُسجَّل تلقائيًا.',
      ] },
      { icon: 'user', title: 'تحديد المسؤول', steps: [
        'بعد حفظ العميل تظهر بطاقة «الخطوات التالية»: اختر المسؤول عنه وحدّد موعد أول متابعة.',
        'يمكنك لاحقًا تغيير المسؤول من خانة «المسؤول» في يمين صفحة العميل (إذا كانت لديك صلاحية الإسناد).',
        'العميل الذي تضيفه يُسند إليك تلقائيًا إذا لم تكن لديك صلاحية الإسناد لغيرك.',
      ] },
      { icon: 'phone', title: 'تسجيل تواصل', steps: [
        'في صفحة العميل اضغط «تسجيل تواصل».',
        'اختر النوع (اتصال، رسالة، اجتماع، بريد) والنتيجة، واكتب ملاحظة قصيرة عمّا حدث.',
        'حدّث حالة العميل من نفس النافذة، وحدّد موعد الخطوة القادمة إن وُجدت.',
        'كل تواصل يظهر في تبويب «النشاط»، وكل تغيير يظهر في تبويب «السجل» مع اسم من قام به ووقته.',
      ] },
      { icon: 'clock', title: 'تحديد موعد المتابعة', steps: [
        'من بطاقة «الخطوة القادمة» اختر التاريخ والوقت، أو استخدم الأزرار السريعة (اليوم، غدًا، بعد 3 أيام، بعد أسبوع).',
        'الأوقات كلها بتوقيت النظام الظاهر بجانب الحقل.',
        'لكل عميل متابعة واحدة مفتوحة: تحديد موعد جديد يستبدل القديم. عند الانتهاء اضغط «تم».',
        'ستصلك تنبيهات قبل الموعد وعند حلوله، ويُبلَّغ المدير إذا تأخرت المتابعة كثيرًا.',
      ] },
      { icon: 'check', title: 'تحديث حالة العميل', steps: [
        'غيّر الحالة مباشرة من خانة «الحالة» في صفحة العميل، أو أثناء تسجيل تواصل.',
        'عند «فاز» أو «خسر» تُلغى المتابعة المفتوحة تلقائيًا.',
      ], legend: true },
      { icon: 'channels', title: 'القنوات', steps: [
        'القناة هي المكان الذي جاء منه العميل: إنستغرام، فيسبوك، واتساب، هاتف، بريد، الموقع، إحالة، إعلانات.',
        'إذا لم تجد القناة المناسبة اختر «أخرى» واكتب اسمها.',
        'المدير يستطيع إضافة قنوات جديدة أو تعطيل ما لا يُستخدم من صفحة «القنوات».',
      ] },
      { icon: 'leads', title: 'لوحة العملاء والتنبيهات', steps: [
        'استخدم التبويبات أعلى القائمة: الكل، عملائي، مستحقة اليوم، متأخرة. المتأخر يظهر باللون الأحمر.',
        'ابحث بالاسم أو الشركة أو الرقم (اضغط / للبحث)، وصفِّ حسب الحالة أو المسؤول أو القناة أو موعد المتابعة.',
        'جرس التنبيهات أعلى القائمة الجانبية يعرض المتابعات المستحقة، واضغط على أي تنبيه لفتح العميل.',
      ] },
    ],
    shortcuts: 'اختصارات: C عميل جديد · / بحث · Esc إغلاق النافذة',
    role: 'دورك',
  },
  en: {
    title: 'How to use',
    intro: 'A quick guide to everything you need day to day. Read it once — it stays in the sidebar whenever you need it.',
    sections: [
      { icon: 'plus', title: 'Add a lead', steps: [
        'Click “New lead” at the top of the sidebar, or press C on your keyboard.',
        'Only the name is required. Add a phone number or email if you have one, and pick the channel the lead came from.',
        'If the phone or email already exists you’ll see a warning with a link to the existing lead. Open it instead of creating a duplicate, or choose “Save anyway” if it’s a different person.',
        'The creation date, the “New” status and you as the creator are filled in automatically.',
      ] },
      { icon: 'user', title: 'Assign an owner', steps: [
        'Right after saving, a “Next steps” card lets you pick the owner and schedule the first follow-up.',
        'You can change the owner later from the “Owner” field on the right of the lead page (if you can assign leads).',
        'If you can’t assign leads to others, leads you add are assigned to you.',
      ] },
      { icon: 'phone', title: 'Log a communication', steps: [
        'On the lead page, click “Log activity”.',
        'Choose the type (call, message, meeting, email) and the outcome, and add a short note about what happened.',
        'Update the lead’s status in the same window and set the next follow-up if there is one.',
        'Every activity appears under “Activity”; every change appears under “History” with who made it and when.',
      ] },
      { icon: 'clock', title: 'Set a follow-up date', steps: [
        'In the “Next step” card pick a date and time, or use the quick buttons (Today, Tomorrow, In 3 days, In a week).',
        'All times use the system time zone shown next to the field.',
        'Each lead has one open follow-up: scheduling a new one replaces it. When it’s done, click “Done”.',
        'You get a reminder before it’s due and when it’s due; managers are told if it stays overdue.',
      ] },
      { icon: 'check', title: 'Update a lead’s status', steps: [
        'Change the status directly in the “Status” field on the lead page, or while logging an activity.',
        'Marking a lead Won or Lost cancels its open follow-up.',
      ], legend: true },
      { icon: 'channels', title: 'Channels', steps: [
        'A channel is where the lead came from: Instagram, Facebook, WhatsApp, phone, email, website, referral, ads.',
        'If none fits, choose “Other” and type the channel name.',
        'Managers can add new channels or disable unused ones on the Channels page.',
      ] },
      { icon: 'leads', title: 'The dashboard and notifications', steps: [
        'Use the tabs above the list: All, Mine, Due today, Overdue. Overdue follow-ups are shown in red.',
        'Search by name, company or phone (press /), and filter by status, owner, channel or follow-up date.',
        'The bell at the top of the sidebar lists follow-ups that need you — click one to open the lead.',
      ] },
    ],
    shortcuts: 'Shortcuts: C new lead · / search · Esc close a window',
    role: 'Your role',
  },
};

export async function helpPage(ctx) {
  const g = GUIDE[getLang()] || GUIDE.en;
  const me = state.me;
  ctx.view.innerHTML = `
    <article class="guide">
      <header class="page-head"><div><h1>${esc(g.title)}</h1><p class="muted">${esc(g.intro)}</p></div></header>
      <p class="notice">${esc(g.role)}: <b>${esc(t(`role.${me.role}`))}</b> — ${esc(t(`role.desc.${me.role}`))}
        ${can('leads.view_all') ? '' : ` ${esc(t('access.assigned_desc'))}`}</p>
      <ol class="guide-sections">
        ${g.sections.map((s, i) => `<li class="card">
          <h2><span class="num">${i + 1}</span>${icon(s.icon)}${esc(s.title)}</h2>
          <ol class="steps">${s.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>
          ${s.legend ? `<ul class="legend">${STATUSES.map((x) => `<li>${statusIcon(x)}<b>${esc(t(`status.${x}`))}</b><span class="muted">${esc(t(`status.desc.${x}`))}</span></li>`).join('')}</ul>` : ''}
        </li>`).join('')}
      </ol>
      <p class="hint center">${esc(g.shortcuts)}</p>
    </article>`;
}
