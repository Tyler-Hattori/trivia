#!/usr/bin/env node
// Phase 0 — free dataset filler. Pulls reliable-source prose + a Commons image
// from the Wikipedia REST API and writes them into EMPTY excerpt/image cells.
// No LLM, no cost. Idempotent: only ever fills blanks (unless --force).
//
// Usage:
//   node enrich.mjs <dataset.csv> [options]
//
// Options:
//   --fields=excerpt,image   override which fields to fill (default per dataset)
//   --limit=N                only process the first N rows that need work
//   --concurrency=N          parallel requests (default 5)
//   --min-sim=0.34           skip matches below this title-similarity (audit gate)
//   --force                  overwrite non-empty cells too
//   --dry-run                report what would change; write nothing
//
// Side effects: writes <dataset>.bak once, and <dataset>.enrich-log.json — the
// latter lists every excerpt filled (with the source title/URL/confidence) and
// is the exact worklist for a later cheap-model (Haiku) house-style reshape.

import path from 'path';
import fs from 'fs';
import {
  readDataset, writeDataset, cfgFor, wpSearch, wpSummary,
  titleSim, mapPool, sleep,
} from './wikilib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node enrich.mjs <dataset.csv> [--fields=] [--limit=] [--dry-run] [--force] [--min-sim=]');
  process.exit(1);
}
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const flag = (k) => args.includes('--' + k);

const DRY = flag('dry-run');
const FORCE = flag('force');
const LIMIT = opt('limit') ? parseInt(opt('limit'), 10) : Infinity;
const CONC = parseInt(opt('concurrency', '5'), 10);
const MIN_SIM = parseFloat(opt('min-sim', '0.34'));

const cfg = cfgFor(file);
const { headers, rows } = readDataset(file);
const fields = (opt('fields') ? opt('fields').split(',') : cfg.fill).filter((f) => headers.includes(f));
if (!cfg.name || !headers.includes(cfg.name)) {
  console.error(`No name column configured for ${path.basename(file)} (looked for "${cfg.name}").`);
  process.exit(1);
}

const empty = (v) => !String(v ?? '').trim();
const needsWork = (r) => fields.some((f) => FORCE || empty(r[f]));

// Build the search query for a row.
function queryFor(row) {
  const name = row[cfg.name];
  const yr = cfg.year ? row[cfg.year] : '';
  if (cfg.film) return `${name} ${String(yr).match(/\d{3,4}/)?.[0] || ''} film`.trim();
  const extra = cfg.extra ? row[cfg.extra] : '';
  return `${name} ${extra || ''}`.trim();
}

const targets = rows.map((r, i) => ({ r, i })).filter(({ r }) => needsWork(r)).slice(0, LIMIT);
console.log(`${path.basename(file)}: ${targets.length} rows need ${fields.join('/')} (of ${rows.length} total)`);

let filled = { excerpt: 0, image: 0 };
let missed = 0;
const log = [];
const misses = [];
let done = 0;

await mapPool(targets, CONC, async ({ r, i }) => {
  await sleep(60); // politeness jitter
  const title = await wpSearch(queryFor(r));
  const label = r[cfg.name];
  if (!title) {
    missed++;
    misses.push({ row: i + 2, name: label, query: queryFor(r), reason: 'no-search-hit' });
    return;
  }
  const sum = await wpSummary(title);
  if (!sum || !sum.extract) {
    missed++;
    misses.push({ row: i + 2, name: label, title, reason: 'no-summary' });
    return;
  }
  const sim = titleSim(label, sum.title);
  const low = sim < MIN_SIM;

  const changes = {};
  if (fields.includes('excerpt') && (FORCE || empty(r.excerpt)) && sum.extract) {
    changes.excerpt = sum.extract;
  }
  if (fields.includes('image') && (FORCE || empty(r.image)) && sum.image) {
    changes.image = sum.image;
  }
  if (!Object.keys(changes).length) {
    missed++;
    misses.push({ row: i + 2, name: label, title: sum.title, reason: 'nothing-to-fill' });
    return;
  }

  if (low) {
    // Low-confidence title match: log it, DON'T auto-write prose (would poison
    // the excerpt). Images are safer but also held back for audit.
    misses.push({ row: i + 2, name: label, title: sum.title, sim: +sim.toFixed(2), reason: 'low-confidence', proposed: changes });
    missed++;
    return;
  }

  if (!DRY) {
    for (const [k, v] of Object.entries(changes)) r[k] = v;
  }
  for (const k of Object.keys(changes)) filled[k] = (filled[k] || 0) + 1;
  log.push({
    row: i + 2, name: label, title: sum.title, sim: +sim.toFixed(2),
    filled: Object.keys(changes),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(sum.title.replace(/ /g, '_'))}`,
  });

  if (++done % 25 === 0) console.log(`  ...${done}/${targets.length}`);
});

const base = file.replace(/\.csv$/, '');
if (!DRY) {
  writeDataset(file, rows, headers);
  fs.writeFileSync(`${base}.enrich-log.json`, JSON.stringify(log, null, 2));
  if (misses.length) fs.writeFileSync(`${base}.misses.json`, JSON.stringify(misses, null, 2));
}

console.log('\n=== summary ===');
console.log(`filled excerpt: ${filled.excerpt || 0}   filled image: ${filled.image || 0}`);
console.log(`skipped/missed: ${missed}  (see ${path.basename(base)}.misses.json — includes low-confidence for manual review)`);
if (DRY) console.log('DRY RUN — no files written.');
else {
  console.log(`wrote ${path.basename(file)} (backup at ${path.basename(file)}.bak)`);
  console.log(`worklist for Haiku reshape: ${path.basename(base)}.enrich-log.json (${log.length} excerpts)`);
}
