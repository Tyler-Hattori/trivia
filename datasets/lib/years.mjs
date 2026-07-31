/**
 * Year parsing — the single source of truth, shared by the Node tooling and the
 * browser. `project/utils/helpers.js` re-exports these rather than keeping its
 * own copy, because two parsers drifting apart silently mis-places entries on
 * the timeline (a span read as a point lands at the wrong x, and nothing errors).
 *
 * Accepted forms: `1543`, `1879-1955`, `27 BC - 14 AD`, `100-44 BC`,
 * `1990-present`, `c. 1500`, `1602-1604`, `fl. 1450`.
 *
 * Deep time is also accepted, because the atlas's Earth range needs it:
 * `66 Ma`, `4.54 billion years ago`, `541 to 485 million years ago`, `11,700 BP`.
 * See `parseAgo`.
 */

/** Strip the thousands separators out of "12,000" without touching "1,2". */
const decomma = (s) => String(s ?? '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');

/**
 * Drop a stated uncertainty: "4,567 ± 3 Ma" is one date, not two.
 *
 * Without this the tolerance reads as a second number, and since a range takes the
 * smaller magnitude as its recent end, "4,567 ± 3 Ma" became a 4.5-billion-year
 * span ending 3 Ma — a single line of a geologic timeline stretched across the
 * entire axis.
 */
const deTolerance = (s) => String(s ?? '').replace(/\s*(?:±|\+\/-|\+-)\s*\d+(?:[.,]\d+)?\s*/g, ' ');

/**
 * Parse a single year token to a signed integer, BC/BCE -> negative.
 * "27 BC" -> -27, "14 AD" -> 14, "c. 1500" -> 1500, "1305" -> 1305.
 * Returns null when no number is present.
 */
export function parseEraYear(s){
  s = decomma(s);
  const bc = /\bB\.?C\.?E?\.?/i.test(s);
  // Up to 10 digits, not 4. A 4-digit cap silently truncated deep-prehistory dates:
  // "113000 BC" matched only "1130" and became -1130, so the stored start (-113000,
  // read straight from Wikidata) and its own display text disagreed by 111,870 years.
  // 10 digits because the age of the Earth is 4,540,000,000 years and Earth mode
  // exists to hold it.
  const m = s.match(/-?\d{1,10}/);
  if(!m) return null;
  const n = parseInt(m[0], 10);       // honours an explicit leading minus
  return bc ? -Math.abs(n) : n;
}

/** True when the string hedges the date ("c.", "circa", "?", "fl."). */
export function isCirca(s){
  return /\b(c|ca|circa|fl)\b\.?|~|\?/i.test(String(s ?? ''));
}

// ---------------------------------------------------------------------------
// Deep time
// ---------------------------------------------------------------------------

/**
 * Relative-date units, longest match first so that "billion years ago" is not
 * read as the bare "years ago" that it contains.
 *
 * Matched case-insensitively even though Ga/Ma/ka are case-significant symbols.
 * That would be a source of false positives on its own, but every one of these
 * only counts when it directly follows a number, and "5 ma" in English prose is
 * a date far more often than it is anything else.
 */
const AGO_UNITS = [
  [/\b(?:ga|gyr|bya|billion\s+years?)\b/i, 1e9],
  [/\b(?:ma|myr|mya|million\s+years?)\b/i, 1e6],
  [/\b(?:ka|kyr|kya|thousand\s+years?)\b/i, 1e3],
  [/\bbp\b|\bb\.p\.|\byears?\s+ago\b|\byears?\s+before\s+present\b/i, 1],
];

/**
 * "Before present" means before 1950 by convention, but the offset is only worth
 * applying when the date is precise enough to see it.
 *
 * Below the limit it is subtracted, so "11,700 BP" is 9750 BC — at that scale two
 * millennia is a sixth of the number and dropping it would be plainly wrong. Above
 * it the number in the text becomes the year unchanged, so "66 Ma" stores
 * -66000000 rather than -65998050: an id and a git diff then read the way the
 * source does, and 1,950 years is nine orders of magnitude under the precision of
 * any claim written at that scale.
 *
 * Both branches use a FIXED epoch rather than the current year, so a stored year
 * still round-trips against its own `yearText` next January. `verify.mjs` asserts
 * that round-trip, and a drifting epoch would break it once a year.
 */
const BP_EPOCH = 1950;
const BP_EPOCH_LIMIT = 1e5;

