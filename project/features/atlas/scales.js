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

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Largest px-per-year, and an absolute floor that exists only to keep the maths
 * finite. The *useful* floor is per-mode and derived — see `ppyRange`.
 */
export const PPY_MAX = 900;
export const ABS_PPY_MIN = 1e-9;

/** y zoom, expressed as how many multiples of the viewport height the atlas fills. */
export const YZ_MIN = 1;
export const YZ_MAX = 900;

/** Fraction of the domain left as air on each side when fitting. */
const FIT_PAD = 0.02;

// ---------------------------------------------------------------------------
// Modes — one linear axis each, at three depths of time
// ---------------------------------------------------------------------------

/*
 * A single linear axis cannot serve both a 5,000-year corpus and the age of the
 * Earth: one entry at −113,000 was enough to push 99% of the data into 3% of the
 * axis, and to make Fit clamp against a floor tuned for a different corpus and
 * land on empty space.
 *
 * A mode picks the DOMAIN — which slice of time the axis covers — and the ladder
 * and tick vocabulary that suit it. That is not the compressed/elided axis that
 * was offered and rejected: inside a mode x is strictly linear, nothing is warped
 * and a gap still reads as the real gap it is. If you find yourself adding a
 * piecewise or log transform here, stop.
 *
 * `from` is a fixed left edge, not a data-derived one, so the axis means the same
 * thing between rebuilds. It only ever widens, to reach an entry older than the
 * mode itself (`domainFor`).
 */
export const MODES = [
  {
    key: 'civ',
    label: 'Civilization',
    title: 'Writing onwards — 3000 BC to now',
    from: -3000,
    stops: [
      { key: 'all',       label: 'All',       ppy: null },   // fit the domain
      { key: 'centuries', label: 'Centuries', ppy: 1.2 },
      { key: 'decades',   label: 'Decades',   ppy: 6 },
      { key: 'years',     label: 'Years',     ppy: 26 },
      { key: 'detail',    label: 'Detail',    ppy: 90 },
    ],
  },
  {
    key: 'human',
    label: 'Humans',
    title: 'The whole human span — 300,000 years',
    from: -300000,
    stops: [
      { key: 'all',       label: 'All',       ppy: null },
      { key: 'millennia', label: 'Millennia', ppy: 0.05 },
      { key: 'eras',      label: 'Eras',      ppy: 0.35 },
      { key: 'centuries', label: 'Centuries', ppy: 1.2 },
      { key: 'decades',   label: 'Decades',   ppy: 6 },
      { key: 'detail',    label: 'Detail',    ppy: 90 },
    ],
  },
  {
    key: 'earth',
    label: 'Earth',
    title: 'Deep time — 4.54 billion years',
    from: -4.54e9,
    stops: [
      { key: 'all',       label: 'All',       ppy: null },
      { key: 'eons',      label: 'Eons',      ppy: 3e-6 },
      { key: 'periods',   label: 'Periods',   ppy: 3e-5 },
      { key: 'epochs',    label: 'Epochs',    ppy: 3e-4 },
      { key: 'ages',      label: 'Ages',      ppy: 3e-3 },
      { key: 'millennia', label: 'Millennia', ppy: 0.05 },
    ],
  },
];

export const DEFAULT_MODE = 'civ';

export const modeOf = (key) => MODES.find((m) => m.key === key) || MODES[0];

/** The mode one step wider than `key`, or null at the widest. */
export const widerMode = (key) => {
  const i = MODES.findIndex((m) => m.key === key);
  return i >= 0 && i < MODES.length - 1 ? MODES[i + 1] : null;
};

/**
 * The domain a mode puts on the axis: its own left edge, and the data's right.
 *
 * Only the WIDEST mode stretches left to reach an entry older than itself, so that
 * nothing in the corpus is unreachable in every mode. The narrower modes hold their
 * fixed edge and leave older entries out of reach — that is the entire point of
 * them, and `outsideCount` in `index.js` reports how many. Letting every mode
 * stretch was the first version of this function, and it handed Civilization mode
 * the same 113,000-year axis that broke Fit in the first place.
 */
