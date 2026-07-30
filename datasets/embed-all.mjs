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

import { readEntries, readVectors, writeVectors, entryText, truncateNormalize, DIM, PATHS } from './lib/store.mjs';
import { embed, ensureUp, EMBED_MODEL } from './lib/ollama.mjs';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const BATCH = Number(argv[argv.indexOf('--batch') + 1]) || 24;

const entries = readEntries();
if(!entries.length){
  console.error('  No entries. Run: node datasets/migrate.mjs');
  process.exit(1);
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

const todo = entries.filter((e) => !existing.has(e.id));
console.log(`  ${entries.length} entries · ${existing.size} already embedded · ${todo.length} to do` +
            `${orphans.length ? ` · ${orphans.length} orphaned vector(s) pruned` : ''}`);
console.log(`  model ${EMBED_MODEL} -> ${DIM} dims (Matryoshka prefix of 768)\n`);

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

  chunk.forEach((e, j) => existing.set(e.id, truncateNormalize(vectors[j], DIM)));
  done += chunk.length;

  // Persist every batch, in entries order, so the file is always consistent
  // with entries.jsonl even if this is killed mid-run.
  const pairs = entries.filter((e) => existing.has(e.id)).map((e) => [e.id, existing.get(e.id)]);
  writeVectors(pairs, { model: EMBED_MODEL, native: vectors[0].length });

  const rate = done / ((Date.now() - t0) / 1000);
  const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
  process.stdout.write(
    `\r  ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s   `,
  );
}

console.log(`\n\n  wrote ${PATHS.vectors} (${existing.size} x ${DIM})`);
console.log('  next:  node datasets/atlas.mjs --rebuild');