const agoToYear = (ago) => -Math.round(ago >= BP_EPOCH_LIMIT ? ago : ago - BP_EPOCH);

/**
 * Parse a relative deep-time date. Returns `{start, end}` with start the OLDER
 * end, or null when the string carries no relative unit.
 *
 * An explicit era token wins: "3000 BC" is absolute and must not be read as a
 * count backwards from now, and "2.5 Ga BC" is not a thing anyone writes.
 */
export function parseAgo(v){
  const s = deTolerance(decomma(v));
  if(/\b(?:BCE?|AD|CE)\b/i.test(s)) return null;
  const unit = AGO_UNITS.find(([re]) => re.test(s));
  if(!unit) return null;

  /*
   * Split the range before reading any number, so each side keeps its own unit.
   * "320 kya – 305 kya" repeats the unit, "252-201 Ma" states it once at the end,
   * and a single scale applied to every number in the string gets one of those
   * wrong: taking the first unit found would read "2 Ma – 500 ka" as 2 and 500
   * million. A side with no unit of its own inherits the other's, which is what
   * "541 to 485 million years ago" means.
   */
  const sides = s
    .split(/\s+to\s+|\s*[–—]\s*|\s+and\s+|(?<=[\d.])\s*-\s*(?=\d)|(?<=[A-Za-z.])\s*-\s*(?=\s*\d)/i)
    .map((t) => t.trim()).filter(Boolean).slice(0, 2)
    .map((t) => ({
      n: (t.match(/\d+(?:\.\d+)?/) || [])[0],
      u: (AGO_UNITS.find(([re]) => re.test(t)) || [])[1],
    }))
    .filter((p) => p.n != null);
  if(!sides.length) return null;

  const shared = sides.find((p) => p.u != null)?.u ?? unit[1];
  const years = sides.map((p) => agoToYear(Number(p.n) * (p.u ?? shared)));

  // A relative date counts down as it moves forward, so the larger number is the
  // earlier year. Ordering here rather than trusting the text keeps `spans run
  // forwards` true whichever way round the source wrote it.
  return { start: Math.min(...years), end: Math.max(...years) };
}

/**
 * Parse a range. Returns `{start, end}`; for a bare year both are the same.
 * `end` is null only when the input has no parseable number at all.
 */
export function parseYears(v, now = new Date().getFullYear()){
  v = String(v || '').trim();
  if(!v) return { start: null, end: null };

  // Before the "present" substitution below, which would otherwise turn the
  // "present" in "12,000 years before present" into the current year and read the
  // whole thing as a range ending now.
  const ago = parseAgo(v);
  if(ago) return ago;

  v = deTolerance(v).trim();

  // "1990-present" / "incumbent" -> the current year
  v = v.replace(/\b(present|current|now|incumbent|ongoing)\b/gi, String(now));

  /*
   * "and" joins a range only when something in front says so.
   *
   * "between 1850 and 1900" is one interval; "published in 1909 and 1916" is two
   * separate dates, and reading that as a seven-year span would draw a bar across
   * a gap where nothing happened. `parseAgo` splits on "and" unconditionally
   * because a deep-time range is never a pair of discrete years. Here the cue is
   * required, which leaves the bare form parsing to its first year as it always
   * has — three entries in the store rely on that.
   */
  if(/^\s*(?:between|from)\b/i.test(v)) v = v.replace(/\s+and\s+/i, ' to ');

  const eraAll = /\bB\.?C\.?E?\.?/i.test(v);

  // Split on a genuine range separator only — never on a leading minus sign:
  //   " to "  |  " - " (spaced dash)  |  a dash directly between two digits
  //   |  a dash after an era token and before a digit ("113000 BC-9700 BC")
  // The last case needs a letter or period before the dash, so a leading "-44"
  // is still read as a negative year rather than split into two parts.
  const parts = v.split(/\s+to\s+|\s+[-–—]\s+|(?<=\d)[-–—](?=\d)|(?<=[A-Za-z.])[-–—](?=\s*\d)/i);

  if(parts.length >= 2){
    let start = parseEraYear(parts[0]);
    let end   = parseEraYear(parts[1]);

    // "100-44 BC": the era token trails the range, so the first number lacks it.
    if(eraAll && start != null && start > 0 &&
       !/\bAD\b|\bCE\b/i.test(parts[0]) && end != null && end < 0){
      start = -start;
    }

    const adEnd = /\bAD\b|\bCE\b/i.test(parts[1]);
    const eraStart = /\bAD\b|\bCE\b|\bB\.?C\.?E?\.?\b/i.test(parts[0]);

    /*
     * "180–10 AD" starts in 180 BC — the mirror of the "100-44 BC" case above.
     *
     * A range that runs backwards while its far half is marked AD is a range
     * across the era boundary whose near half was left unmarked. That is the only
     * reason a source writes AD on a range at all, so the marker is the evidence.
     * Bounded to the first millennium because past it the marker means nothing and
     * the descent is an abbreviation instead — see below.
     */
    if(adEnd && !eraStart && start > 0 && start < 1000 && end > 0 && end < start){
      start = -start;
    }

    /*
     * "1601–03" ends in 1603, not year 3.
     *
     * A range whose far half is written with fewer digits is abbreviated against
     * the near half — the ordinary way of writing a reign or a famine. Read
     * literally it produced a span sixteen centuries wide running backwards, which
     * is the one thing `verify.mjs` asserts cannot happen. Carry down the leading
     * digits, and bump by one place if that still lands before the start ("1899-01"
     * is 1901).
     *
     * Never when the far half names its era: "180–10 AD" abbreviates nothing, and
     * anything else that still runs backwards afterwards is a date this parser has
     * not understood, which the caller is expected to refuse rather than store.
     */
    const digits = (p) => (String(p).match(/\d+/) || [''])[0].length;
    if(start > 0 && end > 0 && end < start && !adEnd && digits(parts[1]) < digits(parts[0])){
      const place = 10 ** digits(parts[1]);
      end = start - (start % place) + end;
      if(end < start) end += place;
    }

    return { start, end };
  }

  const y = parseEraYear(v);
  return { start: y, end: y };
}

