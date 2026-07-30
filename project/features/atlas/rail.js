/*
 * The cluster rail, and the pinned strip.
 *
 * Both of these exist because of explicit gaps in the old view: "collapsing rows
 * is not possible" and "pinning rows to the top of the screen is not possible".
 *
 * COLLAPSE folds a cluster into a single band that stays folded at every zoom,
 * and hides its children from the rail. One control does both, because they are
 * the same intent — "I am not interested in this branch right now" — and two
 * separate toggles for it would just be a puzzle.
 *
 * PIN lifts a cluster into a strip across the top of the canvas, where it stays
 * visible while you pan and zoom the map below. The strip shares the map's x
 * transform, so time stays aligned: you can hold "Cubism" pinned and scroll
 * through four centuries watching what lines up with it. This is the old
 * "keep related topics at the same vertical height" request taken to its
 * conclusion — the topic does not merely keep its height, it keeps the screen.
 */

import { fmtRange } from './scales.js';
import { esc } from './cards.js';
import { COLORS, roundRect, isHidden } from './paint.js';

/** How much of the viewport the pinned strip may take before it starts scrolling. */
export const PIN_MAX_FRACTION = 0.42;
export const PIN_ROW_MIN = 46;
export const PIN_ROW_MAX = 120;

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

export function createRail(root, hooks = {}){
  const el = root.ownerDocument.createElement('div');
  el.className = 'rail';
  root.appendChild(el);

  let A = null;
  let lastKey = '';

  /**
   * Rebuild the list.
   *
   * Guarded by a cheap signature so that panning and zooming — which do not change
   * the tree — never touch the DOM here. Only a change of collapse, pin, filter or
   * depth causes a rebuild.
   */
  function sync(atlas, { collapsed, pinned, filter, depth, counts, selectedNode }){
    A = atlas;
    const key = [
      [...collapsed].sort().join(','), pinned.join(','), depth,
      filter ? filter.count : -1, selectedNode ?? -1,
    ].join('|');
    if(key === lastKey) return;
    lastKey = key;

    const rows = [];
    const pinSet = new Set(pinned);

    (function walk(id){
      const nd = A.nodes[id];
      if(nd.depth > 0){
        const n = counts ? (counts.get(id) || 0) : nd.n;
        const isCollapsed = collapsed.has(id);
        const hasKids = nd.children.length > 0;
        const muted = filter && n === 0;

        rows.push(
          `<div class="rrow${isCollapsed ? ' col' : ''}${muted ? ' muted' : ''}` +
          `${selectedNode === id ? ' cur' : ''}" data-node="${id}" ` +
          `style="--hue:${nd.color};--ind:${(nd.depth - 1) * 11}px" ` +
          `title="${esc(nd.label)} · ${nd.n} entries · ${esc(fmtRange(nd.x0, nd.x1))}">` +
            `<button class="twist" data-act="collapse" title="${hasKids
              ? (isCollapsed ? 'Expand this cluster' : 'Collapse this cluster')
              : 'No sub-clusters'}"${hasKids ? '' : ' disabled'}>${
              hasKids ? (isCollapsed ? '▸' : '▾') : '·'}</button>` +
            `<span class="sw"></span>` +
            `<span class="rlabel">${esc(nd.label)}</span>` +
            `<span class="rn">${filter ? `${n}/${nd.n}` : nd.n}</span>` +
            `<button class="rpin${pinSet.has(id) ? ' on' : ''}" data-act="pin" ` +
              `title="${pinSet.has(id) ? 'Unpin' : 'Pin to the top of the screen'}">◆</button>` +
          `</div>`,
        );
      }
      // A collapsed cluster hides its children here as well as on the map.
      if(collapsed.has(id)) return;
      if(nd.depth >= depth) return;
      for(const c of nd.children) walk(c);
    })(0);

    el.innerHTML =
      `<div class="railhead">` +
        `<span>Clusters</span>` +
        `<button class="btn tiny" data-act="expandAll" title="Expand every cluster">Expand all</button>` +
        `<button class="btn tiny" data-act="collapseTop" title="Collapse to the broadest groups">Collapse</button>` +
      `</div>` +
      `<div class="railbody">${rows.join('')}</div>`;
  }

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;

    if(act === 'expandAll'){ hooks.onExpandAll?.(); return; }
    if(act === 'collapseTop'){ hooks.onCollapseTop?.(); return; }

    const row = e.target.closest('.rrow');
    if(!row) return;
    const id = Number(row.dataset.node);

    if(act === 'collapse'){ hooks.onToggleCollapse?.(id); return; }
    if(act === 'pin'){ hooks.onTogglePin?.(id); return; }
    hooks.onSelectNode?.(id);
  });

  /** Force a rebuild — used when the atlas itself changes. */
  function invalidate(){ lastKey = ''; }

  return { el, sync, invalidate };
}

// ---------------------------------------------------------------------------
// The pinned strip
// ---------------------------------------------------------------------------

/**
 * Lay out the pinned rows. Each pinned cluster gets an equal slice, bounded so
 * that pinning many clusters does not swallow the map.
 */
export function pinLayout(pinned, viewportH){
  if(!pinned.length) return { rows: [], height: 0 };

  const maxTotal = Math.floor(viewportH * PIN_MAX_FRACTION);
  const per = Math.max(PIN_ROW_MIN, Math.min(PIN_ROW_MAX, Math.floor(maxTotal / pinned.length)));
  const rows = pinned.map((id, k) => ({ id, y: k * per, h: per }));
  return { rows, height: Math.min(maxTotal, per * pinned.length) };
}

