#!/usr/bin/env node
/**
 * Compile entries + vectors into the artifacts the browser loads.
 *
 *     node datasets/atlas.mjs --rebuild   # re-fit the hierarchy from scratch
 *     node datasets/atlas.mjs             # keep the hierarchy, place new entries
 *
 * ## Two modes, and why it matters which one you use
 *
 * `--rebuild` re-fits the cluster tree. Every y coordinate and every colour can
 * change, so the map you have learned the shape of is rearranged. Do it when the
 * corpus has grown enough that the old grouping no longer describes it.
 *
 * The default mode treats `layout.json` as frozen: new entries descend the
 * existing tree to their nearest leaf and are slotted in. Nothing already
 * placed moves. This is what makes bulk ingestion usable — add two hundred
 * entries and the atlas you know stays recognisable, with the new points
 * appearing among their kin.
 *
 * ## Outputs
 *
 *   atlas/layout.json   the fitted hierarchy: centroids, order, y bands, colours.
 *                       The one file that must persist for stability.
 *   atlas/atlas.json    everything the canvas needs to draw and hover: columnar
 *                       point arrays plus the node tree. No excerpts.
 *   atlas/details.json  id -> excerpt + facets, fetched lazily on first open.
 *
 * Points are columnar (parallel arrays, not an array of objects) because the
 * renderer wants typed arrays and a 100k-object JSON parse is the kind of thing
 * that breaks the project's "loads incredibly quickly" requirement.
 */

import fs from 'node:fs';
import {
  readEntries, readVectors, writeJSON, readJSON, readVocab, writeVocab,
  truncateNormalize, PATHS, DIM,
} from './lib/store.mjs';
import {
  buildTree, assignY, labelNodes, assignColors, leavesInOrder,
  nearestLeaf, centroid, cosine, pc1Projections, knn, harvestVocabulary,
} from './lib/cluster.mjs';

const argv = process.argv.slice(2);
const REBUILD = argv.includes('--rebuild');
const KNN_K = Number(argv[argv.indexOf('--knn') + 1]) || 8;
const NO_SEMANTIC = argv.includes('--no-semantic-labels');

const entries = readEntries();
if(!entries.length){
  console.error('  No entries. Run: node datasets/migrate.mjs');
  process.exit(1);
}

const vec = readVectors();
const missing = entries.filter((e) => !vec.has(e.id));
if(missing.length){
  console.error(`  ${missing.length} of ${entries.length} entries have no vector.`);
  console.error(`  Run: node datasets/embed-all.mjs`);
  if(missing.length === entries.length) process.exit(1);
}

// Only embedded entries can be placed; an unembedded one has no position.
const rows = entries.filter((e) => vec.has(e.id));
const n = rows.length;
const dim = vec.dim;

// One flat matrix. Row i corresponds to rows[i].
const m = new Float32Array(n * dim);
rows.forEach((e, i) => m.set(vec.get(e.id), i * dim));
rows.forEach((e, i) => { e.vec = m.subarray(i * dim, i * dim + dim); });   // for labelNodes

console.log(`  ${n} entries x ${dim} dims · model ${vec.model}`);

// ---------------------------------------------------------------------------
// The hierarchy
// ---------------------------------------------------------------------------

const FIT_OPTS = { leafTarget: 12, maxBranch: 10, maxDepth: 6, seed: 1, sizeExponent: 0.75, gutter: 0.6 };

let nodes, y, frozen = null;

if(!REBUILD) frozen = readJSON(PATHS.layout, null);

if(frozen && frozen.dim !== dim){
  console.warn(`  layout.json was fitted at ${frozen.dim} dims, store is ${dim}. Rebuilding.`);
  frozen = null;
}

