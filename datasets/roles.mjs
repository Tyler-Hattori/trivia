#!/usr/bin/env node
/**
 * Fill a `role` column on `leaders.csv` from Wikidata P39 (position held).
 * Free — one Wikipedia search and one Wikidata read per row, no model.
 *
 *   node datasets/roles.mjs --dry            report only
 *   node datasets/roles.mjs                  write the column
 *   node datasets/roles.mjs --limit 50       first 50 rows needing work
 *   node datasets/roles.mjs --force          overwrite roles already present
 *
 * ## Why a role column exists
 *
 * The atlas names a cluster with the vocabulary term nearest its centroid, and
 * that vocabulary is harvested from the corpus — a term has to appear in at
 * least six entries to be a candidate at all. Which means the corpus can only
 * name a cluster with words the corpus actually uses.
 *
 * The 612-entry cluster of world political leaders was labelled
 * `President · United States`, accurate for about 11% of its members. Rescoring
 * it against the real vocabulary showed why: `politician` has the HIGHEST cosine
 * to that centroid of any term in the corpus (0.700, tied with `political`) and
 * finishes 46th, because it appears in 20 of 4,126 entries and the generality
 * term is computed from literal document frequency. `leader` appears in 69.
 * `head of state` and `political leader` do not clear the six-entry floor at all.
 *
 * So the words are missing rather than mis-ranked. Every one of the 999 leaders
 * carries exactly two facets, `country` and `party` — rich enough that the
 * fine-grained labels read well (`Mexico · Mexican Government · Reforms`) and
 * silent on what any of these people actually *were*. There is no word in that
 * corpus for the category the cluster is made of.
 *
 * P39 supplies it, from the same free API the rest of the pipeline uses.
 *
 * ## Why the office is normalised
 *
 * P39 gives "President of Mexico", "Emperor of Japan", "Prime Minister of the
 * United Kingdom" — each specific to one country, so each lands in a handful of
 * entries and none clears the document-frequency floor. Storing the head noun
 * instead ("president", "emperor", "prime minister") is what puts a real
 * category noun in front of the labeller. The country is already its own facet,
 * so nothing is lost.
 *
 * ## Choosing among many offices, and among many people
 *
 * A career politician's P39 lists a dozen positions. The row is about one of
 * them — the one whose dates are the row's dates — so a claim whose P580/P582
 * qualifiers overlap the CSV's year span is preferred, and seniority breaks the
 * tie. Without the date test "Prime Minister of the United Kingdom" loses to
 * "Member of the 32nd Parliament" often enough to matter.
 *
 * The same span settles WHICH PERSON, which is the harder half. Searching the
 * bare name returns several plausible pages ("Constantine II of Greece",
 * "Constantine II (emperor)", "Constantine II of Scotland" — all humans holding
 * real offices), so the walk below stops at the first candidate whose office
 * dates overlap the row's years, and only falls back to the first plausible one
 * if none does.
 *
 * Do NOT put the country in the search query. That was the first version, copied
 * from enrich.mjs, and it is worse than useless on this dataset: "Marcus
 * Aurelius rome" ranks *Equestrian statue of Marcus Aurelius* first, "Septimius
 * Severus rome" ranks *Arch of Septimius Severus*. 110 rows failed as
 * `not-a-person` because of that one extra word.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDataset, writeDataset, wpSearch, wpSummary, getJSON, mapPool, sleep,
} from './wikilib.mjs';
import { parseYears } from './lib/years.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WD = 'https://www.wikidata.org';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const a = argv.find((x) => x.startsWith(`--${f}=`));
  if(a) return a.split('=')[1];
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DRY = has('--dry');
const FORCE = has('--force');
const LIMIT = val('limit') ? parseInt(val('limit'), 10) : Infinity;
// 3, not enrich.mjs's 5: this script makes up to four sequential requests per
// row against two hosts, and at 5 a long contiguous stretch of the file came
// back empty from the search API. Slower and complete beats fast and holed.
const CONC = parseInt(val('concurrency', '3'), 10);

const FILE = path.join(HERE, 'leaders.csv');

/*
 * Office label -> the category noun to store, most senior first.
 *
 * Ordered, and the first match wins, because labels compose: "Holy Roman
 * Emperor" must reach `emperor` before "Roman" can suggest anything else, and
 * "Prime Minister" must be tested before "Minister". A leading nationality or
 * period adjective is why matching a bare head word does not work — "Roman
 * emperor", "Byzantine emperor" and "Emperor of Japan" are one role in three
 * grammatical shapes.
 */
