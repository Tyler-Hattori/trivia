#!/usr/bin/env node
/**
 * One-time migration: the eight per-topic CSVs -> atlas/entries.jsonl.
 *
 *     node datasets/migrate.mjs [--dry] [--prune]
 *
 * The CSVs are left untouched; this only reads them. Re-running is safe — it
 * rewrites entries.jsonl from scratch, and any entry added later by ingest.mjs
 * that did not come from a CSV is carried over.
 *
 * This is the only script in the pipeline that DELETES entries, so it refuses to.
 * A stored row that no CSV produces any more stops the run and is listed; pass
 * `--prune` once you have read the list and agree they should go. The reason is
 * that the same silent deletion has been introduced twice by two different
 * carry-over rules (see the discriminator below), and both times the data it took
 * was the kind nothing can re-fetch.
 *
 * ## What changes in the data model
 *
 * The old shape gave every row exactly one category column (`movement`,
 * `field`, `tradition`, …). A cell holding "science fiction / horror" therefore
 * became a *third* category, distinct from both its parts, and the timeline grew
 * a lane for it. Here that cell becomes two topics and the entry belongs to both.
 *
 * Tags land in two fields, and the split matters:
 *   - `domains`  the broad bucket implied by the source file ("art", "politics").
 *                Filterable, but kept out of the embedding — a tag that is
 *                perfectly correlated with the source file would make the atlas
 *                re-derive the eight CSVs instead of finding real structure.
 *   - `topics`   the row's own category cells, split on `/`, `|` and `;`, so
 *                "science fiction / horror" becomes two topics and the entry
 *                belongs to both rather than to a third pseudo-category.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCSV } from './wikilib.mjs';
import { parseYears, isCirca } from './lib/years.mjs';
import { titleCase } from './lib/cluster.mjs';
import {
  DATASETS_DIR, PATHS, makeEntry, entryId, readEntries, writeEntries,
} from './lib/store.mjs';

const DRY = process.argv.includes('--dry');
const PRUNE = process.argv.includes('--prune');

/**
 * Per-CSV mapping into the canonical shape.
 *
 *   title/subtitle/years  which column fills which slot
 *   kind                  point (a moment) or span (a duration)
 *   topics                extra topic columns; each cell is split on / | ;
 *   facets                columns kept as named, filterable, quizzable attributes
 *   domains               broad buckets every row in this file gets
 */
const MAP = {
  'art.csv': {
    title: 'title', subtitle: 'artist', years: 'year', kind: 'point',
    topics: ['movement'], facets: { artist: 'artist', movement: 'movement' },
    domains: ['art', 'visual art'],
  },
  'film.csv': {
    title: 'title', subtitle: 'director', years: 'year', kind: 'point',
    topics: [], facets: { director: 'director' },
    domains: ['film'],
  },
  'science.csv': {
    title: 'discovery', subtitle: 'scientist', years: 'year', kind: 'point',
    topics: ['field'], facets: { scientist: 'scientist', field: 'field' },
    domains: ['science', 'discovery'],
  },
  'people.csv': {
    title: 'name', subtitle: 'occupation', years: 'years', kind: 'span',
    topics: ['occupation', 'country'], facets: { occupation: 'occupation', country: 'country' },
    domains: ['people', 'biography'],
  },
  'leaders.csv': {
    title: 'name', subtitle: 'country', years: 'years', kind: 'span',
    topics: ['country', 'house/party'], facets: { country: 'country', party: 'house/party' },
    domains: ['leaders', 'politics', 'reign'],
  },
  'philosophy.csv': {
    title: 'work', subtitle: 'philosopher', years: 'year', kind: 'point',
    topics: ['school'], facets: { philosopher: 'philosopher', school: 'school' },
    domains: ['philosophy'],
  },
  'religion.csv': {
    title: 'event', subtitle: 'tradition', years: 'year', kind: 'point',
    topics: ['tradition', 'region'], facets: { tradition: 'tradition', region: 'region' },
    domains: ['religion'],
  },
  'us_history.csv': {
    title: 'event', subtitle: 'category', years: 'year', kind: 'point',
    topics: ['category'], facets: { category: 'category' },
    domains: ['us history', 'politics'],
  },
};

