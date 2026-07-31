/*
 * Loading and indexing the compiled atlas.
 *
 * `datasets/atlas/atlas.json` arrives columnar — parallel arrays rather than an
 * array of objects — so this file's job is to turn those into typed arrays, build
 * the indexes the renderer needs every frame, and get out of the way.
 *
 * Three indexes are built once at load:
 *
 *   grid        a spatial hash over (year, y), so "what is on screen" is a
 *               constant-time lookup instead of a scan over every point. This is
 *               what lets the frame loop stay flat as the corpus grows.
 *   topics      topic -> point indices, for filtering
 *   priority    a stable, viewport-independent importance per point, so that
 *               which entries get a card does not change as you pan
 *
 * Excerpts live in a separate file and load in the background. First paint must
 * not wait on 800KB of prose nobody is reading yet.
 */

const CELLS_X = 128;
const CELLS_Y = 128;

export async function loadAtlas({ base = '', onProgress = () => {} } = {}){
  onProgress('loading atlas…');

  const res = await fetch(`${base}datasets/atlas/atlas.json`);
  if(!res.ok){
    throw new Error(
      `Could not load datasets/atlas/atlas.json (HTTP ${res.status}).\n\n` +
      `Build it first:\n` +
      `    node datasets/migrate.mjs\n` +
      `    node datasets/embed-all.mjs\n` +
      `    node datasets/atlas.mjs --rebuild`,
    );
  }

  const raw = await res.json();
  const A = buildModel(raw);

  // Excerpts are only needed when something is opened or hovered, so they load
  // after the atlas resolves and never block the first frame.
  A.details = null;
  A.detailsPromise = fetch(`${base}datasets/atlas/details.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .then((d) => { A.details = d; return d; })
    .catch(() => { A.details = {}; return {}; });

  onProgress('indexing…');
  return A;
}

/** Turn the columnar payload into typed arrays plus indexes. */
export function buildModel(raw){
  const P = raw.points;
  const n = raw.count;

  const A = {
    version: raw.version,
    model: raw.model,
    n,
    xExtent: raw.xExtent,
    maxDepth: raw.maxDepth,
    generated: raw.generated,

    // Per point
    id: P.id,
    title: P.title,
    subtitle: P.subtitle,
    yearText: P.yearText,
    image: P.image,
    dataset: P.dataset,
    topics: P.topics,
    knn: P.knn,
    x0: Float64Array.from(P.x0),
    x1: Float64Array.from(P.x1),
    y: Float64Array.from(P.y),
    leaf: Int32Array.from(P.leaf),
    isSpan: Uint8Array.from(P.kind),
    circa: Uint8Array.from(P.circa),

    nodes: raw.nodes,
  };

  // ---- tree helpers -------------------------------------------------------
  // Depth-first order is the vertical order, since the build assigned y by
  // walking the tree left to right. Handy for rail rendering.
  A.byDepth = [];
  for(const nd of A.nodes){
    (A.byDepth[nd.depth] ||= []).push(nd.id);
  }
  A.leafIds = A.nodes.filter((nd) => !nd.children.length).map((nd) => nd.id);

  /** Every ancestor of a node, nearest first, excluding itself. */
  A.ancestorsOf = (id) => {
    const out = [];
    let p = A.nodes[id]?.parent;
    while(p != null && p !== -1){ out.push(p); p = A.nodes[p].parent; }
    return out;
  };

  // Per-point ancestor chains get consulted on every frame for collapse tests,
  // so flatten them once into a lookup keyed by leaf.
  A.chainOf = new Map();
  for(const id of A.leafIds) A.chainOf.set(id, [id, ...A.ancestorsOf(id)]);

  // Colour per point, taken from its leaf. Copied out so paint never chases
  // pointers through the node array in the inner loop.
  A.color = new Array(n);
  for(let i = 0; i < n; i++) A.color[i] = A.nodes[A.leaf[i]]?.color || '#64748b';

  // ---- priority ----------------------------------------------------------
  /*
   * Which points earn a card when there is not room for all of them.
   *
   * The ordering must be independent of the viewport. If it depended on, say,
   * distance from the centre of the screen, then panning would reshuffle which
   * entries are shown as cards and the map would shimmer. A fixed priority means
   * a card that is on screen stays a card.
   *
   * An exemplar (the entry nearest its cluster's centroid) ranks highest because
   * it is the one entry that best explains where you are.
   */
  const exemplars = new Set(A.nodes.map((nd) => nd.exemplar));
  A.prio = Float32Array.from({ length: n }, (_, i) => {
    let p = 0;
    if(exemplars.has(i)) p += 400;
    if(A.image[i]) p += 60;
    if(A.isSpan[i]) p += 20;                       // spans carry more information
    p += Math.min(30, (A.title[i]?.length || 0) / 2);
    // A deterministic tiebreak, so equal-scoring points have a stable order
    // rather than depending on array position alone.
    p += (hash(A.id[i]) % 1000) / 1000;
    return p;
  });

  A.prioOrder = Array.from({ length: n }, (_, i) => i).sort((a, b) => A.prio[b] - A.prio[a]);

  // ---- spatial grid ------------------------------------------------------
  A.grid = buildGrid(A);

  // ---- topics ------------------------------------------------------------
  A.topicIndex = new Map();
  for(let i = 0; i < n; i++){
    for(const t of A.topics[i] || []){
      let arr = A.topicIndex.get(t);
      if(!arr) A.topicIndex.set(t, (arr = []));
      arr.push(i);
    }
  }
  A.topicsByCount = [...A.topicIndex].map(([t, a]) => [t, a.length]).sort((p, q) => q[1] - p[1]);

  A.datasets = [...new Set(A.dataset)].filter(Boolean).sort();

  // ---- search ------------------------------------------------------------
  // A lowercased haystack per point. Built once; `indexOf` over 2,700 short
  // strings is well under a frame, and it keeps search dependency-free.
  A.haystack = new Array(n);
  for(let i = 0; i < n; i++){
    A.haystack[i] = `${A.title[i]} ${A.subtitle[i]} ${(A.topics[i] || []).join(' ')} ${A.dataset[i]}`.toLowerCase();
  }

  return A;
}

const hash = (s) => {
  let h = 2166136261;
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// Spatial grid
// ---------------------------------------------------------------------------

/*
 * A uniform grid in data space, stored compressed-sparse-row style: one Int32
 * per point in `items`, plus a start offset per cell. No per-cell arrays, no
 * allocation during a query.
 *
 * A span occupies every column it crosses, so a 70-year lifespan is found by a
 * query anywhere along it rather than only where it begins.
 */
/**
 * The span the middle of the corpus occupies, as the grid's x range.
 *
 * A percentile rather than the extent, so no single outlier can set the resolution
 * for everything. Returned widened a little, and never narrower than something the
 * grid can divide.
 */
function denseExtent(A){
  if(!A.n) return A.xExtent;
  const lo = Float64Array.from(A.x0).sort();
  const hi = Float64Array.from(A.x1).sort();
  const k = Math.floor(A.n * 0.01);
  const a = lo[k];
  const b = hi[A.n - 1 - k];
  const pad = Math.max(1, (b - a) * 0.02);
  return [a - pad, b + pad];
}

function buildGrid(A){
  /*
   * The columns are spread over where the entries actually ARE, not over the full
   * extent. A uniform grid on the raw extent has its resolution set by the single
   * oldest entry: one row at −113,000 made a column 899 years wide and packed 99%
   * of the corpus into six of the 128, so the x half of the grid stopped
   * discriminating and every query over-selected by several times. Deep-time
   * entries would end that entirely — at a 4.54-billion-year extent a column is 35
   * million years and the whole of human history is one of them.
   *
   * Trimming is safe rather than approximate: `query` clamps to the column range
   * and then confirms real bounds per point, so an entry outside the trimmed span
   * lands in an edge column and is still found — just via a coarser column, which
   * is the right trade for the few that are out there.
   */
  const [xMin, xMax] = denseExtent(A);
  const xSpan = Math.max(1e-6, xMax - xMin);

  const cellOf = (i) => {
    const cy = Math.min(CELLS_Y - 1, Math.max(0, Math.floor(A.y[i] * CELLS_Y)));
    const c0 = Math.min(CELLS_X - 1, Math.max(0, Math.floor(((A.x0[i] - xMin) / xSpan) * CELLS_X)));
    const c1 = Math.min(CELLS_X - 1, Math.max(0, Math.floor(((A.x1[i] - xMin) / xSpan) * CELLS_X)));
    return { cy, c0, c1 };
  };

  // Pass 1: count entries per cell.
  const counts = new Int32Array(CELLS_X * CELLS_Y);
  let total = 0;
  for(let i = 0; i < A.n; i++){
    const { cy, c0, c1 } = cellOf(i);
    for(let cx = c0; cx <= c1; cx++){ counts[cy * CELLS_X + cx]++; total++; }
  }

  // Pass 2: prefix sum into start offsets.
  const start = new Int32Array(CELLS_X * CELLS_Y + 1);
  for(let c = 0; c < counts.length; c++) start[c + 1] = start[c] + counts[c];

  // Pass 3: scatter.
  const cursor = start.slice(0, -1);
  const items = new Int32Array(total);
  for(let i = 0; i < A.n; i++){
    const { cy, c0, c1 } = cellOf(i);
    for(let cx = c0; cx <= c1; cx++) items[cursor[cy * CELLS_X + cx]++] = i;
  }

  return {
    start, items, xMin, xSpan, CELLS_X, CELLS_Y,

    /**
     * Indices whose bounds intersect the window. A point may appear once per
     * column it spans, so results are de-duplicated through `seen`, a reusable
     * stamp array — cheaper than a Set per frame.
     */
    query(x0, x1, y0, y1, out, seen, stamp){
      out.length = 0;
      const cx0 = Math.max(0, Math.floor(((x0 - xMin) / xSpan) * CELLS_X));
      const cx1 = Math.min(CELLS_X - 1, Math.floor(((x1 - xMin) / xSpan) * CELLS_X));
      const cy0 = Math.max(0, Math.floor(y0 * CELLS_Y));
      const cy1 = Math.min(CELLS_Y - 1, Math.floor(y1 * CELLS_Y));
      if(cx1 < cx0 || cy1 < cy0) return out;

      for(let cy = cy0; cy <= cy1; cy++){
        const row = cy * CELLS_X;
        for(let cx = cx0; cx <= cx1; cx++){
          const s = start[row + cx], e = start[row + cx + 1];
          for(let k = s; k < e; k++){
            const i = items[k];
            if(seen[i] === stamp) continue;
            seen[i] = stamp;
            // The grid is conservative; confirm the actual bounds.
            if(A.x1[i] < x0 || A.x0[i] > x1) continue;
            if(A.y[i] < y0 || A.y[i] > y1) continue;
            out.push(i);
          }
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Parse the search box. Free text plus a few prefixes, matching the vocabulary
 * the old timeline used so muscle memory survives:
 *
 *   cubism                  free text
 *   1750-1800               a year range
 *   ds:art                  a source dataset
 *   topic:surrealism        a topic
 *   has:image               only entries with a picture
 */
export function parseQuery(raw){
  const q = { text: [], range: null, datasets: [], topics: [], flags: [] };
  for(const tok of String(raw || '').trim().split(/\s+/).filter(Boolean)){
    let m;
    if((m = tok.match(/^(-?\d{1,4})\s*(?:-|–|to)\s*(-?\d{1,4})$/))){
      q.range = [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])];
    } else if((m = tok.match(/^ds:(.+)$/i))){
      q.datasets.push(m[1].toLowerCase());
    } else if((m = tok.match(/^topic:(.+)$/i))){
      q.topics.push(m[1].toLowerCase().replace(/_/g, ' '));
    } else if((m = tok.match(/^has:(.+)$/i))){
      q.flags.push(m[1].toLowerCase());
    } else {
      q.text.push(tok.toLowerCase());
    }
  }
  return q;
}

export const queryIsEmpty = (q) =>
  !q.text.length && !q.range && !q.datasets.length && !q.topics.length && !q.flags.length;

/**
 * Compute the match set as a Uint8Array flag per point.
 *
 * Returned as a flag array rather than a list because paint needs random access
 * ("is this point matched?") far more often than it needs to iterate matches.
 * `null` means "no filter active", which callers treat as everything matching —
 * that distinction lets paint skip the lookup entirely in the common case.
 */
export function runFilter(A, { query, topics, datasets, mode }){
  const q = parseQuery(query);
  const hasFacet = (topics && topics.size) || (datasets && datasets.size);
  if(queryIsEmpty(q) && !hasFacet) return null;

  const flags = new Uint8Array(A.n);
  let count = 0;

  for(let i = 0; i < A.n; i++){
    if(q.range && (A.x1[i] < q.range[0] || A.x0[i] > q.range[1])) continue;
    if(q.datasets.length && !q.datasets.includes(A.dataset[i])) continue;
    if(q.flags.includes('image') && !A.image[i]) continue;
    if(q.flags.includes('excerpt') && !A.details?.[A.id[i]]?.excerpt) continue;

    if(q.topics.length){
      const t = A.topics[i] || [];
      if(!q.topics.every((needle) => t.some((x) => x.includes(needle)))) continue;
    }
    if(q.text.length){
      const hay = A.haystack[i];
      if(!q.text.every((needle) => hay.includes(needle))) continue;
    }

    // Sidebar facets are OR within a facet, AND across facets — the behaviour
    // people expect from a faceted browser.
    if(topics && topics.size){
      const t = A.topics[i] || [];
      if(!t.some((x) => topics.has(x))) continue;
    }
    if(datasets && datasets.size && !datasets.has(A.dataset[i])) continue;

    flags[i] = 1;
    count++;
  }

  return { flags, count, query: q, mode };
}
