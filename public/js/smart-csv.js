/**
 * smart-csv.js — turn a messy real-world CSV into clean records.
 * ---------------------------------------------------------------------------
 * No dependencies. Works in a browser and in Node (ESM). ~250 lines.
 *
 * The problem it solves: people upload spreadsheets whose columns are named
 * "Phone #", "phone_number", or "PHONE NUMBER", whose phone values look like
 * "(813) 555-0142", whose prices look like "$2.10", and whose status column
 * says "Prospect" when your database wants "lead". Rejecting those files is
 * easy and useless. This maps and repairs them instead.
 *
 * Three pieces, usable separately:
 *   1. parseCsv(text)               -> { headers, records }
 *   2. autoMap(headers, fields)     -> { fieldKey: csvHeader }   (a guess)
 *   3. buildRows(records, mapping, fields) -> { rows, warnings }
 *
 * You define `fields` once; everything else is generic.
 *
 * ---------------------------------------------------------------------------
 * EXAMPLE
 * ---------------------------------------------------------------------------
 *   import { parseCsv, autoMap, buildRows, clean } from './smart-csv.js';
 *
 *   const fields = [
 *     { key: 'name',  required: true,
 *       synonyms: ['name', 'full name', 'customer'] },
 *     { key: 'phone',
 *       synonyms: ['phone', 'phone number', 'tel'],
 *       clean: clean.phone },
 *     { key: 'email',
 *       synonyms: ['email', 'e mail'],
 *       clean: clean.email },
 *     { key: 'price',
 *       synonyms: ['price', 'cost'],
 *       clean: clean.money },
 *     { key: 'status', default: 'active',
 *       synonyms: ['status'],
 *       clean: clean.oneOf({ active: /active|current|customer/i,
 *                            lead:   /lead|prospect/i }) },
 *   ];
 *
 *   const { headers, records } = parseCsv(fileText);
 *   const mapping = autoMap(headers, fields);   // show this in a UI, let the
 *                                               // user correct it, then:
 *   const { rows, warnings } = buildRows(records, mapping, fields);
 *
 * `rows` is clean objects keyed by field.key. `warnings` is a human-readable
 * list of every value that needed repair or had to be dropped — show it to the
 * user BEFORE importing. Silent data mangling is worse than a rejected file.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (the non-obvious bits)
 * ---------------------------------------------------------------------------
 * - A bad value blanks the FIELD, never the ROW. A typo'd email shouldn't cost
 *   you the customer's name, address, and phone.
 * - Required fields are enforced by you, at the end — `buildRows` reports them
 *   in `warnings` but still returns the row, so you can decide whether to skip
 *   or halt.
 * - Cleaners are pure functions `(value, ctx) => cleaned | undefined`, where
 *   ctx = { warn(msg), rowNum, field }. Add your own; nothing is hardcoded.
 * - autoMap tries exact header matches first, then substring. It is a GUESS.
 *   Always show the user what it guessed and let them fix it.
 */

// ===========================================================================
// 1. PARSING
// ===========================================================================

/**
 * RFC 4180-ish CSV parser. Handles quoted fields, commas inside quotes,
 * escaped quotes (""), and \n / \r\n line endings. Blank lines are dropped.
 *
 * Returns headers in ORIGINAL casing (so a mapping UI shows what the user
 * actually wrote) and records keyed by those original headers.
 */
export function parseCsv(text) {
  // Strip a UTF-8 BOM — Excel loves adding one, and it silently corrupts the
  // first header name into something that matches nothing.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some(f => f.trim() !== '')) rows.push(row);
  }

  if (rows.length < 2) return { headers: rows[0] || [], records: [] };

  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => {
      const v = (r[idx] ?? '').trim();
      if (v !== '') obj[h] = v;   // omit empties so `?? default` works naturally
    });
    return obj;
  });
  return { headers, records };
}

// ===========================================================================
// 2. COLUMN MATCHING
// ===========================================================================

