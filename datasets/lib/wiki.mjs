/**
 * Wikipedia + Wikidata -> a draft atlas entry.
 *
 * All free, all API, no model involved. This is the project's standing rule:
 * retrieval is not a language model's job. A model is only worth paying for
 * judgement — house-voice rewriting and disambiguation — and even that is
 * optional here.
 *
 * ## Where the year comes from
 *
 * Dates are read from Wikidata claims, in a deliberate order of trust, and only
 * fall back to scraping a year out of the lead sentence. Getting this right is
 * the whole game: an entry whose year is wrong is worse than an absent one,
 * because it silently lands in the wrong century and nothing flags it.
 */

import { getJSON, wpSearch, wpSummary, mapPool } from '../wikilib.mjs';
import { parseYears, isCirca, findDate, UNIT_AFTER } from './years.mjs';

const WP = 'https://en.wikipedia.org';
const WD = 'https://www.wikidata.org';

/** Claim groups, most trusted first, and what shape of date each implies. */
const DATE_CLAIMS = [
  { span: ['P580', 'P582'] },                 // start time / end time
  { span: ['P569', 'P570'] },                 // birth / death
  { point: 'P585' },                          // point in time
  { point: 'P571' },                          // inception
  { point: 'P577' },                          // publication date
  { point: 'P1191' },                         // first performance
  { span: ['P2031', 'P2032'] },               // work period start / end
];

/** Wikidata properties mined for topics, with a weight on how specific each is. */
const TOPIC_CLAIMS = [
  'P31',    // instance of
  'P135',   // movement
  'P136',   // genre
  'P106',   // occupation
  'P921',   // main subject
  'P279',   // subclass of
  'P361',   // part of
];

/** Properties that name the responsible person, for the subtitle. */
const CREATOR_CLAIMS = ['P170', 'P50', 'P57', 'P86', 'P84', 'P61', 'P175', 'P6'];

const PLACE_CLAIMS = ['P495', 'P17', 'P27'];

/** Instance-of QIDs too generic to be useful as a topic. */
const JUNK_TOPICS = new Set([
  'Q5',            // human
  'Q35120',        // entity
  'Q1190554',      // occurrence
  'Q26907166',     // temporal entity
  'Q17334923',     // location
  'Q4167410',      // disambiguation page
  'Q13406463',     // list article
  'Q11266439',     // template
]);

/**
 * Instance-of QIDs that mean "this page is not a thing that happened".
 *
 * Wikipedia categories are full of these — "Cubist paintings" contains
 * "List of works by Jean Metzinger" alongside the actual paintings. Such a page
 * has a plausible title, a real image and a datable lead, so nothing downstream
 * catches it; it just becomes a permanent nonsense point on the map.
 */
const NOT_AN_ENTRY = new Set([
  'Q13406463',     // Wikimedia list article
  'Q4167410',      // disambiguation page
  'Q4167836',      // Wikimedia category
  'Q11266439',     // Wikimedia template
  'Q35252665',     // Wikimedia set index article
  'Q17362920',     // Wikimedia duplicated page
  'Q15184295',     // Wikimedia module
  'Q14204246',     // Wikimedia project page
  'Q11753321',     // Wikimedia navigational template
  'Q1457673',      // Wikimedia portal
]);

/**
 * Title shapes that are indexes rather than subjects.
 *
 * Exported because `misses.mjs` rejects the same shapes, and a second copy of
 * this list is how "List of works by Leonardo da Vinci" ends up proposed as the
 * excerpt for a painting.
 */
export const INDEX_TITLE = /^(list|lists|index|outline|glossary|timeline|chronology|bibliography|filmography|discography)\s+of\b|^(category|template|portal|draft|help|wikipedia|module):|\((?:disambiguation)\)$/i;

const yearFromTime = (t) => {
  const m = String(t || '').match(/^([+-])(\d+)/);
  return m ? (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10) : null;
};

/**
 * A Wikidata time value is a year PLUS a precision, and the year alone is a lie
 * whenever the precision is coarser than 9.
 *
 *   9 = year   8 = decade   7 = century   6 = millennium   and coarser below
 *
 * Offa of Mercia's birth is `+0800` precision 7, meaning "8th century", and
 * Guthrum's is `+0900` precision 7, "9th century". Read as literal years those are
 * 800 and 900 — both AFTER the recorded deaths of 796 and 890, which is how two
 * backwards spans got into the store. Nothing downstream catches it: the entry just
 * draws as a negative-width bar.
 *
 * So resolve a value to the RANGE it actually denotes. A caller taking the start of
 * a span uses `lo`, a caller taking the end uses `hi`, and a span can then never run
 * backwards. `imprecise` is true whenever the claim was coarser than a single year,
 * which is what marks the entry circa.
 */
const BUCKET_MIN_PRECISION = 9;

function timeRange(value){
  const year = yearFromTime(value?.time);
  if(year == null) return null;
  const precision = value?.precision ?? BUCKET_MIN_PRECISION;
  if(precision >= BUCKET_MIN_PRECISION) return { lo: year, hi: year, imprecise: false };

  // Bucket width: decade 10, century 100, millennium 1000, and so on.
  const width = 10 ** (BUCKET_MIN_PRECISION - precision);
  // Year 800 at century precision belongs to 701..800 — the bucket ENDING at the
  // encoded year, matching the usual "century = ceil(year/100)" reading. The same
  // arithmetic mirrored across zero gives the BC case.
  const mag = Math.abs(year);
  const hiMag = Math.ceil(mag / width) * width;
  const loMag = hiMag - width + 1;
  return year < 0
    ? { lo: -hiMag, hi: -loMag, imprecise: true }
    : { lo: loMag, hi: hiMag, imprecise: true };
}

const claimValues = (claims, prop) =>
  (claims[prop] || [])
    .filter((c) => c.rank !== 'deprecated')
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => v != null);

const claimQids = (claims, prop) =>
  claimValues(claims, prop).map((v) => v?.id).filter(Boolean);

/** Full claim set for one QID. */
async function wdEntity(qid){
  const d = await getJSON(`${WD}/w/api.php?format=json&action=wbgetentities&props=claims|labels|descriptions&languages=en&ids=${qid}`);
  const e = d?.entities?.[qid];
  if(!e) return null;
  return {
    claims: e.claims || {},
    label: e.labels?.en?.value || null,
    description: e.descriptions?.en?.value || null,
  };
}

