/*
 * openAtlas(): the whole store as the topic timeline's Lanes.
 *
 * Opens in a popup window; this code runs in the opener's realm (docs/ATLAS.md:
 * create nodes with the popup's document, take timers from the popup window).
 *
 * Layout (top to bottom), as on a topic timeline:
 *   toolbar        one compact row (more behind ⋯; the whole bar folds away)
 *   overview       the whole time range with its eras; the box is the view
 *   era bands      the eras at the current zoom; click one to fit it
 *   ticks          years
 *   pinned lanes   any lane whose name you clicked
 *   body           sections > lanes > kinds (lanes.js), scrolled natively up and
 *                  down; time pans sideways by transform
 *
 * Horizontal: x is linear in years, in one of three ranges (scales.js MODES).
 * The layout is computed for a window three screens wide around the view
 * (lanes.js), so panning inside it moves nothing; leaving it, zooming, a filter
 * or a fold lays out again. The DOM holds only the lanes near the scroll position.
 */
import { loadLaneAtlas } from './lanedata.js';
import { layoutAtlas, capsFor, weightOf, GEO } from './lanes.js';
import {
  MODES, DEFAULT_MODE, modeOf, widerMode, domainFor, ppyRange, atEdge, stopsFor,
  clamp, clampView, fitView, ticks, fmtTick, fmtYear, fmtRange,
} from './scales.js';
import { thumbUrl, imgRetry } from '../../utils/helpers.js';
import { CSS } from './styles.js';

const PREFS_KEY = 'atlas:prefs:v2';
const ERA_COLORS = ['#b45309', '#7c3aed', '#2563eb', '#059669', '#dc2626', '#0891b2', '#475569'];
const FONT = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SHELL = (base, css) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${base}">
<title>Atlas</title>
<style>${css}</style>
</head><body>
<div id="boot">Loading the atlas…</div>
<div id="app" style="visibility:hidden">
  <header class="al-bar" id="bar">
    <span class="al-title">Atlas</span>
    <input class="al-search" id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search, or a year range (1750-1800)">
    <div class="al-seg" id="modeSeg"></div>
    <button class="al-btn ic" id="zoomOut" title="Zoom out (−)">−</button>
    <button class="al-btn ic" id="zoomIn" title="Zoom in (+)">+</button>
    <button class="al-btn" id="fitBtn" title="Fit the whole range (0)">Fit</button>
    <span class="al-sp"></span>
    <span class="al-count" id="count"></span>
    <button class="al-btn ic" id="moreBtn" title="More controls">⋯</button>
    <button class="al-btn ic" id="foldBar" title="Hide the toolbar">▲</button>
  </header>
  <div class="al-more" id="more">
    <label>Zoom</label><div class="al-seg" id="stopSeg"></div>
    <label>Go to</label><select id="jump"></select>
    <button class="al-btn" id="foldAll">Fold all</button>
    <button class="al-btn" id="unfoldAll">Unfold all</button>
    <button class="al-btn ic" id="helpBtn" title="Help (?)">?</button>
  </div>
  <div class="al-hdr" id="hdr">
    <button class="al-btn ic al-unfold" id="unfoldBar" title="Show the toolbar">▼</button>
    <div class="tp-over"><div class="strip" id="strip"></div></div>
    <div class="al-bands" id="bands"></div>
    <div class="al-ticks" id="ticks"></div>
    <div class="al-pins" id="pins"><div class="al-world" id="pworld"></div><div class="al-labs" id="plabs"></div></div>
  </div>
  <div class="al-main" id="main">
    <div class="al-grid" id="grid"></div>
    <div class="al-body" id="body"><div class="al-sizer" id="sizer"><div class="al-world" id="world"></div><div class="al-labs" id="labs"></div></div></div>
    <div id="empty">Nothing here. Clear the search, or zoom out.</div>
    <div id="status"></div>
    <aside class="al-detail" id="detail"></aside>
  </div>
</div>
<div class="tp-hover" id="tip"></div>
<div id="help"><div class="box">
  <h3>The atlas</h3>
  <dl>
    <dt>scroll</dt><dd>up and down through the lanes</dd>
    <dt>drag · ⇧ scroll · two fingers sideways</dt><dd>through time</dd>
    <dt>pinch · ⌃ scroll · + −</dt><dd>zoom time; more rows appear as you zoom in</dd>
    <dt>click an entry</dt><dd>read it; ← → step through the entries in its lane</dd>
    <dt>click a lane's name</dt><dd>pin it under the header (again to unpin)</dd>
    <dt>more ▾ after a name</dt><dd>three times the rows for that lane</dd>
    <dt>click a section</dt><dd>fold it away</dd>
    <dt>click an era</dt><dd>fit it to the screen</dd>
    <dt>/ · 0 · m · Esc</dt><dd>search · fit · next time range · close</dd>
  </dl>
  <p>Every entry sits in one lane: its topic (where it matters most), or its
  subject and region when it is in no topic. Inside a lane, as on a topic
  timeline: eras and states as tinted bars, events as dots (a line under the
  title if it lasted), people on their life lines, then works and places. Bold:
  famous, or an essential of its topic. Time is linear in each of the three ranges.</p>
