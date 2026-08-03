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
  makeScale, zoomAt, clampView, fitView, tierFor, depthFor, ticks, collapsedRanges,
  MODES, DEFAULT_MODE, modeOf, widerMode, domainFor, ppyRange, atEdge, stopsFor,
  coupledYZoom, clamp, fmtYear, fmtTick, fmtTickRange,
} from './scales.js';
import {
  sizeCanvas, paintFrame, packLabels, visibleBands, hitTest, bandAt, isHidden,
  COLORS, setCanvasTheme,
} from './paint.js';
import { createCardLayer, createTip, esc } from './cards.js';
import { createDetail } from './detail.js';
import { createRail, pinLayout, paintPinStrip, pinHitTest, pinRowAt, membersOf } from './rail.js';
import { CSS } from './styles.js';

const PREFS_KEY = 'atlas:prefs:v1';

const SHELL = (base, css, theme) => `<!DOCTYPE html>
<html lang="en" data-theme="${theme}"><head><meta charset="UTF-8">
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
      <div class="seg" id="modeSeg"></div>
      <div class="seg" id="scaleSeg"></div>
      <div class="grp spacer">
        <div class="seg" id="axisSeg" title="Which axis the zoom controls move"></div>
        <button class="btn icon" id="zoomOut" title="Zoom out (&minus;)">&minus;</button>
        <span id="ppyLab"></span>
        <button class="btn icon" id="zoomIn" title="Zoom in (+)">+</button>
        <button class="btn" id="fitBtn" title="Fit everything (0)">Fit</button>
        <button class="btn" id="dimBtn" title="Dim non-matches instead of hiding them">Dim</button>
        <button class="btn" id="railBtn" title="Collapse the cluster sidebar (r)">Rail</button>
        <button class="btn" id="facetBtn" title="Toggle topic filters (f)">Topics</button>
        <button class="btn icon" id="themeBtn" title="Light / dark theme (t)">&#9683;</button>
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
    <dt>scroll / two fingers</dt><dd>pan</dd>
    <dt>pinch</dt><dd>zoom at the cursor</dd>
    <dt>&#8963; + wheel</dt><dd>zoom at the cursor, with a mouse</dd>
    <dt>&#8997; + wheel</dt><dd>zoom the topic axis only</dd>
    <dt>&#8679; + pinch</dt><dd>zoom the time axis only</dd>
    <dt>&#8660;&#8661; &#8660; &#8661;</dt><dd>which axis the &plus;&thinsp;&minus; controls zoom</dd>
    <dt>&#8679; + wheel</dt><dd>pan through time</dd>
    <dt>drag</dt><dd>pan</dd>
    <dt>&larr; &rarr; &uarr; &darr;</dt><dd>pan &middot; hold &#8679; for a bigger step</dd>
    <dt>click</dt><dd>open an entry &middot; click a band label to fold the cluster away</dd>
    <dt>hover</dt><dd>preview, at any zoom</dd>
    <dt>/</dt><dd>search</dd>
    <dt>0</dt><dd>fit the whole time range</dd>
    <dt>+ &minus;</dt><dd>zoom</dd>
    <dt>m</dt><dd>cycle time range &mdash; civilization, humans, Earth</dd>
    <dt>r &middot; f &middot; t</dt><dd>sidebar &middot; topic filters &middot; theme</dd>
    <dt>c &middot; p</dt><dd>collapse &middot; pin the selected entry's cluster</dd>
    <dt>j &middot; k</dt><dd>next / previous nearest neighbour</dd>
    <dt>Esc</dt><dd>close, or clear the search</dd>
  </dl>
  <div class="note">
    Horizontal is time, linear. Vertical is position in embedding space: entries near
    each other are about similar things, and colour follows the same ordering, so a
    band of one hue is one family of subjects. Zooming vertically walks down the
    cluster hierarchy. Folding a cluster squeezes it to a thin strip and gives its
    height back to everything else, at every zoom.
  </div>
  <div class="note">
    The three time ranges pick how far back the axis reaches &mdash; 3000&nbsp;BC,
    300,000 years, or the whole 4.54 billion. Each one stays strictly linear, so
    empty stretches read as the real gaps they are; only the far edge moves. A range
    that leaves entries behind its left edge says how many in the status line.
  </div>
</div></div>
</body></html>`;

