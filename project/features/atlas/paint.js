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

export const COLORS = {
  bg: '#0b0e14',
  bgAlt: '#0e121a',
  grid: 'rgba(148,163,184,0.10)',
  gridMajor: 'rgba(148,163,184,0.20)',
  text: '#e2e8f0',
  dim: '#64748b',
  accent: '#38bdf8',
};

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
 */
export function packLabels(A, scale, visible, tier, { collapsed, budget = 220, measure } = {}){
  const placements = [];
  if(tier === 'dot') return placements;

  occ.reset(scale.W, scale.H);

  const spec = CARD[tier] || CARD.chip;
  const inSet = new Set(visible);

  for(const i of A.prioOrder){
    if(placements.length >= budget) break;
    if(!inSet.has(i)) continue;
    if(collapsed && isHidden(A, i, collapsed)) continue;

    const px = scale.sx(A.x0[i]);
    const py = scale.sy(A.y[i]);

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

    placements.push({ i, x, y, w, h, px, py, tier });
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
    hover = -1, selected = -1, dimMode = true, showBandFill = true,
  } = opts;

  const { W, H } = scale;

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

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
      ctx.fillStyle = hexToRgba(nd.color, isCollapsed ? 0.22 : 0.075);
      ctx.fillRect(0, y0, W, Math.max(1, y1 - y0));

      // A hairline at the top edge only. Two adjacent bands then share one line
      // instead of drawing two next to each other.
      ctx.fillStyle = hexToRgba(nd.color, 0.30);
      ctx.fillRect(0, y0, W, 1);
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
    ctx.fillStyle = 'rgba(226,232,240,0.28)';
    ctx.fillRect(Math.round(scale.sx(0)) + 0.5, 0, 1, H);
  }

  // ---- spans ------------------------------------------------------------
  // Drawn before dots so a dot marks the start of its own span.
  ctx.lineWidth = 1;
  for(const i of visible){
    if(!A.isSpan[i]) continue;
    if(collapsed.size && isHidden(A, i, collapsed)) continue;
    const matched = !filter || filter.flags[i];
    if(!matched && !dimMode) continue;

    const xa = scale.sx(A.x0[i]);
    const xb = scale.sx(A.x1[i]);
    if(xb - xa < 1.5) continue;
    const y = Math.round(scale.sy(A.y[i])) + 0.5;
    ctx.fillStyle = hexToRgba(A.color[i], matched ? 0.55 : 0.12);
    ctx.fillRect(Math.max(-2, xa), y - 1, Math.min(W + 4, xb - xa), 2);
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
      const y = scale.sy(A.y[i]);
      const rr = labelled.has(i) ? 1.6 : r;

      ctx.fillStyle = matched ? A.color[i] : 'rgba(100,116,139,0.22)';
      // A square is materially cheaper than an arc and indistinguishable at these
      // sizes; at 100k points that difference is the frame budget.
      if(rr <= 2) ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      else { ctx.beginPath(); ctx.arc(x, y, rr, 0, 6.2832); ctx.fill(); }
    }
  }

  // ---- chips ------------------------------------------------------------
  if(tier === 'chip'){
    ctx.font = '11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.textBaseline = 'middle';
    for(const p of placements){
      const i = p.i;
      const matched = !filter || filter.flags[i];
      if(!matched && !dimMode) continue;

      ctx.fillStyle = matched ? 'rgba(15,20,30,0.86)' : 'rgba(15,20,30,0.45)';
      roundRect(ctx, p.x, p.y, p.w, p.h, 4);
      ctx.fill();

      ctx.fillStyle = hexToRgba(A.color[i], matched ? 0.9 : 0.25);
      ctx.fillRect(p.x, p.y + 3, 2, p.h - 6);

      ctx.fillStyle = matched ? COLORS.text : 'rgba(148,163,184,0.5)';
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
      if(y1 < 14 || y0 > H - 2) continue;
      if(y1 - y0 < 15) continue;

      const label = collapsed.has(nd.id) ? `▸ ${nd.label}  (${nd.n})` : nd.label;
      const ty = Math.max(2, y0 + 3);

      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(11,14,20,0.72)';
      roundRect(ctx, 4, ty - 1, w, 15, 3);
      ctx.fill();

      ctx.fillStyle = hexToRgba(nd.color, 1);
      ctx.fillText(label, 10, ty + 1);
    }
  }

  // ---- selection and hover ---------------------------------------------
  /*
   * A ring drawn OUTSIDE the mark, never a second border on it. The old cards
   * carried their own border plus a focus outline, which is what read as two
   * outlines; here selection is a halo and there is only ever one edge.
   */
  if(selected >= 0 && !isHidden(A, selected, collapsed)){
    ring(ctx, scale.sx(A.x0[selected]), scale.sy(A.y[selected]), 7, COLORS.accent, 2);
  }
  if(hover >= 0 && hover !== selected && !isHidden(A, hover, collapsed)){
    ring(ctx, scale.sx(A.x0[hover]), scale.sy(A.y[hover]), 6, 'rgba(226,232,240,0.75)', 1.5);
  }
}

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
export function hitTest(A, scale, visible, placements, mx, my, { collapsed, radius = 11 } = {}){
  for(let k = placements.length - 1; k >= 0; k--){
    const p = placements[k];
    if(mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) return p.i;
  }

  let best = -1, bestD = radius * radius;
  for(const i of visible){
    if(collapsed?.size && isHidden(A, i, collapsed)) continue;
    const dx = scale.sx(A.x0[i]) - mx;
    const dy = scale.sy(A.y[i]) - my;
    const d = dx * dx + dy * dy;
    if(d < bestD){ bestD = d; best = i; }

    // A span is grabbable anywhere along its bar, not just at its start.
    if(A.isSpan[i]){
      const xa = scale.sx(A.x0[i]), xb = scale.sx(A.x1[i]);
      if(mx >= xa && mx <= xb){
        const dy2 = Math.abs(scale.sy(A.y[i]) - my);
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
