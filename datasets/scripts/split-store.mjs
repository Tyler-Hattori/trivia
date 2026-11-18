#!/usr/bin/env node
/**
 * One-time move (2026-11-17) from the single-file store in datasets/atlas/ to
 * datasets/store/ (chunked; see lib/store.mjs). Copies bytes as they are:
 * vector rows are not re-quantised, entry lines are re-serialised by
 * writeEntries (same entryLine as before, so identical text).
 *
 *     node datasets/scripts/split-store.mjs          # move, then verify counts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ATLAS_DIR, PATHS, CHUNK_ROWS, writeEntries, readEntries, readVectors, readSearchVectors, entryLine } from '../lib/store.mjs';

const old = (f) => path.join(ATLAS_DIR, f);
fs.mkdirSync(PATHS.store, { recursive: true });
fs.mkdirSync(path.dirname(PATHS.vectors), { recursive: true });

// Entries: the exact old lines, in order.
const lines = fs.readFileSync(old('entries.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const entries = lines.map((l) => JSON.parse(l));
writeEntries(entries);
const back = readEntries();
if(back.length !== entries.length) throw new Error(`entries: wrote ${entries.length}, read ${back.length}`);
const same = back.every((e, i) => entryLine(e) === entryLine(entries[i]));
console.log(`  entries: ${entries.length} in ${fs.readdirSync(PATHS.entries).length} chunks · identical: ${same}`);

// Vectors: raw rows into CHUNK_ROWS-row files.
for(const [bin, meta, prefix, metaOut] of [
  ['vectors.bin', 'vectors.json', PATHS.vectors, PATHS.vecMeta],
  ['search-vectors.bin', 'search-vectors.json', PATHS.searchVectors, PATHS.searchVecMeta],
]){
  const buf = fs.readFileSync(old(bin));
  const m = JSON.parse(fs.readFileSync(old(meta), 'utf8'));
  const rowBytes = 4 + m.dim;
  const rows = buf.length / rowBytes;
  if(rows !== m.ids.length) throw new Error(`${bin}: ${rows} rows, ${m.ids.length} ids`);
  for(let i = 0; i * CHUNK_ROWS < rows; i++){
    fs.writeFileSync(`${prefix}-${String(i).padStart(3, '0')}.bin`, buf.subarray(i * CHUNK_ROWS * rowBytes, Math.min(rows, (i + 1) * CHUNK_ROWS) * rowBytes));
  }
  fs.writeFileSync(metaOut, fs.readFileSync(old(meta)));
  console.log(`  ${bin}: ${rows} rows -> ${Math.ceil(rows / CHUNK_ROWS)} chunks`);
}
const v = readVectors(), sv = readSearchVectors();
const a = Buffer.compare(v.buf, fs.readFileSync(old('vectors.bin'))) === 0;
const b = Buffer.compare(sv.buf, fs.readFileSync(old('search-vectors.bin'))) === 0;
console.log(`  vectors byte-identical: map ${a}, search ${b}`);

// Caches that move as they are.
for(const [f, to] of [['layout.json', PATHS.layout], ['taxonomy.json', PATHS.taxonomy], ['ideas.jsonl', PATHS.ideas], ['vocab.bin', PATHS.vocab], ['vocab.json', PATHS.vocabMeta]]){
  if(fs.existsSync(old(f))) fs.copyFileSync(old(f), to);
}
console.log('  copied layout, taxonomy, ideas, vocab. Old files in datasets/atlas/ can now be removed.');