/** Midpoint of a range, or the year itself. 0 when unparseable. */
export function yearValue(v){
  v = String(v || '');

  // "66 Ma" has no dash and no era token, so the bare parseEraYear below would
  // read it as the year 66.
  const ago = parseAgo(v);
  if(ago) return (ago.start + ago.end) / 2;

  if(/[-–—]/.test(v)){
    const { start, end } = parseYears(v);
    if(start != null && end != null) return (start + end) / 2;
  }

  const y = parseEraYear(v);
  return y == null ? 0 : y;
}

// ---------------------------------------------------------------------------
// Finding a date inside prose
// ---------------------------------------------------------------------------

/*
 * Everything above parses a string that is already known to be a date. This
 * finds one inside a sentence, which is what mining a "Timeline of…" article out
 * of a page body needs (`--events` in `ingest.mjs`).
 *
 * The grammar is deliberately narrow, because a false positive here is the
 * expensive kind of wrong: it does not fail, it produces an entry sitting
 * confidently in the wrong millennium. Every form must end in an era token
 * (BC/AD) or a relative unit (Ma/ka/years ago), or be a bare 3-4 digit year.
 * A number with no such marker is not a date.
 */
const NUM   = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const HEDGE = String.raw`\b(?:between|from|c|ca|circa|approx|about|around)\.?\s*|~\s*`;
/*
 * `ago` is REQUIRED on the spelled-out forms, because without it the phrase is a
 * duration and not a date: "flora recovered over 1.7 million years" is a length of
 * time, and reading it as a date put a Paleocene recovery interval in the
 * Pleistocene. The symbol forms need no such suffix — "66 Ma" only ever means an
 * age — which is why they are listed separately.
 *
 * `parseAgo` stays looser than this on purpose. Its job is to read a string already
 * believed to be a date, where leniency costs nothing; the job here is to decide
 * whether a run of prose contains a date at all, where leniency invents entries.
 */
const SCALE = String.raw`(?:billion|million|thousand)\s+years?\s+(?:ago|before\s+present)` +
              String.raw`|G(?:a|yr)|M(?:a|yr)|k(?:a|yr)|mya|bya|kya|B\.?P\.?` +
              String.raw`|years?\s+(?:ago|before\s+present)`;
const ERA   = String.raw`BCE|BC|B\.C\.E\.|B\.C\.|AD|CE|A\.D\.`;
// A slash joins a range too, and a timeline writes "720s/710s Droughts on Euboea"
// where a prose page would write "720s to 710s". Without it the head date matched
// only "720" and left "/710s" at the front of the title.
const SEP   = String.raw`\s*(?:to|and|–|—|-|/)\s*`;

