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
import { parseYears, isCirca } from './years.mjs';

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

/** Title shapes that are indexes rather than subjects. */
const INDEX_TITLE = /^(list|lists|index|outline|glossary|timeline|chronology|bibliography|filmography|discography)\s+of\b|^(category|template|portal|draft|help|wikipedia|module):/i;

const yearFromTime = (t) => {
  const m = String(t || '').match(/^([+-])(\d+)/);
  return m ? (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10) : null;
};

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

/** Lead paragraphs as plain text, longer than the REST summary's one sentence. */
async function leadText(title, maxChars = 1500){
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

  for(const rule of DATE_CLAIMS){
    if(rule.span){
      const a = yearFromTime(claimValues(claims, rule.span[0])[0]?.time);
      const b = yearFromTime(claimValues(claims, rule.span[1])[0]?.time);
      if(a != null){
        start = a;
        end = b ?? new Date().getFullYear();     // still ongoing / still alive
        kind = 'span';
        dateSource = rule.span.join('+');
        break;
      }
    } else {
      const y = yearFromTime(claimValues(claims, rule.point)[0]?.time);
      if(y != null){ start = end = y; kind = 'point'; dateSource = rule.point; break; }
    }
  }

  // Fall back to the text. A parenthetical in the title ("Metropolis (1927 film)")
  // is the most reliable of these; a year in the first sentence is next.
  if(start == null){
    const paren = title.match(/\((\d{3,4})\b/);
    const inText = (lead || summary.extract || '').slice(0, 300)
      .match(/\b(\d{3,4})\s*(BCE?|BC)\b|\b(1\d{3}|20\d{2}|[5-9]\d{2})\b/);
    const guess = paren ? paren[1] : (inText ? (inText[1] || inText[3]) : null);
    if(guess){
      const neg = inText && inText[2];
      start = end = (neg ? -1 : 1) * parseInt(guess, 10);
      dateSource = paren ? 'title' : 'lead-text';
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
    start, end, kind,
    yearText: start == null ? '' : yearText,
    circa: isCirca(lead || '') && dateSource === 'lead-text',
    topics,
    facets,
    origin: {
      wiki: `${WP}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      qid: summary.qid || null,
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
    const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
    for(const l of page?.links || []) out.push(l.title);
    cont = d?.continue?.plcontinue || null;
  } while(cont && out.length < limit);
  return out.slice(0, limit);
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