export function domainFor(key, dataExtent){
  const m = modeOf(key);
  const widest = m.key === MODES[MODES.length - 1].key;
  const lo = widest && dataExtent ? Math.min(m.from, dataExtent[0]) : m.from;
  const hi = Math.max(lo + 1, dataExtent ? dataExtent[1] : 0);
  return [lo, hi];
}

/**
 * The legal px-per-year range for a view, given its mode's domain and width.
 *
 * The floor is *derived*: it is exactly the zoom at which the whole domain fits.
 * That is the fix for the bug this whole mechanism exists for — a hardcoded floor
 * is only ever right for the corpus it was measured against, and when the corpus
 * outgrew it Fit silently stopped fitting. Derived, "zoomed all the way out" and
 * "the whole domain is on screen" cannot drift apart.
 */
export function ppyRange(view){
  const dom = view.domain;
  if(!dom) return [ABS_PPY_MIN, PPY_MAX];
  const span = Math.max(1, dom[1] - dom[0]);
  const fit = Math.max(50, view.W || 100) / (span * (1 + FIT_PAD * 2));
  return [Math.max(ABS_PPY_MIN, Math.min(fit, PPY_MAX)), PPY_MAX];
}

/** Is the view pulled all the way back to its mode's edge? */
export const atEdge = (view) => view.ppy <= ppyRange(view)[0] * 1.02;

/** The scale ladder for a view's mode. */
export const stopsFor = (key) => modeOf(key).stops;

/** How tall a collapsed cluster's strip is on screen, in CSS pixels. */
export const COLLAPSED_STRIP_PX = 15;

// ---------------------------------------------------------------------------
// The y warp — what makes collapsing actually free up space
// ---------------------------------------------------------------------------

/*
 * A collapsed cluster used to keep its full height and simply stop drawing its
 * members, so folding a big branch left a tall empty stripe behind: the section
 * went dark but nothing else got any room. Collapse now warps the y axis.
 *
 * There are two y spaces from here on:
 *
 *   ATLAS  y   what the data holds, in [0,1]. A point's y never changes.
 *   LAYOUT y   what the camera lives in, also normalised to [0,1]. Every
 *              collapsed range is squeezed to a thin strip and the rest of the
 *              axis is stretched back out to fill the gap.
 *
 * `sy` takes atlas y and returns pixels, so almost all painting code is
 * unaffected. `yTop`, `iy` and everything the camera stores are LAYOUT y —
 * which is why `clampView`, `fitView` and the saved prefs need no changes.
 * The few places that mix the two use `warpY` / `unwarpY` explicitly.
 *
 * The strip's layout width is chosen so it lands on COLLAPSED_STRIP_PX at the
 * current zoom — a collapsed cluster must not grow as you zoom in, or it would
 * be back to eating the screen. That makes the warp mildly zoom-dependent, so
 * cursor-anchored zoom drifts by a pixel or two near a collapsed strip. That is
 * the cheaper of the two errors.
 */

const IDENTITY_WARP = {
  n: 0,
  f: (y) => y,
  inv: (v) => v,
};

/**
 * Build the warp for a set of collapsed ranges.
 *
 * `ranges` is a list of `{y0, y1}` in atlas space; they must not nest (the
 * caller drops any range that sits inside another). Order does not matter.
 */
