/*
 * openAtlas() — the orchestrator.
 *
 * Owns the window, the camera, and the frame loop. Everything else in this
 * directory is a pure-ish function of state that this file holds.
 *
 * ## The frame loop
 *
 * State changes set dirty flags and request one animation frame; nothing paints
 * synchronously. The flags matter because the three layers have very different
 * costs: the canvas is cheap and repaints on any camera change, the DOM card layer
 * only re-syncs when placements move, and the rail only rebuilds when the tree,
 * filter or collapse state changes. Panning therefore touches the canvas and the
 * card transforms and nothing else.
 *
 * ## The two invariants inherited from the old engine
 *
 *   1. Geometry never reads scroll position. A point's y comes from the atlas and
 *      its x from its year, so panning sideways can never move anything
 *      vertically. Related topics stay at the same height as you travel through
 *      time — which was the original request and is now structural rather than
 *      maintained by hand.
 *   2. Representation is a function of zoom, not of the data. One number picks
 *      what is offered; `packLabels` fills the space that is actually free.
 */

import { loadAtlas, runFilter, parseQuery, queryIsEmpty } from './data.js';
import {
  makeScale, zoomAt, clampView, fitView, tierFor, depthFor, ticks,
  STOPS, PPY_MIN, PPY_MAX, coupledYZoom, clamp, fmtYear, fmtRange,
} from './scales.js';
import {
  sizeCanvas, paintFrame, packLabels, visibleBands, hitTest, bandAt, isHidden, COLORS,
} from './paint.js';
import { createCardLayer, createTip, esc } from './cards.js';
import { createDetail } from './detail.js';
import { createRail, pinLayout, paintPinStrip, pinHitTest, pinRowAt, membersOf } from './rail.js';
import { CSS } from './styles.js';

const PREFS_KEY = 'atlas:prefs:v1';

const SHELL = (base, css) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${base}">
<title>Atlas — history in embedding space</title>
<style>${css}</style>
</head><body>
<div id="boot"><span class="spin"></span><span>Loading the atlas…</span></div>
<div id="app" style="visibility:hidden">
  <header id="cmd">
    <div class="cmdrow">
      <div id="title">Atlas</div>
      <div id="count"></div>
      <div class="searchbox">
        <span class="mag">&#9906;</span>
        <input id="q" type="text" autocomplete="off" spellcheck="false"
               placeholder="Search — or 1750-1800, ds:art, topic:cubism, has:image">
        <button class="clear" title="Clear (Esc)">&times;</button>
        <span class="kbd">/</span>
      </div>
      <div class="seg" id="scaleSeg"></div>
      <div class="grp spacer">
        <button class="btn icon" id="zoomOut" title="Zoom out (&minus;)">&minus;</button>
        <span id="ppyLab"></span>
        <button class="btn icon" id="zoomIn" title="Zoom in (+)">+</button>
        <button class="btn" id="fitBtn" title="Fit everything (0)">Fit</button>
        <button class="btn" id="dimBtn" title="Dim non-matches instead of hiding them">Dim</button>
        <button class="btn" id="railBtn" title="Toggle the cluster rail (r)">Rail</button>
        <button class="btn" id="facetBtn" title="Toggle topic filters (f)">Topics</button>
        <button class="btn icon" id="helpBtn" title="Keyboard help (?)">?</button>
      </div>
    </div>
    <div class="cmdrow" id="facets"></div>
  </header>
  <div id="ruler"></div>
  <div id="mid">
    <div id="railHost"></div>
    <div id="stage">
      <div id="pinWrap"><canvas id="pinCanvas"></canvas><div id="pinBar"></div></div>
      <div id="surface"><canvas id="canvas"></canvas></div>
      <div id="empty"><div>Nothing matches the current filters.</div></div>
      <div id="status"></div>
    </div>
  </div>
  <div id="mini"><canvas id="miniCanvas"></canvas><div id="miniWin"></div></div>