const splitMulti = (v) =>
  String(v || '').split(/\s*[|/;]\s*/).map((s) => s.trim()).filter(Boolean);

/** Excerpts in the CSVs encode a paragraph break as the two literal chars \n\n. */
const unescapeExcerpt = (v) =>
  String(v || '').replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const entries = [];
const report = [];

for(const [file, cfg] of Object.entries(MAP)){
  const full = path.join(DATASETS_DIR, file);
  if(!fs.existsSync(full)){ report.push([file, 0, 'missing']); continue; }

  const { rows } = parseCSV(fs.readFileSync(full, 'utf8'));
  const dataset = file.replace(/\.csv$/, '');
  let kept = 0, noYear = 0;

  for(const row of rows){
    const title = String(row[cfg.title] || '').trim();
    if(!title) continue;

    const yearText = String(row[cfg.years] || '').trim();
    const { start, end } = parseYears(yearText);
    if(start == null){ noYear++; continue; }   // unplaceable on a time axis

    const topics = cfg.topics.flatMap((col) => splitMulti(row[col]));

    const facets = {};
    for(const [name, col] of Object.entries(cfg.facets)){
      const vals = splitMulti(row[col]);
      if(vals.length === 1) facets[name] = vals[0];
      else if(vals.length > 1) facets[name] = vals;
    }

    const entry = makeEntry({
      title: titleCaseIfLower(title),
      subtitle: String(row[cfg.subtitle] || '').trim(),
      yearText,
      start,
      end: cfg.kind === 'span' ? (end ?? start) : start,
      kind: cfg.kind === 'span' && end != null && end !== start ? 'span' : 'point',
      circa: isCirca(yearText),
      domains: cfg.domains,
      topics,
      facets,
      excerpt: unescapeExcerpt(row.excerpt),
      image: String(row.image || '').trim(),
      origin: { dataset, wiki: '', qid: null },
      addedAt: null,
    });
    entry.id = entryId(entry);
    entries.push(entry);
    kept++;
  }

  report.push([file, kept, noYear ? `${noYear} skipped (no parseable year)` : '']);
}

/**
 * The CSVs are lowercase in places (art titles and artists are all lowercase).
 * Upper-case the display form, but leave anything already mixed-case alone so
 * "iPhone" and "von Neumann" survive.
 */
function titleCaseIfLower(s){
  if(/\p{Lu}/u.test(s)) return s;
  // `titleCase` is imported, not redefined: this had its own copy of the same
  // `\b[a-z]` logic and so had the same bug ("Artist'S Wife", "FranÇOis").
  return titleCase(s)
    .replace(/\b(Of|The|And|A|An|In|On|At|To|For|Von|Van|De|Da|Di|Le|La)\b/g,
             (w, _o, i) => (i === 0 ? w : w.toLowerCase()));
}

// Resolve duplicate ids by suffixing. Two entries genuinely can share a title
// and a year (different artists, same subject), and a silent overwrite would
// lose one.
const seen = new Map();
for(const e of entries){
  const n = (seen.get(e.id) || 0) + 1;
  seen.set(e.id, n);
  if(n > 1) e.id = `${e.id}~${n}`;
}

/*
 * Preserve anything added since that no CSV accounts for.
 *
 * A stored row whose id no CSV produced is one of two things: a CSV row deleted
 * upstream, which should disappear too, or something added later, which must not.
 * This tests for the FIRST — "does it look like a CSV row?" — rather than trying to
 * enumerate every way an entry can arrive, because the two errors cost wildly
 * different amounts. A stale row wrongly kept is visible in the atlas and deletable
 * by hand. A hand-entered or mined row wrongly deleted is gone: nothing can
 * re-fetch it.
 *
 * That asymmetry has already bitten twice, in the same place. The first version
 * keyed on the dataset NAME, so `ingest.mjs --domain art` (which sets
 * `origin.dataset: 'art'`, colliding with art.csv) had all 58 of its entries
 * dropped by a routine re-run. The fix keyed on `origin.wiki || origin.qid`, which
 * held for wiki ingests but silently excluded the one kind of entry that cannot be
 * recovered — stdin prose has `wiki: ''` and `qid: null` — and would have excluded
 * mined events too, which have no QID.
 *
 * So: a row is a CSV row only if it names a dataset that a CSV in MAP actually
 * produces AND carries no marker of having come from anywhere else.
 */
