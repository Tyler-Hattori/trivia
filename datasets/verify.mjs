#!/usr/bin/env node
/**
 * Invariant checks over the built atlas. Pure Node, about a second, no browser.
 *
 *     node datasets/verify.mjs
 *
 * These are the properties the design rests on. Each one, if it silently breaks,
 * produces an atlas that still renders and is still wrong — which is why they
 * are asserted rather than eyeballed.
 */

import fs from 'node:fs';
import { readEntries, readVectors, readJSON, PATHS, entryText } from './lib/store.mjs';
import { cosine, nearestLeaf } from './lib/cluster.mjs';
import { parseYears } from './lib/years.mjs';

let pass = 0;
const fails = [];

const check = (name, fn) => {
  try {
    const detail = fn();
    pass++;
    console.log(`  ok    ${name}${detail ? `   ${detail}` : ''}`);
  } catch(e){
    fails.push([name, e.message]);
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  }
};

const assert = (cond, msg) => { if(!cond) throw new Error(msg); };

// ---------------------------------------------------------------------------

const entries = readEntries();
const atlas = readJSON(PATHS.atlas);
const layout = readJSON(PATHS.layout);
const details = readJSON(PATHS.details);

if(!entries.length || !atlas){
  console.error('  Nothing built. Run: node datasets/migrate.mjs && node datasets/embed-all.mjs && node datasets/atlas.mjs --rebuild');
  process.exit(1);
}

const P = atlas.points;
const N = atlas.count;
const nodes = atlas.nodes;

console.log(`\n  ${entries.length} entries · ${N} placed · ${nodes.length} nodes · model ${atlas.model}\n`);

// ---- store -----------------------------------------------------------------

check('entry ids are unique', () => {
  const seen = new Set();
  for(const e of entries){
    assert(!seen.has(e.id), `duplicate id ${e.id}`);
    seen.add(e.id);
  }
  return `${seen.size} ids`;
});

check('every entry has a parseable year', () => {
  const bad = entries.filter((e) => typeof e.start !== 'number' || Number.isNaN(e.start));
  assert(!bad.length, `${bad.length} without a year, e.g. ${bad[0]?.id}`);
});

check('spans run forwards', () => {
  const bad = entries.filter((e) => e.end != null && e.end < e.start);
  assert(!bad.length, `${bad.length} end-before-start, e.g. ${bad[0]?.id} (${bad[0]?.yearText})`);
});

check('yearText still parses to the stored start', () => {
  const bad = entries.filter((e) => {
    if(!e.yearText) return false;
    const { start } = parseYears(e.yearText);
    return start != null && start !== e.start;
  });
  // A mismatch means the stored number and the displayed text disagree — the
  // card would show one year and sit at another.
  assert(bad.length === 0, `${bad.length} disagree, e.g. ${bad[0]?.id}: text "${bad[0]?.yearText}" vs start ${bad[0]?.start}`);
});

check('vectors exist for every placed point', () => {
  const vec = readVectors();
  const missing = P.id.filter((id) => !vec.has(id));
  assert(!missing.length, `${missing.length} placed points have no vector`);
  return `${vec.ids.length} vectors x ${vec.dim}`;
});

check('vectors are unit length', () => {
  const vec = readVectors();
  let worst = 0, worstId = null;
  for(const id of vec.ids.slice(0, 400)){
    const v = vec.get(id);
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    if(Math.abs(n - 1) > worst){ worst = Math.abs(n - 1); worstId = id; }
  }
  // int8 quantisation perturbs the norm slightly; more than 2% means the
  // per-row scale is wrong, not rounding.
  assert(worst < 0.02, `norm off by ${worst.toFixed(4)} on ${worstId}`);
  return `max norm error ${worst.toExponential(1)}`;
});

// ---- geometry --------------------------------------------------------------

check('y is inside [0,1]', () => {
  for(let i = 0; i < N; i++) assert(P.y[i] >= 0 && P.y[i] <= 1, `point ${P.id[i]} at y=${P.y[i]}`);
});

