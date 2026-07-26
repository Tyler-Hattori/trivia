#!/usr/bin/env node
// Suggester — reads the Wikipedia/Wikidata APIs (no LLM) to propose:
//   1) new ENTRIES for each existing dataset (pages similar to what you already
//      have, not yet present), and
//   2) new DATASET ideas — Wikidata "instance of" (P31) types that show up a lot
//      among the neighbours but aren't represented by any current dataset
//      (e.g. war, battle, time period -> the span datasets in the handoff).
//
// Writes to datasets/suggestions/. Never touches your CSVs.
//
// Usage:
//   node suggest.mjs [dataset.csv ...] [--seeds=N] [--top=K]
//     (no dataset args -> all datasets)
//   --seeds=N   how many existing rows to use as "more like this" seeds (default 25)
//   --top=K     how many entry suggestions to keep per dataset (default 30)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  readDataset, cfgFor, DATASETS, wpMoreLike, wpSummary, wdBatch, wdLabels,
  titleSim, norm, mapPool, sleep,
} from './wikilib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const SEEDS = parseInt(opt('seeds', '25'), 10);
const TOP = parseInt(opt('top', '30'), 10);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const files = args.filter((a) => !a.startsWith('--'));
const datasetFiles = (files.length ? files : Object.keys(DATASETS)).map((f) =>
  fs.existsSync(f) ? f : path.join(SCRIPT_DIR, path.basename(f))
).filter((f) => fs.existsSync(f));

const OUT = path.join(SCRIPT_DIR, 'suggestions');
fs.mkdirSync(OUT, { recursive: true });

// Even sampling of an array down to n items.
function sample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

// P31 types that ARE represented by an existing dataset -> not "new dataset" news.
const COVERED_TYPES = new Set([
  'painting', 'sculpture', 'work of art', 'artwork', 'fresco',      // art
  'film', 'silent film', 'feature film',                            // film
  'human',                                                          // people/leaders
  'literary work', 'philosophical work', 'book', 'treatise', 'essay', // philosophy
  'discovery', 'scientific theory', 'physical law', 'experiment',   // science
]);

const globalTypeTally = {}; // p31 label -> { count, examples:Set }

for (const file of datasetFiles) {
  const cfg = cfgFor(file);
  if (!cfg.name) continue;
  const { rows } = readDataset(file);
  if (!rows.length || !rows[0][cfg.name]) continue;

  const existing = new Set(rows.map((r) => norm(r[cfg.name])));
  const seeds = sample(rows.map((r) => r[cfg.name]).filter(Boolean), SEEDS);

  console.log(`\n${path.basename(file)}: ${seeds.length} seeds -> gathering neighbours...`);

  // 1) fan out morelike over the seeds
  const neigh = {}; // title -> frequency
  await mapPool(seeds, 5, async (seedName) => {
    await sleep(40);
    const query = cfg.film ? `${seedName} film` : seedName;
    const titles = await wpMoreLike(query, 8);
    for (const t of titles) {
      if (existing.has(norm(t))) continue;
      neigh[t] = (neigh[t] || 0) + 1;
    }
  });

  const candidates = Object.entries(neigh)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP * 2) // over-fetch; we'll drop ones without a usable summary
    .map(([title, freq]) => ({ title, freq }));

  // 2) enrich candidates with summary (extract + qid)
  await mapPool(candidates, 5, async (c) => {
    await sleep(40);
    const s = await wpSummary(c.title);
    c.extract = s?.extract || '';
    c.qid = s?.qid || null;
  });

  // 3) Wikidata: P31 type + a representative year for each candidate
  const qids = candidates.map((c) => c.qid).filter(Boolean);
  const claims = await wdBatch(qids);
  const p31ids = [...new Set(Object.values(claims).flatMap((c) => c.p31))];
  const labels = await wdLabels(p31ids);
  for (const c of candidates) {
    const cl = c.qid ? claims[c.qid] : null;
    c.year = cl?.year ?? null;
    c.types = (cl?.p31 || []).map((id) => labels[id] || id);
    // feed the new-dataset radar
    for (const t of c.types) {
      const key = t.toLowerCase();
      if (COVERED_TYPES.has(key)) continue;
      const g = (globalTypeTally[key] ||= { count: 0, examples: new Set() });
      g.count++;
      if (g.examples.size < 6) g.examples.add(c.title);
    }
  }

  const kept = candidates.filter((c) => c.extract).slice(0, TOP);

  // write JSON + human-readable markdown
  fs.writeFileSync(path.join(OUT, path.basename(file, '.csv') + '.json'), JSON.stringify(kept, null, 2));
  const md = [
    `# Entry suggestions — ${path.basename(file)}`,
    ``,
    `${kept.length} candidates not already present, ranked by neighbour frequency.`,
    `Year/type are from Wikidata. Review before adding; then run enrich.mjs to fill.`,
    ``,
    `| freq | title | year | type | snippet |`,
    `|---|---|---|---|---|`,
    ...kept.map((c) =>
      `| ${c.freq} | ${c.title} | ${c.year ?? ''} | ${(c.types[0] || '').replace(/\|/g, '/')} | ${c.extract.slice(0, 120).replace(/\|/g, '/')}… |`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, path.basename(file, '.csv') + '.md'), md + '\n');
  console.log(`  -> ${kept.length} suggestions written to suggestions/${path.basename(file, '.csv')}.md`);
}

// New-dataset radar across everything seen
const radar = Object.entries(globalTypeTally)
  .filter(([, g]) => g.count >= 3)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 40);

const radarMd = [
  `# New-dataset radar`,
  ``,
  `Wikidata "instance of" types that appear frequently among your datasets'`,
  `neighbours but aren't covered by an existing dataset. High-count rows are`,
  `candidates for a new dataset (e.g. wars / time periods -> span datasets).`,
  ``,
  `| count | type | examples |`,
  `|---|---|---|`,
  ...radar.map(([t, g]) => `| ${g.count} | ${t} | ${[...g.examples].join(', ')} |`),
].join('\n');
fs.writeFileSync(path.join(OUT, '_new_datasets.md'), radarMd + '\n');
console.log(`\nNew-dataset radar -> suggestions/_new_datasets.md (${radar.length} type clusters)`);