/** Resolve QIDs -> English labels, batched, cached across a run. */
const labelCache = new Map();
async function labelsFor(qids){
  const need = [...new Set(qids)].filter((q) => q && !labelCache.has(q));
  for(let i = 0; i < need.length; i += 50){
    const chunk = need.slice(i, i + 50);
    const d = await getJSON(`${WD}/w/api.php?format=json&action=wbgetentities&props=labels&languages=en&ids=${chunk.join('|')}`);
    for(const [qid, e] of Object.entries(d?.entities || {})){
      labelCache.set(qid, e.labels?.en?.value || null);
    }
    for(const q of chunk) if(!labelCache.has(q)) labelCache.set(q, null);
  }
  const out = {};
  for(const q of qids) if(labelCache.get(q)) out[q] = labelCache.get(q);
  return out;
}

/** Non-hidden Wikipedia categories, cleaned into topic candidates. */
async function categoriesFor(title){
  const d = await getJSON(
    `${WP}/w/api.php?format=json&action=query&prop=categories&clshow=!hidden&cllimit=30&titles=${encodeURIComponent(title)}`,
  );
  const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
  return (page?.categories || [])
    .map((c) => String(c.title || '').replace(/^Category:/, ''))
    // Categories are mostly bookkeeping ("1907 paintings", "Articles with …").
    // Keep the ones that read as a subject and drop the housekeeping.
    .filter((c) => !/\b(articles|pages|wikipedia|stubs?|CS1|use \w+ dates|short description|commons category)\b/i.test(c))
    .map((c) => c.replace(/\s*\(.*?\)\s*/g, '').trim())
    .filter((c) => c.length > 2 && c.length < 44);
}

/**
 * Lead paragraphs as plain text, longer than the REST summary's one sentence.
 *
 * `exintro=1` is what makes this the LEAD and not the article: one page becomes one
 * entry, dated from its own claims. `mineEvents` drops that parameter on purpose,
 * because a "Timeline of…" page is a hundred entries whose dates are in the body.
 */
/*
 * The excerpt length below which an entry embeds badly.
 *
 * Measured, not guessed. Sweeping the truncation `entryText` applies against how
 * often an entry's 10 nearest neighbours share its Wikidata-derived role, on 192
 * leaders across 4 roles:
 *
 *     150 chars  75.3%      600 chars  76.1%
 *     300 chars  76.6%      700 chars  76.8%
 *     450 chars  75.8%      900 chars  76.9%
 *
 * Flat above 300 and falling off below it. 700 is the peak and is already what
 * `entryText` truncates to, so the useful threshold is not "aim for 700" but
 * "clear 300" — which any Wikipedia lead does about three times over. Below this
 * an entry embeds mostly on its title, which is how a 17-character timeline row
 * ends up next to nothing it belongs with.
 */
export const MIN_EXCERPT = 300;

/*
 * Encyclopedia apparatus, removed mechanically.
 *
 * A Wikipedia lead opens with a dense parenthetical that is nothing but
 * apparatus: `Tiberius Julius Caesar Augustus ( ty-BEER-ee-əs; 16 November 42 BC
 * – 16 March AD 37) was…`, `Jacob Abraham Camille Pissarro ( piss-AR-oh; French:
 * [kamij pisaʁo]; 10 July 1830 – 13 November 1903) was…`. It is noise in an
 * excerpt and it is noise in a vector.
 *
 * Matched by CONTENT, not position: a parenthetical qualifies if it carries a
 * date range, IPA, a pronunciation respelling, or a `Language:` gloss. A
 * parenthetical that is ordinary prose is left alone.
 *
 * Lives here rather than in the one script that first needed it because
 * `era-excerpts.mjs` needs exactly the same cleaning on paragraphs that are not
 * leads — and a second copy of a regex list is how the two title-casers drifted.
 */
const IPA = /[ɑɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑ̃]/;
const GLOSS = /^(?:born|née|nee|Latin|Greek|Ancient Greek|Arabic|Hebrew|Persian|Chinese|Japanese|Russian|Sanskrit|Turkish|Old English|German|French|Italian|Spanish|pronounced|IPA|lit\.?|literally|romanized|transliterated|Classical Latin)\b/i;
const DATERANGE = /\b\d{1,4}\s*(?:BC|BCE|AD|CE)?\s*[–—-]\s*(?:c\.\s*)?\d{1,4}\b|\b\d{1,2}\s+\w+\s+\d{1,4}\b/;

export function stripApparatus(text){
  let out = '';
  let depth = 0, buf = '';
  for(const ch of String(text || '')){
    if(ch === '('){
      if(depth === 0){ depth = 1; buf = ''; continue; }
      depth++; buf += ch; continue;
    }
    if(ch === ')' && depth > 0){
      depth--;
      if(depth === 0){
        const inner = buf.trim();
        const junk = !inner || IPA.test(inner) || GLOSS.test(inner) || DATERANGE.test(inner) ||
                     /^[\s;,·]*$/.test(inner);
        if(!junk) out += `(${inner})`;
        buf = '';
        continue;
      }
      buf += ch; continue;
    }
    if(depth > 0) buf += ch; else out += ch;
  }
  if(depth > 0) out += buf;                       // unbalanced: keep what we have
  return out
    .replace(/\[[^\]]*\]/g, '')                   // bracketed IPA / citations
    .replace(/\s+([,.;:])/g, '$1')                // space left before punctuation
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export async function leadText(title, maxChars = 1500){
  const d = await getJSON(
    `${WP}/w/api.php?format=json&action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&titles=${encodeURIComponent(title)}`,
  );
  const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
  const text = String(page?.extract || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if(text.length <= maxChars) return text;
  // Cut at a paragraph boundary if one is close, else at a sentence.
  const cut = text.lastIndexOf('\n\n', maxChars);
  if(cut > maxChars * 0.5) return text.slice(0, cut).trim();
  const dot = text.lastIndexOf('. ', maxChars);
  return text.slice(0, dot > 0 ? dot + 1 : maxChars).trim();
}

/*
 * A number in a lead sentence is only sometimes a year.
 *
 * This fallback runs precisely when Wikidata has no date claim — and an article
 * with no date claim is very often a thing that has no date at all: a county, a
 * river, a language, a genus. Its lead is then full of quantities, and the old
 * pattern took the first three-or-four digit number it saw. "It is about 560
 * kilometres long" dated the English Channel to AD 560, "663 km" put Surrey in
 * the seventh century, and "500 species" did the same to Oak. Nothing downstream
 * can flag those: a wrong year renders exactly like a right one.
 *
 * Two guards, neither of which needs to know what the article is about:
 */

// 1. A number immediately followed by a unit is a measurement, not a year.
//    `UNIT_AFTER` is imported from `lib/years.mjs`, which owns the unit list
//    because the loose prose grammar there needs the same one.

// 2. A bare three-digit number is far more often a quantity than a year, so it
//    needs an explicit date cue on one side. Four-digit years are left alone —
//    "1927" in a lead sentence is overwhelmingly a date.
const DATE_CUE_BEFORE = /(?:\b(?:in|by|since|from|until|till|around|about|circa|c\.|ca\.|founded|established|built|born|died|dated)\s+|\bAD\s+)$/i;
const DATE_CUE_AFTER  = /^\s*(?:AD|CE|BCE?|BC)\b/i;

/**
 * The first number in a lead that survives both guards, as a signed year.
 * Returns null when nothing in the text reads as a date.
 */
export function yearInLead(text, window = 300){
  const s = String(text || '').slice(0, window);
  const re = /\b(\d{3,4})\b/g;
  let m;
  while((m = re.exec(s))){
    const n = parseInt(m[1], 10);
    if(n < 500 || n > 2100) continue;

    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[1].length);

    if(UNIT_AFTER.test(after)) continue;

    const bc = /^\s*(?:BCE?|BC)\b/i.test(after);
    if(n < 1000 && !bc && !DATE_CUE_BEFORE.test(before) && !DATE_CUE_AFTER.test(after)) continue;

    return bc ? -n : n;
  }
  return null;
}