/*
 * A stated tolerance, consumed so that it cannot be read as a second date.
 *
 * The tolerance may carry its own unit and may follow the value's: one line reads
 * "c. 251.9 Ma ± 0.024 Ma", and matching only as far as the first "Ma" left
 * "± 0.024 Ma – Mesozoic era and Triassic Period begin" as the entry's title.
 */
const TOL = String.raw`\s*(?:±|\+\/-|\+-)\s*\d+(?:[.,]\d+)?(?:\s*(?:${SCALE}))?`;

/** One number plus its unit: "4,567 ± 3 Ma", "305 kya", "44 BC". */
const DATED = `(?:${NUM})(?:${TOL})?\\s*(?:${SCALE}|${ERA})(?![A-Za-z])(?:${TOL})?`;

/**
 * A number carrying an era token or a relative unit. Unambiguous anywhere.
 *
 * A range states its unit either once at the end ("252-201 Ma") or on both sides
 * ("320 kya – 305 kya", "27 BC - 14 AD"). The two-sided form is tried first,
 * because the alternation is ordered and the one-sided pattern would otherwise
 * match just the first half and leave the second date sitting in the entry's title.
 */
const DATE_UNIT =
  `(?:${HEDGE})?(?:${DATED}${SEP}${DATED}` +
  `|(?:${NUM})(?:${TOL})?(?:${SEP}(?:${NUM})(?:${TOL})?)?\\s*(?:${SCALE}|${ERA})(?![A-Za-z])(?:${TOL})?)`;

/*
 * What follows a bare year may not be more of the same number.
 *
 * The guard exists to stop a fragment of a longer number reading as a year:
 * "1,900" must not yield 900 and "1955.5" must not yield 1955. It used to be
 * `(?![\d,.])`, which also rejected a year followed by ordinary punctuation —
 * and "1066, the Norman conquest of England" is the single most common shape a
 * timeline line takes. Worse, on a range it did not fail outright but
 * backtracked: "1914–1918, the Great War" matched just "1914" and left "–1918,"
 * sitting in the entry's title.
 *
 * So reject a following digit, or a comma/period that is itself followed by a
 * digit. A comma before a space is punctuation and always was.
 */
const NOT_MID_NUMBER = String.raw`(?!\d|[,.]\d)`;

/**
 * A bare 3-4 digit year, or a range of them: "1066", "1914–1918", "1920s".
 *
 * The optional `s` is a decade, and it has to be consumed rather than left
 * behind: "1920s" matched as "1920" put a stray "s" at the head of the title.
 * `\b` keeps it from eating the s of an adjoining word.
 */
const YEAR_OR_DECADE = String.raw`\d{3,4}(?:s\b)?`;
const DATE_BARE = `(?:${HEDGE})?${YEAR_OR_DECADE}(?:${SEP}${YEAR_OR_DECADE})?${NOT_MID_NUMBER}`;

/*
 * A bare number is only a date in the right position. At the head of a timeline
 * line it plainly is one; mid-sentence it needs a preposition in front of it, or
 * "It has 400 members and covers 12 states" yields the year 400. Requiring the
 * preposition costs a few real dates and buys immunity from a whole class of
 * quantity-mistaken-for-year, which is the failure that produces a confident entry
 * in the wrong millennium.
 */
const DATE_PREP = String.raw`(?<=\b(?:in|by|since|during|until|from|around|about|circa|c\.?)\s)`;

/*
 * Units that mean the number in front of them is a measurement.
 *
 * Lives here rather than in `wiki.mjs`, which had the only copy, because two
 * consumers now need it: `yearInLead` reads it as "what follows this number",
 * and the loose grammar below reads it as a lookahead. A second copy of a list
 * like this is how "560 kilometres" became the year 560 in the first place.
 */
const UNIT_SRC =
  'k?m|mi|ft|yd|nmi|ha|kg|lb|t|%|°|km2|m2|km²|m²|' +
  'kilometres?|kilometers?|metres?|meters?|miles?|feet|foot|yards?|inches|' +
  'acres?|hectares?|square|cubic|tonnes?|tons?|pounds?|kilograms?|degrees?|' +
  'percent|per\\s+cent|people|inhabitants|residents|households|species|' +
  'members|seats|votes|pages|words|lines|units|copies|episodes|' +
  'million|billion|trillion|thousand|hundred|' +
  // Durations. "flora recovered over 1,700 years" is a length of time, not a
  // date — the same confusion the deep-time rules above guard against.
  'years?|months?|weeks?|days?|hours?|minutes?|seconds?|decades?|centuries|century';

