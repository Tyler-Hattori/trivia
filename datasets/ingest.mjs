#!/usr/bin/env node
/**
 * Add entries to the atlas from Wikipedia or raw text, embed them, and place
 * them on the timeline. The whole point of the rework: bulk data entry with no
 * Claude in the loop.
 *
 *   INPUTS (mix freely)
 *     node datasets/ingest.mjs https://en.wikipedia.org/wiki/Cubism
 *     node datasets/ingest.mjs "Guernica" "The Persistence of Memory"
 *     node datasets/ingest.mjs @my-list.txt              one input per line
 *     node datasets/ingest.mjs --category "Cubist paintings"
 *     node datasets/ingest.mjs --links "List of Impressionist painters"
 *     node datasets/ingest.mjs --events "Timeline of natural history"
 *     cat notes.txt | node datasets/ingest.mjs -         blank-line-separated blocks
 *
 *   OPTIONS
 *     --domain art,visual art     domains for everything in this run
 *     --topics cubism,painting    extra topics for everything in this run
 *     --deep                      --category also descends one level of subcats
 *     --limit N                   cap the input list (default 500)
 *     --from "Gothic art"         skip titles sorting before this — resume a
 *     --to M                        capped run; --to is inclusive of the prefix
 *     --events <page>             mine MANY dated events out of one page's body,
 *                                 from its tables and its dated lines;
 *                                 repeatable. This is how deep time gets in
 *     --events-prose              also mine mid-sentence dates (noisier)
 *     --retitle                   let the LLM name each mined event
 *     --reshape                   rewrite excerpts in house voice (local LLM)
 *     --tag-topics                let the LLM propose topics too
 *     --min-year / --max-year     drop anything outside the range
 *     --dry                       report only, write nothing
 *     --no-build                  skip the atlas update at the end
 *
 *   Lists arrive alphabetically, so a list longer than --limit is walked in passes.
 *   Re-running the same command adds NOTHING: --limit applies to the input list
 *   before the store is read, so pass two re-lists the same titles and skips them
 *   all as already present. Each run prints the --from that continues it.
 *
 * ## What happens to an entry
 *
 *   1. Wikipedia + Wikidata are queried for prose, a date, an image and topics.
 *      Free, no model. Dates come from Wikidata claims where possible because a
 *      wrong year is worse than no entry — it lands in the wrong century and
 *      nothing flags it.
 *   2. Optionally a local LLM reshapes the prose into the project's voice.
 *   3. EmbeddingGemma turns the entry into a vector.
 *   4. The vector descends the FROZEN cluster tree to its nearest leaf, which
 *      gives it a y coordinate among its own kind. Nothing already on the map
 *      moves — that is what makes it safe to add hundreds at a time.
 *
 * Everything is skipped for an entry already present (matched on Wikidata QID
 * first, then on id), so re-running a list is cheap and idempotent.
 */

