/*
 * Canvas painting.
 *
 * Everything that is not an image goes through here: cluster bands, spans, dots
 * and text chips. Image cards are DOM (see cards.js) because <img> decoding,
 * caching and lazy loading are things the browser already does well.
 *
 * The division of labour matters for performance. At any zoom this file draws
 * every visible point — tens of thousands if need be — in one pass with no
 * allocation and no per-point objects. The DOM layer only ever handles the
 * handful of entries that earned a picture.
 */

import { fmtRange, fmtYear } from './scales.js';

/*
 * Two palettes, because the canvas cannot read CSS variables.
 *
 * `COLORS` is mutated in place by `setCanvasTheme` rather than replaced, so every
 * `COLORS.x` read elsewhere keeps working without threading a theme argument
 * through the paint functions.
 *
 * The per-theme band alphas matter more than they look. A cluster colour is
 * OKLCH lightness ~0.6, so a 7.5% wash of it reads clearly on near-black and
 * disappears entirely on white — the light theme needs roughly double.
 */
export const PALETTES = {
  dark: {
    bg: '#0b0e14',
    bgAlt: '#0e121a',
    grid: 'rgba(148,163,184,0.10)',
    gridMajor: 'rgba(148,163,184,0.20)',
    text: '#e2e8f0',
    dim: '#64748b',
    accent: '#38bdf8',
    zeroLine: 'rgba(226,232,240,0.28)',
    hoverRing: 'rgba(226,232,240,0.75)',
    dimMark: 'rgba(100,116,139,0.22)',
    dimSpan: 0.12,
    dimText: 'rgba(148,163,184,0.5)',
    chipBg: 'rgba(15,20,30,0.86)',
    chipBgDim: 'rgba(15,20,30,0.45)',
    labelBg: 'rgba(11,14,20,0.72)',
    bandFill: 0.075,
    bandFillFolded: 0.30,
    bandEdge: 0.30,
    ink: 0,                 // how far a cluster colour is pushed toward the
  },                        // background before it is used as text
  light: {
    bg: '#ffffff',
    bgAlt: '#f4f6fa',
    grid: 'rgba(71,85,105,0.10)',
    gridMajor: 'rgba(71,85,105,0.22)',
    text: '#0f172a',
    dim: '#64748b',
    accent: '#0369a1',
    zeroLine: 'rgba(15,23,42,0.30)',
    hoverRing: 'rgba(15,23,42,0.62)',
    dimMark: 'rgba(100,116,139,0.28)',
    dimSpan: 0.16,
    dimText: 'rgba(100,116,139,0.65)',
    chipBg: 'rgba(255,255,255,0.94)',
    chipBgDim: 'rgba(255,255,255,0.66)',
    labelBg: 'rgba(255,255,255,0.86)',
    bandFill: 0.085,
    bandFillFolded: 0.30,
    bandEdge: 0.20,
    ink: 0.40,
  },
};

export const COLORS = { ...PALETTES.light };

export function setCanvasTheme(name){
  Object.assign(COLORS, PALETTES[name] || PALETTES.light);
}

/**
 * A cluster colour, darkened enough to be read as text.
 *
 * The palette is tuned for coloured marks on a dark ground; the same hue at
 * lightness 0.6 on white is around 3:1, which is not enough for an 11px label.
 * Mixing toward black by `ink` keeps the hue identifiable and the text legible.
 */