if(frozen){
  // ---- incremental: reuse the frozen tree, place newcomers into it ----------
  nodes = frozen.nodes.map((nd) => ({
    ...nd,
    centroid: Float32Array.from(nd.centroid),
    rows: [],
  }));

  const knownIndex = new Map(frozen.placement.map(([id, leaf]) => [id, leaf]));
  const knownY = new Map(frozen.placement.filter((p) => p[2] != null).map(([id, , yv]) => [id, yv]));
  let placed = 0, added = 0;

  rows.forEach((e, i) => {
    let leaf = knownIndex.get(e.id);
    if(leaf === undefined || !nodes[leaf] || nodes[leaf].children.length){
      leaf = nearestLeaf(e.vec, nodes);
      added++;
    } else placed++;
    nodes[leaf].rows.push(i);
  });

  // Roll member lists up the tree so parents describe their subtree again.
  for(let i = nodes.length - 1; i >= 0; i--){
    const nd = nodes[i];
    if(nd.children.length) nd.rows = nd.children.flatMap((c) => nodes[c].rows);
    nd.n = nd.rows.length;
  }

  console.log(`  layout.json reused: ${placed} entries kept their position, ${added} newly placed`);

  // Restore the frozen band geometry verbatim. `assignY` would recompute band
  // heights from the new member counts, which is right for a rebuild and exactly
  // wrong here — the promise of this mode is that bands do not move.
  y = new Float64Array(n);
  for(const nd of nodes){
    const f = frozen.nodes[nd.id];
    if(f && f.y0 != null){ nd.y0 = f.y0; nd.y1 = f.y1; }
  }

  const { exact, interpolated } = placeNewInFrozenBands(m, dim, nodes, y, knownY, rows, frozen.opts);
  console.log(`  y: ${exact} held exactly, ${interpolated} interpolated into gaps`);

  if(interpolated && !knownY.size){
    console.warn('  layout.json predates stored y values — positions were recomputed once.');
  }
} else {
  // ---- full fit ------------------------------------------------------------
  console.log('  fitting hierarchy…');
  ({ nodes } = buildTree(m, dim, n, FIT_OPTS));
  ({ y } = assignY(m, dim, n, nodes, FIT_OPTS));
}

/**
 * Vectors for the candidate label terms.
 *
 * Cached in `atlas/vocab.bin`, and only the terms missing from that cache are
 * embedded — the vocabulary is document-frequency gated, so a few hundred new
 * entries typically add a handful of rows rather than thousands.
 *
 * Ollama being down is not fatal here. It is required to embed *entries*, but a
 * build that only re-lays-out existing vectors should still work offline, so a
 * failure downgrades to the c-TF-IDF labels rather than stopping the run.
 */
async function labelVocabulary(){
  if(NO_SEMANTIC) return null;

  const { terms, df } = harvestVocabulary(rows);
  if(!terms.length) return null;

  const cached = readVocab();
  const usable = cached && cached.model === vec.model && cached.dim === dim ? cached : null;
  const vm = new Float32Array(terms.length * dim);
  const missing = [];

  terms.forEach((t, i) => {
    const v = usable && usable.get(t);
    if(v) vm.set(v, i * dim);
    else missing.push(i);
  });

  if(missing.length){
    let embed, ensureUp;
    try {
      ({ embed, ensureUp } = await import('./lib/ollama.mjs'));
      await ensureUp();
    } catch(e){
      console.warn(`  label vocabulary: ${String(e.message).split('\n')[0]}`);
      console.warn('  falling back to c-TF-IDF labels for this build.');
      return null;
    }

    console.log(`  label vocabulary: ${terms.length} terms · ${missing.length} to embed`);
    const BATCH = 64;
    for(let i = 0; i < missing.length; i += BATCH){
      const idx = missing.slice(i, i + BATCH);
      // Same `title: … | text: …` document form the entries use, so a term and
      // an entry land in the same region of the space rather than two dialects
      // of it.
      const out = await embed(idx.map((j) => `title: ${terms[j]} | text: ${terms[j]}`));
      idx.forEach((j, k) => vm.set(truncateNormalize(out[k], dim), j * dim));
    }
    writeVocab(terms.map((t, i) => [t, vm.subarray(i * dim, (i + 1) * dim)]), { model: vec.model });
  }

  return { terms, df, m: vm, dim };
}

const vocab = await labelVocabulary();

labelNodes(nodes, rows, { vocab });
assignColors(nodes);

const leaves = leavesInOrder(nodes);
const depths = nodes.reduce((mx, nd) => Math.max(mx, nd.depth), 0);