import fs from 'node:fs';
import {
  readEntries, appendEntries, readVectors, appendVectors, writeEntries,
  makeEntry, entryId, entryText, truncateNormalize, DIM, PATHS, readJSON,
} from './lib/store.mjs';
import { describe, describeMany, categoryMembers, pageLinks, mineEvents } from './lib/wiki.mjs';
import { embed, generate, ensureUp, EMBED_MODEL, WRITE_MODEL } from './lib/ollama.mjs';
import { nearestLeaf } from './lib/cluster.mjs';
import { parseYears, isCirca } from './lib/years.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i === -1 || i + 1 >= argv.length ? d : argv[i + 1];
};
const list = (f) => String(val(f, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Repeatable flags. `val` finds only the first, and page titles contain commas
// often enough ("Timeline of the Middle Ages, 1000-1100") that splitting one
// value on commas would be worse than asking for the flag twice.
const vals = (f) => argv.flatMap((a, i) => (a === f && i + 1 < argv.length ? [argv[i + 1]] : []));

const OPT = {
  domains:  list('--domain'),
  topics:   list('--topics'),
  deep:     has('--deep'),
  limit:    Number(val('--limit', 500)),
  from:     val('--from'),
  to:       val('--to'),
  events:   vals('--events'),
  eventsProse: has('--events-prose'),
  retitle:  has('--retitle'),
  reshape:  has('--reshape'),
  tagTopics: has('--tag-topics'),
  minYear:  val('--min-year') != null ? Number(val('--min-year')) : -Infinity,
  maxYear:  val('--max-year') != null ? Number(val('--max-year')) : Infinity,
  dry:      has('--dry'),
  build:    !has('--no-build'),
};

const FLAGS_WITH_VALUES = new Set(['--domain', '--topics', '--limit', '--min-year', '--max-year',
  '--category', '--links', '--from', '--to', '--events']);
const positional = argv.filter((a, i) => {
  if(a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev && FLAGS_WITH_VALUES.has(prev));
});

// ---------------------------------------------------------------------------
// Collect the input list
// ---------------------------------------------------------------------------

let inputs = [];
let rawTextBlocks = [];

for(const p of positional){
  if(p === '-'){
    const stdin = fs.readFileSync(0, 'utf8');
    rawTextBlocks.push(...stdin.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean));
  } else if(p.startsWith('@')){
    const file = p.slice(1);
    if(!fs.existsSync(file)){ console.error(`  no such file: ${file}`); process.exit(1); }
    inputs.push(...fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#')));
  } else {
    inputs.push(p);
  }
}

/*
 * --from / --to select an alphabetical window, so you can walk a list bigger than
 * --limit in passes: `--limit 500`, then `--from "Gothic art"` for the next 500.
 *
 * Re-running the same command does NOT continue where it stopped. --limit is applied
 * to the *input list* below, before the store is read, so an identical second run
 * re-lists the same first N titles, re-fetches all of them, and skips every one as
 * already present. That is what this window is for.
 *
 * The listing calls stop paginating as soon as they hold --limit titles, so a window
 * further down the alphabet would have nothing to filter — the tail was never
 * fetched. When a window is set we therefore list the category or page in full and
 * apply --limit after the filter. Listing is one cheap request per 500 titles; it is
 * the per-entry describe() calls that cost time, and those still honour --limit.
 */
const WINDOWED = OPT.from != null || OPT.to != null;
const LIST_ALL = 100000;
// One past the cap when not windowed, so a truncated run can name the title it
// stopped before. The API pages 500 at a time regardless, so this costs nothing.
const listCap = WINDOWED ? LIST_ALL : OPT.limit + 1;

/*
 * Plain code-point compare, NOT localeCompare, because this has to match the order
 * MediaWiki returns titles in — uppercase before lowercase, accented letters after
 * Z. Sorting locale-aware would silently lose entries across a resumed run: the API
 * puts "Émile Bernard" 1,444th on the Impressionism page, but locale order files it
 * beside "E", so `--from "Gothic art"` would exclude it and no pass would ever fetch
 * it. Matching the API means the boundary a run prints is exactly where it stopped.
 */
const cmp = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/**
 * `--to M` means "everything up to and including the Ms", so a bare prefix match
 * counts as inside the window — otherwise "Monet" would sort after "M" and be cut.
 *
 * The comparison is case-sensitive, matching the listing order. A single letter is
 * therefore best given as a capital, which is how article titles begin.
 */
function inWindow(title){
  if(OPT.from != null && cmp(title, OPT.from) < 0) return false;
  if(OPT.to != null && !String(title).startsWith(OPT.to) && cmp(title, OPT.to) > 0) return false;
  return true;
}

/**
 * A listing must be complete or fail. Partial output is the dangerous case: with
 * --from it looks like the list simply ends there, so the titles past the break are
 * never fetched by any pass.
 */
async function listOrDie(what, fn){
  process.stdout.write(`  ${what}… `);
  try {
    const r = await fn();
    console.log(`${r.length} pages`);
    return r;
  } catch(e){
    console.log('failed');
    console.error(`\n  ${e.message}`);
    console.error(`  The Wikipedia API dropped a request mid-listing. Nothing was written;`);
    console.error(`  just run the same command again.`);
    process.exit(1);
  }
}

if(val('--category')){
  inputs.push(...await listOrDie(
    `listing category "${val('--category')}"${OPT.deep ? ' (+subcategories)' : ''}`,
    () => categoryMembers(val('--category'), { limit: listCap, deep: OPT.deep })));
}

if(val('--links')){
  inputs.push(...await listOrDie(`listing links on "${val('--links')}"`,
    () => pageLinks(val('--links'), { limit: listCap })));
}

// An empty-but-successful listing usually means the title resolved to something else:
// a page that does not exist falls back to a search, so "List of Impressionist
// painters" silently becomes "Impressionism".
if((val('--category') || val('--links')) && !inputs.length && !rawTextBlocks.length && !OPT.events.length){
  console.error(`\n  That page or category listed no articles. Check the title resolves to`);
  console.error(`  what you expect — a missing page falls back to a Wikipedia search, so`);
  console.error(`  "List of Impressionist painters" silently becomes "Impressionism".`);
  process.exit(1);
}

/*
 * Sorted with the same comparator the window uses. The listings already arrive
 * alphabetically, but positional titles and @file lines do not, and --from / the
 * "continue with" hint are only meaningful if the order they report is the order
 * the filter applies. Processing order is otherwise irrelevant: ids come from the
 * title and both migrate.mjs and atlas.mjs sort by year.
 */
inputs = [...new Set(inputs)].sort(cmp);

if(WINDOWED){
  const before = inputs.length;
  inputs = inputs.filter(inWindow);
  const w = [OPT.from != null ? `from "${OPT.from}"` : null, OPT.to != null ? `to "${OPT.to}"` : null]
    .filter(Boolean).join(' ');
  console.log(`  window ${w}: ${inputs.length} of ${before} titles`);
}

// Say so when the cap bites, with the flag that continues from here — a silent
// truncation reads as "that is all there is".
if(inputs.length > OPT.limit){
  const last = inputs[OPT.limit - 1];
  const next = inputs[OPT.limit];
  console.log(`  --limit ${OPT.limit} of ${inputs.length}: stopping at "${last}"`);
  console.log(`  continue with:  --from "${next}"`);
}

inputs = inputs.slice(0, OPT.limit);

if(!inputs.length && !rawTextBlocks.length && !OPT.events.length){
  // Everything from the top of the docblock to the first `## ` heading. Cutting at
  // the heading rather than a hardcoded line count means adding an option can never
  // silently truncate the usage text.
  // slice(2) skips the shebang and the opening `/**`, which the old slice(1) printed.
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2);
  const end = lines.findIndex((l) => /^\s*\*\s*##\s/.test(l));
  console.error(lines.slice(0, end === -1 ? 30 : end)
    .map((l) => l.replace(/^\s*\*?\s?/, '  ')).join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// What is already here
// ---------------------------------------------------------------------------

const existing = readEntries();
const haveQid = new Map(existing.filter((e) => e.origin?.qid).map((e) => [e.origin.qid, e]));
const haveId = new Set(existing.map((e) => e.id));
const haveWiki = new Set(existing.filter((e) => e.origin?.wiki).map((e) => e.origin.wiki));

console.log(`  atlas holds ${existing.length} entries · ${inputs.length} inputs, ` +
            `${rawTextBlocks.length} text blocks, ${OPT.events.length} pages to mine\n`);

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const drafts = [];
const rejected = [];

if(inputs.length){
  let done = 0;
  const fetched = await describeMany(inputs, {
    concurrency: 6,
    onEach: (d, input, _i, err) => {
      done++;
      process.stdout.write(`\r  fetching ${done}/${inputs.length}  ${String(input).slice(0, 48).padEnd(50)}`);
      if(err) rejected.push([input, err.message]);
    },
  });
  console.log('\n');
  fetched.forEach((d, i) => {
    if(!d) rejected.push([inputs[i], 'no such page']);
    else drafts.push(d);
  });
}

/*
 * --events: many entries out of ONE page's body.
 *
 * The rest of this script is one-page-one-entry, dated from that page's Wikidata
 * claims. That shape cannot reach deep time, because the Hadean and the Cambrian
 * are not pages with inception dates — they are lines inside a "Timeline of…"
 * article. `mineEvents` reads the body instead; see lib/wiki.mjs.
 *
 * Two sources, reported separately because they warrant different scrutiny:
 * `mined-table` is a row under a column headed "Year", `mined-line` a line that
 * begins with its date, `mined-prose` a date found inside a sentence and the only
 * one that needs reading before it is written.
 *
 * --limit caps each page separately here, rather than capping a list of titles.
 */
if(OPT.events.length){
  const minedSeen = new Set();
  for(const page of OPT.events){
    process.stdout.write(`  mining "${page}"… `);
    let r;
    try {
      r = await mineEvents(page, { limit: OPT.limit, prose: OPT.eventsProse });
    } catch(e){
      console.log('failed');
      console.error(`\n  ${e.message}`);
      process.exit(1);
    }
    if(!r){ console.log('no such page'); rejected.push([page, 'no such page']); continue; }

    // The same event is listed on more than one timeline page, so dedupe across
    // pages in this run as well as within each one.
    const fresh = r.drafts.filter((d) => {
      const key = `${d.start}|${d.title.toLowerCase()}`;
      if(minedSeen.has(key)) return false;
      minedSeen.add(key);
      return true;
    });
    drafts.push(...fresh);
    for(const [title, why] of r.skipped) rejected.push([title, why]);

    const n = (src) => fresh.filter((d) => d._dateSource === src).length;
    console.log(`${r.page}: ${fresh.length} events ` +
                `(${n('mined-table')} from tables, ${n('mined-line')} dated at a line head, ` +
                `${n('mined-prose')} mid-sentence)` +
                `${r.drafts.length >= OPT.limit ? `  — hit --limit ${OPT.limit}` : ''}`);
    console.log(`    read ${r.tally.tables} tables (${r.tally.rows} rows) and ${r.scanned} lines of text` +
                `${r.tally.tablesSkipped ? `; skipped ${r.tally.tablesSkipped} tables with no date column` : ''}`);
    if(r.tally.noHtml) console.log(`    the page's HTML did not load, so NO tables were read — re-run`);
    if(r.skipped.length) console.log(`    ${r.skipped.length} skipped as unreadable dates`);
    if(!r.drafts.length){
      console.log(`    Nothing dated found. If the page writes its dates mid-sentence rather`);
      console.log(`    than in a table or at the head of a line, try --events-prose.`);
    }
  }
  console.log('');
}

// Raw text blocks: the first line is the title, an optional "year:" prefix line
// sets the date, and the rest is the excerpt.
for(const block of rawTextBlocks){
  const lines = block.split('\n');
  const title = lines[0].replace(/^#\s*/, '').trim();
  let yearText = '';
  const body = [];
  for(const l of lines.slice(1)){
    const m = l.match(/^\s*(?:year|date|years)\s*:\s*(.+)$/i);
    if(m && !yearText) yearText = m[1].trim();
    else body.push(l);
  }
  const { start, end } = parseYears(yearText);
  drafts.push({
    title, subtitle: '', excerpt: body.join('\n').trim(), image: '',
    start, end: end ?? start,
    kind: end != null && end !== start ? 'span' : 'point',
    yearText, circa: isCirca(yearText), topics: [], facets: {},
    // `manual` is what keeps migrate.mjs from deleting this. It is the one kind of
    // entry nothing can re-fetch, and it used to be exactly the kind that a routine
    // `node datasets/migrate.mjs` dropped — see the discriminator there.
    origin: { wiki: '', qid: null, manual: true },
    _dateSource: yearText ? 'given' : null,
  });
}

// ---------------------------------------------------------------------------
// Optional: model-written titles for mined events
// ---------------------------------------------------------------------------

/*
 * Runs BEFORE the dedupe filter, because the id is built from the title and the
 * filter has to compare final ids.
 *
 * The consequence, and the reason this is opt-in: the model's output is not
 * perfectly reproducible, so a second `--events --retitle` run over the same page
 * can title an event differently, fail to recognise it as already present, and add
 * it twice. Mine with `--dry` first, then run once. Without the flag titles come
 * from the event's own words and re-runs dedupe exactly.
 */
const TITLE_RULES = `You name historical and geological events for a timeline index.

Reply with ONLY the name — no date, no explanation, no quotes, no final period.
2 to 8 words, a noun phrase, capitalised as a heading would be.
Name what the event IS, using the source's own terms. Invent nothing.
Name what the text says FIRST. A line often bundles several facts, and the
opening one is the event; the rest is context and must not become the name.
Good: "Cambrian explosion", "Zanclean flood", "First banded iron formations".
Bad: "Eleven taxa of prokaryotes are preserved in the Apex Chert of".`;

const minedDrafts = drafts.filter((d) => d._mined && d.start != null);

if(OPT.retitle && minedDrafts.length){
  await ensureUp();
  console.log(`  naming ${minedDrafts.length} mined events with ${WRITE_MODEL}…`);
  let i = 0, changed = 0;
  for(const d of minedDrafts){
    i++;
    process.stdout.write(`\r  naming ${i}/${minedDrafts.length}  ${d.title.slice(0, 42).padEnd(44)}`);
    try {
      const out = await generate(`DATE: ${d.yearText}\nEVENT: ${d.excerpt}`,
        { system: TITLE_RULES, temperature: 0.1 });
      // Take one line, drop the quoting and trailing punctuation a model adds even
      // when told not to, and reject anything that is not plainly a title: an empty
      // answer, a sentence, or a refusal.
      const t = String(out).split('\n')[0].trim()
        .replace(/^["'“”\s]+|["'“”\s.]+$/g, '').replace(/\s+/g, ' ');
      if(t.length >= 4 && t.length <= 72 && t.split(' ').length <= 12 && !/[.!?]/.test(t)){
        d.title = t;
        changed++;
      }
    } catch(e){
      process.stdout.write(`\n  naming failed for ${d.title}: ${e.message}\n`);
    }
  }
  console.log(`\n  renamed ${changed} of ${minedDrafts.length}\n`);
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * The id this draft will get, computed before the entry is built so a re-run can be
 * recognised as a duplicate.
 *
 * Needed because QID and page URL — the two existing dedupe keys — do not identify
 * a mined or hand-entered entry. Mined events have no QID at all, and they SHARE a
 * page URL with every other event mined from the same article, so keying on the URL
 * would reject a whole second page-load as "already present". Without this check a
 * re-run instead appended the lot again under `~2` ids.
 */
const prospectiveId = (d) => entryId({
  title: d.title,
  start: d.start,
  origin: { dataset: OPT.domains[0] || 'ingest' },
});

const candidates = [];
for(const d of drafts){
  if(d._reject){ rejected.push([d.title, d._reject]); continue; }
  if(d.start == null){ rejected.push([d.title, 'no date found']); continue; }
  if(d.start < OPT.minYear || d.start > OPT.maxYear){ rejected.push([d.title, `year ${d.start} out of range`]); continue; }
  if(d.origin.qid && haveQid.has(d.origin.qid)){ rejected.push([d.title, `already present as ${haveQid.get(d.origin.qid).id}`]); continue; }
  // Skipped for mined events, whose page URL is the source article, not the entry.
  if(!d._mined && d.origin.wiki && haveWiki.has(d.origin.wiki)){ rejected.push([d.title, 'already present (same page)']); continue; }
  if(!d.origin.qid && haveId.has(prospectiveId(d))){
    rejected.push([d.title, `already present as ${prospectiveId(d)}`]); continue;
  }
  candidates.push(d);
}

// ---------------------------------------------------------------------------
// Optional: house-voice reshape
// ---------------------------------------------------------------------------

/**
 * The project's excerpt style, as a system prompt. Wikipedia leads are accurate
 * but written as encyclopedia openings — heavy on parenthetical dates, native
 * spellings and disambiguation. This turns one into the flowing two-paragraph
 * prose the datasets use.
 */
const STYLE = `You rewrite encyclopedia text into a house style for a history timeline.

RULES
- Flowing prose in complete sentences. Never clipped fragments like "Cold War end. Gulf War. Single term."
- One or two paragraphs, 40-120 words total. Separate paragraphs with a blank line.
- Paragraph one: what the thing is and why it matters. Paragraph two (optional): its consequence or context.
- Drop parenthetical birth/death dates, IPA, native-script names and "not to be confused with".
- Keep every fact from the source. Invent nothing. If the source is thin, write less.
- No opening throat-clearing ("This article is about..."), no lists, no headings, no markdown.
- Past tense for events. Do not begin with the subject's name in bold.`;

if(OPT.reshape && candidates.length){
  await ensureUp();
  console.log(`  reshaping ${candidates.length} excerpts with ${WRITE_MODEL}…`);
  let i = 0;
  for(const d of candidates){
    i++;
    process.stdout.write(`\r  reshaping ${i}/${candidates.length}  ${d.title.slice(0, 42).padEnd(44)}`);
    if(!d.excerpt || d.excerpt.length < 40) continue;
    try {
      const out = await generate(
        `Rewrite this into the house style.\n\nTITLE: ${d.title}\nDATE: ${d.yearText}\n\n${d.excerpt}`,
        { system: STYLE, temperature: 0.3 },
      );
      // Guard against a model that ignored the brief and returned something
      // shorter than a sentence or wildly longer than asked.
      if(out && out.length > 60 && out.length < d.excerpt.length * 2.2) d.excerpt = out;
    } catch(e){
      process.stdout.write(`\n  reshape failed for ${d.title}: ${e.message}\n`);
    }
  }
  console.log('\n');
}

if(OPT.tagTopics && candidates.length){
  await ensureUp();
  console.log(`  proposing topics with ${WRITE_MODEL}…`);
  let i = 0;
  for(const d of candidates){
    i++;
    process.stdout.write(`\r  tagging ${i}/${candidates.length}   `);
    try {
      const out = await generate(
        `Give 3-6 lowercase subject tags for this timeline entry, comma-separated, no explanation.\n` +
        `Tags should be reusable across entries (e.g. "cubism", "naval warfare", "quantum mechanics"), ` +
        `not unique to this one.\n\nTITLE: ${d.title}\nDATE: ${d.yearText}\n${d.excerpt.slice(0, 500)}`,
        { temperature: 0.2 },
      );
      const tags = out.split(/[,\n]/).map((s) => s.replace(/^[-*\d.\s]+/, '').trim().toLowerCase())
        .filter((s) => s && s.length < 34 && !/\s{2,}/.test(s)).slice(0, 6);
      d.topics = [...d.topics, ...tags];
    } catch { /* tagging is a bonus; never fail the ingest over it */ }
  }
  console.log('\n');
}

// ---------------------------------------------------------------------------
// Build entries
// ---------------------------------------------------------------------------

const fresh = [];
const idSeen = new Set(haveId);

for(const d of candidates){
  const entry = makeEntry({
    title: d.title,
    subtitle: d.subtitle,
    yearText: d.yearText,
    start: d.start,
    end: d.end ?? d.start,
    kind: d.kind,
    circa: d.circa,
    domains: OPT.domains,
    topics: [...(d.topics || []), ...OPT.topics],
    facets: d.facets || {},
    excerpt: d.excerpt,
    image: d.image,
    // Spread, so `manual` (and anything else provenance grows) survives. Listing
    // the fields by hand is what silently stripped it the first time.
    origin: { ...d.origin, dataset: OPT.domains[0] || 'ingest' },
    addedAt: new Date().toISOString().slice(0, 10),
  });
  entry.id = entryId(entry);
  let n = 1;
  const base = entry.id;
  while(idSeen.has(entry.id)) entry.id = `${base}~${++n}`;
  idSeen.add(entry.id);
  fresh.push(entry);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`  ${fresh.length} new · ${rejected.length} skipped\n`);

const srcCount = new Map();
for(const d of candidates) srcCount.set(d._dateSource || 'none', (srcCount.get(d._dateSource || 'none') || 0) + 1);
if(srcCount.size) console.log(`  date sources: ${[...srcCount].map(([k, v]) => `${k}:${v}`).join('  ')}`);

for(const e of fresh.slice(0, OPT.dry ? 40 : 12)){
  console.log(`    ${String(e.yearText || e.start).padStart(11)}  ${e.title.slice(0, 42).padEnd(44)}` +
              `${e.image ? 'img ' : '    '}${e.excerpt ? `${e.excerpt.length}c ` : 'NO TEXT '}` +
              `${e.topics.slice(0, 3).join(', ')}`);
}
if(fresh.length > 12 && !OPT.dry) console.log(`    … and ${fresh.length - 12} more`);

if(rejected.length){
  const why = new Map();
  for(const [, r] of rejected){
    const key = /already present/.test(r) ? 'already present' : r;
    why.set(key, (why.get(key) || 0) + 1);
  }
  console.log(`\n  skipped: ${[...why].map(([k, v]) => `${k} (${v})`).join(', ')}`);
  const noDate = rejected.filter(([, r]) => r === 'no date found').map(([t]) => t);
  if(noDate.length) console.log(`  no date: ${noDate.slice(0, 8).join(', ')}${noDate.length > 8 ? `, +${noDate.length - 8}` : ''}`);
}

if(OPT.dry){ console.log('\n  --dry: nothing written.'); process.exit(0); }
if(!fresh.length){ console.log('\n  Nothing to add.'); process.exit(0); }

// ---------------------------------------------------------------------------
// Embed and place
// ---------------------------------------------------------------------------

await ensureUp();
const vecStore = readVectors();
if(vecStore.model && vecStore.model !== EMBED_MODEL){
  console.error(`\n  Store was embedded with "${vecStore.model}" but the model is now "${EMBED_MODEL}".`);
  console.error(`  Mixing them would corrupt the map. Re-run: node datasets/embed-all.mjs --force`);
  process.exit(1);
}

process.stdout.write(`\n  embedding ${fresh.length} with ${EMBED_MODEL}… `);
const pairs = [];
for(let i = 0; i < fresh.length; i += 24){
  const chunk = fresh.slice(i, i + 24);
  const vs = await embed(chunk.map((e) => entryText(e)));
  chunk.forEach((e, j) => pairs.push([e.id, truncateNormalize(vs[j], DIM)]));
}
console.log('done');

appendEntries(fresh);
appendVectors(pairs, { model: EMBED_MODEL });

// Preview where each landed, using the frozen tree — the same descent the atlas
// build will do, so this report is not a guess.
const layout = readJSON(PATHS.layout);
if(layout){
  const nodes = layout.nodes.map((nd) => ({ ...nd, centroid: Float32Array.from(nd.centroid) }));
  const atlas = readJSON(PATHS.atlas);
  const counts = new Map();
  for(const [, v] of pairs){
    const leaf = nearestLeaf(v, nodes);
    const name = atlas?.nodes?.[leaf]?.label || `leaf ${leaf}`;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  console.log(`\n  placed into ${counts.size} existing clusters:`);
  for(const [name, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12)){
    console.log(`    ${String(c).padStart(4)}  ${name}`);
  }
}

console.log(`\n  entries.jsonl now holds ${existing.length + fresh.length}`);

if(OPT.build){
  console.log('\n  updating the atlas (keeping existing positions)…\n');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  // fileURLToPath, never `.pathname` — the repo path contains a space and
  // `.pathname` hands over an undecoded %20 that resolves to nothing.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./atlas.mjs', import.meta.url))],
    { stdio: 'inherit' });
  if(r.status !== 0) console.error('\n  atlas build failed — run `node datasets/atlas.mjs` to see why');
} else {
  console.log('  next:  node datasets/atlas.mjs          (place them, keep the map stable)');
  console.log('         node datasets/atlas.mjs --rebuild (re-fit the whole hierarchy)');
}
