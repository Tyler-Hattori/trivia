#!/usr/bin/env node
/**
 * Crawl Wikipedia categories into the store. Free (Wikipedia/Wikidata APIs),
 * resumable, bounded.
 *
 *     node datasets/crawl.mjs                     # every pending line of datasets/crawl.txt
 *     node datasets/crawl.mjs --dry               # list what each line would pull, write nothing
 *     node datasets/crawl.mjs "Battles involving England" --depth 1 --limit 300
 *     node datasets/crawl.mjs --redo "Cubist paintings"
 *
 * After ingesting it runs `classify.mjs` (subject labels for the new pages) and
 * `atlas.mjs` (places them without moving anything else), so one command is
 * the whole pipeline.
 *
 * ## Bounded on purpose
 *
 * Wikipedia's category graph is a web with cycles, not a tree. From "History",
 * a few levels of subcategories reaches a large share of the encyclopedia. So:
 *
 *   --depth N     subcategory levels to descend (default 1; 0 = the category only)
 *   --limit N     pages per line, total (default 300)
 *   a seen-set    no category is listed twice, so cycles terminate
 *   date bins     subcategories that are pure date bins ("1066 in England") are
 *                 skipped: they hold everything that happened that year
 *
 * Start from SPECIFIC categories ("Battles involving England", "Paintings by
 * Claude Monet", "Wars of the Roses"), not top-level ones.
 *
 * Embedding the new rows is the only local compute, throttled in ingest.mjs.
 *
 * ## crawl.txt — three kinds of line
 *
 *     # source                                      | domain   | depth | limit
 *     Battles involving the Kingdom of England      | england  | 1     | 300
 *     search: articletopic:visual-arts painting     | art      | -     | 200
 *     wikidata: painting 1880-1889                  | art      | -     | 200
 *
 *   CATEGORY   a Wikipedia category and `depth` levels of its subcategories.
 *   search:    Wikipedia's own search (CirrusSearch). Accepts its keywords, so a
 *              SUBJECT is `articletopic:<topic>` — the same Wikimedia taxonomy
 *              classify.mjs files entries under (visual-arts, military-and-warfare,
 *              physics, history, biography, films…) — and can be combined:
 *              `articletopic:military-and-warfare incategory:"Kingdom of England"`.
 *   wikidata:  a TYPE and a YEAR RANGE, most famous first (by sitelinks). The way
 *              to ask for a decade: "painting 1880-1889", "battle 1600-1699",
 *              "treaty 1700-1799", "person 1850-1859" (born then). A type is a
 *              word from WD_TYPES below or a raw QID (Q3305213). Uses the free
 *              Wikidata Query Service.
 *
 * Command-line equivalents:
 *     node datasets/crawl.mjs --search "articletopic:physics discovery" --limit 150
 *     node datasets/crawl.mjs --wikidata "painting 1880-1889" --limit 200 --domain art
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEntries, slugify } from './lib/store.mjs';
import { getJSON } from './wikilib.mjs';
import { INDEX_TITLE } from './lib/wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.join(HERE, 'crawl.txt');
const STATE = path.join(HERE, 'crawl-state.json');
const WP = 'https://en.wikipedia.org/w/api.php';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DRY = argv.includes('--dry');
const REDO = arg('--redo');
const one = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--dry'].includes(argv[i - 1])));

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {} };
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');

/** Words the `wikidata:` line understands. Direct instance-of, so the query stays fast. */
const WD_TYPES = {
  painting: 'Q3305213', sculpture: 'Q860861', battle: 'Q178561', war: 'Q198', siege: 'Q188055',
  treaty: 'Q131569', rebellion: 'Q124734', revolution: 'Q10931', film: 'Q11424', novel: 'Q8261',
  book: 'Q7725634', 'literary work': 'Q7725634', poem: 'Q5185279', opera: 'Q1344', symphony: 'Q200629',
  building: 'Q41176', cathedral: 'Q2977', castle: 'Q23413', invention: 'Q1068065', discovery: 'Q12772819',
  election: 'Q40231', disaster: 'Q3839081', expedition: 'Q2401485', person: 'Q5', human: 'Q5',
};

/** Which date a type is dated by: made, released, happened, began, born. */
const WD_DATE = {
  Q3305213: 'wdt:P571', Q860861: 'wdt:P571', Q41176: 'wdt:P571', Q2977: 'wdt:P571', Q23413: 'wdt:P571',
  Q1344: 'wdt:P571', Q200629: 'wdt:P571',
  Q11424: 'wdt:P577', Q8261: 'wdt:P577', Q7725634: 'wdt:P577', Q5185279: 'wdt:P577',
  Q178561: 'wdt:P585', Q188055: 'wdt:P585', Q40231: 'wdt:P585', Q3839081: 'wdt:P585', Q131569: 'wdt:P585|wdt:P571',
  Q198: 'wdt:P580', Q124734: 'wdt:P580', Q10931: 'wdt:P580', Q2401485: 'wdt:P580',
  Q1068065: 'wdt:P575|wdt:P571', Q12772819: 'wdt:P575',
  Q5: 'wdt:P569',
};