</div></div>
</body></html>`;

export async function openAtlas(){
  const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  const w = window.open('', 'atlas');
  if(!w){ alert('Allow pop-ups to open the atlas.'); return; }
  w.document.open();
  w.document.write(SHELL(base, CSS));
  w.document.close();
  w.focus();
  w.imgRetry = imgRetry;

  const D = w.document;
  const $ = (id) => D.getElementById(id);
  let A;
  try { A = await loadLaneAtlas(base); }
  catch(e){ $('boot').innerHTML = `<pre>${esc(e.message)}</pre>`; return; }
  const M = A.meta;

  // ---- state --------------------------------------------------------------
  const V = {
    mode: DEFAULT_MODE, domain: domainFor(DEFAULT_MODE, M.extent),
    x0: 0, ppy: 1, W: 800, H: 600,
    pinned: new Set(), folded: new Set(), more: new Set(),
    query: '', matches: null, selected: null,
    barOpen: true, moreOpen: false,
  };
  let fresh = true;
  loadPrefs();

  const body = $('body'), sizer = $('sizer'), world = $('world'), labs = $('labs');
  const pins = $('pins'), pworld = $('pworld'), plabs = $('plabs');
  const tip = $('tip'), detail = $('detail');

  // ---- measuring labels (same fonts as .tp-ln .lb) --------------------------
  const mctx = D.createElement('canvas').getContext('2d');
  const widths = new Map();
  const measure = (t, bold) => {
    const k = (bold ? 'b' : 'n') + t;
    let v = widths.get(k);
    if(v == null){ mctx.font = `${bold ? 700 : 500} 11.5px ${FONT}`; v = Math.ceil(mctx.measureText(t).width) + 1; widths.set(k, v); }
    return v;
  };

  // ---- sizes, camera --------------------------------------------------------
  function size(){
    V.W = Math.max(200, body.clientWidth);
    V.H = Math.max(120, body.clientHeight);
  }
  const fitX = () => Object.assign(V, pick(fitView({ mode: V.mode, domain: V.domain, W: V.W, H: V.H }), ['x0', 'ppy']));
  const clampX = () => Object.assign(V, pick(clampView({ ...V, yTop: 0, yz: 1 }, V.domain), ['x0', 'ppy']));
  const yearsOnScreen = () => V.W / V.ppy;
  const zoomBy = (factor, px = V.W / 2) => {
    const at = V.x0 + px / V.ppy;
    const [lo, hi] = ppyRange(V);
    V.ppy = clamp(V.ppy * factor, lo, hi);
    V.x0 = at - px / V.ppy;
    clampX();
    update({ layout: true, prefs: true });
  };
  const panBy = (dx) => { V.x0 += dx / V.ppy; clampX(); update({ prefs: true }); };
  const zoomLevel = () => Math.max(0, Math.log2(V.ppy / ppyRange(V)[0]));
  function fitYears(a, b){
    const span = Math.max(1e-6, b - a);
    V.ppy = clamp(V.W / (span * 1.06), ...ppyRange(V));
    V.x0 = a - span * 0.03;
    clampX();
    update({ layout: true, prefs: true });
  }

  // ---- the frame loop -------------------------------------------------------
  const dirty = { layout: true, body: true, header: true, prefs: false };
  let raf = 0;
  function update(flags = {}){
    Object.assign(dirty, flags, { header: true });
    if(!raf) raf = w.requestAnimationFrame(frame);
  }
  let L = null;          // the current layout: { x0, ppy, width, res }
  let rendered = null;   // the body's rendered vertical band { lo, hi }
  function frame(){
    raf = 0;
    if(dirty.layout || needLayout()){ relayout(); dirty.layout = false; dirty.body = true; }
    if(dirty.body){ renderBody(true); renderPins(); dirty.body = false; }
    applyPan();
    if(dirty.header){ renderHeader(); dirty.header = false; }
    if(dirty.prefs){ savePrefs(); dirty.prefs = false; }
    // Zoomed in on a stretch: load its buckets, then lay out again.
    const wy = yearsOnScreen();
    A.ensure(V.x0 - wy, V.x0 + 2 * wy).then((got) => { if(got) update({ layout: true }); });
  }

  function needLayout(){
    if(!L) return true;
    if(L.ppy !== V.ppy || L.W !== V.W) return true;
    const wy = yearsOnScreen();
    return V.x0 < L.x0 + wy * 0.25 || V.x0 + wy > L.x0 + 3 * wy - wy * 0.25;
  }

  function relayout(){
    // Keep the lane at the top of the screen where it is.
    let anchor = null;
    if(L){
      const top = body.scrollTop;
      const ln = L.res.lanes.find((l) => !l.pinned && l.y + l.h > top);
      if(ln) anchor = { key: ln.key, off: top - ln.y };
    }
    const wy = yearsOnScreen();
    const x0 = V.x0 - wy;
    const entries = V.matches ? A.sorted.filter((e) => V.matches.has(e.id)) : A.sorted;
    const res = layoutAtlas(entries, M, {
      x0, ppy: V.ppy, width: 3 * V.W, view: [V.x0, V.x0 + wy], domain: V.domain,
      caps: capsFor(zoomLevel(), !!V.matches), folded: V.matches ? new Set() : V.folded,
      pinned: V.pinned, more: V.more, hideEmpty: !!V.matches, measure,
      order: (S) => (V.mode === 'civ' ? [...S.filter((x) => x.key !== 'earth'), ...S.filter((x) => x.key === 'earth')] : S),
    });
    L = { x0, ppy: V.ppy, W: V.W, res };
    sizer.style.height = `${res.height + 40}px`;
    if(anchor){
      const ln = res.lanes.find((l) => l.key === anchor.key && !l.pinned);
      if(ln) body.scrollTop = ln.y + Math.min(anchor.off, ln.h);
    }
    rendered = null;
    const shown = res.marks.length + res.bars.length;
    $('empty').classList.toggle('on', !shown);
    $('count').textContent = `${M.n.toLocaleString('en-US')} entries`;
    $('status').textContent = V.matches
      ? `${V.matches.size.toLocaleString('en-US')} matches · ${shown} shown`
      : `${shown} shown · ${A.byId.size.toLocaleString('en-US')} loaded${zoomLevel() < 0.5 ? ' · zoom in for more' : ''}`;
  }

  // ---- drawing --------------------------------------------------------------
  const kindCls = (m) => (m.kind === 'people' ? 'pe' : m.kind === 'events' ? 'ev' : m.e.ty === 'work' ? 'wo' : 'ot');
  function markHtml(m, y){
    const e = m.e;
    const wgt = weightOf(e);
    const cls = `tp-ln ${kindCls(m)}${wgt ? ` ${wgt}` : ''}${m.bar ? ' lasted' : ''}${V.selected === e.id ? ' sel' : ''}`;
    const av = m.kind === 'people' && e.im ? `<img class="av" src="${esc(thumbUrl(e.im, 60))}" loading="lazy" alt="" onerror="imgRetry(this,'hide')">` : '';
    if(m.flip){
      // Label left of the dot (against the present): the box starts at the label.
      return `<div class="${cls}" data-id="${esc(e.id)}" style="left:${m.l}px;top:${y}px;width:${m.r - m.l}px;--c:${m.color}"><i class="pt" style="left:${m.x0 - m.l - 4}px"></i><span class="lb" style="left:0;max-width:${m.lw + 2}px">${av}${esc(e.t)}</span></div>`;
    }
    const mk = m.bar ? `<i class="bar" style="width:${m.x1 - m.x0}px"></i>` : '<i class="pt"></i>';
    const lx = m.bar ? 1 : 7;
    return `<div class="${cls}" data-id="${esc(e.id)}"${m.bar ? ` data-w="${m.x1 - m.x0}" data-lw="${m.lw}"` : ''} style="left:${m.x0}px;top:${y}px;width:${m.r - m.l}px;--c:${m.color}">${mk}<span class="lb" style="left:${lx}px;max-width:${m.lw + 2}px">${av}${esc(e.t)}</span></div>`;
  }
  function barHtml(b, y){
    const e = b.e;
    const wd = b.x1 - b.x0;
    return `<div class="tp-era${b.clipL ? ' clipl' : ''}${b.clipR ? ' clipr' : ''}${V.selected === e.id ? ' sel' : ''}" data-id="${esc(e.id)}" data-w="${wd}" style="left:${b.x0}px;width:${wd}px;top:${y}px;--c:${b.color}">${wd > 34 ? `<span>${esc(e.t)}</span>` : ''}</div>`;
  }
  function laneHtml(l, y){
    const more = V.more.has(l.key);
    const moreBtn = l.left || more ? `<button class="al-mo" data-more="${esc(l.key)}" title="${more ? 'Back to the usual rows' : `${l.left} more here: three times the rows for this lane`}">${more ? 'less ▴' : `${l.left.toLocaleString('en-US')} more ▾`}</button>` : '';
    return `<div class="al-lane d${Math.min(2, l.depth)}${hit === l.key ? ' hit' : ''}" style="top:${y}px" data-lane="${esc(l.key)}"><span class="tp-lanelab${l.pinned ? ' pinned' : ''}" data-pin="${esc(l.key)}" title="${l.pinned ? 'Pinned: click to unpin' : 'Click to pin under the header'}">${esc(l.label)}<i>${l.n.toLocaleString('en-US')}</i></span>${moreBtn}</div>`;
  }
  function secHtml(s){
    return `<div class="al-sec" data-sec="${esc(s.key)}" style="top:${s.y}px;--c:${s.color}" title="${s.folded ? 'Unfold' : 'Fold'} ${esc(s.label)}"><span class="tw">${s.folded ? '▸' : '▾'}</span><span class="sw"></span><b>${esc(s.label)}</b><span class="n">${s.n.toLocaleString('en-US')}</span></div>`;
  }

  function renderBody(force){
    if(!L) return;
    const top = body.scrollTop, H = V.H;
    if(!force && rendered && top >= rendered.lo + H * 0.3 && top + H <= rendered.hi - H * 0.3) return;
    const lo = top - H, hi = top + 2 * H;
    const R = L.res;
    const parts = [];
    for(const b of R.bars) if(!b.pinned && b.y > lo && b.y < hi) parts.push(barHtml(b, b.y));
    for(const m of R.marks) if(!m.pinned && m.y > lo && m.y < hi) parts.push(markHtml(m, m.y));
    world.innerHTML = parts.join('');
    const lp = [];
    for(const s of R.sections) if(s.y > lo - 40 && s.y < hi) lp.push(secHtml(s));
    for(const l of R.lanes) if(!l.pinned && l.y + l.h > lo && l.y < hi) lp.push(laneHtml(l, l.y + GEO.SEC * 0 + 8));
    labs.innerHTML = lp.join('');
    rendered = { lo, hi };
    collectSlides();
    placeMoreButtons(labs);
  }

  function renderPins(){
    if(!L) return;
    const R = L.res;
    const on = R.pinHeight > 0;
    pins.classList.toggle('on', on);
    if(!on){ pworld.innerHTML = ''; plabs.innerHTML = ''; return; }
    pins.style.height = `${Math.min(R.pinHeight + 6, Math.round(w.innerHeight * 0.4))}px`;
    pworld.innerHTML = R.bars.filter((b) => b.pinned).map((b) => barHtml(b, b.y + 6)).join('')
      + R.marks.filter((m) => m.pinned).map((m) => markHtml(m, m.y + 6)).join('');
    plabs.innerHTML = R.lanes.filter((l) => l.pinned).map((l) => laneHtml(l, l.y + 14)).join('');
    collectSlides();
    placeMoreButtons(plabs);
    size();
  }
  // "N more ▾" sits after the lane's name.
  function placeMoreButtons(root){
    for(const b of root.querySelectorAll('.al-mo')){
      const lab = b.parentElement.querySelector('.tp-lanelab');
      b.style.left = `${lab.offsetLeft + lab.offsetWidth + 6}px`;
    }
  }

  // Labels slide along bars and life lines as you pan, so a life that began off
  // screen still says whose it is (the timeline's sync()).
  let slides = [];
  function collectSlides(){
    slides = [];
    for(const root of [world, pworld]){
      for(const n of root.querySelectorAll('.tp-ln[data-w]')) slides.push({ sp: n.querySelector('.lb'), x0: parseFloat(n.style.left), w: +n.dataset.w, lw: +n.dataset.lw, era: false });
      for(const n of root.querySelectorAll('.tp-era > span')) slides.push({ sp: n, x0: parseFloat(n.parentElement.style.left), w: +n.parentElement.dataset.w, lw: n.offsetWidth, era: true });
    }
  }
  function applyPan(){
    if(!L) return;
    const off = (L.x0 - V.x0) * V.ppy;
    world.style.transform = pworld.style.transform = `translateX(${off}px)`;
    const left = -off;   // the view's left edge, in layout px
    for(const s of slides){
      const dx = s.era ? Math.max(0, Math.min(left - s.x0 + 4, s.w - s.lw - 14)) : Math.max(0, Math.min(left + 4 - s.x0, s.w - s.lw - 4));
      const t = dx ? `translateX(${dx}px)` : '';
      if(s.sp.style.transform !== t) s.sp.style.transform = t;
    }
  }

  // ---- header: overview strip, era bands, ticks, grid -----------------------
  const eras = () => (M.eras[V.mode] || []).map(([a, b, label], i) => ({ a, b: b ?? V.domain[1], label, c: ERA_COLORS[i % ERA_COLORS.length] }));
  let stripMode = null;
  function renderHeader(){
    const dom = V.domain, span = dom[1] - dom[0];
    const strip = $('strip');
    if(stripMode !== V.mode){
      stripMode = V.mode;
      strip.innerHTML = eras().map((e) => {
        const l = Math.max(0, (e.a - dom[0]) / span), r = Math.min(1, (e.b - dom[0]) / span);
        return r > l ? `<div class="seg" data-fit="${e.a}:${e.b}" style="left:${(100 * l).toFixed(2)}%;width:${(100 * (r - l)).toFixed(2)}%;background:${e.c}" title="${esc(e.label)}: click to fit">${esc(e.label)}</div>` : '';
      }).join('') + '<div class="win" id="win"></div>';
    }
    const win = $('win');
    const wl = (V.x0 - dom[0]) / span, ww = yearsOnScreen() / span;
    win.style.left = `${(100 * clamp(wl, 0, 1)).toFixed(2)}%`;
    win.style.width = `${Math.max(0.6, 100 * Math.min(1 - clamp(wl, 0, 1), ww + Math.min(0, wl))).toFixed(2)}%`;

    const X = (y) => (y - V.x0) * V.ppy;
    $('bands').innerHTML = eras().map((e) => {
      const a = X(e.a), b = X(e.b);
      if(b < 0 || a > V.W) return '';
      const l = Math.max(-4, a), r = Math.min(V.W + 4, b);
      return `<div class="tp-band" data-fit="${e.a}:${e.b}" style="left:${l}px;width:${Math.max(2, r - l - 2)}px;background:${e.c}" title="${esc(e.label)} ${esc(fmtRange(e.a, e.b))}: click to fit">${r - l > 40 ? esc(e.label) : ''}</div>`;
    }).join('');
    const sc = { x0: V.x0, x1: V.x0 + yearsOnScreen(), ppy: V.ppy, sx: X };
    const tk = ticks(sc, V.W < 500 ? 70 : 90);
    $('ticks').innerHTML = tk.list.map((t) => `<span class="tp-tick" style="left:${t.px}px">${esc(fmtTick(t.year, tk.step))}</span>`).join('');
    $('grid').innerHTML = tk.list.map((t) => `<i style="left:${Math.round(t.px)}px"></i>`).join('');
    // Mode buttons: the next-wider range is offered at the edge, never taken by itself.
    const wider = atEdge(V) ? widerMode(V.mode) : null;
    for(const b of $('modeSeg').children){ b.classList.toggle('on', b.dataset.mode === V.mode); b.classList.toggle('edge', b.dataset.mode === wider); }
  }

  // ---- hover and the detail panel -----------------------------------------
  const entryOf = (el) => { const n = el?.closest?.('[data-id]'); return n ? A.byId.get(n.dataset.id) : null; };
  const laneOfEntry = (e) => M.lanes[e.ln];
  const when = (e) => e.y || (e.e != null && e.e !== e.s ? fmtRange(e.s, e.e) : fmtYear(e.s));
  function showTip(e, ev){
    if(!e){ tip.classList.remove('on'); return; }
    const ln = laneOfEntry(e);
    tip.innerHTML = `<b>${esc(e.t)}</b> <span class="tp-meta">· ${esc(when(e))}</span>${e.sub ? `<div>${esc(e.sub)}</div>` : ''}<div class="tp-meta">${esc(ln ? ln.label : '')}</div>`;
    const x = Math.min(ev.clientX + 14, w.innerWidth - 345), y = Math.min(ev.clientY + 16, w.innerHeight - 120);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    tip.classList.add('on');
  }

  async function select(id, { center = false } = {}){
    const e = A.byId.get(id);
    V.selected = e ? id : null;
    for(const n of D.querySelectorAll('.tp-ln.sel,.tp-era.sel')) n.classList.remove('sel');
    if(!e){ detail.classList.remove('open'); return; }
    for(const n of D.querySelectorAll(`[data-id="${cssEsc(id)}"]`)) n.classList.add('sel');
    if(center) centerOn(e);
    const ln = laneOfEntry(e);
    const sec = M.sections.find((s) => s.key === ln?.section);
    const pic = e.im ? `<img class="pic" src="${esc(thumbUrl(e.im, 500))}" alt="" onerror="imgRetry(this,'hide')">` : '';
    const topics = (e.x || []).map((s) => `<button data-topic="${esc(s)}">${esc(topicTitle(s))}</button>`).join('');
    detail.innerHTML = `<div class="hd"><span class="path">${esc(sec ? sec.label : '')} › ${esc(ln ? ln.label : '')}</span>
        <button class="al-btn ic" data-step="-1" title="Previous in this lane (←)">‹</button><button class="al-btn ic" data-step="1" title="Next in this lane (→)">›</button>
        <button class="al-btn ic" data-close="1" title="Close (Esc)">✕</button></div>
      ${pic}<div class="in"><h2>${esc(e.t)}</h2>${e.sub ? `<div class="sub">${esc(e.sub)}</div>` : ''}<div class="yr">${esc(when(e))}${e.c ? ' (approx.)' : ''}</div>
      <div id="dex"><p style="color:#94a3b8">Loading…</p></div>
      ${topics ? `<div class="lb">In topics</div><div class="chips">${topics}</div>` : ''}
      <div id="dnear"></div></div>`;
    detail.classList.add('open');
    detail.scrollTop = 0;
    const d = await A.loadDetails(e);
    if(V.selected !== id) return;
    const ex = d?.excerpt ? d.excerpt.split(/\n+/).slice(0, 4).map((p) => `<p>${esc(p)}</p>`).join('') : '<p style="color:#94a3b8">No summary yet.</p>';
    $('dex').innerHTML = ex + (d?.origin?.wiki || e.id ? `<p><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(e.t.replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipedia ↗</a></p>` : '');
    if(d?.nn?.length){
      $('dnear').innerHTML = `<div class="lb">Related</div><div class="near">${d.nn.map(([nid, t, s]) => `<button data-goto="${esc(nid)}" data-s="${s}"><span>${esc(t)}</span><span class="y">${esc(fmtYear(s))}</span></button>`).join('')}</div>`;
    }
  }
  const cssEsc = (s) => (w.CSS && w.CSS.escape ? w.CSS.escape(s) : String(s).replace(/"/g, '\\"'));
  let topicTitles = new Map(M.lanes.filter((l) => l.topic).map((l) => [l.topic, l.label]));
  const topicTitle = (s) => topicTitles.get(s) || s;

  function centerOn(e){
    const wy = yearsOnScreen();
    const mid = e.e != null && e.e > e.s && e.e - e.s < wy * 0.8 ? (e.s + e.e) / 2 : e.s;
    V.x0 = mid - wy / 2;
    clampX();
    const ln = laneOfEntry(e);
    if(ln && V.folded.has(ln.section)){ V.folded.delete(ln.section); dirty.layout = true; }
    update({ prefs: true });
  }

  /** Go to an entry anywhere: load its bucket, zoom in enough to show it, scroll to it. */
  async function goto(id, s){
    if(!A.byId.has(id)) await A.ensureAt(s);
    const e = A.byId.get(id);
    if(!e) return;
    const ln = laneOfEntry(e);
    if(ln) V.folded.delete(ln.section);
    if(zoomLevel() < 3) V.ppy = clamp(ppyRange(V)[0] * 16, ...ppyRange(V));
    V.x0 = e.s - yearsOnScreen() / 2;
    clampX();
    await A.ensure(V.x0 - yearsOnScreen(), V.x0 + 2 * yearsOnScreen());
    relayout();
    let at = L.res.marks.find((m) => m.e.id === id) || L.res.bars.find((b) => b.e.id === id);
    if(!at && ln){ V.more.add(ln.key); relayout(); at = L.res.marks.find((m) => m.e.id === id) || L.res.bars.find((b) => b.e.id === id); }
    if(at && !at.pinned) body.scrollTop = Math.max(0, at.y - V.H / 3);
    update({ body: true, prefs: true });
    select(id);
  }

  /** Step to the previous/next entry of the selected one's lane, in time. */
  function step(dir){
    const e = A.byId.get(V.selected);
    if(!e || !L) return;
    const same = [...L.res.marks.map((m) => m.e), ...L.res.bars.map((b) => b.e)].filter((x) => x.ln === e.ln).sort((a, b) => a.s - b.s || a.t.localeCompare(b.t));
    const k = same.findIndex((x) => x.id === e.id);
    const nx = same[k + dir];
    if(nx){ select(nx.id); const X = (nx.s - V.x0) * V.ppy; if(X < 40 || X > V.W - 120) centerOn(nx); }
  }

  function scrollToLane(key, flash = true){
    let l = M.lanes.find((x) => x.key === key);
    if(!l) return;
    if(V.folded.delete(l.section)) relayout();
    const ln = L.res.lanes.find((x) => x.key === key);
    if(ln && !ln.pinned) body.scrollTo({ top: Math.max(0, ln.y - 6), behavior: 'smooth' });
    if(flash){ hit = key; update({ body: true }); w.setTimeout(() => { hit = null; update({ body: true }); }, 2600); }
  }
  let hit = null;

  // ---- toolbar ---------------------------------------------------------------
  const SHORT = { civ: 'Civ.', human: 'Humans', earth: 'Earth' };
  $('modeSeg').innerHTML = MODES.map((m) => `<button data-mode="${m.key}" title="${esc(m.title)}"><span class="lg">${esc(m.label)}</span><span class="sh">${esc(SHORT[m.key] || m.label)}</span></button>`).join('');
  const renderStops = () => { $('stopSeg').innerHTML = stopsFor(V.mode).map((s) => `<button data-stop="${s.key}">${s.label}</button>`).join(''); };
  renderStops();
  $('jump').innerHTML = '<option value="">a lane…</option>' + M.sections.map((s) => `<optgroup label="${esc(s.label)}">${M.lanes.filter((l) => l.section === s.key).map((l) => `<option value="${esc(l.key)}">${'\u00a0\u00a0'.repeat(l.depth)}${esc(l.label)}</option>`).join('')}</optgroup>`).join('');

  function setMode(key){
    if(key === V.mode) return;
    const wasFit = atEdge(V);
    const mid = V.x0 + yearsOnScreen() / 2;
    V.mode = modeOf(key).key;
    V.domain = domainFor(V.mode, M.extent);
    if(wasFit) fitX(); else { V.x0 = mid - yearsOnScreen() / 2; clampX(); }
    renderStops();
    // Another range reorders the sections (deep time first outside Civilization): start at the top.
    L = null; body.scrollTop = 0;
    update({ layout: true, prefs: true });
  }
  function setBar(open){
    V.barOpen = open;
    $('bar').classList.toggle('off', !open);
    $('more').classList.toggle('on', open && V.moreOpen);
    $('unfoldBar').classList.toggle('on', !open);
    size(); update({ layout: true, prefs: true });
  }

  D.addEventListener('click', (ev) => {
    const t = ev.target;
    const b = t.closest('button, [data-fit], [data-pin], [data-sec], [data-id]');
    if(!b) return;
    if(b.dataset.mode) return setMode(b.dataset.mode);
    if(b.dataset.stop){
      const s = stopsFor(V.mode).find((x) => x.key === b.dataset.stop);
      if(!s) return;
      if(s.ppy == null){ fitX(); update({ layout: true, prefs: true }); return; }
      const mid = V.x0 + yearsOnScreen() / 2;
      V.ppy = clamp(s.ppy, ...ppyRange(V)); V.x0 = mid - yearsOnScreen() / 2; clampX();
      return update({ layout: true, prefs: true });
    }
    if(b.dataset.fit){ const [a, z] = b.dataset.fit.split(':').map(Number); return fitYears(a, z); }
    if(b.dataset.pin){
      const k = b.dataset.pin;
      if(V.pinned.has(k)) V.pinned.delete(k); else V.pinned.add(k);
      return update({ layout: true, prefs: true });
    }
    if(b.dataset.more){
      const k = b.dataset.more;
      if(V.more.has(k)) V.more.delete(k); else V.more.add(k);
      return update({ layout: true });
    }
    if(b.dataset.sec){
      const k = b.dataset.sec;
      if(V.matches) return;
      if(V.folded.has(k)) V.folded.delete(k); else V.folded.add(k);
      return update({ layout: true, prefs: true });
    }
    if(b.dataset.close) return select(null);
    if(b.dataset.step) return step(+b.dataset.step);
    if(b.dataset.topic){
      // The topic opens in the main window at this entry (topic/index.js reads it).
      w.localStorage.setItem('topic:pendingSelect', V.selected || '');
      if(!window.closed){ window.location.hash = `#/topic/${b.dataset.topic}`; window.focus(); }
      else w.open(`index.html#/topic/${b.dataset.topic}`, '_blank');
      return;
    }
    if(b.dataset.goto) return goto(b.dataset.goto, +b.dataset.s);
    if(b.dataset.id){ if(dragged) return; return select(b.dataset.id); }
    switch(b.id){
      case 'zoomIn': return zoomBy(1.6);
      case 'zoomOut': return zoomBy(1 / 1.6);
      case 'fitBtn': fitX(); return update({ layout: true, prefs: true });
      case 'moreBtn': V.moreOpen = !V.moreOpen; $('more').classList.toggle('on', V.moreOpen); b.classList.toggle('on', V.moreOpen); size(); return update({ layout: true });
      case 'foldBar': return setBar(false);
      case 'unfoldBar': return setBar(true);
      case 'helpBtn': return $('help').classList.add('on');
      case 'foldAll': V.folded = new Set(M.sections.map((s) => s.key)); body.scrollTop = 0; return update({ layout: true, prefs: true });
      case 'unfoldAll': V.folded.clear(); return update({ layout: true, prefs: true });
    }
  });
  $('help').onclick = (ev) => { if(ev.target.id === 'help') $('help').classList.remove('on'); };
  $('jump').onchange = (ev) => { if(ev.target.value) scrollToLane(ev.target.value); ev.target.value = ''; };

  // Overview strip: click to go there; drag the box.
  {
    const strip = $('strip');
    let dragging = false;
    const go = (ev) => {
      const r = strip.getBoundingClientRect();
      const y = V.domain[0] + ((ev.clientX - r.left) / r.width) * (V.domain[1] - V.domain[0]);
      V.x0 = y - yearsOnScreen() / 2; clampX(); update({ prefs: true });
    };
    strip.addEventListener('pointerdown', (ev) => { if(ev.target.closest('.seg') && ev.detail > 1) return; dragging = true; try { strip.setPointerCapture(ev.pointerId); } catch {} go(ev); });
    strip.addEventListener('pointermove', (ev) => { if(dragging) go(ev); });
    strip.addEventListener('pointerup', () => { dragging = false; });
    strip.addEventListener('dblclick', (ev) => { const s = ev.target.closest('.seg'); if(s){ const [a, z] = s.dataset.fit.split(':').map(Number); fitYears(a, z); } });
  }

  // Search: words go through the site's word index; "1750-1800" goes there.
  {
    let timer = 0;
    $('q').addEventListener('input', () => {
      w.clearTimeout(timer);
      timer = w.setTimeout(runSearch, 260);
    });
  }
  async function runSearch(){
    const q = $('q').value.trim();
    V.query = q;
    const m = q.match(/^(-?\d{1,4})\s*(bc)?\s*(?:-|–|to)\s*(-?\d{1,4})\s*(bc)?$/i);
    if(m){
      let a = +m[1], b = +m[3];
      if(m[2]) a = -a; if(m[4]) b = -b;
      V.matches = null;
      return fitYears(Math.min(a, b), Math.max(a, b));
    }
    if(!q){ V.matches = null; update({ layout: true }); return; }
    const ids = await A.search(q);
    if(V.query !== q) return;
    V.matches = ids;
    body.scrollTop = 0;
    update({ layout: true });
  }

  // ---- gestures --------------------------------------------------------------
  // Scroll moves up and down (natively); sideways scroll, shift+scroll and drag
  // move through time; pinch (ctrl+wheel on a trackpad) zooms at the cursor.
  body.addEventListener('scroll', () => { renderBody(false); tip.classList.remove('on'); }, { passive: true });
  const onWheel = (ev) => {
    if(ev.ctrlKey || ev.metaKey){
      ev.preventDefault();
      const r = body.getBoundingClientRect();
      zoomBy(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left);
      return;
    }
    const dx = ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX;
    if(Math.abs(dx) > Math.abs(ev.shiftKey ? 0 : ev.deltaY)){ ev.preventDefault(); panBy(dx); }
  };
  body.addEventListener('wheel', onWheel, { passive: false });
  $('hdr').addEventListener('wheel', onWheel, { passive: false });

  let dragged = false;
  {
    const ptrs = new Map();
    let start = null, pinch = null;
    body.addEventListener('pointerdown', (ev) => {
      if(ev.target.closest('.tp-lanelab, .al-mo, .al-sec')) return;
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      dragged = false;
      if(ptrs.size === 1){ start = { x: ev.clientX, y: ev.clientY, x0: V.x0, top: body.scrollTop, touch: ev.pointerType === 'touch' }; }
      if(ptrs.size === 2){
        const [a, b] = [...ptrs.values()];
        const r = body.getBoundingClientRect();
        pinch = { d: Math.abs(a.x - b.x) || 1, ppy: V.ppy, at: V.x0 + ((a.x + b.x) / 2 - r.left) / V.ppy, mid: (a.x + b.x) / 2 - r.left };
      }
    });
    body.addEventListener('pointermove', (ev) => {
      if(!ptrs.has(ev.pointerId)){ if(ev.pointerType === 'mouse') showTip(entryOf(ev.target), ev); return; }
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if(pinch && ptrs.size === 2){
        const [a, b] = [...ptrs.values()];
        const [lo, hi] = ppyRange(V);
        V.ppy = clamp(pinch.ppy * (Math.abs(a.x - b.x) || 1) / pinch.d, lo, hi);
        V.x0 = pinch.at - pinch.mid / V.ppy;
        clampX(); dragged = true;
        return update({ prefs: true });
      }
      if(!start) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if(!dragged && Math.hypot(dx, dy) < 5) return;
      if(!dragged){ dragged = true; body.classList.add('drag'); try { body.setPointerCapture(ev.pointerId); } catch {} tip.classList.remove('on'); }
      V.x0 = start.x0 - dx / V.ppy; clampX();
      if(!start.touch) body.scrollTop = start.top - dy;
      update({ prefs: true });
    });
    const end = (ev) => {
      ptrs.delete(ev.pointerId);
      if(ptrs.size < 2) pinch = null;
      if(!ptrs.size){ start = null; body.classList.remove('drag'); w.setTimeout(() => { dragged = false; }, 0); }
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
    body.addEventListener('pointerleave', (ev) => { if(ev.pointerType === 'mouse') tip.classList.remove('on'); });
  }

  D.addEventListener('keydown', (ev) => {
    const typing = ev.target === $('q');
    if(ev.key === 'Escape'){
      if($('help').classList.contains('on')) return $('help').classList.remove('on');
      if(V.selected) return select(null);
      if(typing || V.query){ $('q').value = ''; $('q').blur(); return runSearch(); }
      return;
    }
    if(typing) return;
    const k = ev.key;
    if(k === '/'){ ev.preventDefault(); if(!V.barOpen) setBar(true); $('q').focus(); }
    else if(k === '0'){ fitX(); update({ layout: true, prefs: true }); }
    else if(k === '+' || k === '='){ zoomBy(1.6); }
    else if(k === '-' || k === '_'){ zoomBy(1 / 1.6); }
    else if(k === 'm'){ const i = MODES.findIndex((x) => x.key === V.mode); setMode(MODES[(i + 1) % MODES.length].key); }
    else if(k === '?'){ $('help').classList.toggle('on'); }
    else if(k === 'ArrowLeft' || k === 'ArrowRight'){
      ev.preventDefault();
      if(V.selected) step(k === 'ArrowLeft' ? -1 : 1);
      else panBy((k === 'ArrowLeft' ? -1 : 1) * V.W * (ev.shiftKey ? 0.5 : 0.15));
    }
  });

  w.addEventListener('resize', () => { size(); update({ layout: true }); });

  // ---- prefs ----------------------------------------------------------------
  function loadPrefs(){
    try {
      const p = JSON.parse(w.localStorage.getItem(PREFS_KEY) || 'null');
      if(!p) return;
      if(p.mode && MODES.some((m) => m.key === p.mode)){ V.mode = p.mode; V.domain = domainFor(p.mode, M.extent); }
      if(Number.isFinite(p.x0) && Number.isFinite(p.ppy) && p.ppy > 0){ V.x0 = p.x0; V.ppy = p.ppy; fresh = false; }
      const keys = new Set(M.lanes.map((l) => l.key));
      V.pinned = new Set((p.pinned || []).filter((k) => keys.has(k)).slice(0, 6));
      V.folded = new Set((p.folded || []).filter((k) => M.sections.some((s) => s.key === k)));
      if(p.barOpen === false) V.barOpen = false;
    } catch { /* ignore */ }
  }
  function savePrefs(){
    try {
      w.localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: V.mode, x0: V.x0, ppy: V.ppy, pinned: [...V.pinned], folded: [...V.folded], barOpen: V.barOpen }));
    } catch { /* full or private */ }
  }

  // ---- go --------------------------------------------------------------------
  $('boot').classList.add('gone');
  $('app').style.visibility = 'visible';
  setBar(V.barOpen);
  size();
  if(fresh) fitX(); else clampX();
  relayout();
  update({ layout: true, body: true });

  // Opened from a topic page: go to that topic's lane.
  const want = w.localStorage.getItem('atlas:course');
  if(want){ w.localStorage.removeItem('atlas:course'); w.setTimeout(() => scrollToLane(want), 50); }

  // For QA and the console.
  w.__atlas = {
    A, V, get layout(){ return L && L.res; }, update, select, goto, setMode, fitYears, zoomBy, panBy, scrollToLane, runSearch,
    setQuery: (q) => { $('q').value = q; return runSearch(); },
  };
  return { window: w };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
