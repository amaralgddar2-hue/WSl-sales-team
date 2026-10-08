// Time-zone helpers built on Intl (no external libraries). The system time zone is a setting.

export const isValidTimeZone = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

function offsetMs(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock date ('YYYY-MM-DD') + time ('HH:mm') in `tz` → UTC milliseconds. */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(t, tz); // re-check across DST boundaries
  if (second !== t) t = second;
  return t;
}

/** UTC ms → { date: 'YYYY-MM-DD', time: 'HH:mm' } in `tz`. */
export function utcToZoned(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** [start, end) of the calendar day containing `now` in `tz`, plus the end of the 7-day window. */
export function dayBounds(tz, now = Date.now()) {
  const { date } = utcToZoned(now, tz);
  const start = zonedToUtc(date, '00:00', tz);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const end = zonedToUtc(d.toISOString().slice(0, 10), '00:00', tz);
  d.setUTCDate(d.getUTCDate() + 6);
  const weekEnd = zonedToUtc(d.toISOString().slice(0, 10), '00:00', tz);
  return { start, end, weekEnd, today: date };
}

export function formatDateTime(ms, tz, lang) {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(ms));
}