export function makeYWarp(ranges, { H = 800, yz = 1, targetPx = COLLAPSED_STRIP_PX } = {}){
  if(!ranges || !ranges.length) return IDENTITY_WARP;

  const rs = [...ranges]
    .map((r) => ({ y0: Math.max(0, Math.min(1, r.y0)), y1: Math.max(0, Math.min(1, r.y1)) }))
    .filter((r) => r.y1 > r.y0)
    .sort((a, b) => a.y0 - b.y0);
  if(!rs.length) return IDENTITY_WARP;

  const k = rs.length;
  const folded = rs.reduce((a, r) => a + (r.y1 - r.y0), 0);
  const open = Math.max(0, 1 - folded);

  // `share` is the fraction of the LAYOUT axis one strip gets. Solve it so the
  // strip lands on `targetPx`, then cap the total so strips can never take more
  // than 60% of the axis however many are folded.
  const want = clamp(targetPx / Math.max(1, H * yz), 0, 0.6 / k);
  // e is the strip's width in RAW layout units, before the axis is renormalised
  // to [0,1]: e / (open + k*e) === want.
  const e = open > 1e-9 && want * k < 0.999
    ? (want * open) / (1 - want * k)
    : 1;                                   // everything is folded — equal slices

  const total = open + k * e;

  // Piecewise-linear segments, atlas -> layout, built once and binary-searched.
  const seg = [];
  let ay = 0, ly = 0;
  for(const r of rs){
    if(r.y0 > ay){
      seg.push({ a0: ay, a1: r.y0, l0: ly, l1: ly + (r.y0 - ay) });
      ly += r.y0 - ay;
    }
    seg.push({ a0: r.y0, a1: r.y1, l0: ly, l1: ly + e, folded: true });
    ly += e;
    ay = r.y1;
  }
  if(ay < 1) seg.push({ a0: ay, a1: 1, l0: ly, l1: ly + (1 - ay) });

  // Renormalise to [0,1] so the camera's clamps and the saved prefs still mean
  // the same thing.
  for(const s of seg){ s.l0 /= total; s.l1 /= total; }

  const find = (v, lo, hi) => {
    let a = 0, b = seg.length - 1;
    while(a < b){
      const m = (a + b) >> 1;
      if(v > seg[m][hi]) a = m + 1; else b = m;
    }
    return seg[a];
  };

  return {
    n: k,
    stripLayout: e / total,
    f(y){
      if(y <= 0) return 0;
      if(y >= 1) return 1;
      const s = find(y, 'a0', 'a1');
      const span = s.a1 - s.a0;
      return span <= 0 ? s.l0 : s.l0 + ((y - s.a0) / span) * (s.l1 - s.l0);
    },
    inv(v){
      if(v <= 0) return 0;
      if(v >= 1) return 1;
      const s = find(v, 'l0', 'l1');
      const span = s.l1 - s.l0;
      return span <= 0 ? s.a0 : s.a0 + ((v - s.l0) / span) * (s.a1 - s.a0);
    },
  };
}

/**
 * The collapsed ranges to warp by: every collapsed node that is not itself
 * inside another collapsed node. Nesting would double-count the fold.
 */
export function collapsedRanges(A, collapsed){
  if(!collapsed || !collapsed.size) return [];
  const out = [];
  for(const id of collapsed){
    const nd = A.nodes[id];
    if(!nd) continue;
    if(A.ancestorsOf(id).some((p) => collapsed.has(p))) continue;
    out.push({ id, y0: nd.y0, y1: nd.y1 });
  }
  return out;
}

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
 * `x0` is the left edge in years, `yTop` the top edge in LAYOUT y (see the warp
 * above), and the viewport is `W x H` CSS pixels.
 *
 * `folded` is the list of collapsed ranges, in atlas y. With none, the warp is
 * the identity and everything below behaves exactly as it did before collapse
 * gained a vertical effect.
 */
