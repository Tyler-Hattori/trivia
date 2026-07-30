/*
 * Coordinate transforms, the zoom model, and how zoom picks a representation.
 *
 * Two independent axes:
 *
 *   x   years. LINEAR, always — the user chose this explicitly and rejected
 *       compressed/elided empty stretches. Half of all entries fall between 1750
 *       and 1980, so panning at high zoom does cross dead centuries, and that is
 *       intended: the gaps are real history and should read as real.
 *
 *   y   the embedding coordinate, unitless in [0,1]. It has no natural scale, so
 *       "zoomed out" for y means the whole atlas fits the viewport height.
 *
 * The two zoom together by default, which keeps the scatter's aspect stable and
 * makes one wheel gesture do what you expect. They can be driven apart, because
 * scanning a narrow slice of time across every topic is a real thing to want.
 */

/** Smallest and largest px-per-year. The floor fits ~3,500 years in 900px. */
export const PPY_MIN = 0.02;
export const PPY_MAX = 900;

/** y zoom, expressed as how many multiples of the viewport height the atlas fills. */
export const YZ_MIN = 1;
export const YZ_MAX = 900;

/**
 * Named stops for the scale buttons. Each is a target px-per-year; the y zoom
 * follows from `coupledYZoom` so a stop is one predictable place, not a range.
 */
export const STOPS = [
  { key: 'all',      label: 'All',       ppy: null },   // fit everything
  { key: 'eras',     label: 'Eras',      ppy: 0.35 },
  { key: 'centuries',label: 'Centuries', ppy: 1.2 },
  { key: 'decades',  label: 'Decades',   ppy: 6 },
  { key: 'years',    label: 'Years',     ppy: 26 },
  { key: 'detail',   label: 'Detail',    ppy: 90 },
];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * The y zoom that pairs with a given x zoom.
 *
 * Anchored so that "Decades" shows roughly a fifth of the atlas vertically —
 * enough that clusters are separable but you have not lost the sense of where you
 * are. Sub-linear in ppy because y has no units to match: coupling them linearly
 * made vertical zoom run away long before the cards appeared.
 */
export function coupledYZoom(ppy){
  return clamp(1 + Math.pow(ppy, 0.62) * 1.35, YZ_MIN, YZ_MAX);
}

/**
 * Create the transform pair for a frame.
 *
 * `x0` is the left edge in years, `yTop` the top edge in atlas units, and the
 * viewport is `W x H` CSS pixels.
 */
export function makeScale({ x0, ppy, yTop, yz, W, H }){
  const yUnitsVisible = 1 / yz;
  const pxPerY = H / yUnitsVisible;

  return {
    x0, ppy, yTop, yz, W, H,
    x1: x0 + W / ppy,
    yBot: yTop + yUnitsVisible,
    yUnitsVisible,
    pxPerY,

    /** year -> px within the viewport */
    sx: (year) => (year - x0) * ppy,
    /** atlas y -> px within the viewport */
    sy: (y) => (y - yTop) * pxPerY,
    /** px -> year */
    ix: (px) => x0 + px / ppy,
    /** px -> atlas y */
    iy: (px) => yTop + px / pxPerY,
  };
}

/**
 * Zoom by `factor`, holding the data point under the cursor still.
 *
 * Cursor-anchored zoom is not a nicety here. The atlas is browsed by pointing at
 * a cluster and diving in; if zoom moved toward the centre instead, every dive
 * would need a corrective pan and the map would feel like it was fighting back.
 */
export function zoomAt(view, factor, px, py, { yOnly = false, xOnly = false } = {}){
  const s = makeScale(view);
  const yearAt = s.ix(px);
  const yAt = s.iy(py);

  const next = { ...view };

  if(!yOnly){
    next.ppy = clamp(view.ppy * factor, PPY_MIN, PPY_MAX);
    next.x0 = yearAt - px / next.ppy;
  }

  if(!xOnly){
    next.yz = yOnly
      ? clamp(view.yz * factor, YZ_MIN, YZ_MAX)
      : coupledYZoom(next.ppy);
    const pxPerY = view.H / (1 / next.yz);
    next.yTop = yAt - py / pxPerY;
  }

  return clampView(next);
}

