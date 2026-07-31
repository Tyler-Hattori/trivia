/**
 * Embedding space -> a stable vertical coordinate, a cluster hierarchy, and
 * labels for it. Pure math, no I/O, fully deterministic.
 *
 * ## Why a hierarchy and not UMAP
 *
 * The obvious move is UMAP/t-SNE down to one dimension. Rejected for three
 * reasons that matter to this specific design:
 *
 *   1. The timeline needs *nameable groups* at every zoom-out level. A tree
 *      gives them for free; a continuous projection gives none, and you end up
 *      clustering the projection afterwards anyway.
 *   2. Adding entries must not reshuffle the map. UMAP is a global fit — one new
 *      row moves everything. Here a new entry is assigned to the nearest frozen
 *      leaf and nothing else moves.
 *   3. It would be a Python dependency in an otherwise zero-dependency repo.
 *
 * ## The pipeline
 *
 *   bisecting spherical k-means   -> a tree; k per node by silhouette, <=6 deep
 *   ordering pass                 -> siblings sorted so neighbours are similar
 *   per-leaf PC1                  -> order within a leaf
 *   weighted interval assignment  -> y in [0,1]
 *   centroid-nearest vocabulary   -> a label for every node (c-TF-IDF fallback)
 *
 * The ordering pass is what makes vertical distance meaningful: because similar
 * siblings sit next to each other at *every* level, two entries that are close
 * in 256-dim space end up close in y, and a whole branch reads as a contiguous
 * band you can label and collapse.
 *
 * Vectors are expected L2-normalised, so cosine similarity is a plain dot
 * product and "spherical k-means" is just argmax-dot with re-normalised means.
 */

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** Small fast PRNG. Seeded explicitly so a rebuild reproduces byte for byte. */
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Matrix helpers — a flat Float32Array of n*dim, row-major
// ---------------------------------------------------------------------------

const dot = (m, dim, i, v) => {
  let s = 0;
  const off = i * dim;
  for(let d = 0; d < dim; d++) s += m[off + d] * v[d];
  return s;
};

/** Mean of the given rows, re-normalised to unit length. */
export function centroid(m, dim, rows){
  const c = new Float32Array(dim);
  for(const i of rows){
    const off = i * dim;
    for(let d = 0; d < dim; d++) c[d] += m[off + d];
  }
  let sum = 0;
  for(let d = 0; d < dim; d++) sum += c[d] * c[d];
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for(let d = 0; d < dim; d++) c[d] *= inv;
  return c;
}

export const cosine = (a, b) => {
  let s = 0;
  for(let d = 0; d < a.length; d++) s += a[d] * b[d];
  return s;
};

// ---------------------------------------------------------------------------
// Spherical k-means
// ---------------------------------------------------------------------------

/**
 * Cluster `rows` (indices into `m`) into `k` groups.
 * Returns `{ groups: number[][], centroids: Float32Array[] }`, empty groups dropped.
 */
export function kmeans(m, dim, rows, k, { seed = 1, iters = 25 } = {}){
  k = Math.min(k, rows.length);
  if(k <= 1) return { groups: [rows.slice()], centroids: [centroid(m, dim, rows)] };

  const rand = mulberry32(seed);

  // k-means++ seeding: first centre at random, each next one chosen with
  // probability proportional to its squared distance from the nearest centre.
  // Plain random seeding regularly produced one giant cluster plus slivers.
  const centres = [];
  centres.push(centroid(m, dim, [rows[Math.floor(rand() * rows.length)]]));
  const best = new Float64Array(rows.length).fill(Infinity);

  while(centres.length < k){
    const c = centres[centres.length - 1];
    let total = 0;
    for(let i = 0; i < rows.length; i++){
      // On unit vectors, squared euclidean distance is 2 - 2*cos.
      const d2 = Math.max(0, 2 - 2 * dot(m, dim, rows[i], c));
      if(d2 < best[i]) best[i] = d2;
      total += best[i];
    }
    if(total <= 0) break;
    let target = rand() * total;
    let pick = rows.length - 1;
    for(let i = 0; i < rows.length; i++){
      target -= best[i];
      if(target <= 0){ pick = i; break; }
    }
    centres.push(centroid(m, dim, [rows[pick]]));
  }

  let groups = [];
  for(let it = 0; it < iters; it++){
    groups = centres.map(() => []);
    for(const r of rows){
      let bestK = 0, bestS = -Infinity;
      for(let c = 0; c < centres.length; c++){
        const s = dot(m, dim, r, centres[c]);
        if(s > bestS){ bestS = s; bestK = c; }
      }
      groups[bestK].push(r);
    }
    let moved = false;
    for(let c = 0; c < centres.length; c++){
      if(!groups[c].length) continue;
      const next = centroid(m, dim, groups[c]);
      if(!moved && cosine(next, centres[c]) < 0.999999) moved = true;
      centres[c] = next;
    }
    if(!moved) break;
  }

  const keep = groups.map((g, i) => [g, i]).filter(([g]) => g.length);
  return {
    groups: keep.map(([g]) => g),
    centroids: keep.map(([, i]) => centres[i]),
  };
}