const CSV_DATASETS = new Set(Object.keys(MAP).map((f) => f.replace(/\.csv$/, '')));

const looksLikeCsvRow = (e) =>
  CSV_DATASETS.has(e.origin?.dataset || '') &&
  !e.origin?.manual && !e.origin?.wiki && !e.origin?.qid;

const csvIds = new Set(entries.map((e) => e.id));
const stored = readEntries();
const orphans = stored.filter((e) => !csvIds.has(e.id));
const carried = orphans.filter((e) => !looksLikeCsvRow(e));
const dropped = orphans.filter((e) => looksLikeCsvRow(e));

const out = [...entries, ...carried].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

const topicCount = new Map();
for(const e of out) for(const t of e.topics) topicCount.set(t, (topicCount.get(t) || 0) + 1);
const domainCount = new Map();
for(const e of out) for(const t of e.domains) domainCount.set(t, (domainCount.get(t) || 0) + 1);

console.log('\n  file                rows   note');
console.log('  ' + '-'.repeat(56));
for(const [f, n, note] of report) console.log(`  ${f.padEnd(18)} ${String(n).padStart(5)}   ${note}`);
console.log('  ' + '-'.repeat(56));
console.log(`  ${'total'.padEnd(18)} ${String(entries.length).padStart(5)}   ` +
            `${carried.length ? carried.length + ' non-CSV entries carried over, ' : ''}` +
            `${topicCount.size} topics, ${domainCount.size} domains`);
console.log(`  with excerpt: ${out.filter((e) => e.excerpt).length}   ` +
            `with image: ${out.filter((e) => e.image).length}   ` +
            `spans: ${out.filter((e) => e.kind === 'span').length}`);

// This script is the only thing in the pipeline that deletes entries, so it says
// which ones. A silent drop reads as "the CSVs simply hold fewer rows now".
if(dropped.length){
  console.log(`\n  ${dropped.length} stored row(s) that no CSV produces any more:`);
  for(const e of dropped.slice(0, 20)) console.log(`    ${e.id}   ${e.title.slice(0, 40)}`);
  if(dropped.length > 20) console.log(`    … and ${dropped.length - 20} more`);
}
if(carried.length){
  const byKind = { manual: 0, wiki: 0 };
  for(const e of carried) e.origin?.manual ? byKind.manual++ : byKind.wiki++;
  console.log(`\n  carrying over ${carried.length} non-CSV entries ` +
              `(${byKind.wiki} from a page, ${byKind.manual} hand-entered or mined)`);
}

if(DRY){
  console.log('\n  --dry: nothing written. Top topics:');
  console.log('  ' + [...topicCount].sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([t, n]) => `${t}(${n})`).join(', '));
} else if(dropped.length && !PRUNE){
  // Refusing beats warning. A warning scrolls past inside a longer pipeline, and
  // the rows this would take are gone for good.
  console.error(`\n  Refusing to write: that would delete the ${dropped.length} row(s) listed above.`);
  console.error(`\n  If they are CSV rows you removed on purpose:   node datasets/migrate.mjs --prune`);
  console.error(`  If any was hand-entered or mined, it is only listed because it lacks`);
  console.error(`  origin.manual = true — set that in entries.jsonl first, or it is lost.`);
  process.exit(1);
} else {
  writeEntries(out);
  console.log(`\n  wrote ${PATHS.entries}`);
  console.log('  next:  node datasets/embed-all.mjs');
}
