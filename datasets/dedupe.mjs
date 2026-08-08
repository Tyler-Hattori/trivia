/**
 * Remove entries that duplicate another entry's Wikidata QID.
 *
 *     node datasets/dedupe.mjs --dry     # list what would go
 *     node datasets/dedupe.mjs           # write entries.jsonl
 *
 * ## Why this exists
 *
 * `ingest.mjs` deduped against the store as it stood when the run STARTED, and
 * never against what the same run had already accepted. Two source pages both
 * linking one article therefore produced two entries; the generated id collided,
 * the `~N` collision suffix made it unique, and a second copy landed in the
 * store. 65 rows across 58 QIDs arrived that way — two identical Proterozoic
 * eons among them, drawn on the atlas as one unselectable mark.
 *
 * The gate in `ingest.mjs` is fixed and `verify.mjs` asserts the invariant, so
 * no new ones can appear. This clears the ones that already did; nothing else
 * calls it and it should be a single use.
 *
 * ## Which copy survives
 *
 * The richest, not the first. A duplicate pair is rarely identical — one copy
 * usually came from a page that carried an image or a longer lead — so keep the
 * one with the most substance and let the id of the survivor be whichever it
 * already had. Ordering by excerpt length then by image then by id keeps the
 * choice deterministic across runs, which matters because the entry order here
 * is the row order every vector and layout file is indexed against.
 *
 * Vectors are keyed by id in `vectors.json`, and dropping a row leaves its
 * vector orphaned rather than misaligned — `readVectors` looks entries up by id.
 * `atlas.mjs` rebuilds the layout from whatever ids survive, so a rebuild after
 * this is all that is needed. Re-running `embed-all.mjs` is not.
 */
import { readEntries, writeEntries } from './lib/store.mjs';

const DRY = process.argv.includes('--dry');

const entries = readEntries();

const byQid = new Map();
for(const e of entries){
  const q = e.origin?.qid;
  if(!q) continue;
  byQid.set(q, [...(byQid.get(q) || []), e]);
}

/** Prefer the copy with the most to embed on, then the one with an image. */
const richness = (e) =>
  [String(e.excerpt || '').length, e.image ? 1 : 0, (e.topics || []).length];

const drop = new Set();
const groups = [];

for(const [qid, rows] of byQid){
  if(rows.length < 2) continue;
  const ranked = [...rows].sort((a, b) => {
    const ra = richness(a), rb = richness(b);
    for(let i = 0; i < ra.length; i++) if(rb[i] !== ra[i]) return rb[i] - ra[i];
    return String(a.id).localeCompare(String(b.id));
  });
  const [keep, ...rest] = ranked;
  for(const e of rest) drop.add(e.id);
  groups.push({ qid, keep, rest });
}

console.log(`${entries.length} entries · ${groups.length} duplicated QIDs · ${drop.size} to drop\n`);

for(const { qid, keep, rest } of groups){
  console.log(`  ${qid}  ${String(keep.title).slice(0, 44)}`);
  console.log(`    keep  ${keep.id}  (${String(keep.excerpt || '').length} chars${keep.image ? ', image' : ''})`);
  for(const e of rest){
    console.log(`    drop  ${e.id}  (${String(e.excerpt || '').length} chars${e.image ? ', image' : ''})`);
  }
}

if(!drop.size){ console.log('\nNothing to do.'); process.exit(0); }

if(DRY){
  console.log(`\n--dry: nothing written. Re-run without it to drop ${drop.size}.`);
  process.exit(0);
}

const kept = entries.filter((e) => !drop.has(e.id));
writeEntries(kept);

console.log(`\nwrote ${kept.length} entries (was ${entries.length}).`);
console.log('Now rebuild: node datasets/atlas.mjs');