/** Pages from Wikipedia search (CirrusSearch keywords allowed, e.g. articletopic:). */
async function searchPages(query, limit){
  const pages = [];
  for(let off = 0; pages.length < limit; ){
    const d = await getJSON(`${WP}?format=json&action=query&list=search&srnamespace=0&srlimit=500&srprop=&sroffset=${off}&srsearch=${encodeURIComponent(query)}`);
    if(!d) throw new Error(`search "${query}" failed — re-run`);
    for(const r of d.query?.search || []) if(!INDEX_TITLE.test(r.title)) pages.push(r.title);
    if(!d.continue?.sroffset) break;
    off = d.continue.sroffset;
  }
  return { pages: pages.slice(0, limit), categories: 0, pendingSubcats: 0 };
}

/** Pages for "<type> <from>-<to>", most famous first, from the Wikidata Query Service. */
async function wikidataPages(spec, limit){
  const m = spec.match(/^(.+?)\s+(-?\d{1,4})\s*[-–]\s*(-?\d{1,4})$/);
  if(!m) throw new Error(`wikidata line must be "<type> <from>-<to>", got "${spec}"`);
  const type = m[1].trim().toLowerCase();
  const qid = /^Q\d+$/i.test(type) ? type.toUpperCase() : WD_TYPES[type];
  if(!qid) throw new Error(`unknown type "${type}" — use one of: ${Object.keys(WD_TYPES).join(', ')}, or a QID`);
  const [from, to] = [Number(m[2]), Number(m[3])];
  // People are dated by birth; everything else by when it happened or was made.
  // Shaped for the query service's time limit: notability (≥3 language
  // editions) is filtered FIRST — most of Wikidata's ~1M paintings are museum
  // catalogue items with no article — and dates are compared as literals rather
  // than through YEAR(), which cannot use an index. Either alone timed out (504).
  // ONE date property per type where possible: an alternation (P571|P585|…) over
  // ~1M paintings timed out; inception alone answers in ~25s.
  const dateProps = WD_DATE[qid] || 'wdt:P571|wdt:P585|wdt:P580|wdt:P577';
  const lit = (y, end) => `"${y < 0 ? '-' : ''}${String(Math.abs(y)).padStart(4, '0')}-${end ? '12-31' : '01-01'}T00:00:00Z"^^xsd:dateTime`;
  const q = `SELECT DISTINCT ?title ?sl WHERE {
    ?item wdt:P31 wd:${qid} ; wikibase:sitelinks ?sl .
    FILTER(?sl >= 3)
    ?item ${dateProps} ?d .
    FILTER(?d >= ${lit(from)} && ?d <= ${lit(to, true)})
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
  } ORDER BY DESC(?sl) LIMIT ${limit}`;
  const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': 'trivia-dev/0.1 (tylerwhattori@gmail.com; personal study project)', Accept: 'application/sparql-results+json' } });
  if(!r.ok){
    // The query service has a 60s limit. For a decade of a common type, Wikipedia
    // keeps a category ("1880s paintings", "1640s battles") — use that instead.
    const decade = from % 10 === 0 && to === from + 9 && from > 0;
    const plural = type.endsWith('s') ? type : `${type}s`;
    if(decade){
      console.log(`(Wikidata timed out; using Category:${from}s ${plural}) `);
      return crawlCategory(`${from}s ${plural}`, 1, limit, { allowDateBins: true });
    }
    throw new Error(`Wikidata query failed (HTTP ${r.status}) — re-run, or narrow the range`);
  }
  const d = await r.json();
  return { pages: d.results.bindings.map((b) => b.title.value), categories: 0, pendingSubcats: 0 };
}

const DATE_BIN = /^Category:(\d{1,4}s?|\d{1,2}(st|nd|rd|th)[- ]century|\d+(st|nd|rd|th) millennium)\b|\b(\d{3,4}s?) (in|births|deaths|establishments|disestablishments|works|paintings|films|books)\b/i;