const ROLE_PATTERNS = [
  [/\bpharaoh\b/i,                       'pharaoh'],
  [/\b(?:holy roman )?empress\b/i,       'empress'],
  [/\b(?:holy roman )?emperor\b/i,       'emperor'],
  [/\bcaliph\b/i,                        'caliph'],
  [/\bsultan(?:a)?\b/i,                  'sultan'],
  [/\bt[sz]ar(?:ina|itsa)?\b|\bczar\b/i, 'tsar'],
  [/\bshah\b|\bshahanshah\b/i,           'shah'],
  [/\bkhan\b|\bkhagan\b/i,               'khan'],
  [/\bpope\b|\bbishop of rome\b/i,       'pope'],
  [/\bqueen\b/i,                         'queen'],
  [/\bking\b/i,                          'king'],
  [/\bmonarch\b|\bsovereign\b/i,         'monarch'],
  [/\bgrand duke\b|\bgrand duchess\b/i,  'grand duke'],
  [/\barchduke\b/i,                      'archduke'],
  [/\bdoge\b/i,                          'doge'],
  [/\bemir\b/i,                          'emir'],
  [/\bduke\b|\bduchess\b/i,              'duke'],
  [/\bprince(?:ss)?\b/i,                 'prince'],
  [/\bregent\b/i,                        'regent'],
  [/\bviceroy\b/i,                       'viceroy'],
  [/\bgovernor[- ]general\b/i,           'governor-general'],
  [/\bpresident\b/i,                     'president'],
  [/\bprime minister\b|\bpremier\b|\btaoiseach\b|\bchancellor\b/i, 'prime minister'],
  [/\bgeneral secretary\b|\bfirst secretary\b/i, 'general secretary'],
  [/\bparamount leader\b|\bsupreme leader\b/i,   'supreme leader'],
  [/\bdictator\b/i,                      'dictator'],
  [/\bchairman\b|\bchairperson\b/i,      'chairman'],
  [/\bconsul\b/i,                        'consul'],
  [/\bgovernor\b/i,                      'governor'],
  [/\bminister\b/i,                      'minister'],
  [/\bstadtholder\b/i,                   'stadtholder'],
  [/\bcount\b|\bearl\b/i,                'count'],
  [/\blord protector\b/i,                'lord protector'],
];

/** Rank for tie-breaking; earlier in the table means more senior. */
const SENIORITY = new Map(ROLE_PATTERNS.map(([, r], i) => [r, ROLE_PATTERNS.length - i]));

function normaliseOffice(label){
  for(const [re, role] of ROLE_PATTERNS) if(re.test(label)) return role;
  // Unmatched: the phrase before " of " is still a category noun more often than
  // not ("Ard-rí of Ireland" -> "ard-rí"). Reported, so the table can grow.
  const head = String(label).split(/\s+of\s+/i)[0].toLowerCase().trim();
  return head && head.length <= 24 ? head : null;
}

const yearFromTime = (t) => {
  const m = String(t || '').match(/^([+-])(\d+)/);
  return m ? (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10) : null;
};

/** Do [a0,a1] and [b0,b1] share any year? Open ends count as reaching forever. */
function overlaps(a0, a1, b0, b1){
  if(a0 == null || b0 == null) return false;
  const A1 = a1 ?? a0, B1 = b1 ?? b0;
  return a0 <= B1 && b0 <= A1;
}

/**
 * QID -> English label, batched 50 at a time and cached across the run.
 *
 * Declared above the walk below rather than hoisted after it: the walk is a
 * top-level await, so a `const` cache declared underneath is still in its
 * temporal dead zone when the first request lands.
 */