/**
 * Place entries inside frozen bands, holding every already-placed entry at the
 * exact y it had before.
 *
 * The naive version re-ranks a whole leaf whenever one entry joins it, since a
 * rank-based position is `(rank + 0.5) / n`. Measured on a real ingest that moved
 * 10% of existing points by up to 0.7% of the axis — small, but it means the map
 * you were looking at is not quite the map you get back, and on a tall canvas
 * that is a few hundred pixels.
 *
 * So: known entries keep their stored y verbatim. A newcomer is ordered against
 * the leaf's members by the leaf's own principal component, then dropped into the
 * gap between its two nearest *already-placed* neighbours. Several newcomers in
 * one gap share it evenly. Nothing on screen moves at all.
 *
 * The cost is that bands slowly crowd as gaps subdivide; `--rebuild` re-spaces
 * everything and is the intended remedy.
 */
function placeNewInFrozenBands(m, dim, nodes, y, knownY, rows, opts = {}){
  const gutter = opts.gutter ?? 0.6;
  const sizeExponent = opts.sizeExponent ?? 0.75;
  let exact = 0, interpolated = 0;

  for(const nd of nodes){
    if(nd.children.length || !nd.rows.length) continue;

    const pad = (gutter / 2) / (Math.pow(Math.max(nd.n, 1), sizeExponent) + gutter) * (nd.y1 - nd.y0);
    const lo = nd.y0 + pad, hi = nd.y1 - pad;

    // Order every member of the leaf, old and new, along the leaf's own axis.
    const proj = pc1Projections(m, dim, nd.rows);
    const order = nd.rows
      .map((_, i) => i)
      .sort((p, q) => proj[p] - proj[q] || nd.rows[p] - nd.rows[q])
      .map((i) => nd.rows[i]);

    // Known positions anchor the sequence; runs of unknowns between them get
    // spread across the gap they fall into.
    const anchors = order.map((r) => (knownY.has(rows[r].id) ? knownY.get(rows[r].id) : null));

    let i = 0;
    while(i < order.length){
      if(anchors[i] != null){
        y[order[i]] = anchors[i];
        exact++;
        i++;
        continue;
      }
      // A run of new entries from i to j-1.
      let j = i;
      while(j < order.length && anchors[j] == null) j++;
      const before = i > 0 ? anchors[i - 1] ?? y[order[i - 1]] : lo;
      const after  = j < order.length ? anchors[j] : hi;
      const span = after - before;
      const count = j - i;
      for(let k = 0; k < count; k++){
        y[order[i + k]] = before + (span * (k + 1)) / (count + 1);
        interpolated++;
      }
      i = j;
    }

    nd.order = order;
  }

  return { exact, interpolated };
}

// ---------------------------------------------------------------------------
// Time extents per node
// ---------------------------------------------------------------------------

for(let i = nodes.length - 1; i >= 0; i--){
  const nd = nodes[i];
  let x0 = Infinity, x1 = -Infinity;
  for(const r of nd.rows){
    x0 = Math.min(x0, rows[r].start);
    x1 = Math.max(x1, rows[r].end ?? rows[r].start);
  }
  nd.x0 = Number.isFinite(x0) ? x0 : 0;
  nd.x1 = Number.isFinite(x1) ? x1 : 0;
}

const xMin = Math.min(...rows.map((e) => e.start));
const xMax = Math.max(...rows.map((e) => e.end ?? e.start));

// ---------------------------------------------------------------------------
// Nearest neighbours, for "more like this" and the quiz's topic filter
// ---------------------------------------------------------------------------

console.log(`  computing ${KNN_K}-NN…`);
const neighbours = rows.map((e, i) => knn(m, dim, n, e.vec, KNN_K, i).map(([j]) => j));

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const leafOf = new Int32Array(n);
for(const id of leaves) for(const r of nodes[id].rows) leafOf[r] = id;

// Round hard: y needs about 5 decimals to be pixel-exact on a 40k-tall canvas,
// and every extra digit is bytes on the wire for no visible gain.
const r5 = (v) => Math.round(v * 1e5) / 1e5;