/** Pages under a category, descending `depth` subcategory levels, at most `limit`. */
async function crawlCategory(root, depth, limit, { allowDateBins = false } = {}){
  const start = root.startsWith('Category:') ? root : `Category:${root}`;
  const seen = new Set([start]);
  const pages = new Set();
  let frontier = [start];
  let catsListed = 0;
  for(let level = 0; level <= depth && frontier.length && pages.size < limit; level++){
    const next = [];
    for(const cat of frontier){
      if(pages.size >= limit) break;
      let cont = null;
      do {
        const d = await getJSON(`${WP}?format=json&action=query&list=categorymembers&cmlimit=500&cmtype=page|subcat` +
          `&cmtitle=${encodeURIComponent(cat)}${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''}`);
        if(!d) throw new Error(`listing ${cat} failed — re-run (nothing was written)`);
        catsListed++;
        for(const m of d.query?.categorymembers || []){
          if(m.ns === 14){
            if(!seen.has(m.title) && (allowDateBins || !DATE_BIN.test(m.title))){ seen.add(m.title); next.push(m.title); }
          } else if(m.ns === 0 && !INDEX_TITLE.test(m.title)){
            pages.add(m.title);
          }
        }
        cont = d.continue?.cmcontinue || null;
      } while(cont && pages.size < limit);
    }
    frontier = next;
  }
  return { pages: [...pages].slice(0, limit), categories: catsListed, pendingSubcats: frontier.length };
}

function readList(){
  if(arg('--search')) return [{ cat: `search: ${arg('--search')}`, domain: arg('--domain', 'misc'), depth: 0, limit: Number(arg('--limit', 200)) }];
  if(arg('--wikidata')) return [{ cat: `wikidata: ${arg('--wikidata')}`, domain: arg('--domain', 'misc'), depth: 0, limit: Number(arg('--limit', 200)) }];
  if(one) return [{ cat: one, domain: arg('--domain', slugify(one).split('-')[0]), depth: Number(arg('--depth', 1)), limit: Number(arg('--limit', 300)) }];
  if(!fs.existsSync(LIST)){ console.error(`  no ${path.relative(process.cwd(), LIST)} — pass a category, or create the file`); process.exit(1); }
  return fs.readFileSync(LIST, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map((l) => {
      const [cat, domain, depth, limit] = l.split('|').map((s) => s.trim());
      return { cat, domain: domain || slugify(cat.replace(/^(search|wikidata):/, '')).split('-')[0], depth: Number(depth) || (depth === '-' ? 0 : 1), limit: Number(limit || 300) };
    });
}

const jobs = readList().filter((j) => one || REDO === j.cat || !state.done[j.cat]);
if(!jobs.length){ console.log('  nothing pending in crawl.txt (use --redo "<category>" to repeat one)'); process.exit(0); }

const have = new Set(readEntries().map((e) => decodeURIComponent((e.origin?.wiki || '').split('/wiki/')[1] || '').replace(/_/g, ' ').toLowerCase()));
let ingested = 0;

for(const j of jobs){
  process.stdout.write(`\n  ${j.cat}  (${/^(search|wikidata):/.test(j.cat) ? '' : `depth ${j.depth}, `}limit ${j.limit}, domain ${j.domain})… `);
  // One flaky response must not end an hour-long run: retry the listing, and if
  // it still fails skip the line (it stays pending; the next run picks it up).
  let r = null;
  for(let attempt = 1; attempt <= 3 && !r; attempt++){
    try {
      r = j.cat.startsWith('search:') ? await searchPages(j.cat.slice(7).trim(), j.limit)
        : j.cat.startsWith('wikidata:') ? await wikidataPages(j.cat.slice(9).trim(), j.limit)
        : await crawlCategory(j.cat, j.depth, j.limit);
    } catch(e){
      if(attempt === 3){ console.log(`\n    skipped for now: ${e.message}`); }
      else await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
  if(!r) continue;
  const fresh = r.pages.filter((t) => !have.has(t.toLowerCase()));
  console.log(`${r.pages.length} pages from ${r.categories} category listings · ${fresh.length} not in the store` +
    `${r.pendingSubcats ? ` · ${r.pendingSubcats} deeper subcategories not visited` : ''}`);
  if(DRY){ console.log(`    e.g. ${fresh.slice(0, 8).join(' · ')}`); continue; }
  if(fresh.length){
    const f = path.join(HERE, `.crawl-${slugify(j.cat)}.txt`);
    fs.writeFileSync(f, fresh.join('\n') + '\n');
    const res = spawnSync(process.execPath, [path.join(HERE, 'ingest.mjs'), `@${f}`, '--domain', j.domain, '--limit', String(fresh.length), '--no-build'], { stdio: 'inherit' });
    fs.unlinkSync(f);
    if(res.status !== 0){ console.error(`  ingest failed for ${j.cat}; stopping (re-run resumes here)`); break; }
    ingested += fresh.length;
    fresh.forEach((t) => have.add(t.toLowerCase()));
  }
  state.done[j.cat] = { at: new Date().toISOString(), pages: r.pages.length, new: fresh.length };
  saveState();
}

if(!DRY && ingested){
  console.log('\n  labelling new pages with their subject…');
  spawnSync(process.execPath, [path.join(HERE, 'classify.mjs')], { stdio: 'inherit' });
  console.log('\n  placing them on the atlas…');
  spawnSync(process.execPath, [path.join(HERE, 'atlas.mjs')], { stdio: 'inherit' });
}