check('every point sits inside its own leaf band', () => {
  for(let i = 0; i < N; i++){
    const nd = nodes[P.leaf[i]];
    assert(nd, `point ${P.id[i]} references missing node ${P.leaf[i]}`);
    assert(!nd.children.length, `point ${P.id[i]} is attached to non-leaf ${nd.id}`);
    // 1e-5 rounding is applied on output.
    assert(P.y[i] >= nd.y0 - 1e-4 && P.y[i] <= nd.y1 + 1e-4,
      `${P.id[i]} y=${P.y[i]} outside leaf ${nd.id} band ${nd.y0}–${nd.y1}`);
  }
});

check('parent bands contain their children', () => {
  for(const nd of nodes){
    for(const c of nd.children){
      assert(nodes[c].y0 >= nd.y0 - 1e-4 && nodes[c].y1 <= nd.y1 + 1e-4,
        `node ${c} band ${nodes[c].y0}–${nodes[c].y1} escapes parent ${nd.id} ${nd.y0}–${nd.y1}`);
    }
  }
});

check('sibling bands do not overlap', () => {
  for(const nd of nodes){
    const kids = nd.children.map((c) => nodes[c]).sort((a, b) => a.y0 - b.y0);
    for(let i = 1; i < kids.length; i++){
      assert(kids[i].y0 >= kids[i - 1].y1 - 1e-4,
        `siblings ${kids[i - 1].id} and ${kids[i].id} overlap under ${nd.id}`);
    }
  }
});

check('leaf bands tile the axis in order, without gaps', () => {
  const leaves = nodes.filter((nd) => !nd.children.length).sort((a, b) => a.y0 - b.y0);
  assert(Math.abs(leaves[0].y0) < 1e-4, `first leaf starts at ${leaves[0].y0}, not 0`);
  assert(Math.abs(leaves[leaves.length - 1].y1 - 1) < 1e-4,
    `last leaf ends at ${leaves[leaves.length - 1].y1}, not 1`);
  for(let i = 1; i < leaves.length; i++){
    assert(Math.abs(leaves[i].y0 - leaves[i - 1].y1) < 1e-4,
      `gap between leaves ${leaves[i - 1].id} and ${leaves[i].id}`);
  }
  return `${leaves.length} leaves`;
});

check('node time extents contain their members', () => {
  const rowsOf = new Map();
  for(let i = 0; i < N; i++){
    let l = P.leaf[i];
    while(l !== -1 && l != null){
      if(!rowsOf.has(l)) rowsOf.set(l, []);
      rowsOf.get(l).push(i);
      l = nodes[l].parent;
    }
  }
  for(const nd of nodes){
    for(const i of rowsOf.get(nd.id) || []){
      assert(P.x0[i] >= nd.x0 && P.x1[i] <= nd.x1,
        `${P.id[i]} (${P.x0[i]}–${P.x1[i]}) outside node ${nd.id} extent ${nd.x0}–${nd.x1}`);
    }
  }
});

check('node member counts match reality', () => {
  const counts = new Map();
  for(let i = 0; i < N; i++){
    let l = P.leaf[i];
    while(l !== -1 && l != null){ counts.set(l, (counts.get(l) || 0) + 1); l = nodes[l].parent; }
  }
  assert(nodes[0].n === N, `root claims ${nodes[0].n}, atlas has ${N}`);
  for(const nd of nodes){
    assert((counts.get(nd.id) || 0) === nd.n, `node ${nd.id} claims n=${nd.n}, holds ${counts.get(nd.id) || 0}`);
  }
});

// ---- semantics -------------------------------------------------------------

check('vertical neighbours are semantic neighbours', () => {
  // The load-bearing claim of the whole design: closeness in y should mean
  // similarity. Compare the mean similarity of y-adjacent pairs against random
  // pairs. If the ordering carried no information these would be equal.
  const vec = readVectors();
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => P.y[a] - P.y[b]);
  let adj = 0;
  for(let i = 1; i < order.length; i++) adj += cosine(vec.get(P.id[order[i]]), vec.get(P.id[order[i - 1]]));
  adj /= order.length - 1;

  let rnd = 0;
  const samples = 4000;
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for(let s = 0; s < samples; s++){
    rnd += cosine(vec.get(P.id[Math.floor(next() * N)]), vec.get(P.id[Math.floor(next() * N)]));
  }
  rnd /= samples;

  assert(adj > rnd + 0.15, `y-adjacent similarity ${adj.toFixed(3)} is not clearly above random ${rnd.toFixed(3)}`);
  return `adjacent ${adj.toFixed(3)} vs random ${rnd.toFixed(3)}`;
});