export function makeScale({ x0, ppy, yTop, yz, W, H, folded }){
  const yUnitsVisible = 1 / yz;
  const pxPerY = H / yUnitsVisible;
  const warp = makeYWarp(folded, { H, yz });

  return {
    x0, ppy, yTop, yz, W, H,
    x1: x0 + W / ppy,
    yBot: yTop + yUnitsVisible,
    yUnitsVisible,
    pxPerY,
    warp,

    /** year -> px within the viewport */
    sx: (year) => (year - x0) * ppy,
    /** atlas y -> px within the viewport */
    sy: (y) => (warp.f(y) - yTop) * pxPerY,
    /** px -> year */
    ix: (px) => x0 + px / ppy,
    /** px -> LAYOUT y */
    iy: (px) => yTop + px / pxPerY,
    /** px -> ATLAS y, i.e. what the spatial grid is keyed on */
    iyAtlas: (px) => warp.inv(yTop + px / pxPerY),
    /** atlas y -> layout y, and back */
    warpY: (y) => warp.f(y),
    unwarpY: (v) => warp.inv(v),
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
    const [lo, hi] = ppyRange(view);
    next.ppy = clamp(view.ppy * factor, lo, hi);
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
 *
 * `extent` defaults to the view's own mode domain, so a call site that forgets it
 * still clamps to the right thing rather than silently letting the camera leave
 * the mode.
 */
export function clampView(view, extent = view.domain){
  const v = { ...view };
  const [lo, hi] = ppyRange(v);
  v.ppy = clamp(v.ppy, lo, hi);
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

/**
 * The view that fits a mode's whole domain (plus a little air) into `W` px.
 *
 * By construction this lands on `ppyRange`'s floor, so it cannot clamp short of
 * fitting the way the old fixed-floor version did.
 */
export function fitView({ mode = DEFAULT_MODE, domain, W, H }){
  const dom = domain || domainFor(mode, null);
  const span = Math.max(1, dom[1] - dom[0]);
  const pad = span * FIT_PAD;
  const v = { mode, domain: dom, x0: dom[0] - pad, ppy: 0, yTop: 0, yz: 1, W, H };
  v.ppy = ppyRange(v)[0];
  return clampView(v, dom);
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
    // Through `sy`, so a folded branch counts as the thin strip it now is
    // rather than as its full height.
    const heights = ids.map((id) => scale.sy(A.nodes[id].y1) - scale.sy(A.nodes[id].y0))
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

/*
 * Runs from single years to a billion, because the same ladder serves all three
 * modes. Fully zoomed out in Earth mode a tick every 250 million years is the
 * only spacing that leaves the labels readable.
 */
const STEPS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000,
  1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7,
  1e8, 2.5e8, 5e8, 1e9,
];

/** Smallest step from `STEPS` that keeps ticks at least `minPx` apart. */
export function tickStep(ppy, minPx = 78){
  for(const s of STEPS) if(s * ppy >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

export function ticks(scale, minPx = 78){
  const step = tickStep(scale.ppy, minPx);
  const first = Math.ceil(scale.x0 / step) * step;
  const out = [];
  // The cap only bites if the ladder runs out of headroom below the current zoom,
  // which needs a viewport narrow enough that even 1e9 ticks crowd. Cheaper than
  // discovering it as a hung frame.
  for(let y = first; y <= scale.x1 && out.length < 400; y += step){
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

/*
 * Axis labels, which need a different vocabulary from entry labels. An entry is
 * always "1066" or "3000 BC" — that is what its own year means. But an axis at
 * 250-million-year spacing cannot read "4500000000 BC", so the unit follows the
 * STEP, not the value: every label on one axis is then in the same unit and the
 * spacing is legible as even.
 *
 * The third column is the smallest step that earns each unit. `ka` deliberately
 * waits until 10,000-year spacing, so ordinary prehistory ticks still read as
 * "8000 BC" rather than "8 ka".
 */
const TICK_UNITS = [
  [1e9, 'Ga', 5e7],
  [1e6, 'Ma', 5e4],
  [1e3, 'ka', 1e4],
];

export function fmtTick(y, step = 1){
  for(const [unit, suffix, floor] of TICK_UNITS){
    if(step < floor) continue;
    const q = step / unit;
    // Enough decimals to render the step itself exactly: a 2.5 Ma step must not
    // print as alternating 50/53/55, which reads as an uneven axis.
    let dp = 0;
    while(dp < 3 && Number(q.toFixed(dp)) !== q) dp++;
    const v = Math.abs(y) / unit;
    /*
     * `ka`/`Ma`/`Ga` mean "ago", so a positive year cannot wear one: the padded
     * right edge of the axis sits a couple of per cent into the future, and the
     * first version of this printed year +8066 as "8 ka" — eight thousand years in
     * the wrong direction. Anything from year 0 forward is inside a single tick of
     * now at these spacings, so 'present' is both honest and more precise. Same for
     * a negative year too small to print.
     */
    if(y >= 0 || v < Math.pow(10, -dp) / 2) return 'present';
    return `${v.toFixed(dp)} ${suffix}`;
  }
  return fmtYear(y);
}

export const fmtTickRange = (a, b, step = 1) => {
  const l = fmtTick(a, step), r = fmtTick(b, step);
  return l === r ? l : `${l}–${r}`;
};
