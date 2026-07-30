/**
 * Year parsing — the single source of truth, shared by the Node tooling and the
 * browser. `project/utils/helpers.js` re-exports these rather than keeping its
 * own copy, because two parsers drifting apart silently mis-places entries on
 * the timeline (a span read as a point lands at the wrong x, and nothing errors).
 *
 * Accepted forms: `1543`, `1879-1955`, `27 BC - 14 AD`, `100-44 BC`,
 * `1990-present`, `c. 1500`, `1602-1604`, `fl. 1450`.
 */

/**
 * Parse a single year token to a signed integer, BC/BCE -> negative.
 * "27 BC" -> -27, "14 AD" -> 14, "c. 1500" -> 1500, "1305" -> 1305.
 * Returns null when no number is present.
 */
export function parseEraYear(s){
  s = String(s ?? '');
  const bc = /\bB\.?C\.?E?\.?/i.test(s);
  const m = s.match(/-?\d{1,4}/);
  if(!m) return null;
  const n = parseInt(m[0], 10);       // honours an explicit leading minus
  return bc ? -Math.abs(n) : n;
}

/** True when the string hedges the date ("c.", "circa", "?", "fl."). */
export function isCirca(s){
  return /\b(c|ca|circa|fl)\b\.?|~|\?/i.test(String(s ?? ''));
}

/**
 * Parse a range. Returns `{start, end}`; for a bare year both are the same.
 * `end` is null only when the input has no parseable number at all.
 */
export function parseYears(v, now = new Date().getFullYear()){
  v = String(v || '').trim();
  if(!v) return { start: null, end: null };

  // "1990-present" / "incumbent" -> the current year
  v = v.replace(/\b(present|current|now|incumbent|ongoing)\b/gi, String(now));

  const eraAll = /\bB\.?C\.?E?\.?/i.test(v);

  // Split on a genuine range separator only — never on a leading minus sign:
  //   " to "  |  " - " (spaced dash)  |  a dash directly between two digits
  const parts = v.split(/\s+to\s+|\s+[-–—]\s+|(?<=\d)[-–—](?=\d)/i);

  if(parts.length >= 2){
    let start = parseEraYear(parts[0]);
    let end   = parseEraYear(parts[1]);

    // "100-44 BC": the era token trails the range, so the first number lacks it.
    if(eraAll && start != null && start > 0 &&
       !/\bAD\b|\bCE\b/i.test(parts[0]) && end != null && end < 0){
      start = -start;
    }

    return { start, end };
  }

  const y = parseEraYear(v);
  return { start: y, end: y };
}

/** Midpoint of a range, or the year itself. 0 when unparseable. */
export function yearValue(v){
  v = String(v || '');

  if(/[-–—]/.test(v)){
    const { start, end } = parseYears(v);
    if(start != null && end != null) return (start + end) / 2;
  }

  const y = parseEraYear(v);
  return y == null ? 0 : y;
}

/** Human form for a signed year: -44 -> "44 BC", 1907 -> "1907". */
export function yearLabel(y){
  if(y == null || Number.isNaN(y)) return '';
  return y < 0 ? `${Math.abs(Math.round(y))} BC` : String(Math.round(y));
}