const labelCache = new Map();
async function labelsFor(qids){
  const need = [...new Set(qids)].filter((q) => q && !labelCache.has(q));
  for(let i = 0; i < need.length; i += 50){
    const chunk = need.slice(i, i + 50);
    const d = await getJSON(
      `${WD}/w/api.php?format=json&action=wbgetentities&props=labels&languages=en&ids=${chunk.join('|')}`);
    for(const [qid, e] of Object.entries(d?.entities || {})){
      labelCache.set(qid, e.labels?.en?.value || null);
    }
    for(const q of chunk) if(!labelCache.has(q)) labelCache.set(q, null);
  }
  const out = {};
  for(const q of qids) if(labelCache.get(q)) out[q] = labelCache.get(q);
  return out;
}

const rows = readDataset(FILE).rows;
let headers = readDataset(FILE).headers;
if(!headers.includes('role')){
  // Before `excerpt`, so the human-readable column stays last.
  const at = headers.indexOf('excerpt');
  headers = at >= 0
    ? [...headers.slice(0, at), 'role', ...headers.slice(at)]
    : [...headers, 'role'];
}
for(const r of rows) if(r.role === undefined) r.role = '';

const targets = rows.map((r, i) => ({ r, i }))
  .filter(({ r }) => FORCE || !String(r.role || '').trim())
  .slice(0, LIMIT);

console.log(`leaders.csv: ${targets.length} rows need a role (of ${rows.length} total)`);

const log = [];
const misses = [];
const unmatched = new Map();
let done = 0;

/**
 * Rank one candidate page's P39 claims for a row covering `rowStart..rowEnd`.
 * Returns [] when the page is not a person, or holds no readable office.
 */
async function officesFor(qid, rowStart, rowEnd){
  const d = await getJSON(
    `${WD}/w/api.php?format=json&action=wbgetentities&props=claims&languages=en&ids=${qid}`);
  const claims = d?.entities?.[qid]?.claims || {};

  // A position is held by a person. Without this check a search that lands on
  // "Presidency of Mexico" — the office, not the officeholder — answers
  // confidently and wrongly.
  const p31 = (claims.P31 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  if(!p31.includes('Q5')) return { notPerson: true, scored: [] };

  const held = (claims.P39 || []).filter((c) => c.rank !== 'deprecated');
  if(!held.length) return { scored: [] };

  const labels = await labelsFor(held.map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean));

  const scored = [];
  for(const c of held){
    const oq = c.mainsnak?.datavalue?.value?.id;
    const label = oq && labels[oq];
    if(!label) continue;
    const role = normaliseOffice(label);
    if(!role) continue;
    if(!ROLE_PATTERNS.some(([, x]) => x === role)){
      unmatched.set(label, (unmatched.get(label) || 0) + 1);
    }
    const q = c.qualifiers || {};
    const s = yearFromTime(q.P580?.[0]?.datavalue?.value?.time);
    const e = yearFromTime(q.P582?.[0]?.datavalue?.value?.time);
    // The date test dominates seniority: the row is about the term it records,
    // and a lesser office held during those years beats a grander one held
    // thirty years earlier.
    const dated = overlaps(rowStart, rowEnd, s, e) ? 100 : 0;
    scored.push({ role, label, score: dated + (SENIORITY.get(role) || 0), dated: !!dated, s, e });
  }
  scored.sort((a, b) => b.score - a.score);
  return { scored };
}

