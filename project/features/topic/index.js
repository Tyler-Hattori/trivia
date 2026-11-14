/*
 * Topics: one subject at a time, as a clean timeline, a readable outline, and a
 * quiz. Built by `datasets/topic.mjs` into `datasets/topics/<slug>.json`.
 *
 * This is the view meant for LEARNING a subject ("instead of reading the article
 * History of England"); the atlas stays as the view for exploring across
 * subjects. The two answer different questions and neither replaces the other.
 *
 * Routes (hash-based, so reload keeps your place and Back works):
 *   #/topics                      the list
 *   #/topic/<slug>                timeline
 *   #/topic/<slug>/read           outline
 *   #/topic/<slug>/quiz           quiz
 *
 * State that survives navigation within a topic: Key/All, chapter filter,
 * search, zoom. Per-topic, in localStorage.
 */

import { injectStyles } from './styles.js';
import { GEO, makeScale, ticks, pack, anchorYear, fmtYear, fmtRange, summary } from './layout.js';
import { bm25Index, docText } from '../../../datasets/lib/textsearch.mjs';
import { renderQuiz } from './quiz.js';
import { thumbUrl, fullUrl } from '../../utils/helpers.js';

const BASE = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE_LABEL = { event: 'Event', person: 'Person', work: 'Work', period: 'Period', place: 'Place', group: 'Group', concept: 'Concept' };