check('the axis is not a proxy for time', () => {
  // Year is the x-axis. If y correlates strongly with it, the embedding is
  // encoding date and the second dimension is wasted.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for(let i = 0; i < N; i++){
    const x = P.x0[i], yv = P.y[i];
    sx += x; sy += yv; sxx += x * x; syy += yv * yv; sxy += x * yv;
  }
  const r = (N * sxy - sx * sy) / Math.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy));
  assert(Math.abs(r) < 0.6, `y correlates with year at r=${r.toFixed(3)}`);
  return `r=${r.toFixed(3)}`;
});

check('knn excludes self and is sorted', () => {
  for(let i = 0; i < N; i++){
    const nb = P.knn[i];
    assert(!nb.includes(i), `point ${i} lists itself as a neighbour`);
    assert(nb.every((j) => j >= 0 && j < N), `point ${i} has an out-of-range neighbour`);
  }
  return `k=${P.knn[0]?.length}`;
});

check('columnar arrays are all the same length', () => {
  for(const [k, v] of Object.entries(P)){
    assert(Array.isArray(v) && v.length === N, `points.${k} has ${v?.length}, expected ${N}`);
  }
  return `${Object.keys(P).length} columns x ${N}`;
});

check('details.json covers every point', () => {
  const missing = P.id.filter((id) => !details?.[id]);
  assert(!missing.length, `${missing.length} points have no details entry`);
});

// ---- stability -------------------------------------------------------------

check('layout.json can reproduce every placement', () => {
  assert(layout, 'no layout.json');
  const placed = new Map(layout.placement.map(([id, leaf]) => [id, leaf]));
  const drifted = P.id.filter((id, i) => placed.get(id) !== P.leaf[i]);
  assert(!drifted.length, `${drifted.length} points disagree with layout.json`);
  const withY = layout.placement.filter((p) => p[2] != null).length;
  assert(withY === layout.placement.length, `${layout.placement.length - withY} placements lack a stored y`);
  return `${layout.placement.length} placements with y`;
});

check('a re-ingest of an existing entry would be a no-op', () => {
  // Descending the frozen tree with a stored vector must land on the leaf the
  // entry is already in, or incremental placement would scatter re-ingests.
  const vec = readVectors();
  const tree = layout.nodes.map((nd) => ({ ...nd, centroid: Float32Array.from(nd.centroid) }));
  let wrong = 0;
  const step = Math.max(1, Math.floor(N / 300));
  let tested = 0;
  for(let i = 0; i < N; i += step){
    tested++;
    if(nearestLeaf(vec.get(P.id[i]), tree) !== P.leaf[i]) wrong++;
  }
  // Greedy descent is not guaranteed to match a k-means assignment exactly:
  // k-means assigns by leaf centroid globally, descent commits at each level.
  assert(wrong / tested < 0.12, `${wrong}/${tested} sampled entries would be re-placed elsewhere`);
  return `${wrong}/${tested} would move`;
});

check('embedded text excludes domains', () => {
  // Domains are perfectly correlated with the source file. If they leak into the
  // embedding the hierarchy just re-derives the original CSVs.
  const e = entries.find((x) => x.domains?.length && x.topics?.length);
  if(!e) return 'no entry has both to compare';
  const text = entryText(e);
  const leaked = e.domains.filter((d) => text.toLowerCase().includes(d.toLowerCase()) &&
                                          !e.topics.includes(d) &&
                                          !String(e.title + e.subtitle + e.excerpt).toLowerCase().includes(d));
  assert(!leaked.length, `domains leaked into entryText: ${leaked.join(', ')}`);
});

// ---------------------------------------------------------------------------

const sizeKB = (p) => (fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) : 0);
console.log(`\n  payload: atlas.json ${sizeKB(PATHS.atlas)}KB · details.json ${sizeKB(PATHS.details)}KB · vectors.bin ${sizeKB(PATHS.vectors)}KB`);
console.log(`  ${pass} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