await mapPool(targets, CONC, async ({ r, i }) => {
  await sleep(80);                                   // politeness jitter
  const name = String(r.name || '').trim();
  const country = String(r.country || '').trim();
  const record = { row: i + 2, name, country };
  const { start: rowStart, end: rowEnd } = parseYears(String(r.years || ''));

  /*
   * Search on the BARE NAME, and take several candidates.
   *
   * Appending the country — which is what the first version did, copying
   * enrich.mjs — measurably degrades the query on exactly the rows this dataset
   * is full of. "Marcus Aurelius rome" ranks *Equestrian statue of Marcus
   * Aurelius* first, "Septimius Severus rome" ranks *Arch of Septimius Severus*,
   * and "Justinian I eastern rome/byzantine" ranks *Byzantine Empire under the
   * Justinian dynasty*. A monument is not a person, so 110 rows failed as
   * `not-a-person` for no reason other than the extra word.
   *
   * The row's own years disambiguate far better than its country does. Both
   * "Constantine II of Greece" (1964–1973) and "Constantine II (emperor)"
   * (337–340) are humans holding offices; only one of them overlaps a row dated
   * 337. So: walk the candidates, and stop at the first whose office dates
   * actually overlap the row. Country is kept only as a fallback query for a
   * name that finds nothing at all.
   */
  let candidates = (await wpSearch(name, 5)) || [];
  if(!Array.isArray(candidates)) candidates = [candidates].filter(Boolean);
  /*
   * An empty result and a failed request are the same value here — `getJSON`
   * returns null once its retries are exhausted, and `wpSearch` cannot tell the
   * caller which happened. The first full run recorded 329 rows as
   * `no-search-hit` that all returned a page when tried again by hand, in one
   * contiguous stretch of the file, which is the shape of throttling rather
   * than of absent articles. So back off and ask once more before believing it.
   */
  if(!candidates.length){
    await sleep(1200);
    candidates = (await wpSearch(name, 5)) || [];
    if(!Array.isArray(candidates)) candidates = [candidates].filter(Boolean);
  }
  if(!candidates.length && country){
    const t = await wpSearch(`${name} ${country}`);
    if(t) candidates = [t];
  }
  if(!candidates.length){ misses.push({ ...record, reason: 'no-search-hit' }); return; }

  let fallback = null;
  let sawPerson = false;
  for(const title of candidates){
    const sum = await wpSummary(title);
    if(!sum?.qid) continue;
    const { notPerson, scored } = await officesFor(sum.qid, rowStart, rowEnd);
    if(notPerson || !scored.length) continue;
    sawPerson = true;
    const hit = { title, qid: sum.qid, best: scored[0], offices: scored.length };
    if(scored[0].dated){ fallback = hit; break; }     // dates agree — settled
    if(!fallback) fallback = hit;                     // plausible, keep looking
  }

  if(!fallback){
    misses.push({ ...record, candidates: candidates.slice(0, 3),
                  reason: sawPerson ? 'no-readable-office' : 'no-person-with-office' });
    return;
  }

  if(!DRY) r.role = fallback.best.role;
  log.push({
    ...record, title: fallback.title, qid: fallback.qid,
    role: fallback.best.role, office: fallback.best.label,
    matchedOnDates: fallback.best.dated, offices: fallback.offices,
  });

  if(++done % 50 === 0) console.log(`  ...${done}/${targets.length}`);
});

const tally = new Map();
for(const l of log) tally.set(l.role, (tally.get(l.role) || 0) + 1);

console.log('\n=== roles found ===');
for(const [role, n] of [...tally].sort((a, b) => b[1] - a[1])){
  console.log(`  ${String(n).padStart(4)}  ${role}`);
}
console.log(`\n  ${log.length} filled · ${misses.length} missed` +
            ` · ${log.filter((l) => l.matchedOnDates).length} chosen by date overlap`);

const byReason = {};
for(const m of misses) byReason[m.reason] = (byReason[m.reason] || 0) + 1;
if(misses.length) console.log(`  misses: ${JSON.stringify(byReason)}`);

if(unmatched.size){
  const top = [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n  ${unmatched.size} office labels fell through ROLE_PATTERNS to a head-word guess.`);
  console.log(`  Worth adding to the table if any of these is common:`);
  for(const [label, n] of top) console.log(`    ${String(n).padStart(3)}  ${label}`);
}

if(DRY){
  console.log('\nDRY RUN — nothing written.');
} else {
  writeDataset(FILE, rows, headers);
  fs.writeFileSync(path.join(HERE, 'leaders.roles-log.json'), JSON.stringify(log, null, 2));
  fs.writeFileSync(path.join(HERE, 'leaders.roles-misses.json'), JSON.stringify(misses, null, 2));
  console.log(`\nwrote leaders.csv (backup at leaders.csv.bak)`);
  console.log(`     leaders.roles-log.json (${log.length}) · leaders.roles-misses.json (${misses.length})`);
  console.log(`\nNext: node datasets/migrate.mjs && node datasets/embed-all.mjs --force && node datasets/atlas.mjs --rebuild`);
}