const atlas = {
  version: 2,
  model: vec.model,
  dim,
  count: n,
  xExtent: [xMin, xMax],
  maxDepth: depths,
  generated: new Date().toISOString(),

  // Columnar. Order is entries.jsonl order restricted to embedded rows, which
  // is also the order details.json and vectors.b64 use — one index, everywhere.
  points: {
    id:       rows.map((e) => e.id),
    title:    rows.map((e) => e.title),
    subtitle: rows.map((e) => e.subtitle),
    x0:       rows.map((e) => e.start),
    x1:       rows.map((e) => e.end ?? e.start),
    y:        Array.from(y.subarray(0, n), r5),
    leaf:     Array.from(leafOf),
    kind:     rows.map((e) => (e.kind === 'span' ? 1 : 0)),
    circa:    rows.map((e) => (e.circa ? 1 : 0)),
    // A span whose right edge is the present rather than an end date, so the
    // renderer can cap it open instead of squaring it off at the current year.
    openEnded:  rows.map((e) => (e.openEnded ? 1 : 0)),
    image:    rows.map((e) => e.image),
    yearText: rows.map((e) => e.yearText),
    dataset:  rows.map((e) => e.origin?.dataset || ''),
    topics:   rows.map((e) => e.topics),
    knn:      neighbours,
  },

  nodes: nodes.map((nd) => ({
    id: nd.id,
    parent: nd.parent,
    depth: nd.depth,
    children: nd.children,
    n: nd.n,
    label: nd.label,
    terms: nd.terms,
    topics: nd.topTopics,
    exemplar: nd.exemplar,          // index into points
    y0: r5(nd.y0), y1: r5(nd.y1),
    x0: nd.x0, x1: nd.x1,
    color: nd.color,
  })),
};

writeJSON(PATHS.atlas, atlas);

writeJSON(PATHS.details, Object.fromEntries(
  rows.map((e) => [e.id, { excerpt: e.excerpt, facets: e.facets, origin: e.origin }]),
));

// layout.json: only what a later incremental run needs to reproduce geometry.
writeJSON(PATHS.layout, {
  version: 2,
  dim,
  model: vec.model,
  opts: frozen ? frozen.opts : FIT_OPTS,
  fittedAt: frozen ? frozen.fittedAt : new Date().toISOString(),
  fittedCount: frozen ? frozen.fittedCount : n,
  nodes: nodes.map((nd) => ({
    id: nd.id, parent: nd.parent, depth: nd.depth, children: nd.children,
    centroid: Array.from(nd.centroid, (v) => Math.round(v * 1e4) / 1e4),
    y0: r5(nd.y0), y1: r5(nd.y1),
  })),
  // [id, leaf, y] — y is stored so the next incremental run can hold every
  // existing entry at exactly the position it already has.
  placement: rows.map((e, i) => [e.id, leafOf[i], r5(y[i])]),
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const sizes = leaves.map((id) => nodes[id].n).sort((a, b) => a - b);
const byDepth = {};
for(const nd of nodes) byDepth[nd.depth] = (byDepth[nd.depth] || 0) + 1;

console.log(`\n  hierarchy: ${nodes.length} nodes, depth ${depths}`);
console.log('  ' + Object.entries(byDepth).map(([d, c]) => `L${d}:${c}`).join('  '));
console.log(`  leaves: ${leaves.length}  members min ${sizes[0]} / median ${sizes[sizes.length >> 1]} / max ${sizes[sizes.length - 1]}`);
console.log(`  years: ${xMin} … ${xMax}`);
console.log('\n  broad groups (depth 1):');
for(const c of nodes[0].children){
  const nd = nodes[c];
  console.log(`    ${String(nd.n).padStart(5)}  ${nd.color}  y ${nd.y0.toFixed(3)}–${nd.y1.toFixed(3)}  ${nd.label}`);
}

const kb = (p) => Math.round(fs.statSync(p).size / 1024);
console.log(`\n  wrote atlas.json ${kb(PATHS.atlas)}KB · details.json ${kb(PATHS.details)}KB · layout.json ${kb(PATHS.layout)}KB`);