// ---------------------------------------------------------------------------
// Sibling ordering
// ---------------------------------------------------------------------------

/**
 * Order `centroids` into a chain minimising the total distance between adjacent
 * members — a shortest Hamiltonian path, which is what makes "adjacent in y"
 * mean "similar".
 *
 * `left` / `right` are the neighbouring centroids one level up, when known.
 * Including them stops a well-ordered block from being inserted backwards into
 * its parent, which is the flaw in ordering each node in isolation.
 *
 * Exact by brute force up to 8 siblings (<=20k permutations); greedy chain plus
 * 2-opt beyond that.
 */
export function orderChain(centroids, { left = null, right = null } = {}){
  const k = centroids.length;
  if(k <= 1) return [0].slice(0, k);
  if(k === 2){
    const a = [0, 1], b = [1, 0];
    return cost(a) <= cost(b) ? a : b;
  }

  function cost(order){
    let c = 0;
    for(let i = 0; i + 1 < order.length; i++) c += 1 - cosine(centroids[order[i]], centroids[order[i + 1]]);
    if(left)  c += 1 - cosine(left,  centroids[order[0]]);
    if(right) c += 1 - cosine(right, centroids[order[order.length - 1]]);
    return c;
  }

  if(k <= 8){
    let bestOrder = null, bestCost = Infinity;
    const perm = [], used = new Array(k).fill(false);
    (function walk(){
      if(perm.length === k){
        const c = cost(perm);
        if(c < bestCost){ bestCost = c; bestOrder = perm.slice(); }
        return;
      }
      for(let i = 0; i < k; i++){
        if(used[i]) continue;
        used[i] = true; perm.push(i);
        walk();
        perm.pop(); used[i] = false;
      }
    })();
    return bestOrder;
  }

  // Greedy: start from the centroid least like the group's own mean (an
  // extreme, so the chain runs across the spread rather than out of the middle),
  // then repeatedly append the nearest unused.
  const mean = new Float32Array(centroids[0].length);
  for(const c of centroids) for(let d = 0; d < c.length; d++) mean[d] += c[d];
  let start = 0, worst = Infinity;
  for(let i = 0; i < k; i++){
    const s = cosine(centroids[i], mean);
    if(s < worst){ worst = s; start = i; }
  }

  const order = [start];
  const used = new Array(k).fill(false);
  used[start] = true;
  while(order.length < k){
    const last = centroids[order[order.length - 1]];
    let pick = -1, bestS = -Infinity;
    for(let i = 0; i < k; i++){
      if(used[i]) continue;
      const s = cosine(last, centroids[i]);
      if(s > bestS){ bestS = s; pick = i; }
    }
    used[pick] = true;
    order.push(pick);
  }

  // 2-opt: reversing a run can only help, and converges in a few sweeps.
  let improved = true, guard = 0;
  while(improved && guard++ < 40){
    improved = false;
    for(let i = 0; i < k - 1; i++){
      for(let j = i + 1; j < k; j++){
        const trial = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if(cost(trial) < cost(order) - 1e-9){ order.splice(0, k, ...trial); improved = true; }
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// First principal component, by power iteration
// ---------------------------------------------------------------------------

/**
 * Project `rows` onto their dominant direction of variation. Used to order
 * entries *inside* a leaf so that even the smallest scale carries meaning
 * instead of arbitrary insertion order.
 */
export function pc1Projections(m, dim, rows, { seed = 7, iters = 24 } = {}){
  if(rows.length <= 1) return new Float64Array(rows.length);

  const mean = new Float64Array(dim);
  for(const r of rows){
    const off = r * dim;
    for(let d = 0; d < dim; d++) mean[d] += m[off + d];
  }
  for(let d = 0; d < dim; d++) mean[d] /= rows.length;

  const rand = mulberry32(seed);
  let v = new Float64Array(dim);
  for(let d = 0; d < dim; d++) v[d] = rand() * 2 - 1;
  normalise(v);

  // v <- C v without ever materialising the dim x dim covariance matrix:
  // C v = (1/n) sum_r (x_r - mean)((x_r - mean) . v)
  for(let it = 0; it < iters; it++){
    const next = new Float64Array(dim);
    for(const r of rows){
      const off = r * dim;
      let p = 0;
      for(let d = 0; d < dim; d++) p += (m[off + d] - mean[d]) * v[d];
      for(let d = 0; d < dim; d++) next[d] += (m[off + d] - mean[d]) * p;
    }
    if(!normalise(next)) break;
    v = next;
  }

  const out = new Float64Array(rows.length);
  rows.forEach((r, i) => {
    const off = r * dim;
    let p = 0;
    for(let d = 0; d < dim; d++) p += (m[off + d] - mean[d]) * v[d];
    out[i] = p;
  });
  return out;
}

function normalise(v){
  let s = 0;
  for(let d = 0; d < v.length; d++) s += v[d] * v[d];
  if(s <= 1e-20) return false;
  const inv = 1 / Math.sqrt(s);
  for(let d = 0; d < v.length; d++) v[d] *= inv;
  return true;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * Recursively bisect into a labelled tree.
 *
 * Depth adapts to the corpus so leaves stay browsable as the data grows: about
 * 12 entries per leaf whether there are 2,600 entries or 200,000. Branching is
 * held to <=8 so that a zoomed-out view never shows more groups than a person
 * can read at once.
 *
 * Returns a flat array of nodes; `node.children` holds indices into it, and
 * node 0 is the root.
 */
/**
 * Mean simplified silhouette of a candidate split, on the unit sphere.
 *
 * The textbook silhouette compares each point's mean distance to its own
 * cluster against its mean distance to the nearest other cluster, which is
 * O(n^2) and unaffordable at the root. The simplified form substitutes the
 * distance to each *centroid*, making it O(n·k) — and on L2-normalised vectors,
 * where a centroid is the direction the cluster points in, that substitution
 * costs very little.
 *
 * Ranges from -1 to 1. Higher means the split found real separation rather than
 * slicing through the middle of one blob.
 */
function splitQuality(m, dim, groups, centroids){
  let total = 0, count = 0;
  for(let g = 0; g < groups.length; g++){
    for(const r of groups[g]){
      let own = 0, nearest = Infinity;
      const off = r * dim;
      for(let c = 0; c < centroids.length; c++){
        let dot = 0;
        for(let d = 0; d < dim; d++) dot += m[off + d] * centroids[c][d];
        const dist = 1 - dot;
        if(c === g) own = dist;
        else if(dist < nearest) nearest = dist;
      }
      if(nearest === Infinity) continue;
      total += (nearest - own) / Math.max(own, nearest, 1e-9);
      count++;
    }
  }
  return count ? total / count : -1;
}

/**
 * How many ways to split this node — asked of the data, not of the tree's shape.
 *
 * The previous rule computed k from arithmetic: pick the branching factor that
 * makes a balanced tree of the target depth land near `leafTarget` entries per
 * leaf. For 3,787 entries that is always 7, whatever those entries are. It has
 * to force exactly 7 groups even when the corpus holds four clear themes or
 * twelve, so unrelated material gets fused to make the count — which is how 322
 * physics entries ended up sharing a branch with 525 films purely because the
 * politics material was heterogeneous enough to absorb four of the seven slots.
 *
 * Instead, try every k in range and keep the one with the best silhouette. A
 * cheap search first (few iterations, just to rank the candidates) and then a
 * full run of the winner, because k-means is the expensive part and ranking
 * tolerates a rough fit.
 */
function chooseSplit(m, dim, rows, { minK, maxK, seed }){
  let bestK = minK, bestScore = -Infinity;

  for(let k = minK; k <= maxK; k++){
    const { groups, centroids } = kmeans(m, dim, rows, k, { seed, iters: 8 });
    if(groups.length < 2) continue;
    const score = splitQuality(m, dim, groups, centroids);
    if(score > bestScore){ bestScore = score; bestK = k; }
  }

  return kmeans(m, dim, rows, bestK, { seed });
}

export function buildTree(m, dim, n, { leafTarget = 12, maxBranch = 10, maxDepth = 6, seed = 1 } = {}){
  const all = Array.from({ length: n }, (_, i) => i);

  const nodes = [];

  function add(rows, depth, parent){
    const id = nodes.length;
    const node = {
      id, parent, depth,
      rows,                                  // dropped from leaves' output later
      n: rows.length,
      centroid: centroid(m, dim, rows),
      children: [],
    };
    nodes.push(node);

    // Depth is no longer a computed budget, so recursion stops on size alone and
    // `maxDepth` is only a backstop. A branch that keeps separating cleanly is
    // allowed to run deeper than its siblings.
    const isLeaf = depth >= maxDepth || rows.length <= leafTarget * 1.6;
    if(isLeaf) return id;

    const upper = Math.max(2, Math.min(maxBranch, Math.floor(rows.length / leafTarget)));
    const { groups } = chooseSplit(m, dim, rows, { minK: 2, maxK: upper, seed: seed + id * 7919 });

    if(groups.length < 2) return id;           // degenerate split: keep as leaf
    for(const g of groups) node.children.push(add(g, depth + 1, id));
    return id;
  }

  add(all, 0, -1);

  // Order siblings top-down, so each node already knows the neighbours it must
  // line up against when its own children are arranged.
  function orderNode(id, left, right){
    const node = nodes[id];
    if(!node.children.length) return;
    const kids = node.children.map((c) => nodes[c].centroid);
    const order = orderChain(kids, { left, right });
    node.children = order.map((i) => node.children[i]);
    node.children.forEach((c, i) => {
      const prev = i > 0 ? nodes[node.children[i - 1]].centroid : left;
      const next = i + 1 < node.children.length ? nodes[node.children[i + 1]].centroid : right;
      orderNode(c, prev, next);
    });
  }
  orderNode(0, null, null);

  return { nodes, maxDepth };
}

/** Leaves in left-to-right (i.e. top-to-bottom) order. */
export function leavesInOrder(nodes){
  const out = [];
  (function walk(id){
    const node = nodes[id];
    if(!node.children.length){ out.push(id); return; }
    for(const c of node.children) walk(c);
  })(0);
  return out;
}

// ---------------------------------------------------------------------------
// y assignment
// ---------------------------------------------------------------------------

/**
 * Give every leaf a y interval and every entry a y in [0,1].
 *
 * Leaf height is proportional to `n^sizeExponent`, not to `n`. Straight
 * proportionality gives uniform point density but squashes a 4-entry cluster
 * into an unclickable sliver next to a 400-entry one; equal heights waste the
 * canvas on tiny clusters. The 0.75 default keeps big clusters visibly bigger
 * while leaving small ones legible.
 *
 * `gutter` is dead space between leaves, as a fraction of one entry slot. The
 * gap is deliberate: it is what makes cluster boundaries readable when zoomed
 * out far enough that individual points merge.
 */
export function assignY(m, dim, n, nodes, { sizeExponent = 0.75, gutter = 0.6 } = {}){
  const leaves = leavesInOrder(nodes);

  const weights = leaves.map((id) => Math.pow(nodes[id].n, sizeExponent) + gutter);
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  const y = new Float64Array(n);

  let cursor = 0;
  let prevLast = null;      // last vector of the previous non-empty leaf
  leaves.forEach((id, li) => {
    const node = nodes[id];
    const h = weights[li] / total;

    // A frozen tree can hold a leaf whose members were all removed. It keeps its
    // band (so nothing else shifts) but has nothing to place in it.
    if(!node.rows.length){
      node.y0 = cursor; node.y1 = cursor + h; node.order = [];
      cursor = node.y1;
      return;
    }

    const y0 = cursor;
    const y1 = cursor + h;
    cursor = y1;

    // Half the gutter at each end, so points never sit on a boundary.
    const pad = (gutter / 2) / (Math.pow(node.n, sizeExponent) + gutter) * h;
    const inner0 = y0 + pad;
    const inner1 = y1 - pad;

    const proj = pc1Projections(m, dim, node.rows);
    const order = node.rows.map((r, i) => i).sort((a, b) => proj[a] - proj[b] || node.rows[a] - node.rows[b]);

    // Orient this leaf's internal axis to agree with the previous leaf, so the
    // ordering reads continuously across a boundary instead of zig-zagging.
    // Without this, PC1's arbitrary sign flips every few leaves and the vertical
    // ordering that the tree worked to establish is thrown away inside each band.
    if(prevLast){
      const firstVec = rowVec(m, dim, node.rows[order[0]]);
      const lastVec  = rowVec(m, dim, node.rows[order[order.length - 1]]);
      if(cosine(prevLast, lastVec) > cosine(prevLast, firstVec)) order.reverse();
    }

    order.forEach((oi, rank) => {
      const t = node.n === 1 ? 0.5 : (rank + 0.5) / node.n;
      y[node.rows[oi]] = inner0 + t * (inner1 - inner0);
    });

    node.y0 = y0;
    node.y1 = y1;
    node.order = order.map((oi) => node.rows[oi]);
    prevLast = rowVec(m, dim, node.order[node.order.length - 1]);
  });

  // A parent spans its children, so any level can be collapsed into one band.
  for(let i = nodes.length - 1; i >= 0; i--){
    const nd = nodes[i];
    if(!nd.children.length) continue;
    nd.y0 = Math.min(...nd.children.map((c) => nodes[c].y0));
    nd.y1 = Math.max(...nd.children.map((c) => nodes[c].y1));
  }

  return { y, leaves };
}

const rowVec = (m, dim, i) => {
  const out = new Float32Array(dim);
  for(let d = 0; d < dim; d++) out[d] = m[i * dim + d];
  return out;
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const STOP = new Set(`a an the of and or to in on at for from by with as is was were be been being
this that these those it its his her their our your my he she they we you i not no but if then than
so such which who whom whose what when where why how all any both each few more most other some only
own same too very can will just don should now into out up down over under again further once during
before after above below between through against about
first second new old great major early late modern century year years time times world history
also would could may might must have has had do does did made make making known used using
one two three four five six seven eight nine ten
c ca circa ad bc bce ce st mr mrs dr sir jr
work works piece painting film movie book text author page wikipedia`.split(/\s+/));

/**
 * Function words only.
 *
 * Deliberately much smaller than `STOP`, because it serves the opposite purpose.
 * `STOP` filters candidates for c-TF-IDF, where an ordinary category noun like
 * "film" or "painting" is noise — it is frequent everywhere and distinguishes
 * nothing. For centroid-nearest labelling those same nouns are the *answer*: a
 * broad node should be called "Film". So the only things removed here are words
 * that could never be a label.
 */
const VOCAB_STOP = new Set(`a an the of and or to in on at for from by with as is was were be been
being this that these those it its his her their our your my he she they we you i not no but if
then than so such which who whom whose what when where why how all any both each few more most
other some only own same too very can will just don should now into out up down over under again
further once during before after above below between through against about also would could may
might must have has had do does did made make making known used using one two three four five six
seven eight nine ten c ca circa ad bc bce ce st mr mrs dr sir jr known various several many`.split(/\s+/));

/*
 * Credit-line verbs from the Wikipedia film lead: "X is a 1994 American drama
 * film *directed by* Y, *starring* Z, *written* by W". They are frequent across
 * a whole domain and describe nothing within it, which is exactly the profile
 * that wins a naive frequency contest — the original "American · Directed ·
 * Starring" label. Excluded as label candidates only; they stay in the embedded
 * text, where they are harmless.
 */
const CREDIT_STOP = new Set(`directed starring stars star written writes produced produces
presented presenting featuring featured released releasing adapted adapting distributed
starred cowritten co-written screenplay directorial`.split(/\s+/));

const vocabOk = (t) => {
  if(t.length < 3 || t.length > 40) return false;
  if(VOCAB_STOP.has(t) || CREDIT_STOP.has(t)) return false;
  if(!/\p{L}/u.test(t) || /^\d+$/.test(t)) return false;

  const w = t.split(' ');
  if(w.every((x) => VOCAB_STOP.has(x) || /^\d+$/.test(x))) return false;

  // A label must not open or close on a function word. "Painting By", "The Film",
  // "Of England" and "In Physics" are all fragments of a sentence rather than
  // names for anything, and they crowd out the noun that is the actual answer.
  if(w.length > 1 && (VOCAB_STOP.has(w[0]) || VOCAB_STOP.has(w[w.length - 1]))) return false;
  if(w.some((x) => CREDIT_STOP.has(x))) return false;

  return true;
};

/**
 * The token set an entry contributes to the label vocabulary: curated topics and
 * facet values verbatim, plus unigrams and bigrams from its title, subtitle and
 * excerpt. Bigrams matter — "film noir", "abstract expressionism" and "world war"
 * are the labels you actually want, and none survives as two unigrams.
 */
export function vocabTokens(entry){
  const out = new Set();
  const push = (t) => { t = String(t).trim().toLowerCase().replace(/\s+/g, ' '); if(vocabOk(t)) out.add(t); };

  for(const t of entry.topics || []) push(t);
  for(const v of Object.values(entry.facets || {})){
    for(const one of (Array.isArray(v) ? v : [v])) push(one);
  }

  const prose = [entry.title, entry.subtitle, String(entry.excerpt || '').slice(0, 600)]
    .filter(Boolean).join(' . ').toLowerCase();
  // Sentence-ish segments, so a bigram never spans a full stop.
  for(const seg of prose.split(/[^\p{L}\p{N}'’ -]+/u)){
    const w = seg.split(/[\s-]+/).filter(Boolean);
    for(let i = 0; i < w.length; i++){
      push(w[i]);
      if(i + 1 < w.length) push(`${w[i]} ${w[i + 1]}`);
    }
  }
  return out;
}

/**
 * Candidate label terms, harvested from the corpus itself.
 *
 * Nothing here is hand-authored: a term qualifies by appearing in at least
 * `minDocFreq` entries. That is what keeps labelling automatic as the corpus
 * grows — a new subject area brings its own vocabulary in with it, and the terms
 * that describe it become available as labels on the next build.
 *
 * Returns `{ terms, df }` where `df` is the number of entries containing each.
 */
export function harvestVocabulary(entries, { minDocFreq = 6, max = 3000 } = {}){
  const df = new Map();
  for(const e of entries){
    for(const t of vocabTokens(e)) df.set(t, (df.get(t) || 0) + 1);
  }
  const kept = [...df].filter(([, c]) => c >= minDocFreq)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
  return { terms: kept.map(([t]) => t), df: new Map(kept) };
}

/**
 * Distinguishing terms per node, by c-TF-IDF: a term scores highly when it is
 * frequent inside the cluster and rare outside it. This is the BERTopic trick,
 * and it needs no model — which matters, because labelling has to stay free
 * when tens of thousands of entries are being added.
 *
 * `docs[i]` is the token bag for entry i. Curated `topics` are passed through as
 * single tokens (so "abstract expressionism" survives intact) and weighted up,
 * because a hand-applied tag is worth more than a word from an excerpt.
 */
export function tokenBag(entry){
  const bag = new Map();
  const bump = (t, w) => {
    t = t.trim().toLowerCase();
    if(!t || t.length < 2 || STOP.has(t)) return;
    bag.set(t, (bag.get(t) || 0) + w);
  };

  for(const t of entry.topics || []) bump(t, 6);
  // Domains are weighted low: they label a cluster only when nothing more
  // specific distinguishes it, which is the one case where "Art" is the honest
  // name for a group.
  for(const t of entry.domains || []) bump(t, 2);
  for(const v of Object.values(entry.facets || {})){
    for(const one of (Array.isArray(v) ? v : [v])) bump(String(one), 4);
  }
  for(const w of String(entry.subtitle || '').split(/[^\p{L}\p{N}'-]+/u)) bump(w, 3);
  for(const w of String(entry.title || '').split(/[^\p{L}\p{N}'-]+/u)) bump(w, 2);
  for(const w of String(entry.excerpt || '').slice(0, 600).split(/[^\p{L}\p{N}'-]+/u)) bump(w, 1);

  return bag;
}

export function labelNodes(nodes, entries, { terms = 3, vocab = null } = {}){
  const docs = entries.map(tokenBag);

  // Global term mass, for the "rare outside this cluster" half of the score.
  const globalTf = new Map();
  let globalTotal = 0;
  for(const bag of docs){
    for(const [t, w] of bag){ globalTf.set(t, (globalTf.get(t) || 0) + w); globalTotal += w; }
  }

  for(const node of nodes){
    const rows = node.rows || collectRows(nodes, node.id);

    const tf = new Map();
    let total = 0;
    const topicCount = new Map();
    for(const r of rows){
      for(const [t, w] of docs[r]){ tf.set(t, (tf.get(t) || 0) + w); total += w; }
      for(const t of entries[r].topics || []) topicCount.set(t, (topicCount.get(t) || 0) + 1);
    }

    const scored = [...tf].map(([t, w]) => [
      t,
      (w / (total || 1)) * Math.log(1 + globalTotal / (globalTf.get(t) || 1)),
    ]).sort((a, b) => b[1] - a[1]);

    // Drop a term that is a substring of a better-scoring one ("expressionism"
    // right after "abstract expressionism" reads as a duplicate).
    const picked = [];
    for(const [t] of scored){
      if(picked.length >= terms) break;
      if(picked.some((p) => p.includes(t) || t.includes(p))) continue;
      picked.push(t);
    }

    node.terms = picked;
    node.topTopics = [...topicCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4).map(([t, c]) => [t, c]);

    // A topic held by most of the cluster is a better name than any term
    // frequency ranking, because it was applied on purpose.
    const dominant = node.topTopics[0];
    node.label = dominant && dominant[1] >= rows.length * 0.6
      ? titleCase(dominant[0])
      : picked.map(titleCase).join(' · ') || 'Unlabelled';

    // The entry closest to the centroid: a concrete stand-in for the cluster,
    // far more legible in a tooltip than three keywords.
    let bestRow = rows[0], bestSim = -Infinity;
    for(const r of rows){
      const s = node.centroid ? dotRow(node.centroid, r) : 0;
      if(s > bestSim){ bestSim = s; bestRow = r; }
    }
    node.exemplar = bestRow;
    node.cTfIdfLabel = node.label;
  }

  function dotRow(c, r){
    // `entries[r].vec` is attached by the caller (atlas.mjs) for this pass.
    const v = entries[r].vec;
    if(!v) return 0;
    let s = 0;
    for(let d = 0; d < c.length; d++) s += c[d] * v[d];
    return s;
  }

  if(vocab && vocab.terms.length) nameFromCentroids(nodes, entries, vocab, { maxTerms: terms });

  return nodes;
}

/**
 * Name every node by the vocabulary term nearest its centroid.
 *
 * ## Why not c-TF-IDF for this
 *
 * c-TF-IDF is by construction a *distinctiveness* measure: it rewards a term
 * that is frequent inside the cluster and rare outside it. That is right for a
 * leaf and exactly backwards for a broad node, where the honest name is a word
 * that is common inside the cluster *and* common generally. Asked for a label
 * for 258 films it returns "Directed · Starring" — the words unique to film
 * boilerplate — and never "Film", because "Film" is too widespread to score.
 *
 * Centroid distance has no such bias, and the graded behaviour the atlas wants
 * falls out of the geometry rather than being configured. A depth-1 centroid is
 * the mean of hundreds of semantically varied entries, so the nearest term to it
 * is genuinely generic; a leaf centroid is tight, so the nearest term is
 * specific. One function, no per-level rules, and nothing hand-written.
 *
 * Three corrections on top of raw cosine:
 *
 *   `coverage`   what fraction of the cluster actually uses the term. Stops a
 *                term that sits near the mean by accident while describing none
 *                of the members.
 *   `generality` prefers a term whose corpus-wide document frequency is on the
 *                same scale as the cluster's size. This is the cheap Euclidean
 *                stand-in for the property a hyperbolic embedding would give
 *                directly, where distance from the origin *is* generality.
 *                Compared in log space so it is scale-free.
 *   ancestors    a node may not reuse any term one of its ancestors used, so
 *                every level down is forced to add information.
 */
function nameFromCentroids(nodes, entries, vocab, opts = {}){
  // `covWeight` was 0.45 while the vocabulary still contained credit-line verbs,
  // where it took that much lexical evidence to stop "Directed" beating "Film".
  // With those excluded it only distorts: a leaders cluster whose terse excerpts
  // say "Military power." was named Military, though by cosine alone the corpus
  // ranks politician (0.676) and political (0.672) well above military (0.567).
  // Coverage is now a tie-breaker rather than half the score.
  const { covWeight = 0.25, genWeight = 0.10, maxTerms = 3 } = opts;
  const { terms: vterms, m: vm, dim: vdim, df } = vocab;
  const N = Math.max(entries.length, 1);

  const tokens = entries.map(vocabTokens);
  const byDepth = [...nodes].sort((a, b) => a.depth - b.depth);
  const ancestorTerms = new Map();

  for(const node of byDepth){
    const inherited = node.parent >= 0 ? new Set(ancestorTerms.get(node.parent) || []) : new Set();
    const rows = node.rows && node.rows.length ? node.rows : collectRows(nodes, node.id);

    // The root is every entry, so its centroid is the mean of the whole corpus
    // and the nearest term to it is whichever domain happens to be largest. That
    // is not a description of anything, and — because a child may not reuse an
    // ancestor's term — naming it would rob the one cluster the term does
    // describe. Left unnamed and contributing nothing to the ancestor set.
    if(node.depth === 0){
      ancestorTerms.set(node.id, inherited);
      continue;
    }

    if(!node.centroid || !rows.length){
      ancestorTerms.set(node.id, inherited);
      continue;
    }

    // In-cluster document frequency, for the coverage term.
    const inCluster = new Map();
    for(const r of rows){
      for(const t of tokens[r]) inCluster.set(t, (inCluster.get(t) || 0) + 1);
    }

    const size = rows.length;
    const targetLogDf = Math.log(size / N);

    const scored = [];
    for(let i = 0; i < vterms.length; i++){
      const t = vterms[i];
      if(inherited.has(t)) continue;

      // Both sides are unit length, so a dot product is the cosine.
      let cos = 0;
      const off = i * vdim;
      for(let d = 0; d < vdim; d++) cos += node.centroid[d] * vm[off + d];

      const coverage = (inCluster.get(t) || 0) / size;
      const generality = -Math.abs(Math.log((df.get(t) || 1) / N) - targetLogDf);

      scored.push([t, cos + covWeight * coverage + genWeight * generality]);
    }
    if(!scored.length){ ancestorTerms.set(node.id, inherited); continue; }
    scored.sort((a, b) => b[1] - a[1]);

    // Shallow nodes get one broad word; depth buys detail. A three-part name at
    // the top of the tree is the thing this rework set out to remove.
    const want = node.depth <= 1 ? 1 : node.depth === 2 ? 2 : Math.min(3, maxTerms);

    // Substring dedup *within* one label, so it never reads "Film · The Film".
    // Against ancestors the test is exact match only: a parent called "Film"
    // must still leave "Film Noir" available to a child, which is precisely the
    // narrowing the hierarchy is supposed to show.
    const picked = [];
    for(const [t] of scored){
      if(picked.length >= want) break;
      if(picked.some((p) => p.includes(t) || t.includes(p))) continue;
      picked.push(t);
    }

    if(picked.length) node.label = picked.map(titleCase).join(' · ');
    node.semanticTerms = picked;
    ancestorTerms.set(node.id, new Set([...inherited, ...picked]));
  }

  return nodes;
}

function collectRows(nodes, id){
  const out = [];
  (function walk(i){
    const nd = nodes[i];
    if(nd.rows){ out.push(...nd.rows); return; }
    for(const c of nd.children) walk(c);
  })(id);
  return out;
}

/*
 * Do NOT use `\b` here. It is ASCII-only even under the `u` flag, so every
 * non-ASCII letter reads as a non-word character and the letter after it starts a
 * fresh "word": "françois" came out as "FranÇOis" and "ōtomo" as "ōTomo". The
 * lookbehind instead says "a lowercase letter not preceded by a letter, mark or
 * digit".
 *
 * An apostrophe still breaks a word, because "o'keeffe" and "d'arcy" must
 * capitalise — with the one exception of a trailing possessive "'s", which is why
 * the old version produced "Artist'S Wife".
 */
export const titleCase = (s) =>
  String(s).replace(/(?<![\p{L}\p{M}\p{N}])\p{Ll}/gu, (c, i, str) =>
    (/['’]/.test(str[i - 1] ?? '') && c === 's' && !/[\p{L}\p{M}]/u.test(str[i + 1] ?? ''))
      ? c
      : c.toUpperCase());

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Assign a colour per node so that colour encodes the same similarity that
 * vertical position does.
 *
 * Hue follows position in the leaf ordering, which the ordering pass already
 * made similarity-continuous — so neighbouring clusters get neighbouring hues
 * and a whole branch reads as one colour family. The sweep stops at 320 degrees
 * rather than wrapping, because a full wrap would paint the two *most*
 * different branches the same colour.
 *
 * Lightness and chroma vary within a branch to separate siblings without
 * breaking the family resemblance.
 */
export function assignColors(nodes, { hueSpan = 320, hueStart = 258 } = {}){
  const leaves = leavesInOrder(nodes);
  const pos = new Map(leaves.map((id, i) => [id, leaves.length === 1 ? 0.5 : i / (leaves.length - 1)]));

  for(let i = nodes.length - 1; i >= 0; i--){
    const nd = nodes[i];
    const p = nd.children.length
      ? nd.children.reduce((a, c) => a + nodes[c]._p, 0) / nd.children.length
      : pos.get(nd.id);
    nd._p = p;
    const hue = (hueStart + p * hueSpan) % 360;
    // Deeper nodes sit slightly lighter and less saturated, so a leaf point
    // reads as a member of its parent's band rather than competing with it.
    const chroma = 0.148 - Math.min(nd.depth, 4) * 0.008;
    const light  = 0.58 + Math.min(nd.depth, 4) * 0.025;
    nd.color = oklchToHex(light, chroma, hue);
  }
  for(const nd of nodes) delete nd._p;
  return nodes;
}

/**
 * OKLCH -> sRGB hex. Used instead of HSL because HSL's lightness is not
 * perceptual: a sweep of hues at one HSL lightness swings wildly in apparent
 * brightness (yellow glares, blue vanishes), which would make some clusters
 * look emphasised purely by hue. OKLCH holds perceived lightness constant.
 */
export function oklchToHex(L, C, hDeg){
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;

  const r =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const enc = (v) => {
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };

  return '#' + [enc(r), enc(g), enc(bl)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Queries against a frozen tree
// ---------------------------------------------------------------------------

/**
 * Walk a frozen tree to the leaf whose centroid best matches `vec`.
 *
 * This is what keeps ingestion cheap and the map stable: a new entry descends
 * the existing hierarchy instead of triggering a re-fit, so it lands next to its
 * kin and nothing already on screen moves. Greedy descent is O(depth * branch)
 * dot products — microseconds.
 */
export function nearestLeaf(vec, nodes){
  let id = 0;
  while(nodes[id].children?.length){
    let best = nodes[id].children[0], bestS = -Infinity;
    for(const c of nodes[id].children){
      const s = cosine(vec, nodes[c].centroid);
      if(s > bestS){ bestS = s; best = c; }
    }
    id = best;
  }
  return id;
}

/** Top-`k` most similar rows to `vec`. Brute force; fine well past 100k rows. */
export function knn(m, dim, n, vec, k = 8, exclude = -1){
  const heap = [];
  for(let i = 0; i < n; i++){
    if(i === exclude) continue;
    const s = dot(m, dim, i, vec);
    if(heap.length < k){ heap.push([i, s]); heap.sort((a, b) => a[1] - b[1]); }
    else if(s > heap[0][1]){ heap[0] = [i, s]; heap.sort((a, b) => a[1] - b[1]); }
  }
  return heap.reverse();
}
