// Input validation helpers. Errors are machine codes the UI translates (AR/EN).

export class ValidationError extends Error {
  constructor(fields) {
    super('validation');
    this.fields = fields; // { field: 'required' | 'too_long' | 'too_short' | 'invalid' | 'exists' }
  }
}

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Normalise a phone number: keep digits and a leading +. Returns null when it doesn't look like a phone. */
export function normalizePhone(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return '';
  if (!/^[+\d][\d\s().-]*$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  return (trimmed.startsWith('+') ? '+' : '') + digits;
}

/** Key used to detect the same number written differently (+218 91… vs 091…): its last 9 digits. */
export const phoneKey = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 6 ? d.slice(-9) : null;
};

export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Parse `body` against a spec: { field: { type, required, max, min, values } }.
 * Types: text, enum, id, date, time, email, phone, bool, int.
 * With partial=true only keys present in body are validated/returned.
 */
export function parse(body, spec, { partial = false } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const errors = {};

  for (const [key, rule] of Object.entries(spec)) {
    if (partial && !(key in src)) continue;
    let v = src[key];

    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (rule.required) errors[key] = 'required';
      else out[key] = ['text', 'email', 'phone'].includes(rule.type) ? '' : null;
      continue;
    }

    switch (rule.type) {
      case 'text':
        if (typeof v !== 'string') { errors[key] = 'invalid'; break; }
        v = v.trim();
        if (v.length > (rule.max ?? 200)) errors[key] = 'too_long';
        else if (rule.min && v.length < rule.min) errors[key] = 'too_short';
        else out[key] = v;
        break;
      case 'enum':
        if (!rule.values.includes(v)) errors[key] = 'invalid';
        else out[key] = v;
        break;
      case 'id': {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) errors[key] = 'invalid';
        else out[key] = n;
        break;
      }
      case 'int': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < (rule.min ?? -Infinity) || n > (rule.max ?? Infinity)) errors[key] = 'invalid';
        else out[key] = n;
        break;
      }
      case 'date':
        if (!isDate(v)) errors[key] = 'invalid'; else out[key] = v;
        break;
      case 'time':
        if (!isTime(v)) errors[key] = 'invalid'; else out[key] = v;
        break;
      case 'email':
        if (typeof v !== 'string' || v.trim().length > 254 || !EMAIL_RE.test(v.trim())) errors[key] = 'invalid';
        else out[key] = v.trim().toLowerCase();
        break;
      case 'phone': {
        const p = normalizePhone(v);
        if (!p) errors[key] = 'invalid'; else out[key] = p;
        break;
      }
      case 'bool':
        if (typeof v !== 'boolean') errors[key] = 'invalid'; else out[key] = v;
        break;
      default:
        errors[key] = 'invalid';
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

export function checkPassword(pw, field = 'password') {
  if (typeof pw !== 'string' || !pw) throw new ValidationError({ [field]: 'required' });
  if (pw.length < 10) throw new ValidationError({ [field]: 'too_short' });
  if (pw.length > 200) throw new ValidationError({ [field]: 'too_long' });
  return pw;
}