export async function openAtlas({ title = 'Atlas' } = {}){
  const base = location.href.replace(/[^/]*$/, '');
  const w = window.open('', 'atlas');
  if(!w){ alert('Allow pop-ups to open the atlas.'); return; }

  /*
   * The theme has to be known before the document is written, or the window
   * flashes the default theme's background while the atlas loads. Prefs are read
   * twice for that reason: once here from raw localStorage, and again in
   * `loadPrefs()` once the atlas is parsed and node ids can be validated.
   */
  const theme = readTheme(w);
  setCanvasTheme(theme);

  w.document.open();
  w.document.write(SHELL(base, CSS, theme));
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
    x0: 0, ppy: 1, yTop: 0, yz: 1,
    W: 100, H: 100,
    // Which slice of time the x axis covers. `domain` is derived from `mode` plus
    // the data extent; always go through `setMode()` rather than setting either.
    mode: DEFAULT_MODE,
    domain: domainFor(DEFAULT_MODE, A.xExtent),
    theme,
    // Which axis the zoom controls drive: 'both', 'x' (time) or 'y' (topics).
    zoomAxis: 'both',
    collapsed: new Set(),
    // The collapsed set, reduced to the non-nested y ranges `makeScale` warps by.
    // Derived state: always go through `syncFolds()`, never assign it directly.
    folded: [],
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

  // Whether the camera is still at its defaults, so boot knows to fit. Was a float
  // comparison against the extent's left edge, which is not a state any more now
  // that the left edge depends on the mode.
  let freshCamera = true;

  loadPrefs();
  syncFolds();

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
    onExpandAll: () => {
      V.collapsed.clear();
      syncFolds();
      mark({ paint: true, rail: true, mini: true, prefs: true });
    },
    onCollapseTop: () => {
      V.collapsed = new Set((A.byDepth[1] || []));
      syncFolds();
      mark({ paint: true, rail: true, mini: true, prefs: true });
    },
    onFold: () => { $('railBtn').onclick(); },
  });

  // ---- mode + scale segments ----------------------------------------------
  /*
   * The mode segment is fixed; the scale ladder is rebuilt on every mode change,
   * because "Centuries" is a useful stop in a 5,000-year domain and a meaningless
   * one in a 4.54-billion-year domain.
   */
  $('modeSeg').innerHTML = MODES
    .map((m) => `<button data-mode="${m.key}" title="${esc(m.title)}">${esc(m.label)}</button>`)
    .join('');

  function renderStops(){
    $('scaleSeg').innerHTML = stopsFor(V.mode)
      .map((s) => `<button data-stop="${s.key}">${s.label}</button>`).join('');
  }
  renderStops();

  /*
   * The zoom axis.
   *
   * Both axes were always zoomable apart — `zoomAt` has taken `xOnly`/`yOnly`
   * since it was written — but the only way in was alt+wheel, listed in the help
   * panel and therefore invisible. This scopes the ordinary controls to one axis
   * instead. Switching back to Both re-couples y to x, which is the way out.
   *
   * Not persisted: a sticky zoom mode is exactly the kind of leaked pref that made
   * the QA suite fail against a view nobody had set (see ATLAS.md).
   */
  const AXES = [
    { key: 'both', label: '&#8660;&#8661;', title: 'Zoom both axes together' },
    { key: 'x',    label: '&#8660;',        title: 'Zoom time only — a wider or narrower span of years, topics unchanged' },
    { key: 'y',    label: '&#8661;',        title: 'Zoom topics only — more or less of the cluster tree, years unchanged' },
  ];
  $('axisSeg').innerHTML = AXES
    .map((a) => `<button data-axis="${a.key}" title="${esc(a.title)}">${a.label}</button>`)
    .join('');

  /** The `xOnly`/`yOnly` pair the current axis setting implies. */
  const axisOpts = () => ({ xOnly: V.zoomAxis === 'x', yOnly: V.zoomAxis === 'y' });

  function setZoomAxis(key){
    V.zoomAxis = AXES.some((a) => a.key === key) ? key : 'both';
    mark({ paint: true });
  }

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
    //
    // The grid is keyed on ATLAS y, while the camera lives in layout y, so the
    // bounds have to be unwarped. A folded range unwarps to its full original
    // span, which over-selects — those points are then dropped by `isHidden`, so
    // the only cost is a slightly longer visible list while a fold is on screen.
    stamp++;
    const padYears = 40 / scale.ppy;
    const padY = 30 / scale.pxPerY;
    A.grid.query(scale.x0 - padYears, scale.x1 + padYears,
                 scale.unwarpY(Math.max(0, scale.yTop - padY)),
                 scale.unwarpY(Math.min(1, scale.yBot + padY)),
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

    const stops = stopsFor(V.mode);
    const edge = atEdge(V);
    for(const b of $('scaleSeg').children){
      const s = stops.find((x) => x.key === b.dataset.stop);
      b.classList.toggle('on', s
        ? (s.ppy == null ? edge : Math.abs(Math.log(scale.ppy / s.ppy)) < 0.28)
        : false);
    }
    /*
     * The wider mode's button lights up once you are pulled back to this mode's
     * edge. The switch stays manual on purpose — an automatic flip changes the
     * meaning of the whole axis under you, and you cannot tell whether you zoomed
     * or the map did.
     */
    const wider = widerMode(V.mode);
    for(const b of $('modeSeg').children){
      b.classList.toggle('on', b.dataset.mode === V.mode);
      b.classList.toggle('edge', edge && !!wider && b.dataset.mode === wider.key);
    }
    for(const b of $('axisSeg').children){
      b.classList.toggle('on', b.dataset.axis === V.zoomAxis);
    }
    $('ppyLab').textContent = ppyLabel(scale.ppy);
    $('dimBtn').classList.toggle('on', V.dimMode);
    $('railBtn').classList.toggle('on', V.railOpen);
    $('facetBtn').classList.toggle('on', V.facetsOpen);
  }

  /**
   * Recompute the fold ranges the y warp is built from.
   *
   * Called by everything that touches `V.collapsed`, and not from `paint()`: the
   * camera reads `V.folded` in `zoomAt`/`centerOn`, which can run before the next
   * frame, so it has to be correct the moment the collapse happens.
   */
  function syncFolds(){
    V.folded = collapsedRanges(A, V.collapsed);
  }

  /*
   * The year at the centre of the viewport, from the camera rather than from the
   * painted `scale`.
   *
   * `scale` is rebuilt in `paint()`, i.e. on the next animation frame, so two
   * camera actions in the same tick — set the mode, then jump to a stop — had the
   * second one reading the first one's stale geometry and computing a centre from
   * the mode it had just left. That put a Civilization-mode jump 2.2 billion years
   * out and it clamped to the left edge. `V` is always current.
   */
  const midYear = () => V.x0 + (V.W / V.ppy) / 2;

  // ---- ruler --------------------------------------------------------------
  function paintRuler(t){
    rulerEl.innerHTML = t.list
      .filter((tk) => tk.px > -60 && tk.px < V.W + 40)
      .map((tk) => `<div class="tk${tk.major ? ' maj' : ''}" style="left:${Math.round(tk.px)}px">${fmtTick(tk.year, t.step)}</div>`)
      .join('');
  }

  /*
   * "0.00 px/yr" is what the old label said for every zoom in Earth mode. Below a
   * hundredth of a pixel per year the reciprocal is the number that means
   * something.
   */
  function ppyLabel(ppy){
    if(ppy >= 0.01) return `${ppy.toFixed(ppy < 1 ? 2 : 1)} px/yr`;
    const ypp = 1 / ppy;
    if(ypp >= 1e6) return `${(ypp / 1e6).toFixed(ypp >= 1e7 ? 0 : 1)} Myr/px`;
    if(ypp >= 1e3) return `${(ypp / 1e3).toFixed(ypp >= 1e4 ? 0 : 1)} kyr/px`;
    return `${Math.round(ypp)} yr/px`;
  }

  // ---- status -------------------------------------------------------------
  /*
   * How many entries the current mode puts out of reach. Silent truncation would
   * read as "that is all there is", which for a mode whose whole job is to leave
   * deep time out would be a lie. Cached per mode; the answer only changes when
   * the corpus does.
   */
  const outsideCache = new Map();

  function outsideCount(){
    const key = V.mode;
    if(outsideCache.has(key)) return outsideCache.get(key);
    const lo = V.domain[0];
    let n = 0;
    // A span counts as reachable if any part of it is: an entry running from
    // 4000 BC to 2000 BC is visible in Civilization mode.
    for(let i = 0; i < A.n; i++) if(A.x1[i] < lo) n++;
    outsideCache.set(key, n);
    return n;
  }

  function paintStatus(){
    const step = scale._ticks ? scale._ticks.step : 1;
    const parts = [
      fmtTickRange(Math.round(scale.x0), Math.round(scale.x1), step),
      `${visible.length} in view`,
      `L${depth}`,
      tier,
    ];
    if(placements.length) parts.push(`${placements.length} labelled`);
    if(V.collapsed.size) parts.push(`${V.collapsed.size} collapsed`);
    const out = outsideCount();
    if(out) parts.push(`${out} before ${fmtYear(V.domain[0])}`);
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
    // The mode is part of the key: the overview spans the active domain, so a mode
    // change invalidates the bitmap even though nothing about the data moved.
    const key = `${MW}x${MH}|${V.mode}|${filter ? filter.count : -1}|${[...V.collapsed].sort().join(',')}`;

    if(key !== miniKey || !miniCache){
      miniKey = key;
      const off = D.createElement('canvas');
      const dpr = Math.min(w.devicePixelRatio || 1, 2);
      off.width = MW * dpr; off.height = MH * dpr;
      const c = off.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = COLORS.bgAlt;
      c.fillRect(0, 0, MW, MH);

      const [xa, xb] = V.domain;
      const sx = (y) => ((y - xa) / Math.max(1, xb - xa)) * MW;

      for(let i = 0; i < A.n; i++){
        if(A.x1[i] < xa) continue;                 // out of this mode's reach
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
    const [xa, xb] = V.domain;
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
    // yTop is layout y, the point's own y is atlas y.
    V.yTop = makeScale(V).warpY(A.y[i]) - (1 / V.yz) / 2;
    Object.assign(V, clampView(V));
  }

  /** Zoom and pan so a cluster fills the view. */
  function focusNode(id){
    const nd = A.nodes[id];
    if(!nd) return;
    V.selectedNode = id;

    const span = Math.max(1, nd.x1 - nd.x0);
    V.ppy = clamp((V.W * 0.86) / span, ...ppyRange(V));
    V.x0 = nd.x0 - (V.W / V.ppy - span) / 2;

    if(V.collapsed.has(id)){
      // A folded cluster is a fixed-height strip whose layout span shrinks as you
      // zoom in, so "fit it to the viewport" has no solution. Centre it instead
      // and leave the zoom alone; the label is right there to unfold it.
      const s = makeScale(V);
      V.yTop = (s.warpY(nd.y0) + s.warpY(nd.y1)) / 2 - (1 / V.yz) / 2;
    } else {
      // Fit the band vertically with a little air, rather than adopting the coupled
      // zoom — the point of clicking a cluster is to see that cluster.
      //
      // Twice, because the warp's strip widths depend on the y zoom: measure the
      // band, pick a zoom, then re-measure under the warp that zoom implies. The
      // second pass moves things by a pixel or two and the third by nothing.
      for(let pass = 0; pass < 2; pass++){
        const s = makeScale(V);
        const top = s.warpY(nd.y0);
        const bandSpan = Math.max(1e-4, s.warpY(nd.y1) - top);
        V.yz = clamp(1 / (bandSpan * 1.35), 1, 900);
        V.yTop = top - (1 / V.yz - bandSpan) / 2;
      }
    }

    Object.assign(V, clampView(V));
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
    syncFolds();
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

  /*
   * Switch theme. The DOM half is one attribute — `styles.js` has no literal
   * colours below `:root`, so the whole stylesheet follows. The canvas cannot read
   * CSS variables, so `setCanvasTheme` swaps the matching palette in `paint.js`,
   * and the minimap's offscreen cache has to be dropped or the old background
   * survives as a stale bitmap.
   */
  function setTheme(name){
    V.theme = name === 'dark' ? 'dark' : 'light';
    D.documentElement.dataset.theme = V.theme;
    setCanvasTheme(V.theme);
    // The button shows the theme it will switch TO, which is the only reading of a
    // single icon that is not ambiguous.
    $('themeBtn').innerHTML = V.theme === 'light' ? '&#9790;' : '&#9788;';
    $('themeBtn').title = V.theme === 'light' ? 'Dark theme (t)' : 'Light theme (t)';
    miniCache = null;
    mark({ paint: true, mini: true, prefs: true });
  }

  /** Fit the active mode's whole domain. */
  function fit(){
    measure();
    Object.assign(V, fitView({ mode: V.mode, domain: V.domain, W: V.W, H: V.H }));
    mark({ paint: true, prefs: true });
  }

  function zoom(factor, px = V.W / 2, py = V.H / 2, opts){
    Object.assign(V, clampView(zoomAt(V, factor, px, py, opts)));
    mark({ paint: true, prefs: true });
  }

  /*
   * Change how deep the axis runs.
   *
   * The camera is kept where it was, except when you were already pulled all the
   * way back — then the new mode is fitted. Those are the two reasons anyone
   * touches this control: "I hit the edge, give me more time" wants the wider
   * scale on screen, and "I am reading 1750 and want the other ladder" wants to
   * stay in 1750. Fitting unconditionally would throw away the second, and never
   * fitting would make the first look like nothing happened, because five thousand
   * years is invisible inside four billion either way.
   */
  function setMode(key){
    const m = modeOf(key);
    if(m.key === V.mode) return;
    measure();
    const wasFit = atEdge(V);
    const mid = midYear();

    V.mode = m.key;
    V.domain = domainFor(m.key, A.xExtent);
    renderStops();

    if(wasFit){
      Object.assign(V, fitView({ mode: V.mode, domain: V.domain, W: V.W, H: V.H }));
    } else {
      V.x0 = mid - (V.W / V.ppy) / 2;
      Object.assign(V, clampView(V));
    }
    miniCache = null;
    mark({ paint: true, mini: true, prefs: true });
  }

  function gotoStop(key){
    const s = stopsFor(V.mode).find((x) => x.key === key);
    if(!s) return;
    if(s.ppy == null){ fit(); return; }
    const mid = midYear();
    V.ppy = s.ppy;
    V.yz = coupledYZoom(s.ppy);
    V.x0 = mid - (V.W / V.ppy) / 2;
    Object.assign(V, clampView(V));
    mark({ paint: true, prefs: true });
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  // ---- wheel --------------------------------------------------------------
  /*
   * A SCROLL PANS. A PINCH ZOOMS. Those are two different gestures and the atlas
   * used to treat both as zoom, so a two-finger scroll — the way you move around
   * every other map — flew you in and out instead.
   *
   * The browser hands both to `wheel`. The only thing separating them is that a
   * trackpad pinch (and a ctrl-held mouse wheel, which is the same intent) arrives
   * with `ctrlKey` set, synthetically and regardless of whether ctrl is down. That
   * flag is the whole discrimination, so:
   *
   *   plain           pan, both axes, 1 px of delta to 1 px of movement
   *   shift           pan through time — a mouse wheel has no deltaX
   *   ctrl / cmd      zoom at the cursor (pinch, or a mouse wheel held with ctrl)
   *   alt             zoom the topic axis only
   *   shift + pinch   zoom time only
   *
   * The last two override the toolbar's axis setting rather than combining with
   * it. A modifier held down is a statement about this gesture, and a gesture that
   * did something different depending on a control elsewhere in the window would
   * be the worst of both — so an unmodified zoom follows the toolbar, and a
   * modified one means exactly what it says.
   *
   * Pinch deltas are much smaller per event than a wheel notch and arrive in long
   * streams, hence the separate ZOOM_RATE — it is the one number to tune here if
   * pinch feels slow or twitchy.
   */
  const ZOOM_RATE = 0.006;

  surface.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = surface.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;

    if(e.ctrlKey || e.metaKey || e.altKey){
      const factor = Math.exp(-e.deltaY * unit * ZOOM_RATE);
      const pinch = e.ctrlKey || e.metaKey;
      const opts = e.altKey && !pinch ? { yOnly: true }
        : e.shiftKey && pinch ? { xOnly: true }
        : axisOpts();
      zoom(factor, px, py, opts);
      return;
    }

    if(e.shiftKey){
      V.x0 += ((e.deltaY + e.deltaX) * unit) / V.ppy;
    } else {
      V.x0 += (e.deltaX * unit) / V.ppy;
      V.yTop += (e.deltaY * unit) / scale.pxPerY;
    }
    Object.assign(V, clampView(V));
    mark({ paint: true, prefs: true });
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
        Object.assign(V, clampView(V));
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
    //
    // A folded band is the exception: it is a 15px strip with nothing in it but
    // its own label, so anywhere on it unfolds. Requiring the label's exact
    // rectangle would make a fold much harder to undo than to make.
    const nd = bandAt(bands, scale, py);
    if(nd){
      if(V.collapsed.has(nd.id)) toggleCollapse(nd.id);
      else if(px < 190 && py - scale.sy(nd.y0) < 18) toggleCollapse(nd.id);
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
    const [xa, xb] = V.domain;
    const year = xa + f * (xb - xa);
    V.x0 = year - (V.W / V.ppy) / 2;
    Object.assign(V, clampView(V));
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
  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if(b) setMode(b.dataset.mode);
  });
  $('axisSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if(b) setZoomAxis(b.dataset.axis);
  });

  $('zoomIn').onclick = () => zoom(1.7, V.W / 2, V.H / 2, axisOpts());
  $('zoomOut').onclick = () => zoom(1 / 1.7, V.W / 2, V.H / 2, axisOpts());
  $('fitBtn').onclick = fit;
  $('dimBtn').onclick = () => { V.dimMode = !V.dimMode; mark({ paint: true, mini: true, prefs: true }); };
  $('railBtn').onclick = () => {
    V.railOpen = !V.railOpen;
    rail.setFolded(!V.railOpen);
    mark({ paint: true, prefs: true });
  };
  $('facetBtn').onclick = () => { V.facetsOpen = !V.facetsOpen; mark({ facets: true, paint: true, prefs: true }); };
  $('themeBtn').onclick = () => setTheme(V.theme === 'dark' ? 'light' : 'dark');
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
      case '+': case '=': zoom(1.7, V.W / 2, V.H / 2, axisOpts()); return;
      case '-': case '_': zoom(1 / 1.7, V.W / 2, V.H / 2, axisOpts()); return;
      case 'm': {
        const i = MODES.findIndex((x) => x.key === V.mode);
        setMode(MODES[(i + 1) % MODES.length].key);
        return;
      }
      case 'r': $('railBtn').onclick(); return;
      case 'f': $('facetBtn').onclick(); return;
      case 'd': $('dimBtn').onclick(); return;
      case 't': $('themeBtn').onclick(); return;
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

    Object.assign(V, clampView(V));
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
        x0: V.x0, ppy: V.ppy, yTop: V.yTop, yz: V.yz, mode: V.mode,
        collapsed: [...V.collapsed], pinned: V.pinned,
        dimMode: V.dimMode, railOpen: V.railOpen, facetsOpen: V.facetsOpen,
        theme: V.theme,
      }));
    } catch { /* private mode, or a full quota — not worth failing over */ }
  }

  function loadPrefs(){
    try {
      const p = JSON.parse(w.localStorage.getItem(PREFS_KEY) || 'null');
      if(!p) return;
      // Mode first: it sets the domain the camera below is measured against.
      if(p.mode && MODES.some((m) => m.key === p.mode)){
        V.mode = p.mode;
        V.domain = domainFor(p.mode, A.xExtent);
      }
      if(Number.isFinite(p.x0)){ V.x0 = p.x0; freshCamera = false; }
      // Not clamped here: the ppy floor depends on the viewport, and nothing has
      // been measured yet. The `clampView` after `measure()` at boot does it.
      if(Number.isFinite(p.ppy)){ V.ppy = p.ppy; freshCamera = false; }
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

  /*
   * Read just the theme, before the atlas is loaded and before the document is
   * written. Light unless a previous session chose dark; there is deliberately no
   * `prefers-color-scheme` fallback, because the atlas is a document you look at
   * pictures in and white is the right default for that.
   */
  function readTheme(win){
    try {
      const p = JSON.parse(win.localStorage.getItem(PREFS_KEY) || 'null');
      return p && p.theme === 'dark' ? 'dark' : 'light';
    } catch { return 'light'; }
  }

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------

  rail.setFolded(!V.railOpen);
  setTheme(V.theme);
  measure();

  // A fresh visitor gets the whole of the default mode; a returning one gets their
  // camera back, clamped into the mode they left it in — the ppy floor could not be
  // applied in `loadPrefs()` because it depends on the viewport width.
  if(freshCamera) Object.assign(V, fitView({ mode: V.mode, domain: V.domain, W: V.W, H: V.H }));
  else Object.assign(V, clampView(V));

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
    get mode(){ return V.mode; },
    get modes(){ return MODES.map((m) => m.key); },
    get domain(){ return V.domain.slice(); },
    get ppyRange(){ return ppyRange(V); },
    get atEdge(){ return atEdge(V); },
    get outside(){ return outsideCount(); },
    select, focusNode, fit, zoom, setQuery, toggleCollapse, togglePin, setTheme,
    setMode, gotoStop,
    toggleRail: () => $('railBtn').onclick(),
    mark,
    /** Park the camera on a point at a given zoom, for reproducible tests. */
    goto(i, ppy = 40){
      V.ppy = clamp(ppy, ...ppyRange(V));
      V.yz = coupledYZoom(V.ppy);
      centerOn(i);
      mark({ paint: true });
    },
  };

  // Repaint once excerpts land, so detail cards and previews fill in.
  A.detailsPromise?.then(() => { detail.refresh(); mark({ paint: true }); });

  return { window: w, atlas: A, view: V };
}
