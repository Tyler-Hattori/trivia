/*
 * openTimeline() — the orchestrator.
 *
 * Owns the popup window, the view state, and the frame loop. Layout and paint
 * are separate: state changes mark the layout dirty, scrolling only repaints,
 * and both are coalesced onto a single requestAnimationFrame.
 */

import { state } from '../../core/state.js';
import { DATASETS } from '../../core/settings.js';
import { normalizeTimelineRow } from '../../utils/normalize.js';

import { CSS } from './styles.js';
import { clamp, esc, fmtRange, fmtYear, truncate } from './util.js';
import {
  PAD, STOPS, PPY_MIN, PPY_MAX, tierFor, stopFor, makeScale, anchoredScrollLeft, tickStep, majorStep
} from './scales.js';
import {
  buildItems, loadThumbMeta, yearBounds, datasetsPresent,
  parseQuery, runSearch, rankHits, queryIsEmpty
} from './model.js';
import { computeLayout, contentWidthOf } from './layout.js';
import { createCanvasView, paintBand } from './view.js';
import { rulerHTML, buildEraLanes, drawMinimap, minimapTicks } from './chrome.js';
import { paintRail, paintPinRail } from './rail.js';
import { createLightbox } from './lightbox.js';

const SHELL = (base, title, css) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${base}">
<title>${title}</title>
<style>${css}</style>
</head><body>
<div id="boot"><span class="spin"></span><span>Building timeline…</span></div>
<div id="app">
  <header id="cmd">
    <div class="cmdrow">
      <div id="tlTitle"></div>
      <div id="tlCount"></div>
      <div class="searchbox">
        <span class="mag">&#9906;</span>
        <input id="q" type="text" autocomplete="off" spellcheck="false"
               placeholder="Search — or 1750-1800, ds:science, field:optics">
        <span class="kbd" id="qKbd">/</span>
      </div>
      <div class="seg" id="scaleSeg"></div>
      <div class="grp spacer">
        <button class="btn icon" id="zoomOut" title="Zoom out (−)">&minus;</button>
        <span id="ppyLab" style="font-size:11px;color:#64748b;min-width:66px;text-align:center"></span>
        <button class="btn icon" id="zoomIn" title="Zoom in (+)">+</button>
        <button class="btn" id="fitBtn" title="Fit everything (0)">Fit</button>
        <button class="btn" id="railBtn" title="Toggle the lane rail (r)">Rail</button>
        <button class="btn" id="filtersBtn" title="Toggle the filter row (f)">Filters</button>
      </div>
    </div>
    <div class="cmdrow" id="row2"></div>
  </header>
  <div id="mid">
    <div class="railcell bandlabel" id="cornerCell">Lanes</div>
    <div id="ruler"><div id="rulerInner"></div><div id="crosshair"></div><div id="crosshairLab"></div></div>
    <div class="railcell bandlabel" id="eraCell"></div>
    <div id="eraBand"><div id="eraInner"></div></div>
    <div class="railcell" id="pinCell"><div id="pinRailInner"></div></div>
    <div id="pinBand"><div id="pinInner"></div></div>
    <div class="railcell" id="railBody"><div id="railInner"></div></div>
    <div id="scrollWrap"><div id="canvas"><div id="gridlayer"></div></div></div>
    <div id="empty"><div>Nothing matches the current filters.</div></div>
  </div>
  <div id="minimap">
    <div id="mmLabel">Overview</div>
    <div id="mmWrap" title="Drag to pan · Shift-drag to zoom to a range · Double-click to fit">
      <canvas id="mmCanvas"></canvas><div id="mmWindow"></div><div id="mmTicks"></div>
    </div>
  </div>
</div>
<div id="tip"></div>
<div id="palette"><div id="palBox">
  <input id="palInput" type="text" autocomplete="off" spellcheck="false"
         placeholder="Jump to an entry, a year, or a range…">
  <div id="palList"></div>
  <div id="palFoot"><span>&#8593;&#8595; navigate</span><span>&#8629; jump</span>
    <span>&#8679;&#8629; open detail</span><span>esc close</span></div>
