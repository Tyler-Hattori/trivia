/*
 * What an entry can sensibly be asked about, and whether an answer is right.
 *
 * Pure functions over one entry — no DOM, no atlas, no fetch — because the rule
 * "the question has to make sense for this entry" is the whole substance of the
 * quiz and it wants to be readable in one place.
 *
 * ## The rule the old quiz broke
 *
 * The per-dataset quiz asked every row for the same fixed list of columns taken
 * from `settings.js`, and for `art.csv` that list ended with `excerpt` — so it
 * put a text box in front of you and waited for a 600-character paragraph of
 * Wikipedia to be typed from memory. It also asked `title` for entries with no
 * image, where the title is the only thing on screen identifying the entry, so
 * the answer was already printed above the box.
 *
 * Here the askable set is DERIVED from the entry:
 *
 *   - the excerpt is never a question, at any length
 *   - a field with no value is never a question
 *   - `title` is asked only when something else identifies the entry — in
 *     practice a picture. Otherwise the title IS the prompt
 *   - a span (a reign, a life) is asked for both ends; a point for one year
 *   - the categorical questions are whichever facets this entry actually
 *     carries, so a painting is asked its artist and movement, a leader its
 *     country and role, and neither is asked the other's
 */

/*
 * Facets worth asking, and what to call them.
 *
 * An allow-list rather than "every facet", because `instanceOf` is a raw
 * Wikidata class label present on 489 entries — "human", "aircraft model" — and
 * asking someone to guess it is asking them to guess Wikidata's ontology.
 */
export const FACET_LABEL = {
  artist: 'Artist',
  director: 'Director',
  scientist: 'Scientist',
  philosopher: 'Philosopher',
  author: 'Author',
  creator: 'Creator',
  country: 'Country',
  role: 'Role',
  party: 'House / party',
  movement: 'Movement',
  school: 'School',
  tradition: 'Tradition',
  region: 'Region',
  field: 'Field',
  occupation: 'Occupation',
  category: 'Category',
  genre: 'Genre',
};

// A value longer than this is prose that happened to land in a facet, not a
// label anybody could type.
const MAX_ANSWER = 48;

/*
 * Letters that are not an ASCII letter plus a combining mark.
 *
 * `NFKD` splits é into e + ´ and the mark is then stripped, but ł, ø, đ and ß
 * are single indivisible code points — NFKD leaves them alone, the
 * `[^a-z0-9]` pass turns them into spaces, and "Chełmoński" becomes the two
 * words "che" and "monski". Typing the painter's name without diacritics, which
 * is the only way most keyboards can, then failed to match.
 */