/**
 * Keep the viewport over the data.
 *
 * Overscroll is allowed on x by a margin so the first and last entries are not
 * jammed against the frame, but y is held inside [0,1]: the atlas has a real top
 * and bottom, and letting it drift into empty space above the first cluster just
 * loses the user.
 */
export function clampView(view, extent){
  const v = { ...view };
  v.ppy = clamp(v.ppy, PPY_MIN, PPY_MAX);
  v.yz = clamp(v.yz, YZ_MIN, YZ_MAX);

  const yVisible = 1 / v.yz;
  v.yTop = yVisible >= 1 ? (1 - yVisible) / 2 : clamp(v.yTop, 0, 1 - yVisible);

  if(extent){
    const yearsVisible = v.W / v.ppy;
    const margin = Math.min(yearsVisible * 0.25, (extent[1] - extent[0]) * 0.05 + 12);
    const lo = extent[0] - margin;
    const hi = extent[1] + margin;
    v.x0 = yearsVisible >= hi - lo
      ? (lo + hi) / 2 - yearsVisible / 2
      : clamp(v.x0, lo, hi - yearsVisible);
  }

  return v;
}

/** The view that fits `extent` (plus a little air) into `W` px. */
export function fitView({ extent, W, H }){
  const span = Math.max(1, extent[1] - extent[0]);
  const pad = span * 0.02;
  const ppy = clamp(W / (span + pad * 2), PPY_MIN, PPY_MAX);
  return clampView({ x0: extent[0] - pad, ppy, yTop: 0, yz: 1, W, H }, extent);
}

// ---------------------------------------------------------------------------
// Representation
// ---------------------------------------------------------------------------

/**
 * How much detail the current zoom earns.
 *
 * The old engine switched hard between tiers — heat bins, then dots, then chips,
 * then cards — so one notch of zoom could replace every mark on screen at once.
 * That is jarring, and it also wastes space: at the moment cards become legal,
 * hundreds are legal simultaneously and they pile up.
 *
 * Here the tier only sets what is *offered*. Dots are always drawn. Chips and
 * cards are placed by `packLabels` in priority order until the space runs out, so
 * detail arrives gradually as room appears rather than all at once. Nothing ever
 * overlaps and nothing ever pops in wholesale.
 */
export function tierFor(ppy){
  if(ppy < 0.5)  return 'dot';      // dots only; clusters carry the meaning
  if(ppy < 4)    return 'chip';     // room for a few text labels
  if(ppy < 22)   return 'card';     // pictures start to fit
  return 'detail';                  // pictures plus prose
}

/**
 * Which level of the cluster tree to outline and label.
 *
 * Chosen by how tall a level's bands are on screen: a band under ~26px cannot
 * hold a readable label, and one over ~40% of the viewport has stopped being a
 * useful summary. Because it depends on the y zoom rather than a hardcoded ladder,
 * zooming vertically walks down the hierarchy on its own.
 */
export function depthFor(A, scale, { minBandPx = 26, maxDepth = null } = {}){
  const limit = maxDepth ?? A.maxDepth;
  let best = 1;
  for(let d = 1; d <= limit; d++){
    const ids = A.byDepth[d] || [];
    if(!ids.length) break;
    // Median rather than mean: a couple of huge clusters should not hold the
    // whole map at a coarse level.
    const heights = ids.map((id) => (A.nodes[id].y1 - A.nodes[id].y0) * scale.pxPerY)
      .sort((a, b) => a - b);
    const median = heights[heights.length >> 1];
    if(median < minBandPx) break;
    best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Time axis ticks
// ---------------------------------------------------------------------------

const STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000];

/** Smallest step from `STEPS` that keeps ticks at least `minPx` apart. */
export function tickStep(ppy, minPx = 78){
  for(const s of STEPS) if(s * ppy >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

export function ticks(scale, minPx = 78){
  const step = tickStep(scale.ppy, minPx);
  const first = Math.ceil(scale.x0 / step) * step;
  const out = [];
  for(let y = first; y <= scale.x1; y += step){
    out.push({ year: y, px: scale.sx(y), major: y % (step * 5) === 0 });
  }
  return { step, list: out };
}

export const fmtYear = (y) => {
  const r = Math.round(y);
  return r < 0 ? `${Math.abs(r)} BC` : String(r);
};

export const fmtRange = (a, b) =>
  a === b ? fmtYear(a) : `${fmtYear(a)}–${fmtYear(b)}`;