</div>
<div id="help"><div id="helpBox">
  <h3>Atlas — controls</h3>
  <dl>
    <dt>wheel / pinch</dt><dd>zoom at the cursor</dd>
    <dt>&#8997; + wheel</dt><dd>zoom the topic axis only</dd>
    <dt>&#8679; + wheel</dt><dd>pan through time</dd>
    <dt>drag</dt><dd>pan</dd>
    <dt>&larr; &rarr; &uarr; &darr;</dt><dd>pan &middot; hold &#8679; for a bigger step</dd>
    <dt>click</dt><dd>open an entry &middot; click a band label to collapse it</dd>
    <dt>hover</dt><dd>preview, at any zoom</dd>
    <dt>/</dt><dd>search</dd>
    <dt>0</dt><dd>fit everything</dd>
    <dt>+ &minus;</dt><dd>zoom</dd>
    <dt>r &middot; f</dt><dd>rail &middot; topic filters</dd>
    <dt>c &middot; p</dt><dd>collapse &middot; pin the selected entry's cluster</dd>
    <dt>j &middot; k</dt><dd>next / previous nearest neighbour</dd>
    <dt>Esc</dt><dd>close, or clear the search</dd>
  </dl>
  <div class="note">
    Horizontal is time, linear. Vertical is position in embedding space: entries near
    each other are about similar things, and colour follows the same ordering, so a
    band of one hue is one family of subjects. Zooming vertically walks down the
    cluster hierarchy.
  </div>