/** A number immediately followed by a unit is a measurement, not a year. */
export const UNIT_AFTER = new RegExp(`^\\s*(?:${UNIT_SRC})\\b`, 'i');

/*
 * The loose grammar, for `--events-prose` only.
 *
 * Narrative history writes its dates in shapes the rules above deliberately
 * refuse: "his 1912 paper", "Planck won the 1918 Nobel Prize", "the planetary
 * model of the atom (1911)", "throughout the 1920s". Requiring a preposition
 * misses all of them, which is why *History of quantum mechanics* yielded 11
 * events off 397 sentences while 41 of those sentences carried a year.
 *
 * What makes these safe enough to take here and nowhere else is the number
 * itself: a bare 4-digit number in 1000-2099 is a year in a way that a 3-digit
 * one is not, so `400 members` and `663 km` cannot reach these rules at all. A
 * unit lookahead handles the rest ("1500 metres", "2000 people"). This is still
 * looser than the default and it is why the prose tier is opt-in and reported
 * separately: on a page that is not a timeline it also harvests the publication
 * years of cited work.
 */
const YEAR4 = String.raw`(?<![\d,.])(?:1\d{3}|20\d{2})`;
const NOT_UNIT = `(?!\\s*(?:${UNIT_SRC})\\b)`;

const DATE_LOOSE = [
  // "(1911)", "(1914–1918)" — how a history article dates the thing it just
  // named. Requiring nothing but a year inside the brackets rules out a
  // "(Smith 1923)" citation, though not an author-prominent "Smith (1923)",
  // which is structurally identical to a real one. That residual is part of why
  // this tier is opt-in. `clean()` in wiki.mjs drops the emptied brackets that
  // excising the date leaves behind.
  `\\(\\s*(?:1\\d{3}|20\\d{2})(?:${SEP}(?:1\\d{3}|20\\d{2}))?\\s*\\)`,
  // "between 1850 and 1900" — no preposition directly before the first year. The
  // hedge is inside the match so that `parseYears` sees the word that makes "and"
  // a range separator rather than a conjunction.
  `(?:${HEDGE})?${YEAR4}${SEP}(?:1\\d{3}|20\\d{2})${NOT_MID_NUMBER}${NOT_UNIT}`,
  // "the 1920s", "the early 1800s". Imprecise by construction; the caller marks
  // these circa.
  `${YEAR4}s\\b`,
  // "his 1912 paper", "the 1918 Nobel Prize".
  `${YEAR4}${NOT_MID_NUMBER}${NOT_UNIT}`,
].join('|');

/**
 * The first date expression in `s`, as `{ text, index, start, end }`, or null.
 *
 * Three levels of trust, because the position of a date is most of the evidence
 * for whether it is one:
 *
 *   `anchored`  at the very start of the string, the shape of a timeline line
 *               ("541 Ma – the Cambrian explosion"). The date plainly governs
 *               what follows it.
 *   default     mid-sentence, but only where a preposition vouches for it.
 *   `loose`     the attributive and parenthetical forms narrative prose uses.
 *               Read the comment on `DATE_LOOSE` before turning this on.
 */
export function findDate(s, { anchored = false, loose = false } = {}){
  const re = new RegExp(
    anchored ? `^\\s*(?:${DATE_UNIT}|${DATE_BARE})`
    : loose   ? `${DATE_UNIT}|${DATE_PREP}${DATE_BARE}|${DATE_LOOSE}`
    :           `${DATE_UNIT}|${DATE_PREP}${DATE_BARE}`,
    'i');
  const m = re.exec(String(s ?? ''));
  if(!m) return null;
  const text = m[0].trim();
  const { start, end } = parseYears(text);
  if(start == null) return null;
  return { text, index: m.index + m[0].length - m[0].trimStart().length, start, end };
}

/** Human form for a signed year: -44 -> "44 BC", 1907 -> "1907". */
export function yearLabel(y){
  if(y == null || Number.isNaN(y)) return '';
  return y < 0 ? `${Math.abs(Math.round(y))} BC` : String(Math.round(y));
}
