/**
 * Recluster an arbitrary subset of stored entries into their own small
 * hierarchy — the same math `datasets/atlas.mjs` runs over the whole corpus at
 * build time (`buildTree` -> `assignY` -> `labelNodes` -> `assignColors`), but at
 * request time, over just the ids a search matched. Pure function, no HTTP —
 * `serve.mjs` is the only thing that knows this is a route.
 *
 * This is what lets the atlas's "focus mode" show a query's matches organized by
 * their own mutual similarity (a fresh, self-contained tree) rather than at their
 * position in the corpus-wide hierarchy, where a multi-domain topic like "England"
 * is scattered across whatever domains the global tree split it into.
 */

import { readEntries, readVectors } from './store.mjs';
import { buildTree, assignY, labelNodes, assignColors, leavesInOrder } from './cluster.mjs';

// A DoS backstop, not the primary limit — the client is expected to cap what it
// sends well below this (by priority) and report the truncation itself. This is
// a local dev server with no auth, so a request past this ceiling is refused
// outright rather than serviced expensively.
export const RECLUSTER_MAX_IDS = 2000;

/**
 * Smaller than atlas.mjs's corpus-wide FIT_OPTS (leafTarget 12, maxDepth 6): a
 * focus subset is a handful to ~2,000 entries, not 3,800+, and should show
 * sub-structure even on a modest result set rather than collapsing to one leaf.
 */
function fitOptsFor(n){
  const leafTarget = Math.max(4, Math.min(12, Math.round(Math.sqrt(n))));
  return { leafTarget, maxBranch: 8, maxDepth: 5, seed: 1, sizeExponent: 0.75, gutter: 0.5 };
}

// y needs about 5 decimals to be pixel-exact on a tall canvas; same rounding
// atlas.mjs uses for the corpus-wide build, kept for the same reason here.
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * `ids`: string[] of entry ids. Returns a JSON-serialisable result, or throws —
 * the caller (serve.mjs) maps a throw to an HTTP error response.
 *
 * `buildTree`/`assignY`/`labelNodes`/`assignColors` all degrade gracefully at
 * n=0,1,2 (a single leaf, an arbitrary-but-stable order, one colour) — verified
 * against their own code rather than special-cased here, so a query that matches
 * only a couple of entries still gets a real answer instead of a hand-rolled one.
 */
export function reclusterSubset(ids){
  const t0 = Date.now();
  if(!Array.isArray(ids) || !ids.length) throw new Error('ids must be a non-empty array');
  if(ids.length > RECLUSTER_MAX_IDS) throw new Error(`too many ids (${ids.length} > ${RECLUSTER_MAX_IDS})`);

  const uniqueIds = [...new Set(ids)];
  const vec = readVectors();
  const byId = new Map(readEntries().map((e) => [e.id, e]));

  const rows = [];
  for(const id of uniqueIds){
    const e = byId.get(id);
    if(e && vec.has(id)) rows.push(e);
  }
  const missing = uniqueIds.length - rows.length;
  const n = rows.length;
  const dim = vec.dim;

  const m = new Float32Array(n * dim);
  rows.forEach((e, i) => {
    m.set(vec.get(e.id), i * dim);
    e.vec = m.subarray(i * dim, i * dim + dim);   // labelNodes' exemplar pick reads entries[r].vec
  });

  const opts = fitOptsFor(Math.max(n, 1));
  const { nodes } = buildTree(m, dim, n, opts);
  const { y } = assignY(m, dim, n, nodes, opts);
  // vocab: null runs cluster.mjs's fast c-TF-IDF label path — no Ollama round
  // trip, so unlike /api/embed-query this endpoint has zero external dependency.
  labelNodes(nodes, rows, { vocab: null });
  assignColors(nodes);

  const leaves = leavesInOrder(nodes);
  const leafOf = new Int32Array(n);
  for(const id of leaves) for(const r of nodes[id].rows) leafOf[r] = id;

  return {
    requested: ids.length, count: n, missing, elapsedMs: Date.now() - t0,
    nodes: nodes.map((nd) => ({
      id: nd.id, parent: nd.parent, depth: nd.depth, children: nd.children,
      n: nd.n, label: nd.label, y0: r5(nd.y0), y1: r5(nd.y1), color: nd.color,
    })),
    points: {
      id: rows.map((e) => e.id),
      y: Array.from(y.subarray(0, n), r5),
      leaf: Array.from(leafOf),
    },
  };
}
