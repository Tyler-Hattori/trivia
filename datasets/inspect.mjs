#!/usr/bin/env node
/**
 * Inspect the atlas. The quality check that actually matters — a hierarchy can
 * look tidy in aggregate and still put nonsense next to nonsense.
 *
 *     node datasets/inspect.mjs                    # tree overview
 *     node datasets/inspect.mjs --near "cubism"    # nearest neighbours
 *     node datasets/inspect.mjs --leaf 42          # one leaf's members
 *     node datasets/inspect.mjs --cross            # do domains actually mix?
 *     node datasets/inspect.mjs --tree 2           # nodes down to depth 2
 *
 * `--cross` is the one to watch after any change to `entryText()`. If every
 * cluster is 100% one domain, the embedding has re-derived the source files and
 * the atlas is a swimlane chart with extra steps.
 */

import { readEntries, readVectors, readJSON, PATHS, entryText } from './lib/store.mjs';
import { knn, cosine } from './lib/cluster.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? true);
};

const atlas = readJSON(PATHS.atlas);
if(!atlas){ console.error('  No atlas.json. Run: node datasets/atlas.mjs --rebuild'); process.exit(1); }

const entries = readEntries();
const byId = new Map(entries.map((e) => [e.id, e]));
const P = atlas.points;
const N = atlas.count;
const nodes = atlas.nodes;

const label = (i) =>
  `${P.title[i]}${P.subtitle[i] ? ` (${P.subtitle[i]})` : ''} [${P.yearText[i] || P.x0[i]}]`;
const dom = (i) => (byId.get(P.id[i])?.domains || []).slice(0, 2).join('/');

// ---------------------------------------------------------------------------

if(flag('--near') !== null){
  const q = String(flag('--near')).toLowerCase();
  const hits = [];
  for(let i = 0; i < N; i++){
    const hay = `${P.title[i]} ${P.subtitle[i]} ${(P.topics[i] || []).join(' ')}`.toLowerCase();
    if(hay.includes(q)) hits.push(i);
  }
  if(!hits.length){ console.log(`  nothing matches "${q}"`); process.exit(0); }

  const vec = readVectors();
  const dim = vec.dim;
  const m = new Float32Array(N * dim);
  for(let i = 0; i < N; i++) m.set(vec.get(P.id[i]), i * dim);

  for(const i of hits.slice(0, 4)){
    console.log(`\n  ${label(i)}   y=${P.y[i].toFixed(4)}  leaf ${P.leaf[i]} "${nodes[P.leaf[i]].label}"`);
    const v = m.subarray(i * dim, i * dim + dim);
    for(const [j, s] of knn(m, dim, N, v, 8, i)){
      const sameLeaf = P.leaf[j] === P.leaf[i] ? '·' : ' ';
      console.log(`    ${s.toFixed(3)} ${sameLeaf} ${String(dom(j)).padEnd(14)} ${label(j)}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

if(flag('--leaf') !== null){
  const id = Number(flag('--leaf'));
  const nd = nodes[id];
  if(!nd){ console.error(`  no node ${id}`); process.exit(1); }
  console.log(`\n  node ${id}  depth ${nd.depth}  n=${nd.n}  ${nd.color}`);
  console.log(`  label: ${nd.label}`);
  console.log(`  terms: ${nd.terms.join(', ')}`);
  console.log(`  topics: ${nd.topics.map(([t, c]) => `${t}(${c})`).join(', ')}`);
  console.log(`  y ${nd.y0}–${nd.y1}   years ${nd.x0}–${nd.x1}\n`);

  const members = [];
  for(let i = 0; i < N; i++){
    let l = P.leaf[i];
    while(l !== -1 && l !== id) l = nodes[l].parent;
    if(l === id) members.push(i);
  }
  members.sort((a, b) => P.y[a] - P.y[b]);
  for(const i of members) console.log(`    y=${P.y[i].toFixed(4)}  ${String(dom(i)).padEnd(14)} ${label(i)}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

if(flag('--cross') !== null){
  console.log('\n  Domain mixing per leaf — how often does a cluster cross source files?\n');
  const leaves = nodes.filter((nd) => !nd.children.length && nd.n > 1);
  const rowsOf = new Map(leaves.map((nd) => [nd.id, []]));
  for(let i = 0; i < N; i++) rowsOf.get(P.leaf[i])?.push(i);

  let pure = 0;
  const mixed = [];
  for(const nd of leaves){
    const rows = rowsOf.get(nd.id) || [];
    const counts = new Map();
    for(const i of rows){
      const d = byId.get(P.id[i])?.origin?.dataset || '?';
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    if(counts.size === 1) pure++;
    else mixed.push([nd, [...counts].sort((a, b) => b[1] - a[1])]);
  }

  console.log(`  leaves: ${leaves.length}   single-source: ${pure} (${(100 * pure / leaves.length).toFixed(0)}%)   mixed: ${mixed.length}`);
  console.log('\n  the mixed ones:');
  for(const [nd, counts] of mixed.slice(0, 30)){
    console.log(`    ${String(nd.n).padStart(3)}  ${counts.map(([d, c]) => `${d}:${c}`).join(' ')}   ${nd.label}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

const maxDepth = flag('--tree') !== null ? Number(flag('--tree')) : 1;

console.log(`\n  ${atlas.count} points · ${nodes.length} nodes · depth ${atlas.maxDepth} · model ${atlas.model}`);
console.log(`  years ${atlas.xExtent[0]} … ${atlas.xExtent[1]} · built ${atlas.generated?.slice(0, 16)}\n`);

(function walk(id, indent){
  const nd = nodes[id];
  if(nd.depth > maxDepth) return;
  const bar = '│ '.repeat(Math.max(0, nd.depth - 1)) + (nd.depth ? '├─' : '');
  console.log(
    `  ${bar}${String(nd.n).padStart(5)}  ${nd.color}  ` +
    `${String(nd.x0).padStart(5)}–${String(nd.x1).padEnd(5)}  ` +
    `${nd.label}${nd.depth === maxDepth && nd.children.length ? `  (+${nd.children.length} sub)` : ''}`,
  );
  if(nd.depth === maxDepth) return;
  for(const c of nd.children) walk(c, indent + 1);
})(0, 0);

const noExcerpt = entries.filter((e) => !e.excerpt).length;
const noImage = entries.filter((e) => !e.image).length;
console.log(`\n  gaps: ${noExcerpt} entries without an excerpt · ${noImage} without an image`);
if(noExcerpt) console.log('  an entry with no excerpt embeds on its title alone, so it clusters weakly.');