/**
 * Paint the strip.
 *
 * Each row remaps its cluster's own y range onto the row's height, so a pinned
 * cluster is shown at full vertical resolution however thin its band is on the
 * map. The x transform is the map's, untouched — that shared time axis is the
 * entire value of the feature.
 */
export function paintPinStrip(ctx, A, scale, { rows, filter, collapsed, dimMode, hover, selected }){
  const { W } = scale;

  ctx.fillStyle = COLORS.bgAlt;
  ctx.fillRect(0, 0, W, rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0);

  for(const row of rows){
    const nd = A.nodes[row.id];
    if(!nd) continue;

    const span = Math.max(1e-9, nd.y1 - nd.y0);
    const pad = 9;                                   // room for the label strip
    const inner = row.h - pad - 3;
    const toPx = (y) => row.y + pad + ((y - nd.y0) / span) * inner;

    ctx.fillStyle = hexA(nd.color, 0.10);
    ctx.fillRect(0, row.y, W, row.h);
    ctx.fillStyle = hexA(nd.color, 0.34);
    ctx.fillRect(0, row.y, W, 1);

    // Gridlines, so the strip reads against the same time axis as the map.
    if(scale._ticks){
      for(const tk of scale._ticks.list){
        ctx.fillStyle = tk.major ? COLORS.gridMajor : COLORS.grid;
        ctx.fillRect(Math.round(tk.px) + 0.5, row.y + pad, 1, inner);
      }
    }

    // Members. A pinned cluster is small by construction, so this is a scan over
    // its own membership rather than a spatial query.
    for(const i of membersOf(A, row.id)){
      if(collapsed?.size && isHidden(A, i, collapsed)) continue;
      const matched = !filter || filter.flags[i];
      if(!matched && !dimMode) continue;

      const x = scale.sx(A.x0[i]);
      if(x < -6 || x > W + 6) continue;
      const y = toPx(A.y[i]);

      if(A.isSpan[i]){
        const xb = scale.sx(A.x1[i]);
        if(xb - x > 1.5){
          ctx.fillStyle = hexA(A.color[i], matched ? 0.5 : 0.12);
          ctx.fillRect(x, y - 1, xb - x, 2);
        }
      }

      const r = matched ? 2.3 : 1.6;
      ctx.fillStyle = matched ? A.color[i] : 'rgba(100,116,139,0.25)';
      ctx.fillRect(x - r, y - r, r * 2, r * 2);

      if(i === selected){
        ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, 6.2832); ctx.stroke();
      } else if(i === hover){
        ctx.strokeStyle = 'rgba(226,232,240,0.8)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.2832); ctx.stroke();
      }
    }

    // Label, stuck to the left edge for the same reason the map's band labels are.
    const label = `${nd.label}  (${nd.n})`;
    ctx.font = '600 10.5px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(11,14,20,0.8)';
    roundRect(ctx, 4, row.y + 2, w, 13, 3);
    ctx.fill();
    ctx.fillStyle = hexA(nd.color, 1);
    ctx.fillText(label, 10, row.y + 3.5);
  }
}

/** Which pinned row, if any, is under a y pixel. */
export function pinRowAt(rows, py){
  for(const row of rows) if(py >= row.y && py <= row.y + row.h) return row;
  return null;
}

/**
 * Hit test inside the strip, in the row's own remapped space.
 * Returns the point index or -1.
 */
export function pinHitTest(A, scale, rows, mx, my, { collapsed, radius = 10 } = {}){
  const row = pinRowAt(rows, my);
  if(!row) return -1;
  const nd = A.nodes[row.id];
  if(!nd) return -1;

  const span = Math.max(1e-9, nd.y1 - nd.y0);
  const pad = 9;
  const inner = row.h - pad - 3;

  let best = -1, bestD = radius * radius;
  for(const i of membersOf(A, row.id)){
    if(collapsed?.size && isHidden(A, i, collapsed)) continue;
    const x = scale.sx(A.x0[i]);
    const y = row.y + pad + ((A.y[i] - nd.y0) / span) * inner;
    const dx = x - mx, dy = y - my;
    const d = dx * dx + dy * dy;
    if(d < bestD){ bestD = d; best = i; }
    if(A.isSpan[i]){
      const xb = scale.sx(A.x1[i]);
      if(mx >= x && mx <= xb && Math.abs(y - my) < 5) return i;
    }
  }
  return best;
}

/*
 * Members of a subtree, memoised.
 *
 * Called for every pinned row on every frame, so the first call walks the point
 * array once and every later call is a lookup. Without the cache, pinning a
 * top-level cluster would rescan 2,700+ points per frame for no reason.
 */
const memberCache = new WeakMap();

export function membersOf(A, nodeId){
  let byNode = memberCache.get(A);
  if(!byNode){ byNode = new Map(); memberCache.set(A, byNode); }
  let list = byNode.get(nodeId);
  if(list) return list;

  list = [];
  for(let i = 0; i < A.n; i++){
    const chain = A.chainOf.get(A.leaf[i]);
    if(chain && chain.includes(nodeId)) list.push(i);
  }
  byNode.set(nodeId, list);
  return list;
}

const hexA = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
