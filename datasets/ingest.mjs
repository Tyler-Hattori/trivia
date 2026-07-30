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
 *     cat notes.txt | node datasets/ingest.mjs -         blank-line-separated blocks
 *
 *   OPTIONS
 *     --domain art,visual art     domains for everything in this run
 *     --topics cubism,painting    extra topics for everything in this run
 *     --deep                      --category also descends one level of subcats
 *     --limit N                   cap the input list (default 500)
 *     --reshape                   rewrite excerpts in house voice (local LLM)
 *     --tag-topics                let the LLM propose topics too
 *     --min-year / --max-year     drop anything outside the range
 *     --dry                       report only, write nothing
 *     --no-build                  skip the atlas update at the end
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
import { describe, describeMany, categoryMembers, pageLinks } from './lib/wiki.mjs';
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

const OPT = {
  domains:  list('--domain'),
  topics:   list('--topics'),
  deep:     has('--deep'),
  limit:    Number(val('--limit', 500)),
  reshape:  has('--reshape'),
  tagTopics: has('--tag-topics'),
  minYear:  val('--min-year') != null ? Number(val('--min-year')) : -Infinity,
  maxYear:  val('--max-year') != null ? Number(val('--max-year')) : Infinity,
  dry:      has('--dry'),
  build:    !has('--no-build'),
};

const FLAGS_WITH_VALUES = new Set(['--domain', '--topics', '--limit', '--min-year', '--max-year', '--category', '--links']);
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

if(val('--category')){
  process.stdout.write(`  listing category "${val('--category')}"${OPT.deep ? ' (+subcategories)' : ''}… `);
  const members = await categoryMembers(val('--category'), { limit: OPT.limit, deep: OPT.deep });
  console.log(`${members.length} pages`);
  inputs.push(...members);
}

if(val('--links')){
  process.stdout.write(`  listing links on "${val('--links')}"… `);
  const links = await pageLinks(val('--links'), { limit: OPT.limit });
  console.log(`${links.length} pages`);
  inputs.push(...links);
}

inputs = [...new Set(inputs)].slice(0, OPT.limit);

if(!inputs.length && !rawTextBlocks.length){
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1, 30).map((l) => l.replace(/^\s*\*?\s?/, '  ')).join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// What is already here
// ---------------------------------------------------------------------------

const existing = readEntries();
const haveQid = new Map(existing.filter((e) => e.origin?.qid).map((e) => [e.origin.qid, e]));
const haveId = new Set(existing.map((e) => e.id));
const haveWiki = new Set(existing.filter((e) => e.origin?.wiki).map((e) => e.origin.wiki));

console.log(`  atlas holds ${existing.length} entries · ${inputs.length} inputs, ${rawTextBlocks.length} text blocks\n`);

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
    origin: { wiki: '', qid: null }, _dateSource: yearText ? 'given' : null,
  });
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const candidates = [];
for(const d of drafts){
  if(d._reject){ rejected.push([d.title, d._reject]); continue; }
  if(d.start == null){ rejected.push([d.title, 'no date found']); continue; }
  if(d.start < OPT.minYear || d.start > OPT.maxYear){ rejected.push([d.title, `year ${d.start} out of range`]); continue; }
  if(d.origin.qid && haveQid.has(d.origin.qid)){ rejected.push([d.title, `already present as ${haveQid.get(d.origin.qid).id}`]); continue; }
  if(d.origin.wiki && haveWiki.has(d.origin.wiki)){ rejected.push([d.title, 'already present (same page)']); continue; }
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
    origin: { dataset: OPT.domains[0] || 'ingest', wiki: d.origin.wiki, qid: d.origin.qid },
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