</div></div>
</body></html>`;

export async function openAtlas({ title = 'Atlas' } = {}){
  const base = location.href.replace(/[^/]*$/, '');
  const w = window.open('', 'atlas');
  if(!w){ alert('Allow pop-ups to open the atlas.'); return; }

  w.document.open();
  w.document.write(SHELL(base, CSS));
  w.document.close();
  w.focus();

  const D = w.document;
  const $ = (id) => D.getElementById(id);
  const boot = $('boot');

  // ---- load ---------------------------------------------------------------
  let A;
  try {
    A = await loadAtlas({ base, onProgress: (m) => { boot.lastChild.textContent = m; } });
  } catch(e){
    boot.innerHTML = `<pre>${esc(e.message)}</pre>`;
    return;
  }

  // ---- state --------------------------------------------------------------
  const V = {
    x0: A.xExtent[0], ppy: 1, yTop: 0, yz: 1,
    W: 100, H: 100,
    collapsed: new Set(),
    pinned: [],
    query: '',
    topics: new Set(),
    datasets: new Set(),
    dimMode: true,
    railOpen: true,
    facetsOpen: false,
    selected: -1,
    hover: -1,
    selectedNode: null,
  };

  loadPrefs();

  let filter = null;
  let scale = null;
  let visible = [];
  let bands = [];
  let placements = [];
  let tier = 'dot';
  let depth = 1;
  let pins = { rows: [], height: 0 };
  let nodeCounts = null;

  // Reusable buffers for the spatial query, so a pan allocates nothing.
  const seen = new Int32Array(A.n);
  let stamp = 0;

  // ---- DOM ----------------------------------------------------------------
  const stage = $('stage');
  const surface = $('surface');
  const canvas = $('canvas');
  const pinWrap = $('pinWrap');
  const pinCanvas = $('pinCanvas');
  const rulerEl = $('ruler');
  const miniCanvas = $('miniCanvas');
  const miniWin = $('miniWin');
  const statusEl = $('status');
  const emptyEl = $('empty');
  const qInput = $('q');

  const cardLayer = createCardLayer(surface, { onOpen: (i) => select(i, { open: true }) });
  const tip = createTip(D.body);

  const detail = createDetail(stage, {
    onGoto: (j) => select(j, { open: true, center: true }),
    onTopic: (t) => { toggleTopic(t); },
    onNode: (id) => focusNode(id),
    onClose: () => { V.selected = -1; mark({ paint: true }); },
  });

  const rail = createRail($('railHost'), {
    onToggleCollapse: (id) => toggleCollapse(id),
    onTogglePin: (id) => togglePin(id),
    onSelectNode: (id) => focusNode(id),
    onExpandAll: () => { V.collapsed.clear(); mark({ paint: true, rail: true, prefs: true }); },
    onCollapseTop: () => {
      V.collapsed = new Set((A.byDepth[1] || []));
      mark({ paint: true, rail: true, prefs: true });
    },
  });

  // ---- scale segment ------------------------------------------------------
  $('scaleSeg').innerHTML = STOPS
    .map((s) => `<button data-stop="${s.key}">${s.label}</button>`).join('');

  // ---- sizing -------------------------------------------------------------
  function measure(){
    const r = surface.getBoundingClientRect();
    V.W = Math.max(50, Math.round(r.width));
    V.H = Math.max(50, Math.round(r.height));
  }

  // ---------------------------------------------------------------------------
  // The frame loop
  // ---------------------------------------------------------------------------

  const dirty = { data: true, paint: true, rail: true, facets: true, mini: true, prefs: false };
  let raf = 0;

  function mark(flags = {}){
    Object.assign(dirty, flags);
    if(!raf) raf = w.requestAnimationFrame(frame);
  }

  function frame(){
    raf = 0;

    if(dirty.data){
      filter = runFilter(A, {
        query: V.query, topics: V.topics, datasets: V.datasets, mode: V.dimMode ? 'dim' : 'hide',
      });
      nodeCounts = filter ? countByNode() : null;
      dirty.data = false;
      dirty.rail = true;
      dirty.mini = true;
      dirty.facets = true;
    }

    if(dirty.paint) paint();
    if(dirty.rail){
      rail.sync(A, {
        collapsed: V.collapsed, pinned: V.pinned, filter, depth,
        counts: nodeCounts, selectedNode: V.selectedNode,
      });
      dirty.rail = false;
    }
    if(dirty.facets){ renderFacets(); dirty.facets = false; }
    if(dirty.mini){ paintMini(); dirty.mini = false; }
    if(dirty.prefs){ savePrefs(); dirty.prefs = false; }
  }

  function paint(){
    dirty.paint = false;
    measure();

    // Pin strip first: it takes height from the map, so the map's scale depends
    // on it.
    pins = pinLayout(V.pinned, V.H);
    pinWrap.classList.toggle('on', pins.rows.length > 0);

    scale = makeScale(V);
    const t = ticks(scale);
    scale._ticks = t;

    // Visible set from the spatial grid. Widened slightly so a card anchored just
    // off screen still gets placed and does not pop in at the edge.
    stamp++;
    const padYears = 40 / scale.ppy;
    const padY = 30 / scale.pxPerY;
    A.grid.query(scale.x0 - padYears, scale.x1 + padYears,
                 Math.max(0, scale.yTop - padY), Math.min(1, scale.yBot + padY),
                 visible, seen, stamp);

    const prevDepth = depth;
    depth = depthFor(A, scale);
    // The rail renders the tree down to `depth`, so a zoom that changes the depth
    // must rebuild it. Without this the rail silently showed a stale level and only
    // caught up when some other action happened to set the flag.
    if(depth !== prevDepth) dirty.rail = true;
    bands = visibleBands(A, depth, V.collapsed);
    tier = tierFor(scale.ppy);

    const ctx = sizeCanvas(canvas, V.W, V.H);
    ctx.font = '11px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    const measureText = (s) => ctx.measureText(s).width;

    placements = packLabels(A, scale, visible, tier, {
      collapsed: V.collapsed,
      budget: tier === 'detail' ? 90 : tier === 'card' ? 200 : 320,
      measure: measureText,
    });

    paintFrame(ctx, A, scale, {
      bands, visible, filter, collapsed: V.collapsed, tier, placements,
      hover: V.hover, selected: V.selected, dimMode: V.dimMode, ticks: t,
    });

    cardLayer.sync(A, placements, {
      filter, dimMode: V.dimMode, selected: V.selected, hover: V.hover, details: A.details,
    });

    if(pins.rows.length){
      pinWrap.style.height = `${pins.height}px`;
      const pctx = sizeCanvas(pinCanvas, V.W, pins.height);
      paintPinStrip(pctx, A, scale, {
        rows: pins.rows, filter, collapsed: V.collapsed,
        dimMode: V.dimMode, hover: V.hover, selected: V.selected,
      });
    }
    // Outside the guard: when the last pin goes, the bar must empty too.
    $('pinBar').innerHTML = pins.rows
      .map((r) => `<button class="btn tiny" data-unpin="${r.id}" title="Unpin ${esc(A.nodes[r.id].label)}">✕</button>`)
      .join('');

    paintRuler(t);
    paintStatus();
    updateMiniWindow();

    const nMatch = filter ? filter.count : A.n;
    emptyEl.classList.toggle('on', nMatch === 0);
    $('count').textContent = filter
      ? `${nMatch.toLocaleString()} of ${A.n.toLocaleString()}`
      : `${A.n.toLocaleString()} entries`;

    for(const b of $('scaleSeg').children){
      const s = STOPS.find((x) => x.key === b.dataset.stop);
      b.classList.toggle('on', s && s.ppy != null && Math.abs(Math.log(scale.ppy / s.ppy)) < 0.28);
    }
    $('ppyLab').textContent = `${scale.ppy.toFixed(scale.ppy < 1 ? 2 : 1)} px/yr`;
    $('dimBtn').classList.toggle('on', V.dimMode);
    $('railBtn').classList.toggle('on', V.railOpen);
    $('facetBtn').classList.toggle('on', V.facetsOpen);
  }

  // ---- ruler --------------------------------------------------------------
  function paintRuler(t){
    rulerEl.innerHTML = t.list
      .filter((tk) => tk.px > -60 && tk.px < V.W + 40)
      .map((tk) => `<div class="tk${tk.major ? ' maj' : ''}" style="left:${Math.round(tk.px)}px">${fmtYear(tk.year)}</div>`)
      .join('');
  }

  // ---- status -------------------------------------------------------------
  function paintStatus(){
    const parts = [
      `${fmtRange(Math.round(scale.x0), Math.round(scale.x1))}`,
      `${visible.length} in view`,
      `L${depth}`,
      tier,
    ];
    if(placements.length) parts.push(`${placements.length} labelled`);
    if(V.collapsed.size) parts.push(`${V.collapsed.size} collapsed`);
    statusEl.textContent = parts.join('  ·  ');
  }

  // ---- minimap ------------------------------------------------------------
  /*
   * The overview is the whole atlas at once — every point, no filtering by
   * viewport. Cached to an offscreen canvas because it only changes when the
   * filter or collapse state does, not when the camera moves.
   */
  let miniCache = null;
  let miniKey = '';

  function paintMini(){
    const r = miniCanvas.getBoundingClientRect();
    const MW = Math.max(50, Math.round(r.width));
    const MH = Math.max(20, Math.round(r.height));
    const key = `${MW}x${MH}|${filter ? filter.count : -1}|${[...V.collapsed].sort().join(',')}`;

    if(key !== miniKey || !miniCache){
      miniKey = key;
      const off = D.createElement('canvas');
      const dpr = Math.min(w.devicePixelRatio || 1, 2);
      off.width = MW * dpr; off.height = MH * dpr;
      const c = off.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = COLORS.bgAlt;
      c.fillRect(0, 0, MW, MH);

      const [xa, xb] = A.xExtent;
      const sx = (y) => ((y - xa) / Math.max(1, xb - xa)) * MW;

      for(let i = 0; i < A.n; i++){
        if(V.collapsed.size && isHidden(A, i, V.collapsed)) continue;
        const matched = !filter || filter.flags[i];
        if(!matched && !V.dimMode) continue;
        c.fillStyle = matched ? A.color[i] : 'rgba(100,116,139,0.16)';
        c.globalAlpha = matched ? 0.75 : 1;
        c.fillRect(sx(A.x0[i]), A.y[i] * (MH - 2) + 1, 1, 1);
      }
      c.globalAlpha = 1;
      miniCache = off;
    }

    const ctx = sizeCanvas(miniCanvas, MW, MH);
    ctx.drawImage(miniCache, 0, 0, MW, MH);
  }

  function updateMiniWindow(){
    const r = miniCanvas.getBoundingClientRect();
    const MW = Math.max(1, r.width);
    const [xa, xb] = A.xExtent;
    const span = Math.max(1, xb - xa);
    const l = ((scale.x0 - xa) / span) * MW;
    const wd = ((scale.x1 - scale.x0) / span) * MW;
    miniWin.style.left = `${Math.max(0, l)}px`;
    miniWin.style.width = `${Math.max(2, Math.min(MW - Math.max(0, l), wd))}px`;
  }

  // ---- facets -------------------------------------------------------------
  function renderFacets(){
    if(!V.facetsOpen){ $('facets').classList.remove('on'); return; }
    $('facets').classList.add('on');

    const top = A.topicsByCount.slice(0, 34);
    $('facets').innerHTML =
      `<div class="facet"><label>Source</label>${A.datasets.map((d) =>
        `<button class="tag${V.datasets.has(d) ? ' on' : ''}" data-ds="${esc(d)}">${esc(d)}</button>`).join('')}</div>` +
      `<div class="facet"><label>Topic</label>${top.map(([t, n]) =>
        `<button class="tag${V.topics.has(t) ? ' on' : ''}" data-topic="${esc(t)}">${esc(t)} <span style="opacity:.55">${n}</span></button>`).join('')}` +
      `${V.topics.size || V.datasets.size ? '<button class="tag" data-clearfacets="1">clear</button>' : ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function countByNode(){
    const counts = new Map();
    for(let i = 0; i < A.n; i++){
      if(!filter.flags[i]) continue;
      for(const id of A.chainOf.get(A.leaf[i]) || []) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }

  function select(i, { open = false, center = false } = {}){
    V.selected = i;
    V.selectedNode = i >= 0 ? A.leaf[i] : null;
    if(center && i >= 0) centerOn(i);
    if(open && i >= 0){
      detail.open(A, i);
      A.detailsPromise?.then(() => detail.refresh());
    }
    mark({ paint: true, rail: true });
  }

  function centerOn(i){
    const yearsVisible = V.W / V.ppy;
    V.x0 = A.x0[i] - yearsVisible / 2;
    const yVisible = 1 / V.yz;
    V.yTop = A.y[i] - yVisible / 2;
    Object.assign(V, clampView(V, A.xExtent));
  }

  /** Zoom and pan so a cluster fills the view. */
  function focusNode(id){
    const nd = A.nodes[id];
    if(!nd) return;
    V.selectedNode = id;

    const span = Math.max(1, nd.x1 - nd.x0);
    V.ppy = clamp((V.W * 0.86) / span, PPY_MIN, PPY_MAX);
    V.x0 = nd.x0 - (V.W / V.ppy - span) / 2;

    // Fit the band vertically with a little air, rather than adopting the coupled
    // zoom — the point of clicking a cluster is to see that cluster.
    const bandSpan = Math.max(1e-4, nd.y1 - nd.y0);
    V.yz = clamp(1 / (bandSpan * 1.35), 1, 900);
    V.yTop = nd.y0 - (1 / V.yz - bandSpan) / 2;

    Object.assign(V, clampView(V, A.xExtent));
    mark({ paint: true, rail: true, prefs: true });
  }

  function toggleCollapse(id){
    if(V.collapsed.has(id)) V.collapsed.delete(id);
    else {
      V.collapsed.add(id);
      // Collapsing an ancestor makes any collapsed descendant redundant.
      for(const other of [...V.collapsed]){
        if(other !== id && A.ancestorsOf(other).includes(id)) V.collapsed.delete(other);
      }
    }
    mark({ paint: true, rail: true, mini: true, prefs: true });
  }

  function togglePin(id){
    const k = V.pinned.indexOf(id);
    if(k >= 0) V.pinned.splice(k, 1);
    else if(V.pinned.length < 6) V.pinned.push(id);
    mark({ paint: true, rail: true, prefs: true });
  }

  function toggleTopic(t){
    if(V.topics.has(t)) V.topics.delete(t);
    else V.topics.add(t);
    mark({ data: true, paint: true });
  }

  function setQuery(s){
    V.query = s;
    qInput.value = s;
    qInput.parentElement.classList.toggle('filled', !!s);
    mark({ data: true, paint: true });
  }

  function fit(){
    measure();
    Object.assign(V, fitView({ extent: A.xExtent, W: V.W, H: V.H }));
    mark({ paint: true, prefs: true });
  }

  function zoom(factor, px = V.W / 2, py = V.H / 2, opts){
    Object.assign(V, clampView(zoomAt(V, factor, px, py, opts), A.xExtent));
    mark({ paint: true, prefs: true });
  }

  function gotoStop(key){
    const s = STOPS.find((x) => x.key === key);
    if(!s) return;
    if(s.ppy == null){ fit(); return; }
    const mid = scale ? (scale.x0 + scale.x1) / 2 : A.xExtent[0];
    V.ppy = s.ppy;
    V.yz = coupledYZoom(s.ppy);
    V.x0 = mid - (V.W / V.ppy) / 2;
    Object.assign(V, clampView(V, A.xExtent));
    mark({ paint: true, prefs: true });
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  // ---- wheel --------------------------------------------------------------
  surface.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = surface.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    if(e.shiftKey){
      V.x0 += (e.deltaY + e.deltaX) / V.ppy;
      Object.assign(V, clampView(V, A.xExtent));
      mark({ paint: true, prefs: true });
      return;
    }

    // A trackpad pinch arrives as a wheel event with ctrlKey set; treat it as the
    // zoom it is, at the same sensitivity as a mouse wheel.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const d = e.deltaY * unit;
    const factor = Math.exp(-d * 0.0022);
    zoom(factor, px, py, { yOnly: e.altKey });
  }, { passive: false });

  // ---- drag ---------------------------------------------------------------
  let drag = null;

  surface.addEventListener('pointerdown', (e) => {
    if(e.button !== 0) return;
    const r = surface.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      sx: e.clientX, sy: e.clientY,
      px: e.clientX - r.left, py: e.clientY - r.top,
      x0: V.x0, yTop: V.yTop,
      moved: false,
    };
    // Throws NotFoundError if the pointer is already gone — which happens with
    // synthetic events and with a fast click where up precedes this handler.
    try { surface.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });

  surface.addEventListener('pointermove', (e) => {
    const r = surface.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    if(drag && drag.id === e.pointerId){
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if(!drag.moved && Math.abs(dx) + Math.abs(dy) > 3){
        drag.moved = true;
        surface.classList.add('dragging');
        tip.hide();
      }
      if(drag.moved){
        V.x0 = drag.x0 - dx / scale.ppy;
        V.yTop = drag.yTop - dy / scale.pxPerY;
        Object.assign(V, clampView(V, A.xExtent));
        mark({ paint: true });
      }
      return;
    }

    // Hover. The spatial query already ran this frame, so this is a scan over
    // what is on screen, not over the corpus.
    const i = hitTest(A, scale, visible, placements, px, py, { collapsed: V.collapsed });
    if(i !== V.hover){
      V.hover = i;
      mark({ paint: true });
    }
    if(i >= 0){
      tip.show(A, i, e.clientX, e.clientY, {
        details: A.details, cluster: A.nodes[A.leaf[i]]?.label,
      });
    } else {
      tip.hide();
    }
  });

  surface.addEventListener('pointerup', (e) => {
    if(!drag || drag.id !== e.pointerId) return;
    const wasDrag = drag.moved;
    surface.classList.remove('dragging');
    try { surface.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    drag = null;
    if(wasDrag){ mark({ prefs: true }); return; }

    const r = surface.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    const i = hitTest(A, scale, visible, placements, px, py, { collapsed: V.collapsed });
    if(i >= 0){ select(i, { open: true }); return; }

    // Clicking a band's label collapses it; clicking empty band space selects it
    // in the rail, which is the least surprising split of the two intents.
    const nd = bandAt(bands, scale, py);
    if(nd){
      if(px < 190 && py - scale.sy(nd.y0) < 18) toggleCollapse(nd.id);
      else { V.selectedNode = nd.id; mark({ rail: true, paint: true }); }
    }
  });

  surface.addEventListener('pointerleave', () => { tip.hide(); if(V.hover !== -1){ V.hover = -1; mark({ paint: true }); } });

  surface.addEventListener('dblclick', (e) => {
    const r = surface.getBoundingClientRect();
    zoom(2.4, e.clientX - r.left, e.clientY - r.top);
  });

  // ---- pin strip ----------------------------------------------------------
  pinCanvas.addEventListener('pointermove', (e) => {
    const r = pinCanvas.getBoundingClientRect();
    const i = pinHitTest(A, scale, pins.rows, e.clientX - r.left, e.clientY - r.top, { collapsed: V.collapsed });
    if(i !== V.hover){ V.hover = i; mark({ paint: true }); }
    if(i >= 0) tip.show(A, i, e.clientX, e.clientY, { details: A.details, cluster: A.nodes[A.leaf[i]]?.label });
    else tip.hide();
  });
  pinCanvas.addEventListener('pointerleave', () => { tip.hide(); });
  pinCanvas.addEventListener('click', (e) => {
    const r = pinCanvas.getBoundingClientRect();
    const i = pinHitTest(A, scale, pins.rows, e.clientX - r.left, e.clientY - r.top, { collapsed: V.collapsed });
    if(i >= 0) select(i, { open: true });
    else {
      const row = pinRowAt(pins.rows, e.clientY - r.top);
      if(row) focusNode(row.id);
    }
  });

  $('pinBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpin]');
    if(b){ e.stopPropagation(); togglePin(Number(b.dataset.unpin)); }
  });

  // ---- minimap ------------------------------------------------------------
  let miniDrag = false;

  function miniJump(clientX){
    const r = miniCanvas.getBoundingClientRect();
    const f = clamp((clientX - r.left) / r.width, 0, 1);
    const [xa, xb] = A.xExtent;
    const year = xa + f * (xb - xa);
    V.x0 = year - (V.W / V.ppy) / 2;
    Object.assign(V, clampView(V, A.xExtent));
    mark({ paint: true, prefs: true });
  }

  miniCanvas.addEventListener('pointerdown', (e) => { miniDrag = true; miniJump(e.clientX); });
  miniCanvas.addEventListener('pointermove', (e) => { if(miniDrag) miniJump(e.clientX); });
  w.addEventListener('pointerup', () => { miniDrag = false; });
  miniCanvas.addEventListener('dblclick', fit);

  // ---- toolbar ------------------------------------------------------------
  $('scaleSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stop]');
    if(b) gotoStop(b.dataset.stop);
  });
  $('zoomIn').onclick = () => zoom(1.7);
  $('zoomOut').onclick = () => zoom(1 / 1.7);
  $('fitBtn').onclick = fit;
  $('dimBtn').onclick = () => { V.dimMode = !V.dimMode; mark({ paint: true, mini: true, prefs: true }); };
  $('railBtn').onclick = () => {
    V.railOpen = !V.railOpen;
    rail.el.classList.toggle('hidden', !V.railOpen);
    mark({ paint: true, prefs: true });
  };
  $('facetBtn').onclick = () => { V.facetsOpen = !V.facetsOpen; mark({ facets: true, paint: true, prefs: true }); };
  $('helpBtn').onclick = () => $('help').classList.add('on');
  $('help').onclick = () => $('help').classList.remove('on');

  $('facets').addEventListener('click', (e) => {
    const t = e.target.closest('[data-topic]');
    if(t){ toggleTopic(t.dataset.topic); return; }
    const d = e.target.closest('[data-ds]');
    if(d){
      const k = d.dataset.ds;
      if(V.datasets.has(k)) V.datasets.delete(k); else V.datasets.add(k);
      mark({ data: true, paint: true });
      return;
    }
    if(e.target.closest('[data-clearfacets]')){
      V.topics.clear(); V.datasets.clear();
      mark({ data: true, paint: true });
    }
  });

  let qTimer = 0;
  qInput.addEventListener('input', () => {
    // Debounced: the filter is a full pass over the corpus and there is no value
    // in running it between keystrokes.
    //
    // `w.setTimeout`, not the bare global. This module executes in the OPENER's
    // realm, and a backgrounded tab has its timers throttled to about a second —
    // the opener is backgrounded the whole time you are looking at the atlas, so
    // using its timers made every keystroke land a second late.
    w.clearTimeout(qTimer);
    qTimer = w.setTimeout(() => setQuery(qInput.value), 110);
  });
  D.querySelector('.searchbox .clear').onclick = () => setQuery('');

  // ---- keyboard -----------------------------------------------------------
  D.addEventListener('keydown', (e) => {
    const typing = e.target === qInput;

    if(e.key === 'Escape'){
      if($('help').classList.contains('on')) $('help').classList.remove('on');
      else if(detail.boxOpen()) detail.closeBox();
      else if(typing && qInput.value){ setQuery(''); }
      else if(detail.isOpen) detail.close();
      else if(typing) qInput.blur();
      return;
    }

    if(typing) return;

    const step = e.shiftKey ? 0.42 : 0.12;

    switch(e.key){
      case '/': e.preventDefault(); qInput.focus(); qInput.select(); return;
      case '?': $('help').classList.toggle('on'); return;
      case '0': fit(); return;
      case '+': case '=': zoom(1.7); return;
      case '-': case '_': zoom(1 / 1.7); return;
      case 'r': $('railBtn').onclick(); return;
      case 'f': $('facetBtn').onclick(); return;
      case 'd': $('dimBtn').onclick(); return;
      case 'ArrowLeft':  e.preventDefault(); V.x0 -= (V.W * step) / V.ppy; break;
      case 'ArrowRight': e.preventDefault(); V.x0 += (V.W * step) / V.ppy; break;
      case 'ArrowUp':    e.preventDefault(); V.yTop -= (V.H * step) / scale.pxPerY; break;
      case 'ArrowDown':  e.preventDefault(); V.yTop += (V.H * step) / scale.pxPerY; break;
      case 'c':
        if(V.selected >= 0) toggleCollapse(A.leaf[V.selected]);
        else if(V.selectedNode != null) toggleCollapse(V.selectedNode);
        return;
      case 'p':
        if(V.selectedNode != null) togglePin(V.selectedNode);
        else if(V.selected >= 0) togglePin(A.leaf[V.selected]);
        return;
      case 'j': case 'k': {
        if(V.selected < 0) return;
        const nb = A.knn[V.selected] || [];
        if(!nb.length) return;
        const cur = nb.indexOf(V.hover);
        const idx = e.key === 'j'
          ? (cur + 1) % nb.length
          : (cur - 1 + nb.length) % nb.length;
        select(nb[idx], { open: true, center: true });
        return;
      }
      default: return;
    }

    Object.assign(V, clampView(V, A.xExtent));
    mark({ paint: true, prefs: true });
  });

  // ---- resize -------------------------------------------------------------
  let rTimer = 0;
  w.addEventListener('resize', () => {
    w.clearTimeout(rTimer);                      // the atlas window's timer, not the opener's
    rTimer = w.setTimeout(() => { miniCache = null; mark({ paint: true, mini: true }); }, 60);
  });

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  /*
   * Persisted so reopening the atlas puts you back where you were. This is also
   * the reason a test run can look wrong for no apparent reason — see the note in
   * ATLAS.md. `Reset view` is the Fit button plus Expand all.
   */
  function savePrefs(){
    try {
      w.localStorage.setItem(PREFS_KEY, JSON.stringify({
        x0: V.x0, ppy: V.ppy, yTop: V.yTop, yz: V.yz,
        collapsed: [...V.collapsed], pinned: V.pinned,
        dimMode: V.dimMode, railOpen: V.railOpen, facetsOpen: V.facetsOpen,
      }));
    } catch { /* private mode, or a full quota — not worth failing over */ }
  }

  function loadPrefs(){
    try {
      const p = JSON.parse(w.localStorage.getItem(PREFS_KEY) || 'null');
      if(!p) return;
      if(Number.isFinite(p.x0)) V.x0 = p.x0;
      if(Number.isFinite(p.ppy)) V.ppy = clamp(p.ppy, PPY_MIN, PPY_MAX);
      if(Number.isFinite(p.yTop)) V.yTop = p.yTop;
      if(Number.isFinite(p.yz)) V.yz = p.yz;
      // Node ids are only meaningful for the tree that produced them. A rebuild
      // renumbers, so drop anything out of range rather than pinning nonsense.
      V.collapsed = new Set((p.collapsed || []).filter((id) => A.nodes[id]));
      V.pinned = (p.pinned || []).filter((id) => A.nodes[id]).slice(0, 6);
      V.dimMode = p.dimMode !== false;
      V.railOpen = p.railOpen !== false;
      V.facetsOpen = !!p.facetsOpen;
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------

  rail.el.classList.toggle('hidden', !V.railOpen);
  measure();

  // A fresh visitor gets the whole atlas; a returning one gets their camera back.
  if(V.ppy === 1 && V.x0 === A.xExtent[0]) Object.assign(V, fitView({ extent: A.xExtent, W: V.W, H: V.H }));

  boot.classList.add('gone');
  $('app').style.visibility = 'visible';

  mark({ data: true, paint: true, rail: true, facets: true, mini: true });

  /*
   * A debug handle on the atlas window. `datasets/qa-atlas.mjs` drives the view
   * through this: a headless test cannot meaningfully "zoom into a dense region"
   * by dispatching wheel events at guessed coordinates, because on a scatter plot
   * most coordinates are empty space and the test then measures an empty screen.
   */
  w.__atlas = {
    get atlas(){ return A; },
    get view(){ return V; },
    get scale(){ return scale; },
    get visible(){ return visible; },
    get placements(){ return placements; },
    get filter(){ return filter; },
    get tier(){ return tier; },
    get depth(){ return depth; },
    select, focusNode, fit, zoom, setQuery, toggleCollapse, togglePin,
    mark,
    /** Park the camera on a point at a given zoom, for reproducible tests. */
    goto(i, ppy = 40){
      V.ppy = clamp(ppy, PPY_MIN, PPY_MAX);
      V.yz = coupledYZoom(V.ppy);
      centerOn(i);
      mark({ paint: true });
    },
  };

  // Repaint once excerpts land, so detail cards and previews fill in.
  A.detailsPromise?.then(() => { detail.refresh(); mark({ paint: true }); });

  return { window: w, atlas: A, view: V };
}
