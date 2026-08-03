#!/usr/bin/env node
/**
 * Triage `<dataset>.misses.json` — decide mechanically what can be decided, so a
 * model only ever sees what actually needs judgement.
 *
 *   node datasets/misses.mjs                      all *.misses.json
 *   node datasets/misses.mjs art.misses.json      one file
 *   node datasets/misses.mjs --write              write the verdicts back
 *   node datasets/misses.mjs --review art.review.json   emit the undecided rows
 *
 * ## Why this exists
 *
 * `enrich.mjs` holds back a match it is not confident in and records it with a
 * `proposed` excerpt for later review. Read as a worklist, that file looks like
 * 341 excerpts waiting to be approved. It is not. On `art.csv` those 341
 * proposals come from **107 distinct Wikipedia pages** — Camille Pissarro's
 * biography is proposed for 32 different paintings, Vigée Le Brun's for 22.
 *
 * The cause is structural, not a tuning problem. These rows are individual
 * artworks with no article of their own ("a plaza in caracas"), so `wpSearch`
 * returned the nearest thing it could find, which is the artist. Applying the
 * proposals would write one identical excerpt across 32 entries — worse than
 * leaving them blank, because identical prose makes identical vectors, and the
 * atlas would cluster those 32 paintings by the accident of sharing a painter's
 * bio rather than by anything about the paintings.
 *
 * So: reject what is provably wrong, for free, before spending anything.
 *
 * ## The four mechanical verdicts
 *
 *   `reused-page`    the proposed page is proposed for another row too. A page
 *                    that describes two different artworks describes neither;
 *                    in practice it is always the creator's page. No model can
 *                    make this true, so no model needs to see it.
 *   `creator-page`   the proposed page IS the row's own creator column (artist,
 *                    director, scientist). Catches the same error where the
 *                    creator happens to have only one work in the dataset,
 *                    which `reused-page` cannot see.
 *   `index-page`     a list, outline or disambiguation page. Same test
 *                    `describe()` already applies before making an entry, so it
 *                    is imported from lib/wiki.mjs rather than restated.
 *   `no-source`      `no-search-hit` / `no-summary`. There is nothing to review;
 *                    these need `ingest.mjs` (Wikidata-matched, so it does not
 *                    depend on title similarity) or hand entry.
 *
 * What survives is `review` — a real candidate page whose title merely scored
 * below `--min-sim`. That is the set worth judging, and it is the only set worth
 * paying for.
 *
 * Nothing here writes a CSV. This tool decides what to look at; filling the
 * cells stays with `enrich.mjs` and `ingest.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDataset, cfgFor, titleSim } from './wikilib.mjs';
import { INDEX_TITLE } from './lib/wiki.mjs';

// `fileURLToPath`, never `new URL(...).pathname` — the repo path contains a
// space and the latter leaves it as %20, which writes into a stray directory.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const REVIEW_OUT = (() => {
  const i = argv.indexOf('--review');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
})();

const named = argv.filter((a) => !a.startsWith('--') && a !== REVIEW_OUT);
const files = named.length
  ? named.map((f) => (path.isAbsolute(f) ? f : path.join(HERE, f)))
  : fs.readdirSync(HERE).filter((f) => f.endsWith('.misses.json')).sort()
      .map((f) => path.join(HERE, f));

if(!files.length){
  console.error('  no .misses.json files found');
  process.exit(1);
}

const allReview = [];
const grand = { total: 0, reusedPage: 0, creatorPage: 0, indexPage: 0, noSource: 0, review: 0 };

for(const file of files){
  const base = path.basename(file).replace(/\.misses\.json$/, '');
  const csv = path.join(HERE, `${base}.csv`);
  const misses = JSON.parse(fs.readFileSync(file, 'utf8'));

  // The creator column, for `creator-page`. `extra` is what enrich.mjs already
  // appends to its search query, which is exactly why the creator is what comes
  // back when the work itself has no article.
  const cfg = cfgFor(csv);
  let rows = null;
  if(fs.existsSync(csv)) rows = readDataset(csv).rows;

  // `row` in a misses record is the spreadsheet line: header is 1, data starts at 2.
  const creatorOf = (m) => {
    if(!rows || !cfg.extra) return '';
    const r = rows[m.row - 2];
    return r ? String(r[cfg.extra] || '') : '';
  };

  const pageUse = new Map();
  for(const m of misses){
    if(!m.proposed || !m.title) continue;
    pageUse.set(m.title, (pageUse.get(m.title) || 0) + 1);
  }

  const out = [];
  for(const m of misses){
    let verdict, why;
    if(!m.proposed){
      verdict = 'no-source';
      why = m.reason;
    } else if(pageUse.get(m.title) > 1){
      verdict = 'reused-page';
      why = `"${m.title}" is also proposed for ${pageUse.get(m.title) - 1} other row(s)`;
    } else if(creatorOf(m) && titleSim(creatorOf(m), m.title) >= 0.5){
      verdict = 'creator-page';
      why = `"${m.title}" is this row's ${cfg.extra}`;
    } else if(INDEX_TITLE.test(m.title)){
      verdict = 'index-page';
      why = `"${m.title}" is an index or disambiguation page, not a subject`;
    } else {
      verdict = 'review';
      why = `unique candidate page, sim ${m.sim ?? '?'} below the gate`;
    }
    out.push({ ...m, verdict, verdictWhy: why });
  }

  const count = (v) => out.filter((m) => m.verdict === v).length;
  const stats = {
    total: out.length,
    reusedPage: count('reused-page'),
    creatorPage: count('creator-page'),
    indexPage: count('index-page'),
    noSource: count('no-source'),
    review: count('review'),
  };
  for(const k of Object.keys(grand)) grand[k] += stats[k];

  const pages = new Set([...pageUse.keys()]);
  console.log(`\n${path.basename(file)} — ${stats.total} rows` +
              `${rows ? '' : `  (no ${base}.csv, creator-page test skipped)`}`);
  console.log(`  ${String(stats.reusedPage).padStart(4)}  reused-page    rejected free` +
              ` (${pageUse.size ? pages.size : 0} distinct pages behind ${misses.filter((m) => m.proposed).length} proposals)`);
  console.log(`  ${String(stats.creatorPage).padStart(4)}  creator-page   rejected free`);
  console.log(`  ${String(stats.indexPage).padStart(4)}  index-page     rejected free`);
  console.log(`  ${String(stats.noSource).padStart(4)}  no-source      needs ingest.mjs or hand entry`);
  console.log(`  ${String(stats.review).padStart(4)}  review         <- the only rows worth judging`);

  const worst = [...pageUse.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if(worst.length){
    console.log(`  most reused: ${worst.map(([t, n]) => `${t} (${n})`).join(', ')}`);
  }

  if(WRITE){
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`  wrote verdicts back to ${path.basename(file)}`);
  }
  allReview.push(...out.filter((m) => m.verdict === 'review').map((m) => ({ dataset: base, ...m })));
}

console.log(`\n=== all files ===`);
console.log(`  ${grand.total} rows in  ->  ${grand.review} need judgement` +
            `  (${grand.reusedPage + grand.creatorPage + grand.indexPage} rejected mechanically,` +
            ` ${grand.noSource} have no source at all)`);
if(grand.total) {
  console.log(`  ${Math.round(100 * (grand.total - grand.review) / grand.total)}% decided without a model.`);
}

if(REVIEW_OUT){
  const out = path.isAbsolute(REVIEW_OUT) ? REVIEW_OUT : path.join(HERE, REVIEW_OUT);
  fs.writeFileSync(out, JSON.stringify(allReview, null, 2));
  console.log(`  review worklist -> ${path.basename(out)} (${allReview.length} rows)`);
}

if(!WRITE) console.log('  (nothing written — pass --write to record the verdicts)');
