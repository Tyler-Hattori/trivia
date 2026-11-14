#!/usr/bin/env node
/**
 * Embed every entry that does not already have a vector.
 *
 *     node datasets/embed-all.mjs            # fill the gaps (resumable)
 *     node datasets/embed-all.mjs --force    # re-embed everything
 *     node datasets/embed-all.mjs --batch 32
 *
 * Incremental by default, so an interrupted run costs nothing: it writes the
 * whole store after each batch, and a re-run picks up where it stopped.
 *
 * Use --force after changing the model, DIM, or `entryText()` — all three change
 * what the vectors mean, and mixing old with new silently corrupts the map
 * (entries would cluster by *which model embedded them* before anything else).
 */

import fs from 'node:fs';
import {
  readEntries, readVectors, writeVectors, readSearchVectors, writeSearchVectors,
  entryText, truncateNormalize, DIM, SEARCH_DIM, PATHS,
} from './lib/store.mjs';
import { embed, ensureUp, EMBED_MODEL } from './lib/ollama.mjs';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const FORCE = argv.includes('--force');
/*
 * Small batches and a pause between them, by default. A whole-corpus run at full
 * speed holds the GPU at 100% for minutes and is what overheated the laptop on
 * 2026-11-13. Normal use embeds only NEW entries (a few seconds) and never
 * notices; a --force run takes longer and stays cool. `--pause 0` for speed.
 */
const BATCH = Number(arg('--batch')) || 16;
const PAUSE_MS = arg('--pause') != null ? Number(arg('--pause')) : 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entries = readEntries();
if(!entries.length){
  console.error('  No entries. Run: node datasets/scripts/migrate.mjs');
  process.exit(1);
}

/*
 * --import-search <vectors.f32> <ids.json>: adopt full-width float32 vectors
 * computed elsewhere (row-major, SEARCH_DIM wide, ids in row order) as the
 * search store, without touching the model. Only rows whose id is live are kept.
 */
if(argv.includes('--import-search')){
  const [f32, idsPath] = [arg('--import-search'), argv[argv.indexOf('--import-search') + 2]];
  const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
  const raw = fs.readFileSync(f32);
  const M = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if(M.length !== ids.length * SEARCH_DIM) throw new Error(`expected ${ids.length} x ${SEARCH_DIM} floats, got ${M.length}`);
  const live = new Set(entries.map((e) => e.id));
  const rowOf = new Map(ids.map((id, i) => [id, i]));
  const pairs = entries.filter((e) => rowOf.has(e.id)).map((e) => {
    const i = rowOf.get(e.id);
    return [e.id, truncateNormalize(M.subarray(i * SEARCH_DIM, (i + 1) * SEARCH_DIM), SEARCH_DIM)];
  });
  writeSearchVectors(pairs, { model: EMBED_MODEL });
  console.log(`  imported ${pairs.length} search vectors (${ids.filter((id) => !live.has(id)).length} dead ids skipped)`);
  process.exit(0);
}

await ensureUp();

let existing = new Map();
let storedModel = null;
if(!FORCE){
  try {
    const v = readVectors();
    storedModel = v.model;
    if(v.model && v.model !== EMBED_MODEL){
      console.error(
        `  Stored vectors came from "${v.model}" but the configured model is "${EMBED_MODEL}".\n` +
        `  Vectors from different models are not comparable — re-run with --force.`,
      );
      process.exit(1);
    }
    if(v.dim !== DIM){
      console.error(`  Stored vectors are ${v.dim}-dim, DIM is now ${DIM}. Re-run with --force.`);
      process.exit(1);
    }
    for(const id of v.ids) existing.set(id, v.get(id));
  } catch(e){
    // A corrupt or absent sidecar is not fatal — just re-embed.
    if(!/no such file/i.test(e.message)) console.warn(`  ${e.message}\n  Re-embedding from scratch.`);
    existing = new Map();
  }
}

// Drop vectors whose entry is gone. Deleting an entry leaves its row behind,
// and an orphan is not harmless: it inflates the count reported everywhere and
// would be resurrected as a phantom point by anything that iterates the sidecar.
const live = new Set(entries.map((e) => e.id));
const orphans = [...existing.keys()].filter((id) => !live.has(id));
for(const id of orphans) existing.delete(id);

// Search vectors are a second output of the SAME embed call, so a missing one
// costs nothing extra when the map vector is missing too.
const search = new Map();
if(!FORCE){
  try {
    const sv = readSearchVectors();
    if(sv && sv.model === EMBED_MODEL) for(const id of sv.ids) if(live.has(id)) search.set(id, sv.get(id));
  } catch(e){ console.warn(`  search vectors unreadable (${e.message}); rebuilding them`); }
}

const todo = entries.filter((e) => !existing.has(e.id) || !search.has(e.id));
console.log(`  ${entries.length} entries · ${existing.size} already embedded · ${todo.length} to do` +
            `${orphans.length ? ` · ${orphans.length} orphaned vector(s) pruned` : ''}`);
console.log(`  model ${EMBED_MODEL} -> ${DIM} dims for the map, ${SEARCH_DIM} for search · batch ${BATCH}, pause ${PAUSE_MS}ms\n`);

if(!todo.length){
  if(orphans.length){
    const pairs = entries.filter((e) => existing.has(e.id)).map((e) => [e.id, existing.get(e.id)]);
    writeVectors(pairs, { model: EMBED_MODEL, native: null });
    console.log(`  pruned ${orphans.length}, wrote ${PATHS.vectors} (${pairs.length} x ${DIM})`);
  } else {
    console.log('  Nothing to do.');
  }
  process.exit(0);
}

const t0 = Date.now();
let done = 0;

for(let i = 0; i < todo.length; i += BATCH){
  const chunk = todo.slice(i, i + BATCH);
  const vectors = await embed(chunk.map((e) => entryText(e)));

  chunk.forEach((e, j) => {
    // Never overwrite an existing MAP vector: the atlas's frozen layout depends
    // on it, and re-embedding the same text is not bit-identical across runs.
    if(!existing.has(e.id)) existing.set(e.id, truncateNormalize(vectors[j], DIM));
    search.set(e.id, truncateNormalize(vectors[j], SEARCH_DIM));
  });
  done += chunk.length;

  // Persist every batch, in entries order, so the file is always consistent
  // with entries.jsonl even if this is killed mid-run.
  const pairs = entries.filter((e) => existing.has(e.id)).map((e) => [e.id, existing.get(e.id)]);
  writeVectors(pairs, { model: EMBED_MODEL, native: vectors[0].length });
  writeSearchVectors(entries.filter((e) => search.has(e.id)).map((e) => [e.id, search.get(e.id)]), { model: EMBED_MODEL });
  if(PAUSE_MS) await sleep(PAUSE_MS);

  const rate = done / ((Date.now() - t0) / 1000);
  const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
  process.stdout.write(
    `\r  ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s   `,
  );
}

console.log(`\n\n  wrote ${PATHS.vectors} (${existing.size} x ${DIM})`);
console.log('  next:  node datasets/atlas.mjs --rebuild');