let root = null;
const cache = new Map();          // slug -> topic
let T = null;                     // current topic
let V = null;                     // current view state
let kwIndex = null;               // BM25 over the current topic
let searchSeq = 0;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function isTopicRoute(){ return /^#\/topic/.test(location.hash); }

export async function route(){
  const h = location.hash;
  if(!isTopicRoute()){ close(); return false; }
  injectStyles();
  open();
  const m = h.match(/^#\/topic\/([a-z0-9-]+)(?:\/(read|quiz))?/);
  if(!m){ await showList(); return true; }
  await showTopic(m[1], m[2] || 'timeline');
  return true;
}

function open(){
  if(root) return;
  root = document.createElement('div');
  root.className = 'tp';
  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
}

function close(){
  if(!root) return;
  root.remove(); root = null;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKey);
}

export function openTopics(){ location.hash = '#/topics'; }

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function getJSON(path){
  const r = await fetch(BASE + path, { cache: 'no-store' });
  if(!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function loadTopic(slug){
  if(cache.has(slug)) return cache.get(slug);
  const t = await getJSON(`datasets/topics/${slug}.json`);
  t.byId = new Map(t.items.map((it) => [it.id, it]));
  t.items.forEach((it) => { it.anchor = anchorYear(it); });
  cache.set(slug, t);
  return t;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function showList(){
  let idx;
  try { idx = await getJSON('datasets/topics/index.json'); }
  catch { idx = { topics: [] }; }
  root.innerHTML = `
    <div class="tp-bar">
      <button class="tp-btn" data-act="home">← Home</button>
      <div class="tp-title">Topics</div>
      <div class="tp-meta">A subject as a timeline you can read, an outline, and a quiz.</div>
    </div>
    <div style="overflow:auto;flex:1">
      ${idx.topics.length ? `<div class="tp-list">${idx.topics.map((t) => `
        <button class="tp-tile" data-topic="${esc(t.slug)}">
          ${t.cover ? `<img src="${esc(thumbUrl(t.cover, 500))}" loading="lazy" alt="">` : '<img alt="">'}
          <div class="in">
            <div class="t">${esc(t.title)}</div>
            <div class="tp-meta">${esc(fmtYear(t.from))} – ${esc(fmtYear(t.to))} · ${t.chapters} chapters · ${t.key} key / ${t.count} entries</div>
            <div class="tp-meta">from <i>${esc(t.source.page)}</i></div>
          </div>
        </button>`).join('')}</div>`
      : `<div class="tp-empty">
          <p><b>No topics built yet.</b> A topic is made from one Wikipedia article — its sections become chapters,
          its links become the entries:</p>
          <p><code>node datasets/topic.mjs "History of England" --name England --events "Timeline of English history" --ingest</code></p>
        </div>`}
    </div>`;
  root.onclick = (ev) => {
    const b = ev.target.closest('[data-topic],[data-act]');
    if(!b) return;
    if(b.dataset.act === 'home'){ location.hash = ''; return; }
    location.hash = `#/topic/${b.dataset.topic}`;
  };
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

const prefsKey = (slug) => `topic:prefs:v1:${slug}`;

function loadPrefs(slug){
  try { return JSON.parse(localStorage.getItem(prefsKey(slug))) || {}; } catch { return {}; }
}
function savePrefs(){
  if(!T || !V) return;
  localStorage.setItem(prefsKey(T.slug), JSON.stringify({ show: V.show, chapters: [...V.chapters], subjects: [...V.subjects], ppy: V.ppy }));
}

async function showTopic(slug, mode){
  if(!T || T.slug !== slug){
    root.innerHTML = '<div class="tp-empty">Loading…</div>';
    try { T = await loadTopic(slug); }
    catch(e){ root.innerHTML = `<div class="tp-empty">Could not load this topic. ${esc(e.message)}</div>`; return; }
    const p = loadPrefs(slug);
    V = {
      mode,
      show: p.show || 'key',                 // 'key' | 'all'
      chapters: new Set(p.chapters || []),   // empty = every chapter
      subjects: new Set(p.subjects || []),   // empty = every subject
      ppy: p.ppy || defaultPpy(T),
      query: '',
      matches: null,                         // Set of ids, or null when no search
      semantic: false,
      selected: null,
    };
    kwIndex = bm25Index(T.items.map((it) => ({ id: it.id, text: docText(it) })));
  }
  V.mode = mode;
  drawShell();
  drawMode();
}

/**
 * A zoom at which the key entries have room: aim for the median gap between
 * consecutive key anchors to be about a card wide.
 */
function defaultPpy(t){
  const ys = t.items.filter((it) => it.key).map(anchorYear).sort((a, b) => a - b);
  const gaps = [];
  for(let i = 1; i < ys.length; i++) if(ys[i] > ys[i - 1]) gaps.push(ys[i] - ys[i - 1]);
  gaps.sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length * 0.4)] || 10;
  return Math.max(0.5, Math.min(40, (GEO.CARD_W * 0.55) / g));
}

/** Items that pass Key/All, the chapter filter, and (in hide mode) the search. */
function visibleItems(){
  return T.items.filter((it) =>
    it.onTimeline &&
    (V.show === 'all' || it.key) &&
    (!V.chapters.size || V.chapters.has(it.chapter)) &&
    (!V.subjects.size || V.subjects.has(it.subject)));
}

/** Subjects present in this topic (under the current Key/All), biggest first. */
function subjectsOf(){
  const c = new Map();
  for(const it of T.items){
    if(!it.onTimeline || !it.subject || (V.show === 'key' && !it.key)) continue;
    c.set(it.subject, (c.get(it.subject) || 0) + 1);
  }
  return [...c].sort((a, b) => b[1] - a[1]);
}

function drawShell(){
  const tab = (m, label) => `<button data-mode="${m}" class="${V.mode === m ? 'on' : ''}">${label}</button>`;
  const vis = visibleItems();
  root.innerHTML = `
    <div class="tp-bar">
      <button class="tp-btn" data-act="list">← Topics</button>
      <div class="tp-title">${esc(T.title)}</div>
      <a class="tp-src" href="${esc(T.source.url)}" target="_blank" rel="noopener">from ${esc(T.source.page)} ↗</a>
      <span class="tp-seg">${tab('timeline', 'Timeline')}${tab('read', 'Read')}${tab('quiz', 'Quiz')}</span>
      <span class="tp-seg" title="Key: the entries the article leans on most. All: everything datable it links to.">
        <button data-show="key" class="${V.show === 'key' ? 'on' : ''}">Key</button>
        <button data-show="all" class="${V.show === 'all' ? 'on' : ''}">All</button>
      </span>
      ${V.mode !== 'quiz' ? `<input class="tp-search" id="tpSearch" placeholder="Search this topic…" value="${esc(V.query)}">` : ''}
      <span class="tp-meta" id="tpCount">${vis.length} shown${V.matches ? ` · ${countMatches(vis)} match` : ''}</span>
      <span class="tp-spacer"></span>
      ${V.mode === 'timeline' ? `
        <button class="tp-btn" data-zoom="out" title="Zoom out (−)">−</button>
        <button class="tp-btn" data-zoom="in" title="Zoom in (+)">+</button>` : ''}
    </div>
    <div class="tp-chips">
      <button class="tp-chip ${V.chapters.size ? '' : 'on'}" style="--c:#0f172a" data-ch="all">All chapters</button>
      ${T.chapters.map((c) => {
        const n = T.items.filter((it) => it.onTimeline && it.chapter === c.id && (V.show === 'all' || it.key)).length;
        return `<button class="tp-chip ${V.chapters.has(c.id) ? 'on' : ''}" style="--c:${c.color}" data-ch="${c.id}"
          title="${esc(fmtRange(c.from, c.to))}">${esc(c.title)}<span class="n">${n}</span></button>`;
      }).join('')}
    </div>
    ${subjectsOf().length > 1 ? `<div class="tp-chips tp-subj">
      <span class="tp-meta" style="align-self:center;margin-right:2px">Subject</span>
      ${subjectsOf().slice(0, 14).map(([sub, n]) => `<button class="tp-chip ${V.subjects.has(sub) ? 'on' : ''}" style="--c:#475569" data-subj="${esc(sub)}">${esc(sub)}<span class="n">${n}</span></button>`).join('')}
      ${V.subjects.size ? '<button class="tp-chip" style="--c:#94a3b8" data-subj="">clear</button>' : ''}
    </div>` : ''}
    <div class="tp-body">
      <div class="tp-scroll" id="tpScroll"></div>
      <div class="tp-detail" id="tpDetail"></div>
    </div>`;

  root.onclick = onClick;
  const box = root.querySelector('#tpSearch');
  if(box){
    let t = 0;
    box.oninput = () => { clearTimeout(t); t = setTimeout(() => runSearch(box.value), 160); };
    box.onkeydown = (ev) => {
      if(ev.key === 'Enter'){ ev.preventDefault(); jumpToFirstMatch(); }
      if(ev.key === 'Escape'){ box.value = ''; runSearch(''); box.blur(); }
    };
  }
}

const countMatches = (vis) => vis.filter((it) => V.matches.has(it.id)).length;

function drawMode(){
  if(V.mode === 'timeline') drawTimeline();
  else if(V.mode === 'read') drawRead();
  else renderQuiz(root.querySelector('#tpScroll'), T, { show: V.show, chapters: V.chapters, subjects: V.subjects });
  if(V.selected && V.mode !== 'quiz') showDetail(V.selected, false);
}

function refreshCount(){
  const el = root.querySelector('#tpCount');
  if(!el) return;
  const vis = visibleItems();
  el.textContent = `${vis.length} shown${V.matches ? ` · ${countMatches(vis)} match${V.semantic ? '' : ' (keywords only)'}` : ''}`;
}

// ---------------------------------------------------------------------------
// Timeline view
// ---------------------------------------------------------------------------

function drawTimeline(){
  const host = root.querySelector('#tpScroll');
  const keepX = host.scrollLeft, keepW = host.scrollWidth || 1;
  const items = visibleItems();
  const scale = makeScale(items, V.ppy);
  const { pos, laneCount } = pack(items, scale);
  const laneH = GEO.CARD_H + GEO.LANE_GAP;
  const top = GEO.BANDS_H + 16;
  const height = top + laneCount * laneH + 60;

  // Chapter bands: one row, or two when a chapter overlaps its neighbours.
  const bands = T.chapters.map((c) => {
    const its = items.filter((it) => it.chapter === c.id);
    if(!its.length) return '';
    const x0 = Math.min(...its.map((it) => pos.get(it.id).x)) - GEO.CARD_W / 2;
    const x1 = Math.max(...its.map((it) => pos.get(it.id).x)) + GEO.CARD_W / 2;
    const row = c.overlaps ? 1 : 0;
    const dim = V.chapters.size && !V.chapters.has(c.id);
    return `<div class="tp-band ${dim ? 'dim' : ''}" data-ch="${c.id}" style="left:${x0}px;width:${Math.max(40, x1 - x0)}px;top:${6 + row * 24}px;background:${c.color}"
      title="${esc(c.title)} · ${esc(fmtRange(c.from, c.to))}">${esc(c.title)} <span style="opacity:.75;font-weight:500">${esc(fmtRange(c.from, c.to))}</span></div>`;
  }).join('');

  const tk = ticks(scale).map((t) => `
    <div class="tp-tick" style="left:${t.x}px;top:${GEO.BANDS_H - 16}px">${esc(fmtYear(t.year))}</div>
    <div class="tp-grid" style="left:${t.x}px;top:${GEO.BANDS_H}px;height:${height - GEO.BANDS_H}px"></div>`).join('');

  const brk = scale.breaks.map((b) => `
    <div class="tp-break" style="left:${b.x}px;width:${b.w}px;top:${GEO.BANDS_H}px;height:${height - GEO.BANDS_H}px">
      <span>${esc(gapLabel(b.years))}</span></div>`).join('');

  const chColor = new Map(T.chapters.map((c) => [c.id, c.color]));
  const cards = items.map((it) => {
    const p = pos.get(it.id);
    const y = top + p.lane * laneH;
    const c = chColor.get(it.chapter) || '#64748b';
    const dim = V.matches && !V.matches.has(it.id);
    // A duration bar only when it is short enough to read as this card's own
    // extent. A *Middle Ages* bar crossing half the canvas is the chapter band's
    // job, and drawn across the lanes it is just clutter.
    const sw = it.kind === 'span' && it.end != null ? scale.x(it.end) - scale.x(it.start) : 0;
    const span = sw > 2 && sw <= GEO.CARD_W * 4 && it.type !== 'person'
      ? `<div class="tp-span" style="left:${scale.x(it.start)}px;width:${sw}px;top:${y - 6}px;background:${c}"></div>` : '';
    return `${span}
      <div class="tp-card ${dim ? 'dim' : ''} ${it.key ? '' : 'minor'} ${V.selected === it.id ? 'sel' : ''}" data-id="${esc(it.id)}"
        style="--w:${GEO.CARD_W}px;--ih:${GEO.IMG_H}px;left:${p.x - GEO.CARD_W / 2}px;top:${y}px">
        <div class="strip" style="background:${c}"></div>
        ${it.image
          // A dead image swaps to the text fallback. No text inside the handler:
          // an apostrophe in a summary ("Britain's") once broke it as JS.
          ? `<img src="${esc(thumbUrl(it.image, 330))}" loading="lazy" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='-webkit-box'"><div class="noimg" style="display:none">${esc(summary(it.excerpt, 180))}</div>`
          : `<div class="noimg">${esc(summary(it.excerpt, 180))}</div>`}
        <div class="cap">
          <div class="t">${esc(it.title)}</div>
          <div class="y">${esc(it.yearText || fmtYear(it.start))}${it.type ? ` · <span class="ty">${esc(TYPE_LABEL[it.type] || it.type)}</span>` : ''}</div>
        </div>
      </div>`;
  }).join('');

  host.innerHTML = items.length ? `
    <div class="tp-canvas" style="width:${scale.width}px;height:${height}px">
      <div class="tp-bands" style="width:${scale.width}px;height:${GEO.BANDS_H}px">
        <div style="position:relative;height:100%">${bands}${tk.replace(/<div class="tp-grid"[^>]*><\/div>/g, '')}</div>
      </div>
      ${tk.match(/<div class="tp-grid"[^>]*><\/div>/g)?.join('') || ''}
      ${brk}
      ${cards}
    </div>` : '<div class="tp-empty">Nothing to show with these filters.</div>';

  // Keep the same proportional scroll position across zoom/filter changes.
  if(keepW > 1) host.scrollLeft = (keepX / keepW) * host.scrollWidth;
  V.scale = scale; V.pos = pos;
}

function gapLabel(years){
  const y = Math.round(years);
  if(y >= 10000) return `${Math.round(y / 1000).toLocaleString('en-US')},000 years`;
  return `${y.toLocaleString('en-US')} years`;
}

function zoom(f){
  const host = root.querySelector('#tpScroll');
  // Zoom about the centre of the view: remember which year is there.
  const cx = host.scrollLeft + host.clientWidth / 2;
  let year = null;
  if(V.scale){
    // Invert by scanning items — the scale is piecewise, so use the nearest card.
    let best = Infinity;
    for(const [id, p] of V.pos){ const d = Math.abs(p.x - cx); if(d < best){ best = d; year = T.byId.get(id).anchor; } }
  }
  V.ppy = Math.max(0.2, Math.min(80, V.ppy * f));
  savePrefs();
  drawTimeline();
  if(year != null) host.scrollLeft = V.scale.x(year) - host.clientWidth / 2;
}

// ---------------------------------------------------------------------------
// Read view: the article's chapters as an outline you can read top to bottom.
// ---------------------------------------------------------------------------

function drawRead(){
  const host = root.querySelector('#tpScroll');
  const items = visibleItems();
  const html = T.chapters.map((c) => {
    if(V.chapters.size && !V.chapters.has(c.id)) return '';
    const its = items.filter((it) => it.chapter === c.id && (!V.matches || V.matches.has(it.id))).sort((a, b) => a.anchor - b.anchor);
    if(!its.length) return '';
    return `
      <h2 id="ch-${c.id}">${esc(c.title)} <span class="yr">${esc(fmtRange(c.from, c.to))}</span></h2>
      <div class="bar" style="background:${c.color}"></div>
      ${its.map((it) => `
        <div class="tp-row ${it.key ? 'key' : ''} ${V.matches && !V.matches.has(it.id) ? 'dim' : ''}" data-id="${esc(it.id)}">
          <div class="yr">${esc(it.yearText || fmtYear(it.start))}</div>
          <div>
            <div class="t">${esc(it.title)}</div>
            <div class="s">${esc(summary(it.excerpt, 300))}</div>
          </div>
          <div>${it.image ? `<img src="${esc(thumbUrl(it.image, 250))}" loading="lazy" alt="" onerror="this.remove()">` : ''}</div>
        </div>`).join('')}`;
  }).join('');
  host.innerHTML = `<div class="tp-read">${html || '<div class="tp-empty">Nothing to show with these filters.</div>'}</div>`;
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function showDetail(id, scroll = true){
  const it = T.byId.get(id);
  const el = root.querySelector('#tpDetail');
  if(!it || !el) return;
  V.selected = id;
  root.querySelectorAll('.tp-card.sel').forEach((n) => n.classList.remove('sel'));
  root.querySelector(`.tp-card[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  const ch = T.chapters[it.chapter];
  el.classList.add('open');
  el.innerHTML = `
    <div class="hd">
      <button class="tp-btn" data-nav="-1" title="Previous (←)">←</button>
      <button class="tp-btn" data-nav="1" title="Next (→)">→</button>
      <span class="tp-meta" style="flex:1;text-align:center">${esc(ch?.title || '')}</span>
      <button class="tp-btn" data-act="close" title="Close (Esc)">✕</button>
    </div>
    ${it.image ? `<a href="${esc(fullUrl(it.image))}" target="_blank" rel="noopener"><img src="${esc(thumbUrl(it.image, 960))}" alt="" onerror="this.remove()"></a>` : ''}
    <div class="in">
      <h2>${esc(it.title)}</h2>
      <div class="sub">${esc(it.yearText || fmtYear(it.start))}${it.subtitle ? ` · ${esc(it.subtitle)}` : ''}</div>
      <div style="margin-bottom:12px">
        <span class="tp-badge">${esc(TYPE_LABEL[it.type] || it.type)}</span>
        ${it.key ? '<span class="tp-badge" style="border-color:#f59e0b;color:#b45309">Key</span>' : ''}
        ${ch ? `<span class="tp-badge" style="border-color:${ch.color};color:${ch.color}">${esc(ch.title)}</span>` : ''}
        ${it.subject ? `<span class="tp-badge">${esc(it.subject)}</span>` : ''}
        ${it.region ? `<span class="tp-badge">${esc(it.region)}</span>` : ''}
      </div>
      ${String(it.excerpt || '').split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}
      ${it.wiki ? `<p><a class="tp-src" href="${esc(it.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a></p>` : ''}
    </div>`;
  if(scroll && V.mode === 'timeline' && V.pos?.get(id)){
    const host = root.querySelector('#tpScroll');
    const x = V.pos.get(id).x;
    if(x < host.scrollLeft + 80 || x > host.scrollLeft + host.clientWidth - 80){
      host.scrollTo({ left: x - host.clientWidth / 2, behavior: 'smooth' });
    }
  }
}

/** Previous / next in time among what is visible (and matching, if searching). */
function step(dir){
  const list = visibleItems().filter((it) => !V.matches || V.matches.has(it.id)).sort((a, b) => a.anchor - b.anchor || a.start - b.start);
  if(!list.length) return;
  let k = list.findIndex((it) => it.id === V.selected);
  k = k < 0 ? 0 : Math.max(0, Math.min(list.length - 1, k + dir));
  showDetail(list[k].id);
  if(V.mode === 'read') root.querySelector(`.tp-row[data-id="${CSS.escape(list[k].id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Search: keywords in the browser, hybrid from the server when it is there.
// ---------------------------------------------------------------------------

async function runSearch(q){
  V.query = q;
  const my = ++searchSeq;
  if(!q.trim()){ V.matches = null; V.semantic = false; redraw(); return; }

  // Instant keyword pass, so typing never waits on a model.
  V.matches = new Set(kwIndex.search(q, { limit: 400 }).map((h) => h.id));
  V.semantic = false;
  redraw();

  // Then the hybrid ranking from serve.mjs, which also understands paraphrase
  // ("the plague", "who invented printing"). Absent on a static host: keep keywords.
  try {
    const r = await fetch(`${BASE}api/search?topic=${encodeURIComponent(T.slug)}&k=200&q=${encodeURIComponent(q)}`);
    if(!r.ok || my !== searchSeq) return;
    const d = await r.json();
    if(my !== searchSeq) return;
    V.matches = new Set(d.hits.map((h) => h.id));
    V.semantic = !!d.semantic;
    redraw();
  } catch { /* keywords only */ }
}

function redraw(){
  // The outline drops non-matching rows AND empty chapters, so it is rebuilt.
  if(V.mode === 'read'){ drawRead(); refreshCount(); return; }
  // Dim in place rather than rebuilding, so the scroll position and images stay put.
  root.querySelectorAll('.tp-card').forEach((n) => n.classList.toggle('dim', !!V.matches && !V.matches.has(n.dataset.id)));
  root.querySelectorAll('.tp-row').forEach((n) => n.classList.toggle('dim', !!V.matches && !V.matches.has(n.dataset.id)));
  refreshCount();
}

function jumpToFirstMatch(){
  if(!V.matches) return;
  const first = visibleItems().filter((it) => V.matches.has(it.id)).sort((a, b) => a.anchor - b.anchor)[0];
  if(first) showDetail(first.id);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onClick(ev){
  const t = ev.target;
  const b = t.closest('[data-act],[data-mode],[data-show],[data-ch],[data-subj],[data-zoom],[data-nav],[data-id]');
  if(!b) return;
  if(b.dataset.act === 'list'){ location.hash = '#/topics'; return; }
  if(b.dataset.act === 'close'){ V.selected = null; root.querySelector('#tpDetail').classList.remove('open'); root.querySelectorAll('.tp-card.sel').forEach((n) => n.classList.remove('sel')); return; }
  if(b.dataset.mode){ location.hash = `#/topic/${T.slug}${b.dataset.mode === 'timeline' ? '' : '/' + b.dataset.mode}`; return; }
  if(b.dataset.show){ V.show = b.dataset.show; savePrefs(); drawShell(); drawMode(); return; }
  if(b.dataset.ch){
    if(b.dataset.ch === 'all') V.chapters.clear();
    else {
      const id = Number(b.dataset.ch);
      // A plain click selects just that chapter; shift-click adds to the set.
      if(ev.shiftKey){ if(V.chapters.has(id)) V.chapters.delete(id); else V.chapters.add(id); }
      else if(V.chapters.size === 1 && V.chapters.has(id)) V.chapters.clear();
      else { V.chapters.clear(); V.chapters.add(id); }
    }
    savePrefs(); drawShell(); drawMode();
    if(V.mode === 'timeline') root.querySelector('#tpScroll').scrollLeft = 0;
    return;
  }
  if(b.dataset.subj != null){
    const sub = b.dataset.subj;
    if(!sub) V.subjects.clear();
    else if(ev.shiftKey){ if(V.subjects.has(sub)) V.subjects.delete(sub); else V.subjects.add(sub); }
    else if(V.subjects.size === 1 && V.subjects.has(sub)) V.subjects.clear();
    else { V.subjects.clear(); V.subjects.add(sub); }
    savePrefs(); drawShell(); drawMode();
    return;
  }
  if(b.dataset.zoom){ zoom(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5); return; }
  if(b.dataset.nav){ step(Number(b.dataset.nav)); return; }
  if(b.dataset.id && V.mode !== 'quiz') showDetail(b.dataset.id);
}

function onKey(ev){
  if(!T || !V || V.mode === 'quiz') return;
  if(ev.target.closest?.('input,textarea')) return;
  if(ev.key === 'ArrowRight'){ ev.preventDefault(); step(1); }
  else if(ev.key === 'ArrowLeft'){ ev.preventDefault(); step(-1); }
  else if(ev.key === 'Escape'){ V.selected = null; root.querySelector('#tpDetail')?.classList.remove('open'); }
  else if(ev.key === '/'){ ev.preventDefault(); root.querySelector('#tpSearch')?.focus(); }
  else if((ev.key === '+' || ev.key === '=') && V.mode === 'timeline') zoom(1.5);
  else if(ev.key === '-' && V.mode === 'timeline') zoom(1 / 1.5);
}