const TRANSLIT = { ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ı: 'i', ð: 'd', þ: 'th', ß: 'ss', æ: 'ae', œ: 'oe' };

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[łøđħıðþßæœ]/g, (c) => TRANSLIT[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A facet cell may hold alternatives — "rococo / neoclassicism". Any is right. */
const alternatives = (v) =>
  String(v ?? '').split(/\s*[|/;]\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean);

/**
 * The questions this entry supports, in the order they should be shown.
 *
 * `prompt` is what the player is given; everything in `fields` is hidden.
 */
/*
 * Whose image IS the thing, and whose image merely illustrates it.
 *
 * "Has a picture" is not enough to justify asking for the title. A painting's
 * image is the painting, and naming it from the image is the whole game. But an
 * `england` entry for Port Isaac carries a stock photograph of the village —
 * pretty, and no more answerable than any other clifftop harbour. The first
 * version asked for its title and there was no way to know it.
 *
 * A creator facet is what separates the two: the entry is a work somebody made,
 * so the picture is a reproduction of that work rather than a photograph of a
 * subject the entry happens to be about.
 */
const CREATOR_FACETS = ['artist', 'director', 'creator', 'author'];

export function questionsFor(e){
  const fields = [];
  const hasImage = Boolean(e.image);
  const imageIsTheWork = hasImage && CREATOR_FACETS.some((k) => e.facets?.[k]);

  // Only ask for the title when the picture is doing the identifying. Without
  // an image the title is the prompt, and asking for it prints the answer.
  if(imageIsTheWork && e.title) fields.push({ key: 'title', label: 'Title', answer: e.title });

  for(const [key, label] of Object.entries(FACET_LABEL)){
    const v = e.facets?.[key];
    if(!v) continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    if(!value.trim() || value.length > MAX_ANSWER) continue;
    fields.push({ key: `facet:${key}`, label, answer: value });
  }

  /*
   * There is no topic question.
   *
   * It was never a fair thing to ask. `migrate.mjs` puts a leader's country,
   * party and role into `topics` as well as `facets`, so for those entries the
   * answer was a free copy of a box already on screen; and where it was not a
   * copy it was a vague "name any bucket this belongs to" with no way to know
   * which of several the grader held.
   */

  // A reign or a lifetime is two dates and asking for one of them is ambiguous.
  if(e.isSpan && e.x0 !== e.x1){
    fields.push({ key: 'span', label: 'Years (start–end)', answer: e.yearText || `${e.x0}–${e.x1}` });
  } else {
    fields.push({ key: 'year', label: 'Year', answer: e.yearText || String(e.x0) });
  }

  return {
    fields,
    // What is safe to show. The excerpt is not here at any length: it is the
    // source the entry was embedded from and it usually contains every answer
    // in its first sentence.
    prompt: {
      image: hasImage ? e.image : '',
      // Shown whenever it is not itself a question — including for an entry that
      // has a picture the player cannot be expected to identify from.
      title: imageIsTheWork ? '' : e.title,
      dataset: e.dataset,
    },
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * How close a year has to be.
 *
 * A flat tolerance cannot span this corpus: the same rule has to serve a 1907
 * painting and a supernova at −4,570,000,000. Recent dates get a tight absolute
 * window, deep time a relative one, so "4.5 billion years ago" counts and
 * "4,570,000,000 exactly" is not demanded of anybody.
 */
export function yearTolerance(year){
  const mag = Math.abs(year);
  return mag <= 3000 ? 3 : Math.max(3, mag * 0.02);
}

/*
 * A minus sign only counts when nothing precedes it.
 *
 * `-?\d+` reads the hyphen in the range "1837-1901" as a sign, so a correctly
 * typed reign parsed as 1837 and MINUS 1901 and was marked wrong. The lookbehind
 * makes a hyphen between two digits a separator, which is what anyone typing a
 * span means by it.
 */
const YEAR_IN = /(?<!\d)-?\d{1,12}/g;
// Above this magnitude a date is deep time, written "4,570 Ma" and never with an
// era suffix. Nobody types "BC" after four billion, so the sign is not evidence.
const DEEP_TIME = 100000;

/** Every number a player typed, with BC/BCE read as negative. */
function typedYears(raw){
  const s = String(raw || '');
  const neg = /\b(bc|bce)\b/i.test(s);
  const nums = (s.match(YEAR_IN) || []).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
  return neg ? nums.map((n) => (n > 0 ? -n : n)) : nums;
}

/**
 * Grade one field.
 *
 * Returns `{ ok, delta }` — `delta` is the signed year error where one applies,
 * so the run can report an RMSE the way the old quiz did.
 */
export function gradeField(field, raw, e){
  const typed = String(raw || '').trim();
  if(!typed) return { ok: false, delta: null };

  if(field.key === 'year'){
    const want = e.x0;
    let got = typedYears(typed)[0];
    if(got == null) return { ok: false, delta: null };
    // "4,570 Ma" is how the entry states itself, so "4500000000" means four and a
    // half billion years AGO. Insisting on the minus sign would fail every honest
    // answer to every deep-time question.
    if(Math.abs(want) > DEEP_TIME) got = Math.sign(want) * Math.abs(got);
    return { ok: Math.abs(got - want) <= yearTolerance(want), delta: got - want };
  }

  if(field.key === 'span'){
    const got = typedYears(typed);
    if(got.length < 2) return { ok: false, delta: got.length ? got[0] - e.x0 : null };
    const tol = Math.max(yearTolerance(e.x0), yearTolerance(e.x1));
    const ok = Math.abs(got[0] - e.x0) <= tol && Math.abs(got[1] - e.x1) <= tol;
    return { ok, delta: got[0] - e.x0 };
  }

  return { ok: alternatives(field.answer).some((a) => matches(typed, a)), delta: null };
}

/**
 * Whether a typed string names the same thing as the answer.
 *
 * The old rule was `guess.includes(answer) || answer.includes(guess)`, which
 * marks a single letter correct against every answer containing it — typing "a"
 * scored. Two changes: a containment has to be a whole-word one, and a surname
 * on its own counts, because "renoir" is what anybody looking at a Renoir would
 * type and "pierre-auguste renoir" is not.
 */
function matches(guess, answer){
  const g = norm(guess), a = norm(answer);
  if(!g || !a) return false;
  if(g === a) return true;

  const gt = g.split(' ').filter(Boolean);
  const at = a.split(' ').filter(Boolean);

  // Every word of the answer was typed, in any order and among other words.
  if(at.length && at.every((t) => gt.includes(t))) return true;

  // A distinctive single word of the answer — a surname, a one-word movement.
  // Short words are excluded: "of", "the", "war" would match far too much.
  if(gt.length === 1 && gt[0].length >= 4 && at.includes(gt[0])) return true;

  return false;
}