</div></div>
</body></html>`;

export async function openTimeline({
  rows = null,
  title = null,
  minYear = null,
  maxYear = null
} = {}){

  const win = window.open('', 'timeline');
  if(!win){
    // eslint-disable-next-line no-alert
    alert('The timeline opens in a new window — please allow pop-ups for this site.');
    return;
  }

  const heading = title ?? state.active?.title ?? 'Timeline';

  win.document.open();
  win.document.write(SHELL(location.href, esc(heading), CSS));
  win.document.close();
  win.focus();

  const doc = win.document;
  const $ = (s) => doc.querySelector(s);

  /* ---------- data ---------- */

  const meta = await loadThumbMeta();
  const singleKey = state.active?.key || null;

  const source = rows ?? (state.data || []).map(r => normalizeTimelineRow(r, state.active));
  const items = buildItems(source, meta, singleKey);
  const itemsById = [];
  for(const it of items) itemsById[it.id] = it;

  const bounds = yearBounds(items, minYear, maxYear);
  const MIN_Y = bounds.minYear;
  const MAX_Y = bounds.maxYear;
  const YSPAN = Math.max(1, MAX_Y - MIN_Y);

  const order = datasetsPresent(items);
  const dsMeta = {};
  for(const d of DATASETS) dsMeta[d.key] = d;
  for(const k of order) if(!dsMeta[k]) dsMeta[k] = { key: k, title: k, color: '#64748b' };

  const timelineConfig = state.active?.timeline || state.timeline || {};
  const facetDefs = (timelineConfig.filterable || []).map(d => ({
    key: d.key,
    label: d.label,
    dataset: d.dataset || singleKey
  }));

  const facetsByDs = new Map();
  for(const d of facetDefs){
    if(!facetsByDs.has(d.dataset)) facetsByDs.set(d.dataset, []);
    facetsByDs.get(d.dataset).push(d);
  }

  const spanDatasets = order.filter(k => items.some(i => i.ds === k && i.kind === 'span'));

  // The era band is only useful when its spans are long enough to read, so
  // default to whichever span dataset has the longest typical duration.
  function medianSpan(k){
    const d = items.filter(i => i.ds === k && i.kind === 'span')
                   .map(i => i.end - i.start).sort((a, b) => a - b);
    return d.length ? d[d.length >> 1] : 0;
  }
  const defaultEraDs = spanDatasets.length
    ? spanDatasets.reduce((a, k) => (medianSpan(k) > medianSpan(a) ? k : a), spanDatasets[0])
    : null;

  /* ---------- elements ---------- */

  const scroller   = $('#scrollWrap');
  const canvas     = $('#canvas');
  const gridlayer  = $('#gridlayer');
  const rulerInner = $('#rulerInner');
  const railInner  = $('#railInner');
  const eraBand    = $('#eraBand');
  const eraInner   = $('#eraInner');
  const eraCell    = $('#eraCell');
  const pinBand    = $('#pinBand');
  const pinInner   = $('#pinInner');
  const pinCell    = $('#pinCell');
  const pinRail    = $('#pinRailInner');
  const midEl      = $('#mid');
  const tip        = $('#tip');
  const qInput     = $('#q');
  const emptyEl    = $('#empty');
  const mmCanvas   = $('#mmCanvas');
  const mmWrap     = $('#mmWrap');
  const mmWindow   = $('#mmWindow');
  const mmTicks    = $('#mmTicks');
  const crosshair  = $('#crosshair');
  const crossLab   = $('#crosshairLab');

  const PIN_BAND_MAX = 190;

  // The pin band scrolls vertically when it overflows; keep its rail in step.
  pinBand.addEventListener('scroll', () => {
    pinRail.style.transform = `translate3d(0,${-pinBand.scrollTop}px,0)`;
  }, { passive: true });

  const view = createCanvasView(doc, canvas);
  const lightbox = createLightbox(doc, doc.body, dsMeta, (item) => focusItem(item, true));

  /* ---------- view state ---------- */

  const PREF_KEY = 'tl:prefs:' + (singleKey || heading);

  const V = {
    ppy: 8,
    dsOff: new Set(),
    activeFacet: {},
    collapsed: new Set(),
    selected: new Map(),
    pinned: new Set(),
    laneSort: 'az',
    maxLanes: 24,
    hideNonMatches: false,
    railOpen: true,
    filtersOpen: true,
    laneTags: true,
    eraDs: defaultEraDs,
    query: '',
    parsed: null,
    matched: null
  };

  for(const k of order) V.activeFacet[k] = (facetsByDs.get(k) || [])[0]?.key || null;

  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if(saved){
      if(Number.isFinite(saved.ppy)) V.ppy = clamp(saved.ppy, PPY_MIN, PPY_MAX);
      if(Array.isArray(saved.dsOff)) V.dsOff = new Set(saved.dsOff.filter(k => order.includes(k)));
      if(saved.activeFacet) for(const k of order){
        const f = saved.activeFacet[k];
        if(f && (facetsByDs.get(k) || []).some(d => d.key === f)) V.activeFacet[k] = f;
      }
      if(typeof saved.laneSort === 'string') V.laneSort = saved.laneSort;
      if(saved.maxLanes === null || Number.isFinite(saved.maxLanes)) V.maxLanes = saved.maxLanes ?? Infinity;
      if(typeof saved.hideNonMatches === 'boolean') V.hideNonMatches = saved.hideNonMatches;
      if(typeof saved.railOpen === 'boolean') V.railOpen = saved.railOpen;
      if(typeof saved.filtersOpen === 'boolean') V.filtersOpen = saved.filtersOpen;
      if(typeof saved.laneTags === 'boolean') V.laneTags = saved.laneTags;
      if(saved.eraDs === null || spanDatasets.includes(saved.eraDs)) V.eraDs = saved.eraDs;
    } else {
      V.ppy = fitPpy();
    }
  } catch { V.ppy = fitPpy(); }

  function savePrefs(){
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        ppy: V.ppy,
        dsOff: [...V.dsOff],
        activeFacet: V.activeFacet,
        laneSort: V.laneSort,
        maxLanes: Number.isFinite(V.maxLanes) ? V.maxLanes : null,
        hideNonMatches: V.hideNonMatches,
        railOpen: V.railOpen,
        filtersOpen: V.filtersOpen,
        laneTags: V.laneTags,
        eraDs: V.eraDs
      }));
    } catch { /* private mode / quota — prefs are a nicety */ }
  }

  /* ---------- derived ---------- */

  let scale = makeScale(MIN_Y, V.ppy);
  let tier = tierFor(V.ppy);
  let layout = null;
  let contentW = 0;
  let laneOfItem = new Map();
  let eraInfo = null;
  let minimapDirty = true;

  function vw(){ return scroller.clientWidth || 1; }
  function vh(){ return scroller.clientHeight || 1; }

  function fitPpy(){
    const w = (scroller?.clientWidth || win.innerWidth || 1200) - PAD * 2;
    return clamp(w / YSPAN, PPY_MIN, PPY_MAX);
  }

  /* ---------- frame loop ---------- */

  let raf = 0;
  let needLayout = true;
  let lastSL = -1, lastST = -1;

  function invalidate(full = false){
    if(full) needLayout = true;
    if(!raf) raf = win.requestAnimationFrame(frame);
  }

  function frame(){
    raf = 0;
    if(needLayout){ relayout(); needLayout = false; }
    paint();
  }

  function relayout(){
    scale = makeScale(MIN_Y, V.ppy);
    const prevTier = tier;
    tier = tierFor(V.ppy);

    // Crossing a tier boundary retires every node kind at once; drop the
    // recycling pool rather than leaving hundreds of unusable hidden nodes.
    if(prevTier !== tier) view.clear();
    contentW = contentWidthOf(MIN_Y, MAX_Y, V.ppy);

    layout = computeLayout({
      items, order, dsMeta,
      activeFacet: V.activeFacet,
      dsOff: V.dsOff,
      collapsed: V.collapsed,
      selected: V.selected,
      matched: V.matched,
      hideNonMatches: V.hideNonMatches,
      pinned: V.pinned,
      laneSort: V.laneSort,
      maxLanes: V.maxLanes,
      laneTags: V.laneTags,
      scale, tier,
      pinTier: (tier === 'card' || tier === 'detail') ? 'chip' : tier
    });

    laneOfItem = new Map();
    for(const lane of layout.lanes) for(const it of lane.items) laneOfItem.set(it.id, lane);
    for(const lane of layout.pinLanes) for(const it of lane.items) laneOfItem.set(it.id, lane);

    canvas.style.width = contentW + 'px';
    canvas.style.height = layout.contentH + 'px';

    /* gridlines as a repeating background — no DOM nodes at all */
    const step = tickStep(V.ppy);
    const maj = majorStep(step);
    const wMin = step * V.ppy;
    const wMaj = maj * V.ppy;
    const firstMin = scale.x(Math.ceil(MIN_Y / step) * step);
    const firstMaj = scale.x(Math.ceil(MIN_Y / maj) * maj);
    gridlayer.style.width = contentW + 'px';
    gridlayer.style.height = layout.contentH + 'px';
    gridlayer.style.backgroundImage =
      `repeating-linear-gradient(90deg,var(--grid-major) 0,var(--grid-major) 1px,transparent 1px,transparent ${wMaj}px),` +
      `repeating-linear-gradient(90deg,var(--grid) 0,var(--grid) 1px,transparent 1px,transparent ${wMin}px)`;
    gridlayer.style.backgroundPosition = `${firstMaj}px 0, ${firstMin}px 0`;

    /* era band */
    if(V.eraDs){
      eraInfo = buildEraLanes(items, V.eraDs, scale, dsMeta[V.eraDs]?.color || '#64748b');
      eraBand.style.display = '';
      eraCell.style.display = '';
      eraBand.style.height = eraInfo.height + 'px';
      eraCell.textContent = `Eras · ${dsMeta[V.eraDs]?.title || V.eraDs}` +
        (eraInfo.omitted ? ` (${eraInfo.omitted} too short here)` : '');
      eraCell.title = eraInfo.omitted
        ? `${eraInfo.shown} shown; ${eraInfo.omitted} spans are too narrow to label at this zoom — zoom in to see them.`
        : `${eraInfo.shown} spans shown`;
    } else {
      eraInfo = null;
      eraBand.style.display = 'none';
      eraCell.style.display = 'none';
    }

    /* pinned band */
    if(layout.pinLanes.length){
      pinBand.style.display = '';
      pinCell.style.display = '';
      // Cap the sticky band; if the pins are taller than that it scrolls
      // internally, with the rail cell following along.
      pinBand.style.height = Math.min(layout.pinH, PIN_BAND_MAX) + 'px';
      pinInner.style.height = layout.pinH + 'px';
      paintPinRail(pinRail, layout.pinLanes);
    } else {
      pinBand.style.display = 'none';
      pinCell.style.display = 'none';
    }

    emptyEl.classList.toggle('on', layout.lanes.length === 0 && layout.pinLanes.length === 0);

    renderHeader();
    minimapDirty = true;
    lastSL = lastST = -1;                 // force dependent chrome to repaint
  }

  function paint(){
    const sl = scroller.scrollLeft;
    const st = scroller.scrollTop;
    const w = vw(), h = vh();
    const moved = sl !== lastSL || st !== lastST;

    if(moved || !view.size){
      const xMin = sl - 300, xMax = sl + w + 300;

      rulerInner.style.transform = `translate3d(${-sl}px,0,0)`;
      rulerInner.innerHTML = rulerHTML(scale, MIN_Y, MAX_Y, xMin, xMax);

      if(eraInfo){
        eraInner.style.transform = `translate3d(${-sl}px,0,0)`;
        paintBand(doc, eraInner, eraInfo.lanes, itemsById, xMin, xMax);
      }
      if(layout.pinLanes.length){
        pinInner.style.transform = `translate3d(${-sl}px,0,0)`;
        paintBand(doc, pinInner, layout.pinLanes, itemsById, xMin, xMax);
      }

      railInner.style.transform = `translate3d(0,${-st}px,0)`;
      paintRail(railInner, layout, dsMeta, V.selected, V.pinned, V.matched, st, h);

      updateMinimapWindow(sl, w);
      lastSL = sl; lastST = st;
    }

    view.paint({
      layout, itemsById, dsMeta,
      scrollLeft: sl, scrollTop: st,
      vw: w, vh: h, contentW,
      laneTags: V.laneTags
    });

    if(minimapDirty){
      drawMinimap(mmCanvas, items, dsMeta, order, V.dsOff, V.matched, MIN_Y, MAX_Y);
      mmTicks.innerHTML = minimapTicks(MIN_Y, MAX_Y, mmWrap.clientWidth || 600);
      minimapDirty = false;
    }
  }

  function updateMinimapWindow(sl, w){
    const y0 = scale.year(sl);
    const y1 = scale.year(sl + w);
    const l = clamp(((y0 - MIN_Y) / YSPAN) * 100, 0, 100);
    const r = clamp(((y1 - MIN_Y) / YSPAN) * 100, 0, 100);
    mmWindow.style.left = l + '%';
    mmWindow.style.width = Math.max(0.4, r - l) + '%';
  }

  /* ---------- header ---------- */

  function renderHeader(){
    $('#tlTitle').textContent = heading;

    const shown = layout ? layout.lanes.reduce((n, l) => n + l.count, 0)
                         + layout.pinLanes.reduce((n, l) => n + l.count, 0) : 0;
    const laneN = layout ? layout.lanes.length + layout.pinLanes.length : 0;
    const matchN = V.matched ? V.matched.size : null;
    $('#tlCount').textContent =
      `${shown.toLocaleString()} / ${items.length.toLocaleString()} entries · ${laneN} lanes` +
      (matchN != null ? ` · ${matchN.toLocaleString()} matches` : '');

    const cur = stopFor(V.ppy);
    $('#scaleSeg').innerHTML = STOPS.map(s =>
      `<button data-stop="${s.id}" class="${s.id === cur ? 'on' : ''}" ` +
      `title="${s.ppy} px per year">${s.label}</button>`).join('');

    $('#ppyLab').textContent = V.ppy >= 10 ? `${V.ppy.toFixed(0)} px/yr`
      : V.ppy >= 1 ? `${V.ppy.toFixed(1)} px/yr`
      : `${V.ppy.toFixed(2)} px/yr`;

    $('#railBtn').classList.toggle('on', V.railOpen);
    $('#filtersBtn').classList.toggle('on', V.filtersOpen);
    midEl.classList.toggle('norail', !V.railOpen);
    $('#row2').style.display = V.filtersOpen ? '' : 'none';

    /* filter row */
    const chips = order.map(k => {
      const off = V.dsOff.has(k);
      const n = items.reduce((c, it) => c + (it.ds === k ? 1 : 0), 0);
      return `<button class="dschip${off ? ' off' : ''}" data-ds="${esc(k)}" title="${off ? 'Show' : 'Hide'} ${esc(dsMeta[k].title || k)}">` +
        `<span class="sw" style="background:${esc(dsMeta[k].color || '#94a3b8')}"></span>` +
        `${esc(dsMeta[k].title || k)}<span class="n">${n}</span></button>`;
    }).join('');

    const facets = order.filter(k => !V.dsOff.has(k)).map(k => {
      const defs = facetsByDs.get(k) || [];
      if(defs.length <= 1) return '';
      return `<span class="grp"><span class="lbl">${esc(dsMeta[k].title || k)}</span>` +
        `<span class="seg">${defs.map(d =>
          `<button data-facet-ds="${esc(k)}" data-facet="${esc(d.key)}" ` +
          `class="${V.activeFacet[k] === d.key ? 'on' : ''}">${esc(d.label)}</button>`).join('')}</span></span>`;
    }).join('');

    const eraOpts = ['<option value="">none</option>']
      .concat(spanDatasets.map(k =>
        `<option value="${esc(k)}"${V.eraDs === k ? ' selected' : ''}>${esc(dsMeta[k].title || k)}</option>`))
      .join('');

    $('#row2').innerHTML =
      `<span class="grp"><span class="lbl">Datasets</span>${chips}</span>` +
      (facets ? `<span class="grp"><span class="lbl">Group by</span>${facets}</span>` : '') +
      `<span class="grp"><span class="lbl">Lane order</span><span class="seg">` +
        ['az', 'time', 'count'].map(s =>
          `<button data-sort="${s}" class="${V.laneSort === s ? 'on' : ''}">` +
          `${s === 'az' ? 'A–Z' : s === 'time' ? 'First' : 'Count'}</button>`).join('') +
      `</span></span>` +
      `<span class="grp"><span class="lbl">Max lanes</span><span class="seg">` +
        [12, 24, 60, Infinity].map(n =>
          `<button data-maxlanes="${n}" class="${V.maxLanes === n ? 'on' : ''}">` +
          `${Number.isFinite(n) ? n : 'All'}</button>`).join('') +
      `</span></span>` +
      `<span class="grp"><span class="lbl">Search</span><span class="seg">` +
        `<button data-mode="dim" class="${!V.hideNonMatches ? 'on' : ''}">Dim</button>` +
        `<button data-mode="hide" class="${V.hideNonMatches ? 'on' : ''}">Hide</button>` +
      `</span></span>` +
      `<span class="grp"><span class="lbl">Era band</span>` +
        `<select id="eraSel" class="btn">${eraOpts}</select></span>` +
      `<span class="grp">` +
        `<button class="btn${V.laneTags ? ' on' : ''}" data-lanetags="1">Lane tags</button>` +
        `<button class="btn" data-clear="1">Clear filters</button>` +
        `<button class="btn" data-reset="1">Reset view</button>` +
      `</span>`;
  }

  /* ---------- navigation ---------- */

  function setPpy(next, anchorClientX){
    const clamped = clamp(next, PPY_MIN, PPY_MAX);
    if(clamped === V.ppy) return;
    const ax = anchorClientX != null ? anchorClientX : vw() / 2;
    const nsl = anchoredScrollLeft(MIN_Y, V.ppy, clamped, scroller.scrollLeft, ax);
    V.ppy = clamped;
    needLayout = true;
    frameNowThen(() => { scroller.scrollLeft = Math.max(0, nsl); });
    savePrefs();
  }

  /** Relayout synchronously, then apply a scroll position that depends on it. */
  function frameNowThen(fn){
    if(raf){ win.cancelAnimationFrame(raf); raf = 0; }
    relayout();
    needLayout = false;
    fn();
    paint();
  }

  function focusRange(y0, y1, pad = 90){
    const width = Math.max(1, y1 - y0);
    setPpyDirect(clamp((vw() - pad * 2) / width, PPY_MIN, PPY_MAX), () => {
      scroller.scrollLeft = Math.max(0, scale.x(y0) - pad);
    });
  }

  function setPpyDirect(next, after){
    V.ppy = clamp(next, PPY_MIN, PPY_MAX);
    needLayout = true;
    frameNowThen(after || (() => {}));
    savePrefs();
  }

  function fitAll(){
    setPpyDirect(fitPpy(), () => { scroller.scrollLeft = 0; });
  }

  function centerYear(y){
    scroller.scrollLeft = Math.max(0, scale.x(y) - vw() / 2);
    invalidate();
  }

  function focusItem(item, alsoVertical = true){
    let lane = laneOfItem.get(item.id);

    // The item may be filtered out — relax whatever is hiding it, then retry.
    if(!lane){
      V.dsOff.delete(item.ds);
      V.collapsed.delete(item.ds);
      V.selected.delete(`${item.ds}:${V.activeFacet[item.ds]}`);
      V.hideNonMatches = false;
      frameNowThen(() => {});
      lane = laneOfItem.get(item.id);
    }

    scroller.scrollLeft = Math.max(0, scale.x(item.at) - vw() / 2);
    if(alsoVertical && lane && !lane.pinned){
      scroller.scrollTop = Math.max(0, lane.y - vh() / 2 + lane.h / 2);
    }
    invalidate();
    win.requestAnimationFrame(() => view.flash(item.id));
  }

  /* ---------- search ---------- */

  let searchTimer = 0;

  function applySearch(q, immediate = false){
    V.query = q;
    if(searchTimer) win.clearTimeout(searchTimer);
    const run = () => {
      V.parsed = parseQuery(V.query, facetDefs);
      V.matched = runSearch(items, V.parsed);
      const kbd = $('#qKbd');
      if(kbd) kbd.textContent = V.matched ? `${V.matched.size}` : '/';
      invalidate(true);
    };
    if(immediate) run();
    else searchTimer = win.setTimeout(run, 80);
  }

  /* ---------- palette ---------- */

  const palette = $('#palette');
  const palInput = $('#palInput');
  const palList = $('#palList');
  let palHits = [];
  let palCursor = 0;

  function openPalette(seed){
    palette.classList.add('open');
    palInput.value = seed != null ? seed : V.query;
    palInput.select();
    palInput.focus();
    refreshPalette();
  }

  function closePalette(){
    palette.classList.remove('open');
    scroller.focus();
  }

  function refreshPalette(){
    const p = parseQuery(palInput.value, facetDefs);
    if(queryIsEmpty(p)){
      palHits = [];
      palList.innerHTML = `<div id="palEmpty">Type to search ${items.length.toLocaleString()} entries — ` +
        `try <b>1750-1800</b>, <b>ds:film</b> or <b>field:optics</b>.</div>`;
      return;
    }
    const m = runSearch(items, p);
    palHits = rankHits(items, p, m, 40);
    palCursor = 0;

    if(!palHits.length){
      palList.innerHTML = `<div id="palEmpty">No matches.</div>`;
      return;
    }

    let html = '';
    let lastDs = null;
    palHits.forEach((it, i) => {
      if(it.ds !== lastDs){
        html += `<span class="grp">${esc(dsMeta[it.ds]?.title || it.ds)}</span>`;
        lastDs = it.ds;
      }
      html += `<div class="row${i === palCursor ? ' cur' : ''}" data-i="${i}">` +
        `<span class="sw" style="background:${esc(dsMeta[it.ds]?.color || '#94a3b8')}"></span>` +
        `<span class="t">${esc(it.label)}</span>` +
        `<span class="s">${esc(truncate(it.subtitle || it.misc || '', 40))}</span>` +
        `<span class="y">${esc(it.displayYear)}</span></div>`;
    });
    palList.innerHTML = html;
  }

  function movePalCursor(d){
    if(!palHits.length) return;
    palCursor = clamp(palCursor + d, 0, palHits.length - 1);
    palList.querySelectorAll('.row').forEach(r => {
      const on = Number(r.dataset.i) === palCursor;
      r.classList.toggle('cur', on);
      if(on) r.scrollIntoView({ block: 'nearest' });
    });
  }

  function takePalette(openDetail){
    const it = palHits[palCursor];
    if(!it) return;
    closePalette();
    focusItem(it);
    if(openDetail){
      const lane = laneOfItem.get(it.id);
      lightbox.show(it, lane ? lane.items : [it]);
    }
  }

  /* ---------- events ---------- */

  scroller.addEventListener('scroll', () => invalidate(), { passive: true });

  scroller.addEventListener('wheel', (e) => {
    if(e.ctrlKey || e.metaKey){
      e.preventDefault();
      const rect = scroller.getBoundingClientRect();
      setPpy(V.ppy * Math.pow(1.0022, -e.deltaY), e.clientX - rect.left);
    }
  }, { passive: false });

  /* drag to pan */
  let drag = null;
  scroller.addEventListener('mousedown', (e) => {
    if(e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop, moved: false };
  });
  doc.addEventListener('mousemove', (e) => {
    if(!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if(!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    canvas.classList.add('grabbing');
    scroller.scrollLeft = drag.sl - dx;
    scroller.scrollTop = drag.st - dy;
  });
  doc.addEventListener('mouseup', () => {
    if(drag && drag.moved) suppressClick = true;
    drag = null;
    canvas.classList.remove('grabbing');
  });
  let suppressClick = false;

  /* canvas click — items open the detail view, clusters and bins zoom in */
  function onEntityClick(e){
    if(suppressClick){ suppressClick = false; return; }
    const el = e.target.closest('[data-k],[data-id]');
    if(!el) return;

    const key = el.dataset.k;
    const rec = key ? view.specForKey(key) : null;
    const spec = rec?.spec;

    if(spec && (spec.kind === 'cluster' || spec.kind === 'bin')){
      const pad = Math.max(1, (spec.r1 - spec.r0) * 0.15 + 1);
      focusRange(spec.r0 - pad, spec.r1 + pad);
      return;
    }

    const id = el.dataset.id;
    if(id == null) return;
    const it = itemsById[Number(id)];
    if(!it) return;
    const lane = laneOfItem.get(it.id);
    lightbox.show(it, lane ? lane.items : [it]);
  }
  canvas.addEventListener('click', onEntityClick);
  pinInner.addEventListener('click', onEntityClick);
  eraInner.addEventListener('click', onEntityClick);

  /* hover tooltip + ruler crosshair */
  function tipFor(spec, lane, it){
    if(spec && spec.kind === 'cluster'){
      return `<div class="t">${spec.n} entries</div>` +
        `<div class="m">${esc(lane?.value || '')}</div>` +
        `<div class="y">${esc(fmtRange(Math.round(spec.r0), Math.round(spec.r1)))}</div>` +
        `<div class="x">Click to zoom in.</div>`;
    }
    if(spec && spec.kind === 'bin'){
      return `<div class="t">${spec.n} entries</div>` +
        `<div class="m">${esc(lane?.value || '')}</div>` +
        `<div class="y">${esc(fmtRange(Math.round(spec.r0), Math.round(spec.r1)))}</div>` +
        `<div class="x">Click to zoom in.</div>`;
    }
    if(!it) return '';
    const m = [it.subtitle, it.misc].filter(Boolean).join(' · ');
    return `<div class="t">${esc(it.label)}</div>` +
      (m ? `<div class="m">${esc(m)}</div>` : '') +
      `<div class="y">${esc(it.displayYear)}</div>` +
      (it.snippet ? `<div class="x">${esc(it.snippet)}</div>` : '');
  }

  function positionTip(e){
    const W = win.innerWidth, H = win.innerHeight;
    const w = tip.offsetWidth || 300, h = tip.offsetHeight || 120;
    let x = e.clientX + 16, y = e.clientY + 16;
    if(x + w + 8 > W) x = e.clientX - w - 12;
    if(y + h + 8 > H) y = e.clientY - h - 12;
    tip.style.left = Math.max(6, x) + 'px';
    tip.style.top = Math.max(6, y) + 'px';
  }

  function onHover(e){
    if(drag && drag.moved){ tip.style.display = 'none'; return; }
    const el = e.target.closest('[data-k]');
    if(!el){ tip.style.display = 'none'; return; }
    const rec = view.specForKey(el.dataset.k);
    const spec = rec?.spec;
    const it = el.dataset.id != null ? itemsById[Number(el.dataset.id)] : null;
    if(!spec && !it){ tip.style.display = 'none'; return; }
    if(tier === 'detail' && spec && spec.kind === 'detail'){ tip.style.display = 'none'; return; }
    const html = tipFor(spec, rec?.lane, it);
    if(!html){ tip.style.display = 'none'; return; }
    tip.innerHTML = html;
    tip.style.display = 'block';
    positionTip(e);
  }
  canvas.addEventListener('mousemove', onHover);
  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

  scroller.addEventListener('mousemove', (e) => {
    const rect = scroller.getBoundingClientRect();
    const x = e.clientX - rect.left + scroller.scrollLeft;
    crosshair.style.display = 'block';
    crossLab.style.display = 'block';
    crosshair.style.left = (x - scroller.scrollLeft) + 'px';
    crossLab.style.left = (x - scroller.scrollLeft) + 'px';
    crossLab.textContent = fmtYear(scale.year(x));
  });
  scroller.addEventListener('mouseleave', () => {
    crosshair.style.display = 'none';
    crossLab.style.display = 'none';
  });

  /* header + rail delegation */
  doc.getElementById('cmd').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if(!t) return;

    if(t.id === 'zoomIn')  return setPpy(V.ppy * 1.4);
    if(t.id === 'zoomOut') return setPpy(V.ppy / 1.4);
    if(t.id === 'fitBtn')  return fitAll();
    if(t.id === 'railBtn'){ V.railOpen = !V.railOpen; savePrefs(); return invalidate(true); }
    if(t.id === 'filtersBtn'){ V.filtersOpen = !V.filtersOpen; savePrefs(); return invalidate(true); }

    if(t.dataset.stop){
      const s = STOPS.find(x => x.id === t.dataset.stop);
      if(s) setPpy(s.ppy);
      return;
    }
    if(t.dataset.ds){
      const k = t.dataset.ds;
      if(V.dsOff.has(k)) V.dsOff.delete(k); else V.dsOff.add(k);
      savePrefs();
      return invalidate(true);
    }
    if(t.dataset.facetDs){
      V.activeFacet[t.dataset.facetDs] = t.dataset.facet;
      V.selected.delete(`${t.dataset.facetDs}:${t.dataset.facet}`);
      savePrefs();
      return invalidate(true);
    }
    if(t.dataset.sort){ V.laneSort = t.dataset.sort; savePrefs(); return invalidate(true); }
    if(t.dataset.maxlanes){
      V.maxLanes = Number(t.dataset.maxlanes);
      savePrefs();
      return invalidate(true);
    }
    if(t.dataset.mode){ V.hideNonMatches = t.dataset.mode === 'hide'; savePrefs(); return invalidate(true); }
    if(t.dataset.lanetags){ V.laneTags = !V.laneTags; savePrefs(); view.clear(); return invalidate(true); }
    if(t.dataset.clear){
      V.selected.clear(); V.dsOff.clear(); V.collapsed.clear(); V.pinned.clear();
      qInput.value = ''; applySearch('', true);
      savePrefs();
      return;
    }
    if(t.dataset.reset){
      V.selected.clear(); V.dsOff.clear(); V.collapsed.clear(); V.pinned.clear();
      V.laneSort = 'az'; V.hideNonMatches = false; V.laneTags = true;
      V.maxLanes = 24;
      V.eraDs = defaultEraDs;
      qInput.value = ''; V.query = ''; V.matched = null; V.parsed = null;
      savePrefs();
      return fitAll();
    }
  });

  doc.getElementById('cmd').addEventListener('change', (e) => {
    if(e.target.id === 'eraSel'){
      V.eraDs = e.target.value || null;
      savePrefs();
      invalidate(true);
    }
  });

  function railClick(e){
    const pin = e.target.closest('[data-pin]');
    if(pin){
      e.stopPropagation();
      const id = pin.dataset.pin;
      if(V.pinned.has(id)) V.pinned.delete(id); else V.pinned.add(id);
      return invalidate(true);
    }
    if(e.target.closest('[data-expand]')){
      V.maxLanes = Infinity;
      savePrefs();
      return invalidate(true);
    }
    const sec = e.target.closest('[data-sec]');
    if(sec){
      const k = sec.dataset.sec;
      if(V.collapsed.has(k)) V.collapsed.delete(k); else V.collapsed.add(k);
      return invalidate(true);
    }
    const lane = e.target.closest('[data-lane]');
    if(lane){
      const l = layout.lanes.find(x => x.id === lane.dataset.lane)
             || layout.pinLanes.find(x => x.id === lane.dataset.lane);
      if(!l) return;
      const compound = `${l.ds}:${l.facetKey}`;
      let set = V.selected.get(compound);
      if(!set){ set = new Set(); V.selected.set(compound, set); }
      if(set.has(l.value)) set.delete(l.value); else set.add(l.value);
      if(!set.size) V.selected.delete(compound);
      return invalidate(true);
    }
  }
  railInner.addEventListener('click', railClick);
  pinRail.addEventListener('click', railClick);

  /* search box */
  qInput.addEventListener('input', () => applySearch(qInput.value));
  qInput.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){ qInput.value = ''; applySearch('', true); qInput.blur(); }
    if(e.key === 'Enter'){
      e.preventDefault();
      openPalette(qInput.value);
    }
  });

  /* palette */
  palInput.addEventListener('input', refreshPalette);
  palInput.addEventListener('keydown', (e) => {
    if(e.key === 'ArrowDown'){ e.preventDefault(); movePalCursor(1); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); movePalCursor(-1); }
    else if(e.key === 'Enter'){ e.preventDefault(); takePalette(e.shiftKey || e.metaKey || e.ctrlKey); }
    else if(e.key === 'Escape'){ e.preventDefault(); closePalette(); }
  });
  palList.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if(!row) return;
    palCursor = Number(row.dataset.i);
    takePalette(false);
  });
  palette.addEventListener('mousedown', (e) => { if(e.target === palette) closePalette(); });

  /* minimap */
  let mmDrag = null;
  mmWrap.addEventListener('mousedown', (e) => {
    const rect = mmWrap.getBoundingClientRect();
    mmDrag = { shift: e.shiftKey, x0: e.clientX - rect.left, rect };
    if(!e.shiftKey) centerYear(MIN_Y + ((e.clientX - rect.left) / rect.width) * YSPAN);
    e.preventDefault();
  });
  doc.addEventListener('mousemove', (e) => {
    if(!mmDrag) return;
    const x = e.clientX - mmDrag.rect.left;
    if(mmDrag.shift){
      const a = Math.min(mmDrag.x0, x), b = Math.max(mmDrag.x0, x);
      mmWindow.style.left = (a / mmDrag.rect.width * 100) + '%';
      mmWindow.style.width = Math.max(0.4, (b - a) / mmDrag.rect.width * 100) + '%';
    } else {
      centerYear(MIN_Y + (x / mmDrag.rect.width) * YSPAN);
    }
  });
  doc.addEventListener('mouseup', (e) => {
    if(!mmDrag) return;
    if(mmDrag.shift){
      const x = e.clientX - mmDrag.rect.left;
      const a = Math.min(mmDrag.x0, x), b = Math.max(mmDrag.x0, x);
      if(b - a > 6){
        focusRange(MIN_Y + (a / mmDrag.rect.width) * YSPAN,
                   MIN_Y + (b / mmDrag.rect.width) * YSPAN);
      }
    }
    mmDrag = null;
  });
  mmWrap.addEventListener('dblclick', fitAll);

  /* keyboard */
  doc.addEventListener('keydown', (e) => {
    const typing = e.target === qInput || e.target === palInput;

    if((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)){
      e.preventDefault();
      return openPalette();
    }

    if(e.key === 'Escape'){
      if(palette.classList.contains('open')) return closePalette();
      if(lightbox.isOpen) return lightbox.hide();
      return;
    }

    if(lightbox.isOpen){
      if(e.key === 'ArrowLeft'){ e.preventDefault(); return lightbox.step(-1); }
      if(e.key === 'ArrowRight'){ e.preventDefault(); return lightbox.step(1); }
      return;
    }

    if(typing) return;

    switch(e.key){
      case '/': e.preventDefault(); qInput.focus(); qInput.select(); break;
      case '+': case '=': e.preventDefault(); setPpy(V.ppy * 1.4); break;
      case '-': case '_': e.preventDefault(); setPpy(V.ppy / 1.4); break;
      case '0': e.preventDefault(); fitAll(); break;
      case 'r': V.railOpen = !V.railOpen; savePrefs(); invalidate(true); break;
      case 'f': V.filtersOpen = !V.filtersOpen; savePrefs(); invalidate(true); break;
      case 'ArrowLeft': scroller.scrollLeft -= e.shiftKey ? vw() : 180; break;
      case 'ArrowRight': scroller.scrollLeft += e.shiftKey ? vw() : 180; break;
      case 'Home': e.preventDefault(); scroller.scrollLeft = 0; break;
      case 'End': e.preventDefault(); scroller.scrollLeft = contentW; break;
      default: return;
    }
  });

  win.addEventListener('resize', () => { minimapDirty = true; invalidate(true); });
  win.addEventListener('beforeunload', savePrefs);

  /* ---------- go ---------- */

  if(!Number.isFinite(V.ppy) || V.ppy <= 0) V.ppy = fitPpy();
  relayout();
  needLayout = false;
  paint();
  doc.getElementById('boot').classList.add('done');
  scroller.setAttribute('tabindex', '-1');
  scroller.focus({ preventScroll: true });
}