/**
 * Everything known about one page, as a draft entry.
 * Returns null when the page does not exist.
 */
export async function describe(input){
  const title = await resolveTitle(input);
  if(!title) return null;

  const summary = await wpSummary(title);
  if(!summary) return null;

  const [lead, cats, wd] = await Promise.all([
    leadText(title),
    categoriesFor(title),
    summary.qid ? wdEntity(summary.qid) : Promise.resolve(null),
  ]);

  const claims = wd?.claims || {};

  // ---- is this even an entry? --------------------------------------------
  // Cheapest possible rejection, before any topic or date work.
  const instanceOf = claimQids(claims, 'P31');
  const notEntry = instanceOf.find((q) => NOT_AN_ENTRY.has(q));
  if(notEntry) return { _reject: 'index or meta page', title, _wiki: true };
  if(INDEX_TITLE.test(title)) return { _reject: 'index page (by title)', title, _wiki: true };

  // ---- dates -------------------------------------------------------------
  let start = null, end = null, kind = 'point', dateSource = null;

  let imprecise = false;
  /*
   * Whether the end year is the subject's or merely today's.
   *
   * An absent P582 means the end is not recorded, and substituting the current
   * year is the only way to give the span a right edge to draw to. But the
   * substitution is indistinguishable from a real end date once stored, so
   * Phanerozoic, Animal, Fungus and the Age of Earth all drew as bars stopping
   * dead at 2026, in the same shape as a reign that genuinely ended there.
   * Recorded, so the renderer can cap those spans open instead.
   *
   * Not named `ongoing`: an absent P582 usually does mean unfinished, but it also
   * catches things Wikidata simply never dated the end of — Vikings, Olmecs.
   */
  let openEnded = false;

  for(const rule of DATE_CLAIMS){
    if(rule.span){
      // Widen outward: earliest year the start could be, latest the end could be.
      const a = timeRange(claimValues(claims, rule.span[0])[0]);
      const b = timeRange(claimValues(claims, rule.span[1])[0]);
      if(a){
        start = a.lo;
        end = b ? b.hi : new Date().getFullYear();   // no end recorded / still alive
        openEnded = !b;
        kind = 'span';
        imprecise = a.imprecise || !!b?.imprecise;
        dateSource = rule.span.join('+');
        break;
      }
    } else {
      const r = timeRange(claimValues(claims, rule.point)[0]);
      if(r){
        // A point has one x, so take the middle of the range rather than an edge:
        // "17th century" reads better at 1650 than pinned to 1601 or 1700.
        start = end = r.imprecise ? Math.round((r.lo + r.hi) / 2) : r.lo;
        kind = 'point';
        imprecise = r.imprecise;
        dateSource = rule.point;
        break;
      }
    }
  }

  // Fall back to the text. A parenthetical in the title ("Metropolis (1927 film)")
  // is the most reliable of these; a year in the first sentence is next.
  if(start == null){
    const paren = title.match(/\((\d{3,4})\b/);
    if(paren){
      start = end = parseInt(paren[1], 10);
      dateSource = 'title';
    } else {
      const hit = yearInLead(lead || summary.extract || '');
      if(hit){
        start = end = hit;
        dateSource = 'lead-text';
      }
    }
  }

  // ---- topics ------------------------------------------------------------
  const topicQids = TOPIC_CLAIMS.flatMap((p) => claimQids(claims, p))
    .filter((q) => !JUNK_TOPICS.has(q));
  const creatorQids = CREATOR_CLAIMS.flatMap((p) => claimQids(claims, p));
  const placeQids = PLACE_CLAIMS.flatMap((p) => claimQids(claims, p));

  const labels = await labelsFor([...topicQids, ...creatorQids, ...placeQids]);

  const topics = [
    ...topicQids.map((q) => labels[q]),
    ...placeQids.map((q) => labels[q]),
    ...cats.slice(0, 6),
  ].filter(Boolean).map((t) => t.toLowerCase());

  const creators = creatorQids.map((q) => labels[q]).filter(Boolean);

  // ---- facets ------------------------------------------------------------
  const facets = {};
  const put = (name, prop) => {
    const vals = claimQids(claims, prop).map((q) => labels[q]).filter(Boolean);
    if(vals.length === 1) facets[name] = vals[0];
    else if(vals.length > 1) facets[name] = vals.slice(0, 4);
  };
  put('creator', 'P170'); put('author', 'P50'); put('director', 'P57');
  put('movement', 'P135'); put('genre', 'P136'); put('occupation', 'P106');
  put('country', 'P495'); put('instanceOf', 'P31');

  const image = summary.image ||
    (claimValues(claims, 'P18')[0]
      ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(String(claimValues(claims, 'P18')[0]).replace(/ /g, '_'))}`
      : '');

  const yearText = kind === 'span' && start !== end
    ? `${fmtYear(start)}-${fmtYear(end)}`
    : fmtYear(start);

  return {
    title: displayTitle(summary.title || title),
    subtitle: creators[0] || wd?.description || summary.description || '',
    excerpt: lead || summary.extract || '',
    image,
    start, end, kind, openEnded,
    yearText: start == null ? '' : yearText,
    // A claim coarser than one year is approximate by definition. detail.js renders
    // this as "approx." next to the date, so the widened range is not read as exact.
    circa: imprecise || (isCirca(lead || '') && dateSource === 'lead-text'),
    topics,
    facets,
    origin: {
      wiki: `${WP}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      qid: summary.qid || null,
      // Kept on the stored entry, not just in the run report. `lead-text` is the
      // one source here that reads prose rather than a structured claim, so it
      // is the set worth re-checking after the fact — and without this there is
      // no way to ask which entries came from it.
      dateSource,
    },
    _dateSource: dateSource,
    _description: wd?.description || '',
  };
}

