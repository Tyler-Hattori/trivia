#!/usr/bin/env node
/**
 * fame-backfill.mjs — fetch Wikidata sitelink counts for entries that predate
 * the `sitelinks` field, so the fame signal covers the whole corpus and not
 * just entries ingested after it existed.
 *
 *   node datasets/fame-backfill.mjs --dry     # report only, write nothing
 *   node datasets/fame-backfill.mjs           # fetch + write entries.jsonl
 *
 * Then rebuild so the browser sees it:
 *
 *   node datasets/atlas.mjs && node datasets/verify.mjs
 *
 * Only touches entries.jsonl in place — nothing is added or removed, so
 * migrate.mjs's carry-over/deletion logic is not involved.
 *
 * An entry with no QID (a mined timeline event, a hand-entered row) has no
 * Wikidata entity to ask and is left with `sitelinks: null` -> `fame: 0` at
 * build time. There is no notability signal available for those regardless.
 */

import { readEntries, writeEntries } from './lib/store.mjs';
import { sitelinksFor } from './lib/wiki.mjs';
import { mapPool } from './wikilib.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const CONC = Number((argv.includes('--concurrency') ? argv[argv.indexOf('--concurrency') + 1] : null) || 4);
const BATCH = 50;   // wbgetentities' own limit per request

const entries = readEntries();
const targets = entries.filter((e) => e.origin?.qid && e.sitelinks == null);

console.log(`\n  ${entries.length} entries, ${targets.length} missing sitelinks and have a QID`);
if(!targets.length){
  console.log('  nothing to do\n');
  process.exit(0);
}

const qids = [...new Set(targets.map((e) => e.origin.qid))];
const batches = [];
for(let i = 0; i < qids.length; i += BATCH) batches.push(qids.slice(i, i + BATCH));

console.log(`  fetching sitelinks for ${qids.length} QIDs, ${BATCH} per request…`);
const counts = new Map();
let done = 0;
await mapPool(batches, CONC, async (batch) => {
  const got = await sitelinksFor(batch);
  for(const [qid, n] of got) counts.set(qid, n);
  done += batch.length;
  process.stdout.write(`\r          ${Math.min(done, qids.length)}/${qids.length} QIDs`);
});
process.stdout.write('\n');

let updated = 0;
for(const e of targets){
  const n = counts.get(e.origin.qid);
  if(n != null){ e.sitelinks = n; updated++; }
}
console.log(`  ${updated} entries updated`);

const sample = [...targets].filter((e) => e.sitelinks != null).sort((a, b) => b.sitelinks - a.sitelinks);
console.log('\n  most notable:');
for(const e of sample.slice(0, 8)) console.log(`    ${e.sitelinks}\t${e.title}`);
console.log('  least notable:');
for(const e of sample.slice(-8)) console.log(`    ${e.sitelinks}\t${e.title}`);

if(DRY){
  console.log('\n  --dry: nothing written\n');
  process.exit(0);
}

writeEntries(entries);
console.log(`\n  wrote datasets/atlas/entries.jsonl\n\n  Next:  node datasets/atlas.mjs && node datasets/verify.mjs\n`);