export function hueInk(hex){
  if(!COLORS.ink) return hex;
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const m = 1 - COLORS.ink;
  const ch = (v) => Math.round(v * m).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Set up a canvas for the device pixel ratio. Returns the 2D context. */
export function sizeCanvas(canvas, W, H){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(W * dpr));
  const h = Math.max(1, Math.round(H * dpr));
  if(canvas.width !== w || canvas.height !== h){
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const hexToRgba = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * The cluster bands for the current depth, plus any collapsed node encountered
 * on the way down.
 *
 * Walks from the root and stops at whichever comes first: the target depth, a
 * collapsed node, or a leaf. So a collapsed cluster stays one band no matter how
 * far you zoom in — which is the whole point of collapsing it.
 */
export function visibleBands(A, depth, collapsed){
  const out = [];
  (function walk(id){
    const nd = A.nodes[id];
    if(collapsed.has(id) || nd.depth >= depth || !nd.children.length){
      if(nd.depth > 0) out.push(nd);
      return;
    }
    for(const c of nd.children) walk(c);
  })(0);
  return out;
}

/** Is this point inside a collapsed cluster? */
export function isHidden(A, i, collapsed){
  if(!collapsed.size) return false;
  for(const id of A.chainOf.get(A.leaf[i]) || []) if(collapsed.has(id)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Label packing
// ---------------------------------------------------------------------------

/*
 * Occupancy grid over the viewport, so "does this label overlap anything already
 * placed" is a handful of byte reads. Reused across frames — cleared with fill(0)
 * rather than reallocated, because this runs on every pan.
 */
const OCC_CELL = 8;

class Occupancy {
  constructor(){ this.cols = 0; this.rows = 0; this.bits = new Uint8Array(0); }

  reset(W, H){
    const cols = Math.ceil(W / OCC_CELL) + 2;
    const rows = Math.ceil(H / OCC_CELL) + 2;
    if(cols !== this.cols || rows !== this.rows){
      this.cols = cols; this.rows = rows;
      this.bits = new Uint8Array(cols * rows);
    } else {
      this.bits.fill(0);
    }
  }

  free(x, y, w, h){
    const c0 = Math.max(0, (x / OCC_CELL) | 0), c1 = Math.min(this.cols - 1, ((x + w) / OCC_CELL) | 0);
    const r0 = Math.max(0, (y / OCC_CELL) | 0), r1 = Math.min(this.rows - 1, ((y + h) / OCC_CELL) | 0);
    for(let r = r0; r <= r1; r++){
      const off = r * this.cols;
      for(let c = c0; c <= c1; c++) if(this.bits[off + c]) return false;
    }
    return true;
  }

  mark(x, y, w, h){
    const c0 = Math.max(0, (x / OCC_CELL) | 0), c1 = Math.min(this.cols - 1, ((x + w) / OCC_CELL) | 0);
    const r0 = Math.max(0, (y / OCC_CELL) | 0), r1 = Math.min(this.rows - 1, ((y + h) / OCC_CELL) | 0);
    for(let r = r0; r <= r1; r++){
      const off = r * this.cols;
      for(let c = c0; c <= c1; c++) this.bits[off + c] = 1;
    }
  }
}

const occ = new Occupancy();

// Above this, an entry is famous enough to earn a highlight: a bigger dot, a
// thin ring, a bold label. One number to tune if the highlight fires too
// often or too rarely once real fame data is loaded.
const FAME_HI = 0.7;

/** Card geometry per tier. Heights are worst case for the text they hold. */
export const CARD = {
  chip: { w: 0,   h: 20, gap: 3 },      // width is measured from the title
  card: { w: 132, h: 150, gap: 5 },
  detail: { w: 196, h: 250, gap: 6 },
};

/**
 * Decide which visible points get a label, and where.
 *
 * Candidates are considered in a fixed global priority order, so panning does not
 * reshuffle the result: a point that has a card keeps it while it stays on screen.
 * The first thing placed near a spot wins, and anything that would overlap is left
 * as a dot. Detail therefore thickens smoothly as you zoom instead of a whole tier
 * appearing at once.
 *
 * `budget` caps how many DOM cards can exist, which is what keeps the frame flat
 * when a dense region fills the screen.
 *
 * `yArr` optionally replaces `A.y` as the source of each point's vertical
 * position — a typed-array pointer swap, not a per-point accessor call, so
 * focus mode (which has its own y per point, see index.js) costs nothing extra
 * here beyond which array gets read.
 */
export function packLabels(A, scale, visible, tier, { collapsed, budget = 220, measure, yArr } = {}){
  const placements = [];
  if(tier === 'dot') return placements;

  occ.reset(scale.W, scale.H);

  const spec = CARD[tier] || CARD.chip;
  const inSet = new Set(visible);
  const Y = yArr || A.y;

  for(const i of A.prioOrder){
    if(placements.length >= budget) break;
    if(!inSet.has(i)) continue;
    if(collapsed && isHidden(A, i, collapsed)) continue;

    const px = scale.sx(A.x0[i]);
    const py = scale.sy(Y[i]);

    let w = spec.w, h = spec.h;
    if(tier === 'chip'){
      w = Math.min(190, (measure ? measure(A.title[i]) : A.title[i].length * 6.1) + 16);
    }

    // Anchor: a point's mark sits at its year, so its label goes just right of it
    // and vertically centred, which keeps the label's meaning unambiguous when
    // two are near each other.
    let x = px + 7;
    let y = py - h / 2;

    // Nudge inside the viewport rather than dropping the label. An entry at the
    // screen edge is exactly the one you are panning toward.
    if(x + w > scale.W - 2) x = px - w - 7;
    if(x < 2) x = 2;
    y = Math.max(1, Math.min(scale.H - h - 1, y));

    const g = spec.gap;
    if(!occ.free(x - g, y - g, w + g * 2, h + g * 2)) continue;
    occ.mark(x - g, y - g, w + g * 2, h + g * 2);

    placements.push({ i, x, y, w, h, px, py, tier, famous: A.fame[i] > FAME_HI });
  }

  return placements;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Paint one frame.
 *
 * Order is back to front: background, gridlines, cluster bands, spans, dots,
 * chips, then the selection and hover marks on top.
 */
export function paintFrame(ctx, A, scale, opts){
  const {
    bands, visible, filter, collapsed, tier, placements,
    hover = -1, selected = -1, dimMode = true, showBandFill = true, yArr,
    // Set by focus mode, which clears the canvas and paints its own bands'
    // fill *before* calling this (see paintFocusBandFill in index.js's
    // paint()) so its wash sits under the dots the same way the map's own
    // band fill does. Clearing again here would erase that wash.
    skipClear = false,
  } = opts;

  const { W, H } = scale;
  // See `packLabels`'s note on `yArr` — same swap, same reason.
  const Y = yArr || A.y;

  if(!skipClear){
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- cluster bands ----------------------------------------------------
  // Filled, never stroked. An outlined band plus an outlined card produced the
  // doubled-border look that made the old view feel noisy; a wash of colour reads
  // as grouping without competing with the marks inside it.
  if(showBandFill){
    for(const nd of bands){
      const y0 = scale.sy(nd.y0);
      const y1 = scale.sy(nd.y1);
      if(y1 < 0 || y0 > H) continue;
      const isCollapsed = collapsed.has(nd.id);
      ctx.fillStyle = hexToRgba(nd.color, isCollapsed ? COLORS.bandFillFolded : COLORS.bandFill);
      ctx.fillRect(0, y0, W, Math.max(1, y1 - y0));

      // A hairline at the top edge only. Two adjacent bands then share one line
      // instead of drawing two next to each other.
      ctx.fillStyle = hexToRgba(nd.color, COLORS.bandEdge);
      ctx.fillRect(0, y0, W, 1);
      // A folded band is a thin strip, so it gets a bottom edge too — otherwise
      // two stacked folded clusters read as one.
      if(isCollapsed) ctx.fillRect(0, Math.max(y0 + 1, y1 - 1), W, 1);
    }
  }

  // ---- time gridlines ---------------------------------------------------
  const t = opts.ticks;
  if(t){
    for(const tk of t.list){
      ctx.fillStyle = tk.major ? COLORS.gridMajor : COLORS.grid;
      ctx.fillRect(Math.round(tk.px) + 0.5, 0, 1, H);
    }
  }

  // Year zero, when in view: a genuine landmark, worth one brighter line.
  if(scale.x0 < 0 && scale.x1 > 0){
    ctx.fillStyle = COLORS.zeroLine;
    ctx.fillRect(Math.round(scale.sx(0)) + 0.5, 0, 1, H);
  }

  /*
   * ---- spans -------------------------------------------------------------
   * Drawn before dots so a dot marks the start of its own span.
   *
   * A span that has not ended gets a fading tail rather than a squared-off right
   * edge. Its stored end is the current year — the only number available for a
   * thing that is still going — and drawn plainly that is a lie the eye reads
   * literally: the Phanerozoic, Animal and Fungus all appeared to terminate in
   * 2026, in the same shape as a reign that genuinely ended. At full zoom-out
   * they are the widest bars on the map, so it was also the most conspicuous
   * thing on it, which is why they read as spans running past the present.
   *
   * A gradient rather than an arrowhead: the bar is 2px tall and these are often
   * thousands of pixels long, so a glyph at the end is invisible unless you have
   * already scrolled to it, while a tail is legible at any zoom and needs no
   * legend. The fade is over the last 40px of the bar, or its final third when
   * it is shorter than that, so a narrow openEnded span still shows the taper.
   */
  ctx.lineWidth = 1;
  for(const i of visible){
    if(!A.isSpan[i]) continue;
    if(collapsed.size && isHidden(A, i, collapsed)) continue;
    const matched = !filter || filter.flags[i];
    if(!matched && !dimMode) continue;

    const xa = scale.sx(A.x0[i]);
    const xb = scale.sx(A.x1[i]);
    if(xb - xa < 1.5) continue;
    const y = Math.round(scale.sy(Y[i])) + 0.5;
    const alpha = matched ? 0.55 : COLORS.dimSpan;

    // Clamped to the viewport before measuring the tail, or an openEnded span
    // whose end is off-screen fades somewhere nobody can see while the visible
    // part draws flat.
    const x0 = Math.max(-2, xa);
    const x1 = Math.min(W + 4, xb);
    if(x1 <= x0) continue;

    if(A.openEnded[i] && x1 < W + 4){
      const fade = Math.min(40, (x1 - x0) / 3);
      const g = ctx.createLinearGradient(x1 - fade, 0, x1, 0);
      g.addColorStop(0, hexToRgba(A.color[i], alpha));
      g.addColorStop(1, hexToRgba(A.color[i], 0));
      ctx.fillStyle = hexToRgba(A.color[i], alpha);
      ctx.fillRect(x0, y - 1, (x1 - fade) - x0, 2);
      ctx.fillStyle = g;
      ctx.fillRect(x1 - fade, y - 1, fade, 2);
    } else {
      ctx.fillStyle = hexToRgba(A.color[i], alpha);
      ctx.fillRect(x0, y - 1, x1 - x0, 2);
    }
  }

  // ---- dots -------------------------------------------------------------
  /*
   * Radius grows with zoom so a point stays a reasonable target, but stays small
   * enough at low zoom that density reads as shading rather than a solid mass.
   *
   * Points that got a label are drawn smaller, as an anchor: the label is the
   * mark now, and a full-size dot beside it just looks like a duplicate.
   */
  const labelled = new Set(placements.map((p) => p.i));
  const r = tier === 'dot'
    ? (scale.ppy < 0.15 ? 1.1 : scale.ppy < 1 ? 1.7 : 2.4)
    : 2.6;

  // Two passes so matched points are never buried under dimmed ones.
  for(const pass of [0, 1]){
    for(const i of visible){
      if(collapsed.size && isHidden(A, i, collapsed)) continue;
      const matched = !filter || filter.flags[i];
      if(pass === 0 && matched) continue;
      if(pass === 1 && !matched) continue;
      if(!matched && !dimMode) continue;

      const x = scale.sx(A.x0[i]);
      const y = scale.sy(Y[i]);
      const famous = matched && A.fame[i] > FAME_HI;
      const rr = labelled.has(i) ? 1.6 : (famous ? r * 1.7 : r);

      ctx.fillStyle = matched ? A.color[i] : COLORS.dimMark;
      // A square is materially cheaper than an arc and indistinguishable at these
      // sizes; at 100k points that difference is the frame budget.
      if(rr <= 2) ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      else { ctx.beginPath(); ctx.arc(x, y, rr, 0, 6.2832); ctx.fill(); }
    }
  }

  /*
   * A thin ring around every famous, matched dot, in its own pass after both
   * dot passes: it has to composite over dimmed dots correctly and must not
   * double-draw once per pass. Restrained on purpose — a bigger dot and a
   * hairline ring, not a glow, to match the rest of the canvas's filled-not-
   * stroked, one-hairline aesthetic.
   */
  for(const i of visible){
    if(!filter || !filter.flags[i]){ continue; }
    if(A.fame[i] <= FAME_HI) continue;
    if(collapsed.size && isHidden(A, i, collapsed)) continue;
    const x = scale.sx(A.x0[i]);
    const y = scale.sy(Y[i]);
    const rr = (labelled.has(i) ? 1.6 : r * 1.7) + 3;
    ring(ctx, x, y, rr, hexToRgba(A.color[i], 0.55), 1);
  }

  // ---- chips ------------------------------------------------------------
  if(tier === 'chip'){
    const REGULAR = '11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    const FAMOUS = '600 11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.font = REGULAR;
    ctx.textBaseline = 'middle';
    for(const p of placements){
      const i = p.i;
      const matched = !filter || filter.flags[i];
      if(!matched && !dimMode) continue;

      ctx.fillStyle = matched ? COLORS.chipBg : COLORS.chipBgDim;
      roundRect(ctx, p.x, p.y, p.w, p.h, 4);
      ctx.fill();

      ctx.fillStyle = hexToRgba(A.color[i], matched ? 0.9 : 0.25);
      ctx.fillRect(p.x, p.y + 3, 2, p.h - 6);

      ctx.font = matched && p.famous ? FAMOUS : REGULAR;
      ctx.fillStyle = matched ? COLORS.text : COLORS.dimText;
      ctx.fillText(clip(ctx, A.title[i], p.w - 12), p.x + 7, p.y + p.h / 2);

      // A leader line when the label had to move away from its point.
      if(Math.abs(p.x - p.px) > 10 || Math.abs(p.y + p.h / 2 - p.py) > 10){
        ctx.strokeStyle = hexToRgba(A.color[i], matched ? 0.35 : 0.1);
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x < p.px ? p.x + p.w : p.x, p.y + p.h / 2);
        ctx.stroke();
      }
    }
  }

  // ---- band labels ------------------------------------------------------
  /*
   * Stuck to the left edge of the viewport, not to the band's own start year.
   * Anchored to the data, a label scrolls out of view the moment you pan past its
   * cluster's first entry — which is precisely when you still need to know which
   * cluster you are looking at.
   */
  if(showBandFill){
    ctx.font = '600 11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.textBaseline = 'top';
    for(const nd of bands){
      const y0 = scale.sy(nd.y0);
      const y1 = scale.sy(nd.y1);
      const isCollapsed = collapsed.has(nd.id);
      if(y1 < 2 || y0 > H - 2) continue;
      // An expanded band with no room for a legible label goes without one. A
      // FOLDED band always keeps its label: the strip is only a dozen pixels tall
      // and that label is the whole affordance for getting the cluster back.
      if(!isCollapsed && y1 - y0 < 15) continue;

      const label = isCollapsed ? `▸ ${nd.label}  (${nd.n})` : nd.label;
      const ty = clampNum(y0 + (isCollapsed ? (y1 - y0 - 13) / 2 : 3), 2, H - 15);

      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = COLORS.labelBg;
      roundRect(ctx, 4, ty - 1, w, 15, 3);
      ctx.fill();

      ctx.fillStyle = hueInk(nd.color);
      ctx.fillText(label, 10, ty + 1);
    }
  }

  // ---- selection and hover ---------------------------------------------
  /*
   * A ring drawn OUTSIDE the mark, never a second border on it. The old cards
   * carried their own border plus a focus outline, which is what read as two
   * outlines; here selection is a halo and there is only ever one edge.
   */
  if(selected >= 0 && !isHidden(A, selected, collapsed) && !Number.isNaN(Y[selected])){
    ring(ctx, scale.sx(A.x0[selected]), scale.sy(Y[selected]), 7, COLORS.accent, 2);
  }
  if(hover >= 0 && hover !== selected && !isHidden(A, hover, collapsed) && !Number.isNaN(Y[hover])){
    ring(ctx, scale.sx(A.x0[hover]), scale.sy(Y[hover]), 6, COLORS.hoverRing, 1.5);
  }
}

/*
 * A focus tree's own depth-1 nodes, drawn as bands — the "organized into named
 * groups" half of focus mode's payoff, so a reclustered search reads as
 * sub-groups ("Battles," "Monarchs," …) rather than an unexplained scatter.
 *
 * Split into fill and labels, called on either side of `paintFrame` (fill
 * before, so dots and spans layer on top of the wash exactly like the map's
 * own bands do; labels after, so they stay on top of everything else the same
 * way the map's own band labels do). Deliberately separate from
 * `visibleBands`/`paintFrame`'s band path rather than reusing it: a focus
 * tree's node ids restart at 0 and collide with real global node ids, so
 * sharing any `V.collapsed`-keyed surface with them would risk a focus band
 * reading as folded because an unrelated global node happens to share its
 * small integer id. No per-band collapse here in v1 — every focus band is
 * always expanded.
 */
const focusBandsOf = (nodes) => (nodes?.[0]?.children || []).map((id) => nodes[id]).filter(Boolean);

export function paintFocusBandFill(ctx, scale, nodes, W, H){
  for(const nd of focusBandsOf(nodes)){
    const y0 = scale.sy(nd.y0);
    const y1 = scale.sy(nd.y1);
    if(y1 < 0 || y0 > H) continue;
    ctx.fillStyle = hexToRgba(nd.color, COLORS.bandFill);
    ctx.fillRect(0, y0, W, Math.max(1, y1 - y0));
    ctx.fillStyle = hexToRgba(nd.color, COLORS.bandEdge);
    ctx.fillRect(0, y0, W, 1);
  }
}

export function paintFocusBandLabels(ctx, scale, nodes, W, H){
  ctx.font = '600 11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.textBaseline = 'top';
  for(const nd of focusBandsOf(nodes)){
    const y0 = scale.sy(nd.y0);
    const y1 = scale.sy(nd.y1);
    if(y1 < 2 || y0 > H - 2 || y1 - y0 < 15) continue;

    const label = `${nd.label}  (${nd.n})`;
    const ty = clampNum(y0 + 3, 2, H - 15);
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = COLORS.labelBg;
    roundRect(ctx, 4, ty - 1, w, 15, 3);
    ctx.fill();
    ctx.fillStyle = hueInk(nd.color);
    ctx.fillText(label, 10, ty + 1);
  }
}

const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);

function ring(ctx, x, y, r, color, lw){
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 6.2832);
  ctx.stroke();
}

export function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Truncate to fit `maxW`, with an ellipsis. Binary search on width. */
function clip(ctx, text, maxW){
  if(ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while(lo < hi){
    const mid = (lo + hi + 1) >> 1;
    if(ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * What is under the cursor.
 *
 * Placed labels are tested first, by rectangle, so a chip or card is clickable
 * across its whole area rather than only at the dot it belongs to. Failing that,
 * the nearest point within `radius` wins — generous enough to be forgiving at
 * dot zoom, where marks are two pixels wide.
 */
export function hitTest(A, scale, visible, placements, mx, my, { collapsed, radius = 11, yArr } = {}){
  for(let k = placements.length - 1; k >= 0; k--){
    const p = placements[k];
    if(mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) return p.i;
  }

  const Y = yArr || A.y;
  let best = -1, bestD = radius * radius;
  for(const i of visible){
    if(collapsed?.size && isHidden(A, i, collapsed)) continue;
    const dx = scale.sx(A.x0[i]) - mx;
    const dy = scale.sy(Y[i]) - my;
    const d = dx * dx + dy * dy;
    if(d < bestD){ bestD = d; best = i; }

    // A span is grabbable anywhere along its bar, not just at its start.
    if(A.isSpan[i]){
      const xa = scale.sx(A.x0[i]), xb = scale.sx(A.x1[i]);
      if(mx >= xa && mx <= xb){
        const dy2 = Math.abs(scale.sy(Y[i]) - my);
        if(dy2 < 5 && dy2 * dy2 < bestD){ bestD = dy2 * dy2; best = i; }
      }
    }
  }
  return best;
}

/** The band under a y pixel, for clicking a cluster rather than a point. */
export function bandAt(bands, scale, my){
  for(const nd of bands){
    if(my >= scale.sy(nd.y0) && my <= scale.sy(nd.y1)) return nd;
  }
  return null;
}

export { fmtRange, fmtYear };