const fmtYear = (y) => (y == null ? '' : y < 0 ? `${Math.abs(y)} BC` : String(y));

/**
 * Drop Wikipedia's trailing disambiguator: "Guernica (Picasso)" -> "Guernica",
 * "Metropolis (1927 film)" -> "Metropolis". It exists to make an article title
 * unique across all of Wikipedia, which is not a constraint the atlas has — the
 * subtitle and the year already distinguish entries, and the parenthetical just
 * clutters a card. Kept when removing it would leave nothing.
 */
function displayTitle(t){
  const stripped = String(t).replace(/\s*\([^()]*\)\s*$/, '').trim();
  return stripped.length >= 2 ? stripped : String(t).trim();
}

/** A URL, an exact title, or a search phrase -> a real page title. */
export async function resolveTitle(input){
  const s = String(input || '').trim();
  if(!s) return null;

  const m = s.match(/^https?:\/\/[a-z-]+\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if(m) return decodeURIComponent(m[1]).replace(/_/g, ' ');

  // Confirm an exact title exists before spending a search on it.
  const d = await getJSON(`${WP}/w/api.php?format=json&action=query&redirects=1&titles=${encodeURIComponent(s)}`);
  const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
  if(page && page.pageid) return page.title;

  return await wpSearch(s, 1);
}

/** Every page in a category (optionally recursing one level into subcategories). */
export async function categoryMembers(category, { limit = 500, deep = false } = {}){
  const cat = category.startsWith('Category:') ? category : `Category:${category}`;
  const out = [];
  const subcats = [];
  let cont = null;

  do {
    const u = `${WP}/w/api.php?format=json&action=query&list=categorymembers&cmlimit=500` +
              `&cmtitle=${encodeURIComponent(cat)}&cmtype=page|subcat` +
              (cont ? `&cmcontinue=${encodeURIComponent(cont)}` : '');
    const d = await getJSON(u);
    // getJSON has already retried with backoff, so a null here is a hard failure.
    // Returning the partial list would be worse than failing: the caller cannot tell
    // a truncated listing from a small category, and an alphabetical resume built on
    // one silently skips every title past the break.
    if(!d) throw new Error(`category listing failed after ${out.length} titles — re-run`);
    for(const mem of d?.query?.categorymembers || []){
      if(mem.ns === 14) subcats.push(mem.title);
      else out.push(mem.title);
    }
    cont = d?.continue?.cmcontinue || null;
  } while(cont && out.length < limit);

  if(deep){
    for(const sub of subcats){
      if(out.length >= limit) break;
      const more = await categoryMembers(sub, { limit: limit - out.length, deep: false });
      out.push(...more);
    }
  }

  return out.slice(0, limit);
}

/** Article links on a page — for ingesting a "List of …" article wholesale. */
export async function pageLinks(title, { limit = 500 } = {}){
  const real = await resolveTitle(title);
  if(!real) return [];
  const out = [];
  let cont = null;
  do {
    const u = `${WP}/w/api.php?format=json&action=query&prop=links&plnamespace=0&pllimit=500` +
              `&titles=${encodeURIComponent(real)}` + (cont ? `&plcontinue=${encodeURIComponent(cont)}` : '');
    const d = await getJSON(u);
    // See categoryMembers: fail loudly rather than hand back a partial list.
    if(!d) throw new Error(`link listing failed after ${out.length} titles — re-run`);
    const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
    for(const l of page?.links || []) out.push(l.title);
    cont = d?.continue?.plcontinue || null;
  } while(cont && out.length < limit);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Mining many events out of one page body
// ---------------------------------------------------------------------------

/*
 * `describe()` produces one entry per page, which is the right shape for a
 * painting or a person and the wrong shape for the article that actually holds
 * deep time. "Timeline of natural history" is not an event; it is four hundred of
 * them, each a line with its own date, and the atlas's Earth range is empty
 * without exactly that kind of page.
 *
 * So this reads the whole body and treats each dated line or sentence as a
 * candidate entry. The date is the hard part and lives in `years.mjs` (`findDate`);
 * everything here is about deciding which chunks of text are events at all, and
 * about failing to produce an entry rather than producing a wrong one.
 *
 * ## Two sources, because one page shape was invisible
 *
 * A page states its events either in tables or in prose, and the split is not a
 * matter of degree — *Timeline of English history* is 22 wikitables holding one
 * event per row, and *History of quantum mechanics* is narrative paragraphs.
 * Both returned nothing, for unrelated reasons:
 *
 *   TABLES were never fetched. `prop=extracts&explaintext=1` strips wiki tables
 *   entirely, so the English history page arrived as 1,337 characters of intro
 *   and headings out of 197,000. The miner was not failing to parse those rows;
 *   it never received them. Hence the second fetch below, `action=parse`, and
 *   the only HTML parsing in the pipeline.
 *
 *   PROSE arrived fine but the grammar refused it. See `DATE_LOOSE` in
 *   years.mjs.
 *
 * A table row is the most trustworthy shape there is — a column headed "Year"
 * says outright that the cell is a date and that the row is what it dates — so
 * tables are mined by default and get their own tier, `mined-table`.
 *
 * Prose is now always mined and returned separately, in `prose` rather than
 * `drafts`. The gate that `--events-prose` operates moved from mining to
 * writing: the flag decides whether the caller keeps the loose tier, not whether
 * this function looks for it. That is what lets one `--dry` run tell you the
 * shape of a page. Mining both costs a second walk over lines already in memory
 * and no extra request — the old arrangement made you re-fetch the page to find
 * out that it was prose-shaped.
 */

/** Sections that are apparatus, not content. */
const SKIP_SECTION =
  /^(see also|references?|further reading|external links?|notes?|bibliography|sources?|footnotes?|citations?|gallery)$/i;

/** A trailing abbreviation, meaning that full stop did not end a sentence. */
const ABBR_END = /(?:\b(?:c|ca|cf|vs|St|Mt|Dr|Mr|Mrs|Ms|Jr|Sr|approx|est|fig|no|vol|ch|pp|Fig|Ma|ka|Ga|BC|BCE|AD|CE|e\.g|i\.e)|\b[A-Z]|\bB\.C|\bA\.D)\.$/;

/** Split prose into sentences, without breaking on "c. 1500" or "St. Paul". */
function sentences(text){
  const out = [];
  let buf = '';
  for(const piece of String(text).split(/(?<=[.!?])\s+/)){
    buf = buf ? `${buf} ${piece}` : piece;
    if(ABBR_END.test(buf.trim())) continue;
    out.push(buf.trim());
    buf = '';
  }
  if(buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Leading connectives and separators left behind by cutting the date off.
 *
 * Punctuation included: "2500–1600 Ma. Contains the Palaeoproterozoic…" leaves a
 * full stop at the front, and "720s/710s Droughts on Euboea" a slash.
 */
const DANGLING = /^(?:[–—:\-·•*.,;/\s]+|(?:and|but|then|also|meanwhile|however|approximately|about|around)\b[,\s]*)+/i;

/**
 * A title for a mined event, from the event's own words.
 *
 * Cut at the first strong break — a colon, a dash, or a comma introducing a
 * subordinate clause — because a timeline line is usually "<the thing>: <why it
 * matters>" and the first half is the title. Falls back to the opening words.
 */
function titleFrom(body){
  let s = String(body).replace(DANGLING, '').replace(/\s+/g, ' ').trim();
  if(!s) return '';

  const cut = s.search(/\s[–—]\s|[:;]\s|,\s(?=(?:which|when|where|who|whose|and|while|after|before|marking|leading|making|resulting|beginning|allowing|although|though)\b)/i);
  if(cut > 11) s = s.slice(0, cut);

  s = s.replace(/[\s,;:.–—-]+$/, '');
  if(s.length > 72){
    const words = s.slice(0, 72).split(' ');
    if(words.length > 1) words.pop();          // never end mid-word
    s = words.join(' ').replace(/[\s,;:.–—-]+$/, '');
  }
  // A trailing function word means the cut landed inside a phrase. Repeated,
  // because truncation regularly leaves two of them: "… in a dense region of the"
  // needs both stripped, and one pass left titles ending in "of".
  s = s.replace(/(?:\s+\b(?:of|in|on|at|to|for|from|with|by|and|or|the|a|an))+$/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Wikipedia's own reference litter, which explaintext leaves behind. */
const clean = (s) => String(s)
  .replace(/\[\d+\]/g, '')
  .replace(/\(\s*\)/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

/**
 * Every dated event `page`'s body yields, as draft entries in `describe()`'s shape.
 *
 * Returns `{ drafts, prose, ... }` — two arrays, because the two confidence
 * levels deserve different scrutiny and the caller opts into the looser one:
 *
 *   `drafts`  `mined-table`, a row under a column headed "Year", and
 *             `mined-line`, a line that BEGINS with its date. In both the date
 *             unambiguously belongs to the text beside it.
 *   `prose`   `mined-prose`, a date found inside a sentence. The sentence may be
 *             about something else and merely mention the year — on *Cubism*
 *             this tier returns 105 candidates of which roughly half are
 *             art-historical commentary rather than events. Read them before
 *             writing them.
 *
 * Returns null when the page does not exist.
 */
/** Nothing on Earth is older than the Earth. The bound that settles a separator. */
const EARTH_AGE = 4.6e9;

/**
 * True when a number's decimal point could equally be a thousands separator, and
 * both readings are possible.
 *
 * One page carries "3,400 Ma", "3.400 Ma" and "0.315 Ma". The second is a mistyped
 * thousands separator meaning 3.4 Ga; the third is a real decimal meaning 315 ka;
 * the shapes are identical. Getting it wrong is wrong by a factor of a thousand,
 * which on this axis is the difference between the Archean and last Tuesday.
 *
 * Two things narrow it. An integer part of zero is never a thousands group, so
 * "0.315" is settled. And the age of the Earth bounds the other reading: the
 * Cretaceous-Paleogene extinction is written "66.038 ± 0.011 Ma", and 66,038 Ma
 * would predate the universe, so that one is settled too — which matters, because
 * it is the single most valuable line on the page.
 *
 * What survives both tests really is ambiguous ("2.070 Ma" is either 2.07 or 2,070
 * Ma and the page gives no way to tell), and those are skipped and reported rather
 * than guessed.
 */
function ambiguousSeparator(text){
  const m = /(?<!\d)([1-9]\d*)\.(\d{3})(?!\d)/.exec(text);
  if(!m) return false;
  const asDecimal = parseYears(text).start;
  const asThousands = parseYears(text.replace(m[0], m[1] + m[2])).start;
  if(asDecimal == null || asThousands == null) return false;
  return Math.abs(asThousands) <= EARTH_AGE;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/*
 * Deliberately regex, not a DOM library: the zero-dependency rule holds, and the
 * job is narrow enough to stay honest. Only `wikitable`s are read — the class is
 * what MediaWiki puts on a content table and withholds from the navboxes,
 * infoboxes and maintenance banners that make up every other table on the page.
 * On six timeline articles that filter was exact: every `wikitable` was rows of
 * events and every non-`wikitable` was apparatus.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
                   ndash: '–', mdash: '—', hellip: '…', times: '×' };

/**
 * Decode the entities the API's HTML carries. Needed for more than punctuation:
 * `action=parse` escapes underscores in generated attribute values as `&#95;`,
 * so an unescaped read leaves `cite&#95;ref` litter in the text.
 */
const decodeEntities = (s) => String(s).replace(
  /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi,
  (all, dec, hex, name) => {
    if(dec) return String.fromCodePoint(Number(dec));
    if(hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? all;
  });

/*
 * The `/wiki/…` targets inside a cell, in the order they appear.
 *
 * This is the one piece of a mined event worth more than the sentence itself.
 * A timeline row reads "First trilobites." — seventeen characters, which embeds
 * to almost nothing — but the row's HTML says
 * `<a href="/wiki/Trilobite">trilobites</a>`, and that link is an editor's own
 * disambiguation of what the row is about. Guessing the subject from the text
 * means a search that can return the wrong page; following the link cannot.
 *
 * `cellText` runs after this and throws the markup away, so the extraction has to
 * happen on the raw cell. Namespaced links are skipped: a File: or Category: link
 * is apparatus, not a subject.
 */
const NS_LINK = /^(?:file|image|category|template|portal|help|wikipedia|special|talk|module|s|wikt):/i;

export function cellLinks(html){
  const out = [];
  for(const m of String(html || '').matchAll(/<a\b[^>]*href="\/wiki\/([^"#?]+)"/gi)){
    let t;
    try { t = decodeURIComponent(m[1]); } catch { t = m[1]; }
    t = decodeEntities(t).replace(/_/g, ' ').trim();
    if(!t || NS_LINK.test(t) || INDEX_TITLE.test(t)) continue;
    if(!out.includes(t)) out.push(t);
  }
  return out;
}

/** One table cell's HTML as plain text. */
const cellText = (html) => clean(decodeEntities(String(html)
  // Citation markers first, while they are still identifiable by class. Stripping
  // tags before this would leave the bracketed footnote numbers behind.
  .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, '')
  .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\/(p|div|li|tr)>|<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')));

/** Every `wikitable` on the page, with the offset it starts at. */
function wikitables(html){
  const out = [];
  const open = /<table\b([^>]*)>/gi;
  let m;
  while((m = open.exec(html))){
    const start = open.lastIndex;
    // Walk to the matching close, counting depth. A wikitable containing another
    // table is rare but a non-greedy match on `</table>` would silently truncate
    // it, and the rows after the cut would vanish without a word.
    const scan = /<table\b|<\/table>/gi;
    scan.lastIndex = start;
    let depth = 1, tag;
    while(depth > 0 && (tag = scan.exec(html))) depth += tag[0] === '</table>' ? -1 : 1;
    const end = depth === 0 ? scan.lastIndex - '</table>'.length : html.length;
    if(/wikitable/i.test(m[1])) out.push({ index: m.index, html: html.slice(start, end) });
    open.lastIndex = end;
  }
  return out;
}

/** Section headings with their offsets, so a table can be told which one it is under. */
function headings(html){
  const out = [];
  for(const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)){
    out.push({ index: m.index, title: cellText(m[1]).replace(/\s*\[\s*edit\s*\]\s*$/i, '') });
  }
  return out;
}

/** The cells of one `<tr>`, as `{ tag, html, rowspan, colspan }`. */
function rowCells(rowHtml){
  const out = [];
  // Bounded by the next cell rather than by a closing tag, because a cell's own
  // `</td>` is optional in the wikitext and therefore in what the parser emits.
  const re = /<(t[hd])\b([^>]*)>([\s\S]*?)(?=<t[hd]\b|<\/tr>|$)/gi;
  let m;
  while((m = re.exec(rowHtml))){
    const attrs = m[2] || '';
    const span = (name) => {
      const v = new RegExp(`${name}\\s*=\\s*"?(\\d+)`, 'i').exec(attrs);
      return v ? Math.min(Math.max(parseInt(v[1], 10), 1), 400) : 1;
    };
    out.push({
      tag: m[1].toLowerCase(),
      html: m[3].replace(/<\/t[hd]>\s*$/i, ''),
      rowspan: span('rowspan'),
      colspan: span('colspan'),
    });
  }
  return out;
}

/**
 * A table as a rectangular grid, resolving `rowspan` and `colspan`.
 *
 * Not optional bookkeeping. A year cell spanning several event rows is how these
 * tables avoid repeating a date — 274 of them on *Timeline of Chinese history* —
 * and the rows underneath such a cell carry one fewer `<td>`. Read positionally
 * they shift left, so the Date column's value lands in the Year column and the
 * event text lands in Date. Every one of those rows would be dated wrongly or
 * dropped.
 */
function tableGrid(tableHtml){
  const rows = [];
  const carry = [];                       // per column: { html, left } still spanning
  for(const raw of tableHtml.split(/<tr\b[^>]*>/i).slice(1)){
    const own = rowCells(raw);
    if(!own.length) continue;
    const cells = [], tags = [];
    let col = 0;
    const drain = () => {
      while(carry[col]?.left > 0){
        cells[col] = carry[col].html;
        tags[col] = 'td';
        carry[col].left--;
        col++;
      }
    };
    for(const c of own){
      drain();
      for(let k = 0; k < c.colspan; k++){
        cells[col] = k === 0 ? c.html : '';
        tags[col] = c.tag;
        if(c.rowspan > 1) carry[col] = { html: cells[col], left: c.rowspan - 1 };
        col++;
      }
    }
    drain();                              // columns still spanning past the last cell
    rows.push({ cells: [...cells].map((c) => c ?? ''), tags });
  }
  return rows;
}

/*
 * Which column is which, from the header row.
 *
 * `Year | Date | Event` is not one page's habit but the shape: across six
 * timeline articles it headed 90 of the 91 usable tables, the odd one out being
 * `Year | Date | Events`. Even so this matches on synonyms rather than on that
 * literal, and a table whose header names no date column is skipped and counted
 * rather than guessed at positionally.
 */
const DATE_HEADER =
  /^(years?|yrs?|dates?|times?|period|when|age|epoch|ma|bp|reign)\b/i;
const TEXT_HEADER =
  /^(events?|descriptions?|details?|significances?|notes?|milestones?|developments?|occurrences?|incidents?|summary|outcomes?|results?)\b/i;

function columnRoles(names, rows){
  const date = names.findIndex((n) => DATE_HEADER.test(n));
  if(date < 0) return null;

  let text = names.findIndex((n, i) => i !== date && TEXT_HEADER.test(n));
  if(text < 0){
    // No named description column: take the wordiest one. A table of events puts
    // the prose somewhere, and length is what distinguishes it from a column of
    // regnal numbers or flags.
    const weight = names.map((n, i) => (i === date ? -1 :
      rows.reduce((sum, r) => sum + cellText(r.cells[i] || '').length, 0)));
    text = weight.indexOf(Math.max(...weight));
    if(weight[text] <= 0) return null;
  }
  // A second date column is the finer grain within the year ("Year | Date").
  const fine = names.findIndex((n, i) => i !== date && i !== text && DATE_HEADER.test(n));
  return { date, text, fine };
}

/*
 * A date column's cell, read as a date.
 *
 * The column header is evidence the prose rules do not have, and it is worth a
 * lot: a cell holding "43" under a heading of "Year" is AD 43, where the same
 * two digits in a sentence are a quantity. So a cell that is *nothing but* a
 * year-shaped token is parsed as one, which recovers the 115 rows of 3,464 that
 * `findDate` alone refused — every one of them a real 1-2 digit year, or an
 * "AD 69" with its era written in front of the number instead of after it.
 *
 * Anchored to both ends on purpose. A cell with words in it gets no such licence
 * and falls through to the ordinary grammar.
 */
const CELL_HEDGE = String.raw`(?:(?:c|ca|circa|approx|about|around)\.?\s*|~\s*)?`;
const CELL_ERA = String.raw`(?:AD|CE|BCE?|A\.D\.|B\.C\.(?:E\.)?)`;
const CELL_YEAR = String.raw`\d{1,4}s?`;
const YEAR_CELL = new RegExp(
  `^${CELL_HEDGE}(?:${CELL_ERA}\\s*)?${CELL_YEAR}` +
  `(?:\\s*(?:–|—|-|to)\\s*${CELL_HEDGE}${CELL_YEAR})?(?:\\s*${CELL_ERA})?$`, 'i');

function dateFromCell(text){
  const t = String(text || '').trim();
  if(!t) return null;
  if(YEAR_CELL.test(t)){
    const { start, end } = parseYears(t);
    if(start != null) return { text: t, index: 0, start, end };
  }
  return findDate(t, { anchored: true });
}

/*
 * A year with no era and no unit, five digits or more, in a Year column.
 *
 * "90,000" on *Timeline of Japanese history* heads the Aso Caldera eruption, and
 * means 90,000 years ago; read literally it is a date 88,000 years in the future.
 * The page never says which, and neither reading can be ruled out by arithmetic
 * the way `ambiguousSeparator` rules one out — so these are reported rather than
 * guessed, on the standing rule that a wrong year is worse than a missing entry.
 */
const UNMARKED_LARGE = /^\s*\d{1,3}(?:,\d{3})+\s*$|^\s*\d{5,}\s*$/;

/*
 * A section heading is a topic only sometimes.
 *
 * "Roman Britain" and "Matrix mechanics" say something a year cannot. "1st
 * century BC" does not — it is the entry's own date spelled out, and as a topic
 * it would do what letting `domains` into the embedded text did: cluster entries
 * by a value the axis already carries, so the map re-derives the calendar. And a
 * heading long enough to be a sentence ("Einstein applies quanta to explain the
 * photoelectric effect") is not a label at all; it would be a chip nothing else
 * ever shares.
 */
const PERIOD_WORD =
  /^(?:\d{1,5}(?:st|nd|rd|th|s)?|centur(?:y|ies)|millenni(?:um|a)|decades?|years?|bce?|ce|ad|the|early|mid|late|and|to|[–—-]+)$/i;
const GENERIC_HEADING = /^(history|overview|introduction|timeline|events?|background)$/i;
const TOPIC_MAX = 48;

/*
 * Which era a section is in, when it says so: -1 BC, +1 AD, 0 no idea.
 *
 * *Timeline of ancient Greece* writes every one of its 189 datable lines as a bare
 * number — "777: Cumae is founded by Chalcis" — and states the era once, in the
 * heading above them: "Archaic Period (785–481 BC)". Read literally every entry
 * on that page lands in the wrong millennium, and twenty of them come out as spans
 * running backwards, which is the shape `verify.mjs` refuses.
 *
 * A heading naming both eras ("Han dynasty (206 BC – 220 AD)") settles nothing and
 * returns 0 rather than guessing, which is right: those pages date their rows
 * explicitly anyway, and an explicit era on the row always wins over this.
 */
function eraOf(heading){
  const s = String(heading || '');
  const bc = /\bB\.?C\.?E?\.?\b/i.test(s);
  const ad = /\bA\.?D\.?\b|\bCE\b/i.test(s);
  if(bc && !ad) return -1;
  if(ad && !bc) return 1;
  return 0;
}

/** True when a date's own text names its era, in which case nothing may override it. */
const HAS_ERA = /\bB\.?C\.?E?\.?\b|\bA\.?D\.?\b|\bCE\b|ago|BP|\b[GMk](?:a|yr)\b/i;

/** A heading's trailing span ("Proto-Cubism: 1907–1908"), which the entry's own date already says. */
const HEADING_PERIOD =
  /[\s:,–—-]+(?:c\.?\s*)?\d{3,4}s?(?:\s*(?:–|—|-|to|and)\s*(?:c\.?\s*)?\d{3,4}s?)?\s*(?:BCE?|AD|CE)?$/i;

function topicFrom(heading){
  const h = String(heading || '').replace(HEADING_PERIOD, '').trim();
  if(!h || h.length > TOPIC_MAX || GENERIC_HEADING.test(h)) return null;
  const words = h.toLowerCase().match(/[\p{L}\d]+|[–—-]+/gu) || [];
  if(!words.length || words.every((w) => PERIOD_WORD.test(w))) return null;
  return h.toLowerCase();
}

/**
 * `minChars` where the date is known to govern the text: a table row, or a line
 * that begins with its date.
 *
 * The floor exists to reject a date with *nothing* attached — a year in a table
 * of contents, a bare caption — and 40 characters is the right guess only for a
 * sentence pulled out of a paragraph, where the remainder may be about anything.
 * A row under a column headed "Event" is an event by declaration, and so is a
 * line that opens with its own year; both are frequently terse. The 40-char floor
 * was silently discarding 72 events from *Timeline of natural history*, among
 * them "First trilobites." and "Vredefort impact structure forms." — precisely
 * the deep-time rows the whole `--events` path exists to collect.
 */
const DATED_MIN_CHARS = 12;

export async function mineEvents(page, { limit = 400, minChars = 40, maxChars = 700 } = {}){
  const title = await resolveTitle(page);
  if(!title) return null;

  const [extract, parsed] = await Promise.all([
    getJSON(`${WP}/w/api.php?format=json&action=query&prop=extracts&explaintext=1&exlimit=1&redirects=1&titles=${encodeURIComponent(title)}`),
    getJSON(`${WP}/w/api.php?format=json&action=parse&prop=text&redirects=1&page=${encodeURIComponent(title)}`),
  ]);
  const pg = extract?.query?.pages ? Object.values(extract.query.pages)[0] : null;
  const body = String(pg?.extract || '');
  const html = String(parsed?.parse?.text?.['*'] || '');
  // `noHtml` matters enough to report: it means the second fetch failed and the
  // table path is silently off, which reads exactly like a page with no tables.
  const tally = { tables: 0, tablesSkipped: 0, rows: 0, noHtml: !html };
  if(!body && !html) return { page: title, drafts: [], skipped: [], scanned: 0, tally };

  const url = `${WP}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const drafts = [];
  /*
   * Prose drafts are collected apart from the strict ones and returned apart,
   * because the caller decides whether to keep them but this function no longer
   * decides whether to look. Two separate arrays rather than one tagged list so
   * that `limit` and the dedupe below cannot let the noisy tier crowd out the
   * trustworthy one — see the second pass at the bottom.
   */
  const prose = [];
  let sink = drafts;
  const skipped = [];
  const seen = new Set();
  let section = '';
  // The page's own title is a weaker era hint than a section heading, and is
  // overridden by one ("Timeline of the 1st millennium BC" vs a section in AD).
  const pageEra = eraOf(title);

  /*
   * The one place a draft is created, so that a row and a sentence cannot drift
   * apart in how they are guarded, deduped or dated. `date` is `findDate`'s shape;
   * `text` is what the title is made from and `excerpt` is what is stored.
   */
  const push = ({ text, excerpt, date, source, topic, facets, floor = minChars, links }) => {
    if(sink.length >= limit) return;
    const name = titleFrom(text);
    if(name.length < 3 || text.replace(DANGLING, '').length < floor) return;
    if(excerpt.length > maxChars) return;
    if(ambiguousSeparator(date.text)){
      skipped.push([name, `ambiguous separator in "${date.text}"`]);
      return;
    }

    // A bare year under a heading that names its era belongs to that era. Written
    // into `yearText` rather than applied to the numbers alone, because verify.mjs
    // requires the stored text to re-parse to the stored year — and because the
    // card should say "777 BC", which is what the page means.
    let { text: yearText, start, end } = date;
    if(start > 0 && !HAS_ERA.test(yearText) && (eraOf(topic) || pageEra) === -1){
      yearText = `${yearText} BC`;
      ({ start, end } = parseYears(yearText));
    }

    /*
     * Last line of defence. A span that runs backwards is a date this code has
     * misread — an abbreviation it failed to expand, an era it could not infer —
     * and `verify.mjs` asserts the store holds none. Refusing it and saying so is
     * the only honest option left; guessing at this point is guessing.
     */
    if(end != null && end < start){
      skipped.push([name, `backwards span in "${yearText}"`]);
      return;
    }

    const key = `${start}|${name.toLowerCase()}`;
    if(seen.has(key)) return;                  // the same event listed twice
    seen.add(key);

    const span = end != null && end !== start;
    sink.push({
      title: name,
      subtitle: '',
      excerpt,
      image: '',
      start,
      end: span ? end : start,
      kind: span ? 'span' : 'point',
      yearText,
      // A relative date ("66 million years ago") is approximate by construction,
      // and so are a hedged one and a decade ("the 1920s"). detail.js renders
      // this as "approx.".
      circa: isCirca(yearText) ||
        /ago|BP|\b[GMk](?:a|yr)\b|billion|million|thousand|\d0s\b/i.test(yearText),
      topics: [topicFrom(topic)].filter(Boolean),
      facets: facets || {},
      origin: { wiki: url, qid: null, manual: true },
      _dateSource: source,
      _mined: title,
      // Subject candidates for `thicken` in ingest.mjs. Underscore-prefixed, so
      // `makeEntry` drops it and it never reaches the store.
      _links: links || [],
    });
  };

  /** A dated chunk of running text: one timeline line, or one sentence. */
  const addChunk = (chunk, date, source) => {
    // Excise the date only when it leads, which is when it is punctuation rather
    // than grammar: "1066 – the Norman conquest" wants the date gone from its
    // title, but cutting 1877 out of "Boltzmann suggested in 1877 that…" leaves
    // "suggested in that". Mid-sentence the date stays where the author put it.
    const cut = date.index === 0 || !clean(chunk.slice(0, date.index));
    const text = cut
      ? clean(chunk.slice(0, date.index) + chunk.slice(date.index + date.text.length))
      : clean(chunk);
    push({ text, excerpt: clean(chunk), date, source, topic: section,
           floor: cut ? DATED_MIN_CHARS : minChars });
  };

  // -- tables ---------------------------------------------------------------
  const heads = headings(html);
  for(const table of wikitables(html)){
    const rows = tableGrid(table.html);
    const header = rows.find((r) => r.cells.length > 1 &&
      r.tags.filter((t) => t === 'th').length >= r.cells.length - 1);
    const roles = header && columnRoles(header.cells.map(cellText), rows);
    if(!roles){ tally.tablesSkipped++; continue; }

    let under = '';
    for(const h of heads){ if(h.index < table.index) under = h.title; else break; }
    if(SKIP_SECTION.test(under)){ tally.tablesSkipped++; continue; }
    tally.tables++;
    section = under;

    for(const row of rows){
      if(row === header) continue;
      const when = cellText(row.cells[roles.date] || '');
      const what = cellText(row.cells[roles.text] || '');
      // A row with an empty cell in either column is a divider or a spanning
      // sub-heading, not an event.
      if(!when || !what) continue;
      tally.rows++;

      const date = dateFromCell(when);
      if(!date){
        if(UNMARKED_LARGE.test(when)) skipped.push([what.slice(0, 40), `unmarked large year "${when}"`]);
        continue;
      }
      // The finer date cannot go in `yearText`, which verify.mjs requires to
      // re-parse to the stored year — "24 January AD 41" parses to 24. It is real
      // information, so it is kept as a facet instead.
      const fine = roles.fine >= 0 ? cellText(row.cells[roles.fine] || '') : '';
      push({
        text: what, excerpt: what, date, source: 'mined-table', topic: section,
        facets: fine && fine !== when ? { date: fine } : {},
        floor: DATED_MIN_CHARS,
        links: cellLinks(row.cells[roles.text] || ''),
      });
    }
  }

  /*
   * -- running text ---------------------------------------------------------
   *
   * Two passes over the same lines, and the order is the point.
   *
   * The strict pass runs to completion first, so `seen` is complete before a
   * single prose draft is considered. Interleaved — which is what a single pass
   * does — a loose match on line 5 claims the `start|title` key and silently
   * blocks the line-anchored statement of the same event on line 800. That draft
   * is then dropped again at write time for being prose, and the event vanishes
   * from a run that never asked for prose at all.
   *
   * `limit` likewise applies per tier, because `sink` swaps between the passes.
   * A page's trustworthy events can no longer be crowded out of the budget by
   * sentences the caller may well discard.
   */
  const eachLine = (fn) => {
    section = '';
    let n = 0;
    for(const raw of body.split('\n')){
      const line = clean(raw);
      if(!line) continue;
      const head = line.match(/^(=+)\s*(.*?)\s*\1$/);
      if(head){ section = head[2]; continue; }
      if(SKIP_SECTION.test(section)) continue;
      n++;
      fn(line);
    }
    return n;
  };

  const anchoredOf = new Map();
  const scanned = eachLine((line) => {
    const anchored = findDate(line, { anchored: true });
    anchoredOf.set(line, anchored);
    if(anchored) addChunk(line, anchored, 'mined-line');
  });

  sink = prose;
  eachLine((line) => {
    if(anchoredOf.get(line)) return;             // the strict pass already took it
    for(const sent of sentences(line)){
      const date = findDate(sent, { loose: true });
      if(date) addChunk(sent, date, 'mined-prose');
    }
  });

  return { page: title, drafts, prose, skipped, scanned, tally };
}

/** Describe many pages with polite concurrency. */
export async function describeMany(inputs, { concurrency = 6, onEach } = {}){
  return mapPool(inputs, concurrency, async (input, i) => {
    try {
      const d = await describe(input);
      onEach?.(d, input, i);
      return d;
    } catch(e){
      onEach?.(null, input, i, e);
      return null;
    }
  });
}
