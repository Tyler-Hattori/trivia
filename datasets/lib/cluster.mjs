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
 *   bisecting spherical k-means   -> a tree, ~4 levels deep
 *   ordering pass                 -> siblings sorted so neighbours are similar
 *   per-leaf PC1                  -> order within a leaf
 *   weighted interval assignment  -> y in [0,1]
 *   c-TF-IDF                      -> a label for every node
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
export function buildTree(m, dim, n, { leafTarget = 12, maxBranch = 8, seed = 1 } = {}){
  const all = Array.from({ length: n }, (_, i) => i);
  const maxDepth = Math.max(1, Math.min(6, Math.round(Math.log(Math.max(2, n / leafTarget)) / Math.log(6))));

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

    const isLeaf = depth >= maxDepth || rows.length <= leafTarget * 1.6;
    if(isLeaf) return id;

    // Branch wider near the root (broad themes) and narrower deeper down.
    const k = Math.max(2, Math.min(maxBranch, Math.round(Math.pow(rows.length / leafTarget, 1 / (maxDepth - depth)))));
    const { groups } = kmeans(m, dim, rows, k, { seed: seed + id * 7919 });

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

export function labelNodes(nodes, entries, { terms = 3 } = {}){
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
  }

  function dotRow(c, r){
    // `entries[r].vec` is attached by the caller (atlas.mjs) for this pass.
    const v = entries[r].vec;
    if(!v) return 0;
    let s = 0;
    for(let d = 0; d < c.length; d++) s += c[d] * v[d];
    return s;
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