/** "Phone #" -> "phone", "E-Mail Address" -> "e mail address" */
export function normHeader(h) {
  return String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Guesses which CSV header corresponds to a field. Exact match on any synonym
 * wins; otherwise the first header CONTAINING a synonym. Returns '' if unsure —
 * an empty guess is honest, a wrong one is expensive.
 */
export function guessColumn(headers, synonyms) {
  const normed = headers.map(normHeader);
  const wanted = synonyms.map(normHeader);

  for (const syn of wanted) {
    const i = normed.indexOf(syn);
    if (i !== -1) return headers[i];
  }
  for (const syn of wanted) {
    const i = normed.findIndex(h => h.includes(syn));
    if (i !== -1) return headers[i];
  }
  return '';
}

/** Builds a { fieldKey: csvHeader } guess for every field. */
export function autoMap(headers, fields) {
  const mapping = {};
  for (const f of fields) {
    mapping[f.key] = guessColumn(headers, f.synonyms || [f.key]);
  }
  return mapping;
}

// ===========================================================================
// 3. CLEANERS
// ===========================================================================

/**
 * Each cleaner: (rawValue, ctx) => cleanedValue | undefined
 * `undefined` means "couldn't use it" — the field is left unset and a warning
 * is recorded. ctx.warn(msg) attaches a message to the row.
 */
export const clean = {
  /** Trim and collapse internal whitespace. The default when none is given. */
  text: (v) => {
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s === '' ? undefined : s;
  },

  /**
   * North-American-first phone normalizer -> E.164 ("+18135550142").
   * Accepts "(813) 555-0142", "813.555.0142", "+44 20 7946 0958".
   * Pass { defaultCountry: '' } to refuse bare 10-digit numbers.
   */
  phone: (v, ctx) => {
    const raw = String(v).trim();
    const hadPlus = raw.startsWith('+');
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (hadPlus && digits.length >= 8 && digits.length <= 15) return '+' + digits;
    ctx.warn(`couldn't understand phone "${raw}" — left blank`);
    return undefined;
  },

  email: (v, ctx) => {
    const s = String(v).trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
    ctx.warn(`"${s}" doesn't look like an email — left blank`);
    return undefined;
  },

  /** "$2.10" / "1,299.00" -> 2.1 / 1299. Rejects negatives. */
  money: (v, ctx) => {
    const n = Number(String(v).replace(/[$£€,\s]/g, ''));
    if (Number.isFinite(n) && n >= 0) return n;
    ctx.warn(`"${v}" isn't a valid amount — left blank`);
    return undefined;
  },

  /** "1,240" -> 1240. Whole numbers, zero or more. */
  int: (v, ctx) => {
    const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
    if (Number.isFinite(n) && n >= 0) return n;
    ctx.warn(`"${v}" isn't a whole number — left blank`);
    return undefined;
  },

  /** "yes"/"true"/"1"/"y" -> true; "no"/"false"/"0"/"n" -> false. */
  bool: (v, ctx) => {
    const s = String(v).trim().toLowerCase();
    if (/^(y|yes|true|1|x)$/.test(s)) return true;
    if (/^(n|no|false|0)$/.test(s)) return false;
    ctx.warn(`"${v}" isn't a yes/no value — left blank`);
    return undefined;
  },

  /** "2024-03-05", "3/5/24", "Mar 5 2024" -> "2024-03-05" (or undefined). */
  date: (v, ctx) => {
    const d = new Date(String(v).trim());
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    ctx.warn(`"${v}" isn't a date we recognize — left blank`);
    return undefined;
  },

  /**
   * Factory. Maps free text onto a fixed set of allowed values via regex.
   *   clean.oneOf({ lead: /lead|prospect/i, current: /customer|active/i })
   * First matching key wins. No match -> warning + undefined (so the field's
   * `default`, if any, applies).
   */
  oneOf: (patterns) => (v, ctx) => {
    const s = String(v).trim();
    for (const [value, pattern] of Object.entries(patterns)) {
      if (pattern.test(s)) return value;
    }
    ctx.warn(`"${s}" isn't a recognized ${ctx.field} — left blank`);
    return undefined;
  },
};

// ===========================================================================
// 4. BUILDING ROWS
// ===========================================================================

/**
 * Applies mapping + cleaners to every record.
 *
 * fields: [{ key, synonyms?, clean?, default?, required? }]
 * mapping: { fieldKey: csvHeader }  (from autoMap, ideally user-corrected)
 *
 * Returns { rows, warnings, missingRequired }
 *   rows            — clean objects, one per input record, same order
 *   warnings        — strings like `Row 4: couldn't understand phone "555"`
 *   missingRequired — field keys with no column mapped at all
 */
export function buildRows(records, mapping, fields, { headerOffset = 2 } = {}) {
  const warnings = [];
  const missingRequired = fields
    .filter(f => f.required && !mapping[f.key])
    .map(f => f.key);

  const rows = records.map((rec, idx) => {
    const rowNum = idx + headerOffset;   // 1-based, past the header row
    const out = {};

    for (const f of fields) {
      const header = mapping[f.key];
      const raw = header ? rec[header] : undefined;

      if (raw === undefined || raw === '') {
        if (f.default !== undefined) out[f.key] = f.default;
        else if (f.required) warnings.push(`Row ${rowNum}: missing ${f.key}`);
        continue;
      }

      const cleaner = f.clean || clean.text;
      const ctx = {
        rowNum,
        field: f.key,
        warn: (msg) => warnings.push(`Row ${rowNum}: ${msg}`),
      };
      const value = cleaner(raw, ctx);

      if (value !== undefined) out[f.key] = value;
      else if (f.default !== undefined) out[f.key] = f.default;
      else if (f.required) warnings.push(`Row ${rowNum}: ${f.key} could not be read`);
    }
    return out;
  });

  return { rows, warnings, missingRequired };
}

/** Convenience: rows that have every required field present. */
export function usableRows(rows, fields) {
  const required = fields.filter(f => f.required).map(f => f.key);
  return rows.filter(r => required.every(k => r[k] !== undefined && String(r[k]).trim() !== ''));
}
