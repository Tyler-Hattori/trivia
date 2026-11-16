/*
 * Topics: one subject at a time. Built by `datasets/topic.mjs` into
 * `datasets/topics/<slug>.json`.
 *
 * The bar this has to clear is "better than reading the Wikipedia article":
 * shorter, with the story intact, and testing you as you go. So:
 *
 *   Learn      the default. The article's own chapter openings, then the key
 *              entries one line each, told the way THE ARTICLE tells them (the
 *              sentence that links them, from topic.mjs), not through each
 *              entry's own Wikipedia lead. A contents rail tracks what you know.
 *              Every chapter ends with a short check.
 *   Timeline   the same entries as image cards on a time axis, for seeing
 *              sequence and overlap. Click a chapter band to fit it.
 *   Quiz       Order / Era / Recall, remembering what you missed.
 *
 * Routes (hash-based, so reload keeps your place and Back works):
 *   (no hash), #/topics           the list: the home page
 *   #/quiz                        a quiz across every topic (Order / Recall)
 *   #/review                      what is due for review, across every topic
 *   #/topic/<slug>                learn
 *   #/topic/<slug>/timeline       timeline
 *   #/topic/<slug>/quiz           quiz
 *   (#/topic/<slug>/read still works, as learn)
 *
 * Per-topic prefs and quiz memory live in localStorage.
 */

import { injectStyles } from './styles.js';
import { GEO, BAR, LANE, makeScale, ticks, anchorYear, fmtYear, fmtRange, fmtWhen, summary, borrowedPortrait, setNarrow, layoutTimeline, layoutLanes, DEFAULT_PINNED } from './layout.js';
import { bm25Index, docText } from '../../../datasets/lib/textsearch.mjs';
import { renderQuiz, loadMastery, isKnown, isDue, dueSummary } from './quiz.js';
import { renderSearch, parseWhen } from './search.js';
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

export function isTopicRoute(){ return /^#\/(topic|topics|quiz|review|search)(\/|$)/.test(location.hash); }

export async function route(){
  const h = location.hash;
  if(!isTopicRoute()){ close(); return false; }
  injectStyles();
  open();
  if(/^#\/(quiz|review)/.test(h)){ await showCross(h.startsWith('#/review') ? 'review' : 'quiz'); return true; }
  if(h.startsWith('#/search')){ T = null; V = null; await renderSearch(root, h.replace(/^#\/search\/?/, '')); return true; }
  const m = h.match(/^#\/topic\/([a-z0-9-]+)(?:\/(read|learn|timeline|quiz))?/);
  if(!m){ await showList(); return true; }
  const mode = m[2] === 'timeline' || m[2] === 'quiz' ? m[2] : 'learn';
  await showTopic(m[1], mode);
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

// On a phone the contents rail is a drawer, not a column.
const narrow = () => window.matchMedia('(max-width: 760px)').matches;
// Pinned span tracks, remembered separately for phone and desktop.
const pinKey = () => narrow() ? 'topic:pinned:phone' : 'topic:pinned';

const go = (mode) => { location.hash = `#/topic/${T.slug}${mode === 'learn' ? '' : '/' + mode}`; };

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
  linkPeople(t);
  cache.set(slug, t);
  return t;
}

/**
 * People <-> what they did, within one topic. `it.who`: the people an entry is
 * by or about; `it.did`: a person's entries, oldest first. From the builder's
 * own links (`about`, `by`, a borrowed picture) and from the title naming the
 * person ("Archimedes' principle", "Newton's laws of motion"), by full name or
 * by a surname that no other person in the topic shares.
 */
function linkPeople(t){
  const people = t.items.filter((it) => it.type === 'person');
  const isPerson = (id) => t.byId.get(id)?.type === 'person';
  const surname = new Map();
  const count = new Map();
  for(const p of people){
    const w = String(p.title).replace(/\s*\(.*\)$/, '').split(/\s+/);
    const last = w[w.length - 1];
    if(w.length > 1 && last.length >= 4 && /^[A-Z][a-z]/.test(last) && !/^[IVXL]+$/.test(last)){
      surname.set(p.id, last); count.set(last, (count.get(last) || 0) + 1);
    }
  }
  const pats = people.map((p) => {
    const names = [String(p.title).replace(/\s*\(.*\)$/, '')];
    const s = surname.get(p.id);
    if(s && count.get(s) === 1) names.push(s);
    const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return [p, new RegExp(`(^|[^\\p{L}])(${esc.join('|')})($|[^\\p{L}])`, 'u')];
  });
  for(const it of t.items){
    it.who = []; it.did = it.did || [];
  }
  for(const it of t.items){
    if(it.type === 'person') continue;
    const who = new Set([it.about, it.by, it.imageFrom].filter((id) => id && id !== it.id && isPerson(id)));
    for(const [p, re] of pats) if(re.test(it.title)) who.add(p.id);
    it.who = [...who];
    for(const id of it.who) t.byId.get(id).did.push(it.id);
  }
  for(const p of people) p.did.sort((a, b) => (t.byId.get(a).start ?? 0) - (t.byId.get(b).start ?? 0));
}

/** entry id -> the topics it is in, for entries in two or more (topic.mjs). */
let members = null;
async function loadMembers(){
  if(members) return members;
  try { members = await getJSON('datasets/topics/members.json'); } catch { members = {}; }
  topicTitles = topicTitles || await getJSON('datasets/topics/index.json').then((d) => new Map(d.topics.map((t) => [t.slug, t.title]))).catch(() => new Map());
  return members;
}
let topicTitles = null;

/** topics/all.json: every timeline entry of every topic, compact (topic.mjs). For Meanwhile and the cross-topic quiz. */
let allP = null;
function loadAll(){
  if(!allP) allP = getJSON('datasets/topics/all.json').then((d) => {
    for(const r of d.items){
      r.anchor = r.i ? null : anchorYear({ type: r.ty, kind: r.k ? 'span' : 'point', start: r.s, end: r.e, dataset: r.d });
    }
    d.items.sort((a, b) => (a.anchor ?? Infinity) - (b.anchor ?? Infinity));
    return d;
  }).catch(() => { allP = null; return { topics: {}, items: [] }; });
  return allP;
}

/*
 * Meanwhile: what the OTHER topics were doing at the same time. The window
 * grows with distance from today, because "the same time" means a few years in
 * 1940 and a few centuries in 3000 BC. A span (a war, a reign) uses its own
 * years; a person their adult life.
 */
function meanwhileRange(it){
  const age = Math.max(0, new Date().getFullYear() - it.anchor);
  const w = Math.max(4, Math.round(age * 0.035));
  if(it.type === 'person' && it.end != null && it.end > it.start) return [it.start + Math.min(20, (it.end - it.start) / 3), it.end, w];
  if(it.end != null && it.end > it.start && it.end - it.start <= 12 * w) return [it.start, it.end, w];
  return [it.anchor - w, it.anchor + w, w];
}
async function meanwhile(it, slug){
  const A = await loadAll();
  const [lo, hi, w] = meanwhileRange(it);
  const mid = (lo + hi) / 2;
  const by = new Map();
  for(const r of A.items){
    if(r.i || r.anchor < lo || r.anchor > hi || r.x === slug || r.id === it.id) continue;
    (by.get(r.x) || by.set(r.x, []).get(r.x)).push(r);
  }
  const groups = [...by].map(([x, rows]) => {
    rows.sort((a, b) => (b.key || 0) - (a.key || 0) || Math.abs(a.anchor - mid) - Math.abs(b.anchor - mid));
    return { slug: x, title: A.topics[x]?.title || x, rows, n: rows.length, keyN: rows.filter((r) => r.key).length };
  }).sort((a, b) => b.keyN - a.keyN || b.n - a.n);
  // Each thing once: Cicero is in four topics, and three Ciceros say less
  // than Cicero, Vercingetorix and the Gallic Wars.
  const shown = new Set([it.id]);
  for(const g of groups){
    g.rows = g.rows.filter((r) => !shown.has(r.id)).slice(0, 3);
    g.rows.forEach((r) => shown.add(r.id));
  }
  return { groups: groups.filter((g) => g.rows.length).slice(0, 6), lo, hi, w };
}
/**
 * One or two sentences about an entry, as THIS topic tells it. A mined
 * timeline event's title IS its sentence ("Charles VI died. He was succeeded
 * by…"), so the part the title already says is dropped rather than read twice.
 */
const lineOf = (it) => {
  const s = it.context || (it.note ? summary(it.note, 220) : '') || summary(it.excerpt, 200);
  const t = String(it.title || '').replace(/[.…\s]+$/, '');
  if(t.length > 25 && s.startsWith(t)){
    const rest = s.slice(t.length).replace(/^[.…,;:\s]+/, '');
    return rest.length > 20 ? rest : '';
  }
  return s;
};

/** An idea's definition: the first sentence of its own lead. */
export const defOf = (it) => it.def || summary(String(it.excerpt || '').split(/(?<=[.!?])\s+(?=[A-Z])/)[0], 260);
const repeatsText = (a, b) => !!a && !!b && (a.includes(b.slice(0, 60)) || b.includes(a.slice(0, 60)));

/**
 * Key points: a short summary of a chapter, written for this site (by Claude,
 * from the article and the entries; datasets/topic-notes/<slug>.json), and
 * labelled as such so it is never mistaken for the article's words.
 */
function pointsBox(points, color, label = 'Key points'){
  return `<div class="tp-points" style="--c:${color}"><div class="lb">${esc(label)} <span title="A summary written for this site by Claude, from the article. Check the article for anything that matters.">· summary</span></div>
    <ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/*
 * Built to stay usable at hundreds of topics: a search box over titles and
 * blurbs, shelf chips with counts, a sort, a "Continue" row for what you have
 * started, compact cards, and per-topic hide (with a way to show them again).
 */
const LIST_KEY = 'topics:list:v1';
const listPrefs = () => { try { return JSON.parse(localStorage.getItem(LIST_KEY)) || {}; } catch { return {}; } };
const saveListPrefs = (p) => localStorage.setItem(LIST_KEY, JSON.stringify(p));
const lastOpened = (slug) => Number(localStorage.getItem(`topic:opened:${slug}`) || 0);

async function showList(){
  let idx;
  try { idx = await getJSON('datasets/topics/index.json'); }
  catch { idx = { topics: [] }; }
  const L = { q: '', group: '', sort: 'group', showHidden: false, hidden: [], ...listPrefs() };
  const all = idx.topics.map((t) => {
    const m = loadMastery(t.slug);
    const known = Object.values(m).filter(isKnown).length;
    const seen = Object.keys(m).length;
    const touched = Math.max(lastOpened(t.slug), ...Object.values(m).map((x) => x.at || 0));
    return { ...t, group: t.group || 'Other', known, seen, touched };
  });

  const due = dueSummary();
  root.innerHTML = `
    <div class="tp-bar">
      <a class="tp-btn" href="#/home" title="Home">←</a>
      <div class="tp-title">Topics</div>
      <input class="tp-search" id="tlSearch" placeholder="Search ${all.length} topics…  ( / )" value="${esc(L.q)}">
      <select class="tp-select tp-hide-m" id="tlSort" title="Order">
        ${[['group', 'By shelf'], ['az', 'A–Z'], ['size', 'Largest first'], ['progress', 'Most known first']].map(([v, l]) =>
          `<option value="${v}" ${L.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="tp-spacer"></span>
      <a class="tp-btn ${due.n ? 'primary' : ''}" href="#/review" title="Spaced repetition: what you answered before and is due again">Review${due.n ? ` <b>${due.n}</b> due` : ''}</a>
      <a class="tp-btn" href="#/quiz" title="Questions from every topic at once">Quiz all</a>
      <button class="tp-btn tp-hide-m" data-act="atlas" title="Every entry on one map: time across, subject down">Atlas ↗</button>
    </div>
    <div class="tp-chiprow" id="tlGroups"></div>
    <div style="overflow:auto;flex:1" id="tlBody"></div>`;

  const draw = () => {
    saveListPrefs({ q: L.q, group: L.group, sort: L.sort, hidden: L.hidden });
    const hidden = new Set(L.hidden);
    const q = L.q.trim().toLowerCase();
    const match = (t) => !q || `${t.title} ${t.group} ${t.blurb || ''} ${t.source.page}`.toLowerCase().includes(q);
    const pool = all.filter(match);
    const groups = [...new Set(pool.filter((t) => !hidden.has(t.slug)).map((t) => t.group))].sort();
    root.querySelector('#tlGroups').innerHTML = `
      <button class="tp-chip ${L.group ? '' : 'on'}" style="--c:#0f172a" data-group="">All<span class="n">${pool.filter((t) => !hidden.has(t.slug)).length}</span></button>
      ${groups.map((g) => `<button class="tp-chip ${L.group === g ? 'on' : ''}" style="--c:#475569" data-group="${esc(g)}">${esc(g)}<span class="n">${pool.filter((t) => t.group === g && !hidden.has(t.slug)).length}</span></button>`).join('')}
      ${hidden.size ? `<span class="tp-spacer"></span><button class="tp-chip" style="--c:#94a3b8" data-act="hidden">${L.showHidden ? 'Hide' : 'Show'} ${hidden.size} hidden</button>` : ''}`;

    const vis = pool.filter((t) => (L.showHidden || !hidden.has(t.slug)) && (!L.group || t.group === L.group));
    const order = {
      az: (a, b) => a.title.localeCompare(b.title),
      size: (a, b) => b.count - a.count,
      progress: (a, b) => b.known / Math.max(1, b.key) - a.known / Math.max(1, a.key) || a.title.localeCompare(b.title),
      group: (a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title),
    }[L.sort] || ((a, b) => 0);
    vis.sort(order);

    const card = (t) => `
      <div class="tp-tcard ${hidden.has(t.slug) ? 'hid' : ''}" data-topic="${esc(t.slug)}" tabindex="0">
        <div class="im">${t.cover ? `<img src="${esc(thumbUrl(t.cover, 330))}" loading="lazy" alt="" onerror="imgRetry(this,'hide')">` : ''}</div>
        <div class="in">
          <div class="t">${esc(t.title)}</div>
          <div class="tp-meta">${esc(fmtRange(t.from, t.to))} · ${t.chapters} chapters${due.per[t.slug] ? ` · <b class="tp-due">${due.per[t.slug]} due</b>` : ''}</div>
          ${t.blurb ? `<div class="bl">${esc(t.blurb)}</div>` : ''}
          ${t.seen ? `<div class="tp-prog" title="${t.known} of ${t.key} essentials known"><i style="width:${Math.min(100, 100 * t.known / Math.max(1, t.key)).toFixed(0)}%"></i></div>` : ''}
        </div>
        <button class="x" data-hide="${esc(t.slug)}" title="${hidden.has(t.slug) ? 'Unhide' : 'Hide this topic'}">${hidden.has(t.slug) ? '↺' : '×'}</button>
      </div>`;

    // Continue: what you opened or answered in the last month, four at most.
    const month = Date.now() - 30 * 864e5;
    const started = !q && !L.group ? vis.filter((t) => t.touched > month && !hidden.has(t.slug)).sort((a, b) => b.touched - a.touched).slice(0, 4) : [];
    let html = '';
    if(started.length) html += `<h2 class="tp-shelf">Continue</h2><div class="tp-tgrid">${started.map(card).join('')}</div>`;
    if(L.sort === 'group' && !L.group){
      for(const g of [...new Set(vis.map((t) => t.group))]){
        const its = vis.filter((t) => t.group === g);
        html += `<h2 class="tp-shelf">${esc(g)} <span class="tp-meta">${its.length}</span></h2><div class="tp-tgrid">${its.map(card).join('')}</div>`;
      }
    } else if(vis.length) html += `${started.length ? '<h2 class="tp-shelf">All</h2>' : ''}<div class="tp-tgrid">${vis.map(card).join('')}</div>`;
    if(q) html += `<div class="tp-empty" style="margin:18px auto 0"><a class="tp-btn primary" href="#/search/${encodeURIComponent(L.q.trim())}">Search everything for “${esc(L.q.trim())}” →</a>
      <div class="tp-meta" style="margin-top:6px">Every entry in the store, not just the topics. A year (1294) or a span (1290s, 13th century) builds a page for those years.</div></div>`;
    if(!vis.length) html += all.length
      ? `<div class="tp-empty">No topic matches “${esc(L.q)}”${L.group ? ` in ${esc(L.group)}` : ''}.</div>`
      : `<div class="tp-empty"><p><b>No topics built yet.</b> Add lines to <code>datasets/topics.txt</code> and run
          <code>node datasets/topic.mjs --list --ingest</code>.</p></div>`;
    root.querySelector('#tlBody').innerHTML = `<div class="tp-tlist">${html}</div>`;
  };
  draw();

  const box = root.querySelector('#tlSearch');
  box.oninput = () => { L.q = box.value; draw(); };
  box.onkeydown = (ev) => {
    if(ev.key === 'Escape'){ box.value = ''; L.q = ''; draw(); }
    if(ev.key === 'Enter'){
      const first = root.querySelector('.tp-tcard');
      // A date, or no topic by that name: search everything instead.
      if(parseWhen(box.value) || !first) location.hash = `#/search/${encodeURIComponent(box.value.trim())}`;
      else location.hash = `#/topic/${first.dataset.topic}`;
    }
  };
  root.querySelector('#tlSort').onchange = (ev) => { L.sort = ev.target.value; draw(); };
  root.onclick = (ev) => {
    const b = ev.target.closest('[data-topic],[data-act],[data-group],[data-hide]');
    if(!b || b.tagName === 'A') return;
    if(b.dataset.hide){
      ev.stopPropagation();
      const h = new Set(L.hidden);
      if(h.has(b.dataset.hide)) h.delete(b.dataset.hide); else h.add(b.dataset.hide);
      L.hidden = [...h]; draw(); return;
    }
    if(b.dataset.act === 'atlas'){ localStorage.removeItem('atlas:course'); window.openAtlas?.(); return; }
    if(b.dataset.act === 'hidden'){ L.showHidden = !L.showHidden; draw(); return; }
    if(b.dataset.group != null){ L.group = b.dataset.group; draw(); return; }
    location.hash = `#/topic/${b.dataset.topic}`;
  };
  root.onkeydown = (ev) => {
    if(ev.key === '/' && ev.target !== box){ ev.preventDefault(); box.focus(); }
    if(ev.key === 'Enter' && ev.target.classList?.contains('tp-tcard')) location.hash = `#/topic/${ev.target.dataset.topic}`;
  };
}

// ---------------------------------------------------------------------------
// Across topics: #/quiz and #/review
// ---------------------------------------------------------------------------

/*
 * One quiz over every topic, from topics/all.json. It is the topic quiz
 * (quiz.js) run on a synthetic topic whose "chapters" are the topics, so Order
 * asks "which came first" across subjects ("the Meiji Restoration or the Paris
 * Commune?"), and every answer is recorded in the topic the entry belongs to.
 * Review is the same with only what is due.
 */
const CROSS_KEY = 'topics:cross:v1';
const XPAL = ['#b45309', '#2563eb', '#7c3aed', '#be123c', '#15803d', '#0e7490', '#a16207', '#4f46e5', '#c2410c', '#0f766e', '#9333ea', '#475569', '#db2777', '#65a30d'];

async function showCross(kind){
  T = null; V = null;
  root.innerHTML = '<div class="tp-empty">Loading…</div>';
  const A = await loadAll();
  const slugs = Object.keys(A.topics).sort((a, b) => A.topics[a].title.localeCompare(A.topics[b].title));
  const idx = new Map(slugs.map((x, i) => [x, i]));
  const items = A.items.filter((r) => idx.has(r.x)).map((r) => ({
    id: `${r.x}|${r.id}`, eid: r.id, x: r.x, title: r.t, yearText: r.y || '', start: r.s, end: r.e ?? null,
    kind: r.k ? 'span' : 'point', type: r.ty, key: !!r.key, image: r.im || '', context: r.c || '',
    chapter: idx.get(r.x), onTimeline: !r.i, anchor: r.anchor, dataset: r.d || '',
    ...(r.i ? { isIdea: true, keyIdea: true, def: r.def || '', excerpt: r.def || '', start: null } : {}),
  }));
  const ST = {
    slug: `__${kind}`, title: 'all topics', synthetic: true, reviewOnly: kind === 'review',
    chapters: slugs.map((x, i) => ({ id: i, title: A.topics[x].title, color: XPAL[i % XPAL.length] })),
    items, byId: new Map(items.map((it) => [it.id, it])),
    loadMem(){
      const m = {};
      for(const x of slugs) for(const [id, rec] of Object.entries(loadMastery(x))) m[`${x}|${id}`] = rec;
      return m;
    },
    memRef: (id) => { const k = id.indexOf('|'); return [id.slice(0, k), id.slice(k + 1)]; },
  };
  let P = {};
  try { P = JSON.parse(localStorage.getItem(CROSS_KEY)) || {}; } catch {}
  // Review covers anything you have answered, essential or not.
  const X = { show: kind === 'review' ? 'all' : (P.show || 'key'), scope: new Set((P.scope || []).map((x) => idx.get(x)).filter((i) => i != null)) };
  const save = () => localStorage.setItem(CROSS_KEY, JSON.stringify({ show: kind === 'review' ? P.show : X.show, scope: [...X.scope].map((i) => slugs[i]) }));

  root.innerHTML = `
    <div class="tp-bar">
      <a class="tp-btn" href="#/home" title="Home">←</a>
      <div class="tp-title">${kind === 'review' ? 'Review' : 'Quiz'}</div>
      <button class="tp-btn tp-mob" data-x="toc">☰ Scope</button>
      ${kind === 'quiz' ? `<span class="tp-seg" title="Essentials: what each article leans on most. Everything: all it links to that has a date.">
        <button data-xshow="key" class="${X.show === 'key' ? 'on' : ''}">Essentials</button>
        <button data-xshow="all" class="${X.show === 'all' ? 'on' : ''}">Everything</button></span>` : ''}
      <span class="tp-spacer"></span>
      ${kind === 'quiz' ? '<a class="tp-btn tp-hide-m" href="#/cluster-quiz" title="The older quiz over all 12,000+ entries, by atlas cluster">Whole store by cluster</a>' : ''}
      <a class="tp-btn" href="#/${kind === 'review' ? 'quiz' : 'review'}">${kind === 'review' ? 'Quiz' : 'Review'}</a>
    </div>
    <div class="tp-body">
      <nav class="tp-rail" id="tpRail"></nav>
      <div class="tp-main"><div class="tp-scroll" id="tpScroll"></div></div>
    </div>`;

  const rail = () => {
    const mem = ST.loadMem(), now = Date.now();
    const stat = (i) => {
      const its = items.filter((it) => it.chapter === i && (X.show === 'all' || it.key));
      return { n: its.length, known: its.filter((it) => isKnown(mem[it.id])).length, due: its.filter((it) => isDue(mem[it.id], now)).length };
    };
    const row = (i, label, color, s) => `<button class="tp-toc ${i === 'all' ? (X.scope.size ? '' : 'on') : X.scope.has(i) ? 'on' : ''}" data-xtoc="${i}" style="--c:${color}">
      <span class="dot"></span><span class="tx"><span class="nm">${esc(label)}</span>
      ${s.n ? `<span class="tp-prog"><i style="width:${(100 * s.known / s.n).toFixed(0)}%"></i></span>` : ''}</span>
      <span class="k">${kind === 'review' ? (s.due ? `<b class="tp-due">${s.due}</b>` : '–') : `${s.known}/${s.n}`}</span></button>`;
    const stats = ST.chapters.map((c) => stat(c.id));
    const tot = stats.reduce((a, b) => ({ n: a.n + b.n, known: a.known + b.known, due: a.due + b.due }), { n: 0, known: 0, due: 0 });
    root.querySelector('#tpRail').innerHTML = `
      <button class="tp-btn tp-mob tp-railx" data-x="toc" title="Close">✕</button>
      <div class="hd">${kind === 'review' ? 'Due in' : 'Quiz on'}</div>
      ${row('all', 'Every topic', '#0f172a', tot)}
      ${ST.chapters.map((c, i) => (kind === 'review' && !stats[i].due && !X.scope.has(i) ? '' : row(c.id, c.title, c.color, stats[i]))).join('')}
      <div class="ft tp-meta">${kind === 'review'
        ? 'Right answers come back after 1, 3, 7, 16, 35 and 90 days; misses after ten minutes.'
        : 'Order questions mix topics: what came first, here or there? Every answer counts in its own topic.'}</div>`;
  };
  const quiz = () => renderQuiz(root.querySelector('#tpScroll'), ST, {
    show: X.show, chapters: X.scope,
    onAnswer: rail,
    onOpen: (id) => { const it = ST.byId.get(id); if(it){ pendingSelect = it.eid; location.hash = `#/topic/${it.x}`; } },
    onWiden: kind === 'review' ? () => { location.hash = '#/quiz'; } : X.scope.size ? () => { X.scope.clear(); save(); rail(); quiz(); } : null,
  });
  rail(); quiz();
  root.onclick = (ev) => {
    const b = ev.target.closest('[data-x],[data-xtoc],[data-xshow]');
    if(!b) return;
    if(b.dataset.x === 'toc'){ root.querySelector('#tpRail').classList.toggle('open'); return; }
    if(b.dataset.xshow){ X.show = b.dataset.xshow; save(); showCross(kind); return; }
    if(b.dataset.xtoc != null){
      const i = b.dataset.xtoc === 'all' ? null : Number(b.dataset.xtoc);
      if(i == null) X.scope.clear();
      else if(X.scope.has(i)) X.scope.delete(i); else X.scope.add(i);
      root.querySelector('#tpRail').classList.remove('open');
      save(); rail(); quiz();
    }
  };
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

const prefsKey = (slug) => `topic:prefs:v2:${slug}`;

function loadPrefs(slug){
  try { return JSON.parse(localStorage.getItem(prefsKey(slug))) || {}; } catch { return {}; }
}
function savePrefs(){
  if(!T || !V) return;
  localStorage.setItem(prefsKey(T.slug), JSON.stringify({
    show: V.show, subject: V.subject, ppy: V.ppy, readAt: V.readAt,
  }));
}

async function showTopic(slug, mode){
  if(!T || T.slug !== slug){
    root.innerHTML = '<div class="tp-empty">Loading…</div>';
    try { T = await loadTopic(slug); }
    catch(e){ root.innerHTML = `<div class="tp-empty">Could not load this topic. ${esc(e.message)}</div>`; return; }
    const p = loadPrefs(slug);
    V = {
      mode,
      show: p.show || 'key',                 // 'key' (Essentials) | 'all' (Everything)
      // Timeline/quiz focus; empty = every chapter. Not restored from last time:
      // coming back to a topic should never open on four cards of one chapter.
      chapters: new Set(),
      subject: p.subject || '',
      ppy: p.ppy || defaultPpy(T),
      readAt: p.readAt ?? null,              // learn: chapter you were last reading
      query: '',
      matches: null,                         // Set of ids, or null when no search
      semantic: false,
      selected: null,
      layout: localStorage.getItem('topic:layout') || 'lanes',   // 'lanes' | 'cards' (global)
      // Span tracks frozen in the header (lanes; global): see layout.js TRACKS.
      // Lanes frozen in the header (clicked by name); none by default.
      pinned: (() => { try { return JSON.parse(localStorage.getItem(pinKey())) || DEFAULT_PINNED; } catch { return DEFAULT_PINNED; } })(),
    };
    kwIndex = bm25Index(T.items.map((it) => ({ id: it.id, text: docText(it) })));
    localStorage.setItem(`topic:opened:${slug}`, String(Date.now()));
    loadMembers();
  }
  const prev = V.mode;
  V.mode = mode;
  // Learn always shows every chapter (the rail scrolls, it does not filter);
  // arriving there from a chapter-focused timeline should not hide the rest.
  if(mode === 'learn' && prev !== 'learn') V.chapters.clear();
  V.mastery = loadMastery(T.slug);
  // Arriving from the atlas's "In topics" (another window): open that entry.
  const fromAtlas = localStorage.getItem('topic:pendingSelect');
  if(fromAtlas){ localStorage.removeItem('topic:pendingSelect'); pendingSelect = pendingSelect || fromAtlas; }
  // Arriving from another topic's "Also in": open the same entry here.
  if(pendingSelect && T.byId.has(pendingSelect)){ V.selected = pendingSelect; if(!T.byId.get(pendingSelect).key) V.show = 'all'; }
  pendingSelect = null;
  drawShell();
  drawMode();
  if(V.selected && V.mode === 'learn') root.querySelector(`.tp-row[data-id="${CSS.escape(V.selected)}"]`)?.scrollIntoView({ block: 'center' });
}
let pendingSelect = null;

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

/** Items that pass Essentials/Everything, the chapter focus and the subject. */
function visibleItems({ ignoreChapters = false } = {}){
  return T.items.filter((it) =>
    it.onTimeline &&
    (V.show === 'all' || it.key) &&
    (ignoreChapters || !V.chapters.size || V.chapters.has(it.chapter)) &&
    (!V.subject || it.subject === V.subject));
}

/** Timeline candidates: on the timeline and in the chapter/subject focus, essential or not. */
function timelinePool(){
  return T.items.filter((it) => it.onTimeline &&
    (!V.chapters.size || V.chapters.has(it.chapter)) &&
    (!V.subject || it.subject === V.subject));
}

/** Subjects present in this topic (under the current show), biggest first. */
function subjectsOf(){
  const c = new Map();
  for(const it of T.items){
    if(!it.onTimeline || !it.subject || (V.show === 'key' && !it.key)) continue;
    c.set(it.subject, (c.get(it.subject) || 0) + 1);
  }
  return [...c].sort((a, b) => b[1] - a[1]);
}

function drawShell(){
  const tab = (m, label, tip) => `<button data-mode="${m}" class="${V.mode === m ? 'on' : ''}" title="${tip}">${label}</button>`;
  const subs = subjectsOf();
  root.innerHTML = `
    <div class="tp-bar">
      <button class="tp-btn" data-act="list" title="All topics">←</button>
      <div class="tp-title">${esc(T.title)}</div>
      ${V.mode !== 'timeline' ? `<button class="tp-btn tp-mob" data-act="toc" title="Contents">☰ ${V.mode === 'quiz' ? 'Scope' : 'Contents'}</button>` : ''}
      <span class="tp-seg tp-modes">${tab('learn', 'Learn', 'The story, chapter by chapter')}${tab('timeline', 'Timeline', 'Everything on a time axis')}${tab('quiz', 'Quiz', 'Test yourself')}</span>
      <span class="tp-seg" title="Essentials: what the article leans on most. Everything: all it links to that has a date.">
        <button data-show="key" class="${V.show === 'key' ? 'on' : ''}">Essentials</button>
        <button data-show="all" class="${V.show === 'all' ? 'on' : ''}">Everything</button>
      </span>
      ${subs.length > 1 ? `<select class="tp-select tp-hide-m" id="tpSubj" title="Only one kind of subject">
        <option value="">All subjects</option>
        ${subs.map(([s, n]) => `<option value="${esc(s)}" ${V.subject === s ? 'selected' : ''}>${esc(s)} (${n})</option>`).join('')}
      </select>` : ''}
      ${V.mode === 'timeline' ? `<select class="tp-select" id="tpChap" title="Fit one chapter to the screen">
        <option value="all">All chapters</option>
        ${T.chapters.filter((c) => T.items.some((it) => it.onTimeline && it.chapter === c.id && (V.show === 'all' || it.key))).map((c) =>
          `<option value="${c.id}" ${V.chapters.size === 1 && V.chapters.has(c.id) ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
      </select>` : ''}
      ${V.mode !== 'quiz' ? `<input class="tp-search" id="tpSearch" placeholder="Search ${esc(T.title)}…  ( / )" value="${esc(V.query)}">` : ''}
      <span class="tp-meta" id="tpCount"></span>
      <span class="tp-spacer"></span>
      ${V.mode === 'timeline' ? `
        <span class="tp-seg" title="Cards: entries as cards, most important on top. Lanes: events, people and works in thin lanes.">
          <button data-layout="cards" class="${V.layout === 'cards' ? 'on' : ''}" title="Cards"><span class="tp-hide-m">Cards</span><span class="tp-mob">▦</span></button><button data-layout="lanes" class="${V.layout !== 'cards' ? 'on' : ''}" title="Lanes"><span class="tp-hide-m">Lanes</span><span class="tp-mob">☰</span></button>
        </span>
        <button class="tp-btn" data-zoom="out" title="Zoom out (−)">−</button>
        <button class="tp-btn" data-zoom="in" title="Zoom in (+)">+</button>` : ''}
      <button class="tp-btn tp-hide-m" data-act="atlas" title="See this topic's entries among everything else on the atlas">Atlas ↗</button>
      ${V.mode !== 'timeline' ? `<a class="tp-src" href="${esc(T.source.url)}" target="_blank" rel="noopener" title="The article this topic is built from">${esc(T.source.page)} ↗</a>` : ''}
    </div>
    <div class="tp-body">
      ${V.mode !== 'timeline' ? '<nav class="tp-rail" id="tpRail"></nav>' : ''}
      <div class="tp-main">
        ${V.mode === 'timeline' ? '<div class="tp-over" id="tpOver"></div>' : ''}
        <div class="tp-scroll" id="tpScroll"></div>
      </div>
      <div class="tp-detail" id="tpDetail"></div>
    </div>
    <div class="tp-hover" id="tpHover"></div>`;

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
  const chs = root.querySelector('#tpChap');
  if(chs) chs.onchange = () => fitChapter(chs.value);
  const sel = root.querySelector('#tpSubj');
  if(sel) sel.onchange = () => { V.subject = sel.value; savePrefs(); drawShell(); drawMode(); };
  refreshCount();
}

function drawMode(){
  if(V.mode === 'timeline') drawTimeline();
  else if(V.mode === 'learn') drawLearn();
  else renderQuiz(root.querySelector('#tpScroll'), T, {
    show: V.show, chapters: V.chapters, subjects: V.subject ? new Set([V.subject]) : new Set(),
    onAnswer: () => { V.mastery = loadMastery(T.slug); drawRail(); },
    onOpen: (id) => showDetail(id),
    // A dead end offers the next wider scope: all chapters, then Everything.
    onWiden: V.chapters.size || V.subject || V.show === 'key' ? () => {
      if(V.chapters.size || V.subject){ V.chapters.clear(); V.subject = ''; } else V.show = 'all';
      savePrefs(); drawShell(); drawMode();
    } : null,
  });
  drawRail();
  if(V.selected && V.mode !== 'quiz'){
    // Keep the panel only if what it shows is still in view (a chapter fit or
    // a filter can take it away).
    if(stepList().some((it) => it.id === V.selected)) showDetail(V.selected, false);
    else closeDetail();
  }
}

function refreshCount(){
  const el = root.querySelector('#tpCount');
  if(!el) return;
  if(!V.matches){ el.textContent = ''; return; }
  const n = visibleItems().filter((it) => V.matches.has(it.id)).length;
  el.innerHTML = `${n} match${n === 1 ? '' : 'es'}${V.when ? ` in ${esc(V.when.label)}` : V.semantic ? '' : ' (keywords)'} · <a href="#/search/${encodeURIComponent(V.query.trim())}">search everything →</a>`;
}

// ---------------------------------------------------------------------------
// Contents rail (Learn and Quiz)
// ---------------------------------------------------------------------------

function chapterStats(c){
  const its = T.items.filter((it) => it.chapter === c.id && ((it.onTimeline && (V.show === 'all' || it.key)) || it.keyIdea));
  const known = its.filter((it) => isKnown(V.mastery[it.id])).length;
  return { n: its.length, known };
}

function drawRail(){
  const el = root.querySelector('#tpRail');
  if(!el) return;
  const quiz = V.mode === 'quiz';
  const all = T.chapters.reduce((s, c) => { const x = chapterStats(c); s.n += x.n; s.known += x.known; return s; }, { n: 0, known: 0 });
  const row = (c) => {
    const s = chapterStats(c);
    if(!s.n) return '';
    const on = quiz ? V.chapters.has(c.id) : V.readAt === c.id;
    return `<button class="tp-toc ${on ? 'on' : ''}" data-toc="${c.id}" style="--c:${c.color}">
      <span class="dot"></span>
      <span class="tx"><span class="nm">${esc(c.title)}</span><span class="yr">${esc(fmtRange(c.from, c.to))}</span>
        <span class="tp-prog"><i style="width:${(100 * s.known / s.n).toFixed(0)}%"></i></span></span>
      <span class="k" title="${s.known} of ${s.n} answered right">${s.known}/${s.n}</span>
    </button>`;
  };
  el.innerHTML = `
    <div class="hd">${quiz ? 'Quiz on' : 'Contents'}</div>
    ${quiz ? `<button class="tp-toc ${V.chapters.size ? '' : 'on'}" data-toc="all" style="--c:#0f172a"><span class="dot"></span>
      <span class="tx"><span class="nm">Everything</span></span><span class="k">${all.known}/${all.n}</span></button>` : ''}
    ${T.chapters.map(row).join('')}
    <div class="ft tp-meta">${all.known} of ${all.n} ${V.show === 'key' ? 'essentials' : 'entries'} known.
      ${quiz ? 'Missed ones come back more often.' : 'Answer quiz questions to fill these bars.'}</div>`;
  el.insertAdjacentHTML('afterbegin', '<button class="tp-btn tp-mob tp-railx" data-act="toc" title="Close">✕</button>');
}

// ---------------------------------------------------------------------------
// Learn view
// ---------------------------------------------------------------------------

function paras(text){
  return String(text || '').split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
}

function drawLearn(){
  const host = root.querySelector('#tpScroll');
  const items = visibleItems({ ignoreChapters: true }).filter((it) => !V.matches || V.matches.has(it.id));
  const words = (s) => String(s || '').split(/\s+/).length;
  let total = words(T.intro);

  const row = (it) => {
    total += words(lineOf(it)) + 3;
    const known = isKnown(V.mastery[it.id]);
    return `
      <div class="tp-row ${it.key ? 'key' : ''} ${V.selected === it.id ? 'sel' : ''}" data-id="${esc(it.id)}">
        <div class="yr">${esc(fmtWhen(it))}</div>
        <div class="mid">
          <div class="t">${esc(it.title)}${known ? '<span class="ok" title="You answered this right">✓</span>' : ''}<span class="ty">${esc(TYPE_LABEL[it.type] || '')}</span></div>
          <div class="yr2">${esc(fmtWhen(it))}</div>
          ${lineOf(it) ? `<div class="s">${esc(lineOf(it))}</div>` : ''}
        </div>
        <div class="im">${it.image ? `<img src="${esc(thumbUrl(it.image, 120))}" loading="lazy" alt="" onerror="imgRetry(this)">` : ''}</div>
      </div>`;
  };

  /*
   * Key ideas: what a chapter is ABOUT when that is a concept rather than an
   * event (Energy, the Ideal gas law, Natural selection). Undated, so never on
   * the timeline; here they come first, defined in one sentence each, with
   * the article's own sentence when it has one.
   */
  const ideaRow = (it) => {
    const def = defOf(it);
    const ctx = it.context || it.note || '';
    total += words(def) + words(ctx) + 3;
    const known = isKnown(V.mastery[it.id]);
    return `
      <div class="tp-row tp-idea key ${V.selected === it.id ? 'sel' : ''}" data-id="${esc(it.id)}">
        <div class="yr">idea</div>
        <div class="mid">
          <div class="t">${esc(it.title)}${known ? '<span class="ok" title="You answered this right">✓</span>' : ''}</div>
          ${def ? `<div class="s">${esc(def)}</div>` : ''}
          ${ctx && !repeatsText(ctx, def) ? `<div class="s tp-ictx">${esc(summary(ctx, 260))}</div>` : ''}
        </div>
        <div class="im">${it.image ? `<img src="${esc(thumbUrl(it.image, 120))}" loading="lazy" alt="" onerror="imgRetry(this)">` : ''}</div>
      </div>`;
  };
  const chapterHtml = T.chapters.map((c, ci) => {
    const its = items.filter((it) => it.chapter === c.id).sort((a, b) => a.anchor - b.anchor);
    const ideas = T.items.filter((it) => it.chapter === c.id && (V.show === 'key' ? it.keyIdea : it.isIdea) && (!V.matches || V.matches.has(it.id)));
    if(!its.length && !ideas.length && (V.matches || V.subject)) return '';
    total += (c.points || []).reduce((n, x) => n + words(x), 0);
    total += words(c.intro);
    // Group by the article's own subsections, in the article's order. Entries
    // mentioned in the chapter's opening come first, without a heading.
    const order = [null, ...(c.subsections || []).map((s) => s.title)];
    const groups = order.map((sub) => ({ sub, its: its.filter((it) => (it.sub || null) === sub) })).filter((g) => g.its.length);
    const stray = its.filter((it) => !order.includes(it.sub || null));
    if(stray.length) groups.push({ sub: null, its: stray });
    const next = T.chapters.slice(ci + 1).find((n) => items.some((it) => it.chapter === n.id));
    return `
      <section class="tp-ch" id="ch-${c.id}" data-ch-sec="${c.id}">
        <div class="tp-chhd" style="--c:${c.color}">
          <div class="num">Chapter ${ci + 1}</div>
          <h2>${esc(c.title)}</h2>
          <div class="yr">${[fmtRange(c.from, c.to), its.length ? `${its.length} ${V.show === 'key' ? 'essentials' : 'entries'}` : '', ideas.length ? `${ideas.length} idea${ideas.length === 1 ? '' : 's'}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        ${c.intro && !V.matches ? `<div class="tp-intro" style="--c:${c.color}">${paras(c.intro)}</div>` : ''}
        ${c.points?.length && !V.matches ? pointsBox(c.points, c.color) : ''}
        ${ideas.length ? `<h3 class="tp-sub">Key ideas</h3>${ideas.map(ideaRow).join('')}${its.length ? '<h3 class="tp-sub">In order</h3>' : ''}` : ''}
        ${groups.map((g) => `
          ${g.sub ? `<h3 class="tp-sub">${esc(g.sub)}</h3>` : ''}
          ${g.its.map(row).join('')}`).join('')}
        ${(its.length >= 3 || ideas.length >= 2) && !V.matches ? `<div class="tp-chend">
          <button class="tp-btn primary" data-check="${c.id}">Test yourself on ${esc(c.title)} →</button>
          ${next ? `<button class="tp-btn" data-goch="${next.id}">Next: ${esc(next.title)} ↓</button>` : ''}
        </div>` : ''}
      </section>`;
  }).join('');

  const mins = Math.max(1, Math.round(total / 230));
  host.innerHTML = `<div class="tp-read">
    ${!V.matches ? `<header class="tp-head">
      <h1>${esc(T.title)}</h1>
      ${T.source.credit ? `<div class="tp-credit">Text by <a href="${esc(T.source.url)}" target="_blank" rel="noopener">${esc(T.source.credit)}</a>.
        Dates, pictures and the "About" sections come from Wikipedia.</div>` : ''}
      <div class="tp-meta">${T.chapters.length} chapters · ${items.length} ${V.show === 'key' ? 'essentials' : 'entries'} · about ${mins} min to read
        · from <a class="tp-src" href="${esc(T.source.url)}" target="_blank" rel="noopener">${esc(T.source.page)}</a>
        (${V.show === 'key' ? 'switch to <a href="#" data-show="all">Everything</a> for all ' + T.items.filter((it) => it.onTimeline).length : 'switch to <a href="#" data-show="key">Essentials</a> for the short version'})</div>
      ${T.intro ? `<div class="tp-intro lead">${paras(T.intro)}</div>` : ''}
      ${T.points?.length ? pointsBox(T.points, '#0f172a', 'In short') : ''}
    </header>` : ''}
    ${chapterHtml || '<div class="tp-empty">Nothing matches.</div>'}
  </div>`;

  // Scroll spy: the rail follows the chapter you are reading.
  let raf = 0;
  host.onscroll = () => {
    if(raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = host.getBoundingClientRect().top + 90;
      let cur = null;
      for(const s of host.querySelectorAll('[data-ch-sec]')) if(s.getBoundingClientRect().top <= top) cur = Number(s.dataset.chSec);
      if(cur !== V.readAt){ V.readAt = cur; savePrefs(); highlightRail(); }
    });
  };
  if(V.readAt != null && !V.restored){
    V.restored = true;
    root.querySelector(`#ch-${V.readAt}`)?.scrollIntoView({ block: 'start' });
  }
}

function highlightRail(){
  root.querySelectorAll('.tp-toc').forEach((b) => b.classList.toggle('on', Number(b.dataset.toc) === V.readAt));
  root.querySelector('.tp-toc.on')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Timeline view
// ---------------------------------------------------------------------------

function drawTimeline(){
  const host = root.querySelector('#tpScroll');
  setNarrow(narrow());
  const keepX = host.scrollLeft, keepW = host.scrollWidth || 1;
  // Essentials or everything; periods become bars in the eras track, and in
  // Essentials the free space fills with more entries as you zoom in.
  // Two layouts: cards (packed by importance) or lanes (events, people, works).
  const lanes = V.layout !== 'cards';
  const caps = narrow() ? { states: 2, rulers: 1, eras: 1 } : { states: 3, rulers: 2, eras: 2 };
  const opts = { show: V.show, ppy: V.ppy, lookup: (id) => T.byId.get(id), caps, pinned: V.pinned };
  const L = lanes ? layoutLanes(timelinePool(), { ...opts, measure: measureLabel }) : layoutTimeline(timelinePool(), opts);
  const { scale, pos } = L;
  const items = lanes ? L.items : L.cards;
  // Chapter bands only for a chronological article; without them the ticks move up.
  const head = T.chronological ? GEO.BANDS_H : 26;
  // Header tracks, each under a small label line: States & dynasties, Rulers, Eras & movements.
  const TRK_LABEL = 13;
  let hy = head + 2;
  const headerTracks = L.header.map((t) => { const y0 = hy; hy += TRK_LABEL + t.rows * BAR.ROW + 2; return { ...t, y0 }; });
  // Lanes: pinned lanes (any of them) stack in the frozen header under the ticks.
  const pinTop = head + 22;
  const bandsH = lanes ? (L.pinnedHeight ? pinTop + L.pinnedHeight + 8 : head) : headerTracks.length ? hy + 4 : head;
  const top = bandsH + (lanes ? 22 : 16);
  const height = top + (lanes ? L.height + 40 : L.laneCount * GEO.UNIT + 60);

  // Chapter bands: one row, or two when a chapter overlaps its neighbours.
  // Bands are eras. In a thematic article ("Female Impressionists", "Beyond
  // France") chapters overlap in time and the bands just pile up; there the
  // card's colour strip and the Chapter menu carry the chapter instead.
  const extent = new Map();
  const bands = T.chapters.map((c) => {
    const its = items.filter((it) => it.chapter === c.id);
    if(!its.length) return '';
    const x0 = lanes ? Math.min(...its.map((it) => pos.get(it.id).x)) - 8 : Math.min(...its.map((it) => pos.get(it.id).x)) - GEO.CARD_W / 2;
    const x1 = lanes ? Math.max(...its.map((it) => pos.get(it.id).x1)) + 8 : Math.max(...its.map((it) => pos.get(it.id).x)) + GEO.CARD_W / 2;
    extent.set(c.id, [x0, x1]);
    if(!T.chronological) return '';
    const row = c.overlaps ? 1 : 0;
    return `<div class="tp-band" data-band="${c.id}" style="left:${x0}px;width:${Math.max(40, x1 - x0)}px;top:${6 + row * 24}px;background:${c.color}"
      title="${esc(c.title)} · ${esc(fmtRange(c.from, c.to))} — click to fit"><span>${esc(c.title)} <i style="opacity:.75;font-weight:500;font-style:normal">${esc(fmtRange(c.from, c.to))}</i></span></div>`;
  }).join('');

  const tk = ticks(scale);
  const tickHtml = tk.map((t) => `<div class="tp-tick" style="left:${t.x}px;top:${head - 16}px">${esc(fmtYear(t.year, { short: true }))}</div>`).join('');
  const gridHtml = tk.map((t) => `<div class="tp-grid" style="left:${t.x}px;top:${bandsH}px;height:${height - bandsH}px"></div>`).join('');

  const brk = scale.breaks.map((b) => `
    <div class="tp-break" style="left:${b.x}px;width:${b.w}px;top:${bandsH}px;height:${height - bandsH}px">
      <span>${esc(gapLabel(b.years))}</span></div>`).join('');

  const chColor = new Map(T.chapters.map((c) => [c.id, c.color]));
  // The eras track (dynasties, kingdoms, eras) and the rulers track under it.
  const bar = (b, y, ruler) => {
    const c = ruler ? '#64748b' : chColor.get(b.it.chapter) || '#64748b';
    const dim = V.matches && !V.matches.has(b.it.id);
    return `<div class="tp-era${ruler ? ' ruler' : ''}${b.clipL ? ' clipl' : ''}${b.clipR ? ' clipr' : ''}${dim ? ' dim' : ''}${V.selected === b.it.id ? ' sel' : ''}" data-id="${esc(b.it.id)}"
      style="left:${b.x0}px;width:${b.x1 - b.x0}px;top:${y}px;--c:${c}" title="${esc(b.it.title)} · ${esc(fmtWhen(b.it))}">${b.x1 - b.x0 > 34 ? `<span>${esc(b.it.title)}</span>` : ''}</div>`;
  };
  // Cards: each header track under a small label line.
  const eraHtml = headerTracks.map((t) =>
    `<div class="tp-trk" style="top:${t.y0}px;width:${scale.width}px"><span class="tp-lanelab">${esc(t.label)}</span></div>`
    + t.bars.map((b) => bar(b, t.y0 + TRK_LABEL + b.row * BAR.ROW, t.key === 'rulers')).join('')).join('');
  const laneParts = lanes ? lanesHtml(L, top, pinTop, chColor, bar) : null;
  const cards = lanes ? laneParts.body : items.map((it) => {
    const p = pos.get(it.id);
    const y = top + p.lane * GEO.UNIT;
    const c = chColor.get(it.chapter) || '#64748b';
    const dim = V.matches && !V.matches.has(it.id);
    const person = it.type === 'person';
    // The line in the gap above the card: a life (people) or a duration.
    const line = p.line
      // Touching its card's top edge, in its colour: the card hangs from its
      // span. Halfway up the gap it read as the line of the card above.
      ? `<div class="${person ? 'tp-life' : 'tp-span'}${p.line.openL ? ' openl' : ''}${p.line.openR ? ' openr' : ''}${V.selected === it.id ? ' hl' : ''}" data-for="${esc(it.id)}" style="left:${p.line[0]}px;width:${p.line[1] - p.line[0]}px;top:${y - (person ? 2 : 3)}px;--lc:${c}"></div>` : '';
    const known = isKnown(V.mastery[it.id]) ? '<span class="ok">✓</span> ' : '';
    const when = esc(fmtWhen(it));
    const full = L.tiers.get(it.id) === 'full';
    const cls = `tp-card ${full ? 'full' : 'chip'} ${person ? 'person' : ''} ${dim ? 'dim' : ''} ${it.key ? '' : 'minor'} ${L.minor.has(it.id) ? 'fill' : ''} ${V.selected === it.id ? 'sel' : ''}`;
    const box = `data-id="${esc(it.id)}" style="--w:${GEO.CARD_W}px;--ih:${GEO.IMG_H}px;--h:${full ? GEO.CARD_H : GEO.CHIP_H}px;--c:${c};left:${p.x - GEO.CARD_W / 2}px;top:${y}px"`;
    if(full) return `${line}
      <div class="${cls}" ${box}>
        <div class="strip"></div>
        <img src="${esc(thumbUrl(it.image, 330))}" loading="lazy" alt="" onerror="imgRetry(this,'card')"><div class="noimg" style="display:none"></div>
        <div class="cap">
          <div class="t">${known}${esc(cardTitle(it.title, when))}</div>
          <div class="y">${when}${it.type ? ` · <span class="ty">${esc(TYPE_LABEL[it.type] || it.type)}</span>` : ''}</div>
        </div>
      </div>`;
    // A chip: date over title. A person's chip has a round portrait.
    const face = person && it.image ? `<img class="av" src="${esc(thumbUrl(it.image, 120))}" loading="lazy" alt="" onerror="imgRetry(this,'hide')">` : '';
    return `${line}
      <div class="${cls}" ${box}>
        ${face}
        <div class="tx">
          <div class="y">${when}${person ? '' : it.type && it.type !== 'event' ? ` · <span class="ty">${esc(TYPE_LABEL[it.type] || it.type)}</span>` : ''}</div>
          <div class="t">${known}${esc(cardTitle(it.title, when))}</div>
        </div>
      </div>`;
  }).join('');

  host.innerHTML = items.length ? `
    <div class="tp-canvas" style="width:${scale.width}px;height:${height}px">
      <div class="tp-bands" style="width:${scale.width}px;height:${bandsH}px">
        <div style="position:relative;height:100%">${bands}${tickHtml}${eraHtml}${lanes ? laneParts.head : ''}</div>
      </div>
      ${gridHtml}
      ${brk}
      ${cards}
    </div>` : '<div class="tp-empty">Nothing to show with these filters.</div>';

  // Keep the same proportional scroll position across zoom/filter changes. The
  // first time, start where the essentials start, not at the oldest outlier
  // (Impressionism opened on Dutch painting of 1568).
  if(!V.tlShown && !V.chapters.size){
    V.tlShown = true;
    const ys = items.filter((it) => it.key).map((it) => it.anchor).sort((a, b) => a - b);
    const y0 = ys[Math.floor(ys.length * 0.08)];
    if(y0 != null) host.scrollLeft = Math.max(0, scale.x(y0) - GEO.CARD_W);
    // (lanes start the same way: a little before the first essential)
  } else if(keepW > 1) host.scrollLeft = (keepX / keepW) * host.scrollWidth;
  V.scale = scale; V.pos = pos; V.extent = extent;
  // What ←/→ steps through on the timeline: what is drawn, cards and bars.
  const allBars = [...L.header.flatMap((t) => t.bars), ...(L.bars || [])];
  V.drawn = [...new Map([...items, ...allBars.map((b) => b.it)].map((it) => [it.id, it])).values()];
  for(const b of allBars) if(!pos.has(b.it.id)) pos.set(b.it.id, { x: (b.x0 + b.x1) / 2, bar: true });
  if(V.selected) markLinked(T.byId.get(V.selected));
  bindTimelineGestures(host);
  drawOverview();
}

/** Label width in px, as drawn in the lanes (11.5px Inter-like, bold for essentials). */
let measureCtx = null;
function measureLabel(text, bold){
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${bold ? 700 : 500} ${narrow() ? 12 : 11.5}px ${getComputedStyle(document.body).fontFamily}`;
  return Math.ceil(measureCtx.measureText(String(text)).width) + 2;
}

/** The lanes layout's marks: events, people and works, each in its own lane. */
function lanesHtml(L, top, pinTop, chColor, bar){
  // Two groups: pinned lanes go in the frozen header (from pinTop), the rest in the body (from top).
  const head = [], body = [];
  const at = (pinned) => (pinned ? pinTop : top);
  for(const ln of L.lanes){
    // A hairline over each lane with its name; the name slides into view with
    // the scroll, and clicking it pins the lane to the header (or unpins it).
    (ln.pinned ? head : body).push(`<div class="tp-lane" style="top:${at(ln.pinned) + ln.y0 - 13}px;width:${L.scale.width}px"><span class="tp-lanelab${ln.pinned ? ' pinned' : ''}" data-pin="${ln.key}"
      title="${ln.pinned ? 'Pinned: stays in view as you scroll down. Click to unpin.' : 'Click to pin: keep this lane in view as you scroll down.'}">${esc(ln.label)}</span></div>`);
  }
  for(const b of L.bars) (b.pinned ? head : body).push(bar(b, at(b.pinned) + b.y, b.track === 'rulers'));
  const out = { push: (pinned, html) => (pinned ? head : body).push(html) };
  for(const m of L.marks){
    const it = m.it;
    const c = chColor.get(it.chapter) || '#64748b';
    const dim = V.matches && !V.matches.has(it.id);
    const known = isKnown(V.mastery[it.id]) ? '<span class="ok">✓</span>' : '';
    const kind = m.lane === 'people' ? 'pe' : m.lane === 'works' ? 'wo' : m.lane === 'other' ? 'ot' : 'ev';
    const cls = `tp-ln ${kind}${it.key && !m.minor ? ' key' : ''}${m.minor ? ' fill' : ''}${m.bar ? ' lasted' : ''}${m.inside ? ' in' : ''}${dim ? ' dim' : ''}${V.selected === it.id ? ' sel' : ''}`;
    const av = kind === 'pe' && it.image ? `<img class="av" src="${esc(thumbUrl(it.image, 60))}" loading="lazy" alt="" onerror="imgRetry(this,'hide')">` : '';
    const mark = m.bar ? `<i class="bar" style="width:${m.x1 - m.x0}px"></i>` : `<i class="pt"></i>`;
    const lx = m.bar ? 1 : 7;
    // A bar's label slides along it as you scroll (drawOverview's sync), so a
    // life that began off screen still says whose it is.
    out.push(m.pinned, `<div class="${cls}" data-id="${esc(it.id)}" ${m.bar ? `data-w="${m.x1 - m.x0}" data-lw="${m.lw}"` : ''} style="left:${m.x0}px;top:${at(m.pinned) + m.y}px;width:${m.r - m.l}px;--c:${c}">${mark}<span class="lb" style="left:${lx}px;max-width:${m.lw + 2}px">${av}${known}${esc(it.title)}</span></div>`);
  }
  return { head: head.join(''), body: body.join('') };
}

/**
 * The overview strip: every chapter at its width on the canvas, with the part
 * you are looking at outlined. Click anywhere on it to go there; click a
 * chapter name to fit that chapter. Shows the way out of a chapter focus.
 */
function drawOverview(){
  const el = root.querySelector('#tpOver');
  const host = root.querySelector('#tpScroll');
  if(!el || !V.scale) return;
  const W = V.scale.width || 1;
  const segs = !T.chronological
    ? (() => { let last = -1e9; const k = (el.clientWidth || 800) / W; return ticks(V.scale).filter((t) => (t.x * k - last >= 72 ? (last = t.x * k, true) : false)); })().map((t) =>
      `<span class="yr" style="left:${(100 * t.x / W).toFixed(2)}%">${esc(fmtYear(t.year, { short: true }))}</span>`).join('')
    : T.chapters.filter((c) => V.extent.has(c.id)).map((c) => {
    const [x0, x1] = V.extent.get(c.id);
    return `<div class="seg" data-fit="${c.id}" style="left:${(100 * Math.max(0, x0) / W).toFixed(2)}%;width:${(100 * (x1 - x0) / W).toFixed(2)}%;background:${c.color}" title="${esc(c.title)} — click to fit">${esc(c.title)}</div>`;
  }).join('');
  el.innerHTML = `
    ${V.chapters.size ? `<button class="tp-btn sm" data-fit="all" title="Show every chapter">← All chapters</button>` : ''}
    <div class="strip" id="tpStrip">${segs}<div class="win" id="tpWin"></div></div>`;
  const win = el.querySelector('#tpWin');
  // An era bar or chapter band wider than the view keeps its name in view: the label slides
  // along the bar as you scroll, like a sticky heading.
  const laneLabs = [...host.querySelectorAll('.tp-lanelab')];
  const slides = [...host.querySelectorAll('.tp-ln[data-w]')].map((n) => ({ sp: n.querySelector('.lb'), x0: parseFloat(n.style.left), w: +n.dataset.w, lw: +n.dataset.lw }));
  const eras = [...host.querySelectorAll('.tp-era > span, .tp-band > span')].map((sp) => ({ sp, x0: parseFloat(sp.parentElement.style.left), w: parseFloat(sp.parentElement.style.width), lw: sp.offsetWidth }));
  const sync = () => {
    win.style.left = `${(100 * host.scrollLeft / W).toFixed(2)}%`;
    win.style.width = `${Math.min(100, 100 * host.clientWidth / W).toFixed(2)}%`;
    for(const n of laneLabs) n.style.transform = `translateX(${host.scrollLeft}px)`;
    // Past the lane names (about 110 px) so they never cover a label.
    for(const e of slides){
      const dx = Math.max(0, Math.min(host.scrollLeft + 110 - e.x0, e.w - e.lw - 4));
      e.sp.style.transform = dx ? `translateX(${dx}px)` : '';
    }
    for(const e of eras){
      const dx = Math.max(0, Math.min(host.scrollLeft - e.x0 + 4, e.w - e.lw - 14));
      e.sp.style.transform = dx ? `translateX(${dx}px)` : '';
    }
  };
  sync();
  // One listener: a redraw replaces the last one rather than adding another.
  if(host._sync) host.removeEventListener('scroll', host._sync);
  host._sync = sync;
  host.addEventListener('scroll', sync, { passive: true });
  el.querySelector('#tpStrip').onclick = (ev) => {
    if(ev.target.closest('[data-fit]')) return;      // a chapter: fitted by onClick
    const r = ev.currentTarget.getBoundingClientRect();
    host.scrollTo({ left: ((ev.clientX - r.left) / r.width) * W - host.clientWidth / 2, behavior: 'smooth' });
  };
}

/** Fit one chapter (or every chapter) to the width of the window. */
function fitChapter(id){
  const host = root.querySelector('#tpScroll');
  if(id === 'all'){ V.chapters.clear(); V.ppy = defaultPpy(T); }
  else {
    V.chapters = new Set([Number(id)]);
    const its = visibleItems();
    if(its.length > 1){
      const ys = its.map((it) => it.anchor);
      const span = Math.max(1, Math.max(...ys) - Math.min(...ys));
      const usable = Math.max(300, host.clientWidth - GEO.LEFT - GEO.RIGHT - GEO.CARD_W);
      V.ppy = Math.max(0.2, Math.min(80, usable / span));
    }
  }
  savePrefs();
  drawShell(); drawMode();
  root.querySelector('#tpScroll').scrollLeft = 0;
}

/** Drag the empty canvas to pan; the wheel scrolls through time when nothing scrolls vertically. */
function bindTimelineGestures(host){
  if(host.dataset.gestures) return;
  host.dataset.gestures = '1';
  let drag = null;
  host.addEventListener('pointerdown', (ev) => {
    if(ev.button !== 0 || ev.target.closest('.tp-card,.tp-band,.tp-era,.tp-ln,.tp-lanelab')) return;
    drag = { x: ev.clientX, y: ev.clientY, l: host.scrollLeft, t: host.scrollTop, moved: false };
    host.setPointerCapture(ev.pointerId);
  });
  host.addEventListener('pointermove', (ev) => {
    if(drag){
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if(Math.abs(dx) + Math.abs(dy) > 3){ drag.moved = true; host.classList.add('dragging'); }
      host.scrollLeft = drag.l - dx; host.scrollTop = drag.t - dy;
      return;
    }
    hover(ev);
  });
  const end = () => { drag = null; host.classList.remove('dragging'); };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('pointerleave', () => hover(null));
  host.addEventListener('wheel', (ev) => {
    if(ev.ctrlKey){ ev.preventDefault(); zoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15); return; }
    const vertical = host.scrollHeight > host.clientHeight + 4;
    if(!vertical && Math.abs(ev.deltaY) > Math.abs(ev.deltaX)){ ev.preventDefault(); host.scrollLeft += ev.deltaY; }
  }, { passive: false });
}

let hoverLine = null;
/** Hovering a card shows how the article puts it, without opening anything. */
function hover(ev){
  const tip = root?.querySelector('#tpHover');
  if(!tip) return;
  const card = ev?.target.closest?.('.tp-card,.tp-era,.tp-ln');
  // The hovered card's span line stands out, so it is clear whose it is.
  const hid = card?.classList.contains('tp-card') ? card.dataset.id : null;
  if(hid !== hoverLine){
    root.querySelectorAll('.tp-life.hv,.tp-span.hv').forEach((n) => n.classList.remove('hv'));
    if(hid) root.querySelector(`[data-for="${CSS.escape(hid)}"]`)?.classList.add('hv');
    hoverLine = hid;
  }
  if(!card || V.mode !== 'timeline'){ tip.classList.remove('on'); return; }
  const it = T.byId.get(card.dataset.id);
  if(!it) return;
  if(tip.dataset.id !== it.id){
    tip.dataset.id = it.id;
    tip.innerHTML = `<b>${esc(it.title)}</b> <span class="tp-meta">${esc(fmtWhen(it))}</span><div>${esc(summary(lineOf(it), 320))}</div>`;
  }
  const r = card.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 340, r.right + 8);
  tip.style.left = `${left < r.right ? Math.max(8, r.left - 338) : left}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - 160, r.top))}px`;
  tip.classList.add('on');
}

/** A card's title without a leading year its date line already shows ("1293 Kamakura earthquake" under "1293"). */
function cardTitle(title, when){
  const m = String(title).match(/^(\d{3,4})\s+(?=\p{Lu})/u);
  return m && String(when).includes(m[1]) ? title.slice(m[0].length) : title;
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
// Detail drawer
// ---------------------------------------------------------------------------

function showDetail(id, scroll = true){
  const it = T.byId.get(id);
  const el = root.querySelector('#tpDetail');
  if(!it || !el) return;
  V.selected = id;
  root.querySelectorAll('.tp-card.sel,.tp-row.sel,.tp-era.sel,.tp-ln.sel').forEach((n) => n.classList.remove('sel'));
  root.querySelectorAll(`.tp-card[data-id="${CSS.escape(id)}"],.tp-era[data-id="${CSS.escape(id)}"],.tp-ln[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('sel'));
  root.querySelectorAll('.tp-life.hl,.tp-span.hl').forEach((n) => n.classList.remove('hl'));
  root.querySelector(`[data-for="${CSS.escape(id)}"]`)?.classList.add('hl');
  markLinked(it);
  root.querySelector(`.tp-row[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  const ch = T.chapters[it.chapter];
  const list = stepList();
  const k = list.findIndex((x) => x.id === id);
  // Outside the current view (a related entry): step from where it would sit.
  const at = k >= 0 ? k : list.findIndex((x) => x.anchor > it.anchor);
  const undated = it.start == null || !!it.isIdea;
  const prev = undated ? null : k >= 0 ? list[k - 1] : list[(at < 0 ? list.length : at) - 1];
  const next = undated ? null : k >= 0 ? list[k + 1] : list[at < 0 ? list.length : at];
  const related = (it.related || []).map((r) => T.byId.get(r)).filter(Boolean).slice(0, 8);
  const m = V.mastery[it.id];
  // Wikipedia leads open with pronunciation and date clutter: "( ; (1643-01-04)4 January 1643 [O.S. 25 December 1642]".
  const about = String(it.excerpt || '')
    .replace(/\((\d{4}-\d\d-\d\d)\)/g, '').replace(/\s*\[O\.S\.[^\]]*\]/g, '')
    .replace(/\(\s*[;,]\s*/g, '(').replace(/\(\s*\)\s*/g, '').replace(/ {2,}/g, ' ')
    .split(/\n+/).filter(Boolean);
  const who = (it.who || []).map((x) => T.byId.get(x)).filter(Boolean);
  const did = (it.did || []).map((x) => T.byId.get(x)).filter((d) => d && d.start != null);
  el.classList.add('open');
  el.innerHTML = `
    <div class="hd">
      <button class="tp-btn" data-nav="-1" title="Earlier (←)" ${prev ? '' : 'disabled'}>←</button>
      <button class="tp-btn" data-nav="1" title="Later (→)" ${next ? '' : 'disabled'}>→</button>
      <span class="tp-meta" style="flex:1;text-align:center">${undated ? 'idea' : k >= 0 ? `${k + 1} of ${list.length}` : 'not in this view'}</span>
      <button class="tp-btn" data-act="close" title="Close (Esc)">✕</button>
    </div>
    ${it.image && !borrowedPortrait(it, (x) => T.byId.get(x)) ? `<a href="${esc(fullUrl(it.image))}" target="_blank" rel="noopener"><img src="${esc(thumbUrl(it.image, 960))}" alt="" onerror="imgRetry(this)"></a>` : ''}
    <div class="in">
      <h2>${esc(it.title)}</h2>
      <div class="sub">${[fmtWhen(it), it.subtitle].filter(Boolean).map(esc).join(' · ')}</div>
      ${undated && defOf(it) ? `<div class="tp-ctx" style="--c:#0f172a"><div class="lb">What it is</div>${esc(defOf(it))}</div>` : ''}
      <div style="margin-bottom:12px">
        ${ch ? `<span class="tp-badge" style="border-color:${ch.color};color:${ch.color}">${esc(ch.title)}</span>` : ''}
        <span class="tp-badge">${esc(it.isIdea ? 'Idea' : TYPE_LABEL[it.type] || it.type)}</span>
        ${it.key ? '<span class="tp-badge" style="border-color:#f59e0b;color:#b45309">Essential</span>' : ''}
        ${m ? `<span class="tp-badge" style="${isKnown(m) ? 'border-color:#16a34a;color:#15803d' : 'border-color:#f87171;color:#b91c1c'}">${isKnown(m) ? '✓ known' : 'missed'} · ${m.r}/${m.r + m.w}</span>` : ''}
      </div>
      ${who.length ? `<div class="tp-who">${who.map((p) => `<button class="tp-person" data-id="${esc(p.id)}">
        ${p.image ? `<img src="${esc(thumbUrl(p.image, 120))}" alt="" onerror="imgRetry(this,'hide')">` : ''}<span><b>${esc(p.title)}</b>
        <i>${esc(fmtWhen(p))}</i></span></button>`).join('')}</div>` : ''}
      ${about.length ? `<div class="tp-about">${about.slice(0, 1).map((p) => `<p>${esc(p)}</p>`).join('')}
        ${about.length > 1 ? `<details><summary>More about ${esc(it.title)}</summary>${about.slice(1).map((p) => `<p>${esc(p)}</p>`).join('')}</details>` : ''}</div>` : ''}
      ${did.length ? `<div class="lb">${esc(it.title)} on this timeline</div><div class="tp-did">${did.map((d) =>
        `<button class="tp-didrow" data-id="${esc(d.id)}"><span>${esc(fmtWhen(d))}</span>${esc(d.title)}</button>`).join('')}</div>` : ''}
      ${it.context ? `<div class="tp-ctx" style="--c:${ch?.color || '#cbd5e1'}">
        <div class="lb">In ${esc(T.source.page)}${it.sub ? ` · ${esc(it.sub)}` : ''}</div>${esc(it.context)}</div>` : ''}
      ${it.note ? `<div class="tp-ctx tp-note" style="--c:#94a3b8"><div class="lb">${esc(T.source.page)} on ${esc(it.title)}</div>${esc(it.note)}
        ${it.noteUrl ? ` <a class="tp-src" href="${esc(it.noteUrl)}" target="_blank" rel="noopener">Read on the site ↗</a>` : ''}</div>` : ''}
      ${(() => {
        const other = (members?.[it.id] || []).filter((x) => x !== T.slug);
        return other.length ? `<div class="lb">Also in</div><div class="tp-rel">${other.map((x) =>
          `<a class="tp-relc tp-also" href="#/topic/${esc(x)}" data-also="${esc(x)}">${esc(topicTitles?.get(x) || x)} →</a>`).join('')}</div>` : '';
      })()}
      ${related.length ? `<div class="lb">Connected</div><div class="tp-rel">${related.map((r) =>
        `<button class="tp-relc" data-id="${esc(r.id)}">${esc(r.title)} <span>${esc(fmtWhen(r))}</span></button>`).join('')}</div>` : ''}
      <div id="tpMeanwhile"></div>
      <div class="tp-nav2">
        ${prev ? `<button class="tp-btn" data-nav="-1">← ${esc(prev.title)}</button>` : '<span></span>'}
        ${next ? `<button class="tp-btn" data-nav="1">${esc(next.title)} →</button>` : ''}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        ${it.wiki ? `<a class="tp-src" href="${esc(it.wiki)}" target="_blank" rel="noopener">Full article on Wikipedia ↗</a>` : ''}
        ${V.mode !== 'timeline' && it.onTimeline ? `<a class="tp-src" href="#" data-act="ontl">Show on the timeline</a>` : ''}
      </div>
    </div>`;
  el.scrollTop = 0;
  if(!undated) drawMeanwhile(it);
  if(!scroll) return;
  if(V.mode === 'timeline' && V.pos?.get(id)){
    const host = root.querySelector('#tpScroll');
    const x = V.pos.get(id).x;
    if(x < host.scrollLeft + 80 || x > host.scrollLeft + host.clientWidth - 80){
      host.scrollTo({ left: x - host.clientWidth / 2, behavior: 'smooth' });
    }
  }
  if(V.mode === 'learn') root.querySelector(`.tp-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Fill the detail panel's Meanwhile block once all.json is in. */
async function drawMeanwhile(it){
  const slot = root.querySelector('#tpMeanwhile');
  if(!slot) return;
  const want = it.id;
  const M = await meanwhile(it, T.slug);
  if(V.selected !== want || !slot.isConnected || !M.groups.length) return;
  const range = `${fmtYear(Math.round(M.lo))}–${fmtYear(Math.round(M.hi))}`;
  slot.innerHTML = `<div class="lb">Meanwhile <span class="tp-mw-r">${esc(range)}</span></div>
    <div class="tp-mw">${M.groups.map((g) => `
      <div class="g"><div class="h">${esc(g.title)}${g.n > g.rows.length ? ` <span>+${g.n - g.rows.length}</span>` : ''}</div>
        ${g.rows.map((r) => `<a href="#/topic/${esc(r.x)}" data-mw="${esc(r.x)}" data-mwid="${esc(r.id)}" title="${esc(r.c || '')}">
          <span class="y">${esc(r.ty === "person" && r.y ? r.y : fmtYear(r.s))}</span> ${esc(r.t)}</a>`).join('')}
      </div>`).join('')}</div>`;
}

/** What ←/→ steps through: visible (and matching) entries, in time order. */
function stepList(){
  const ignore = V.mode === 'learn';
  return (V.mode === 'timeline' && V.drawn ? V.drawn : visibleItems({ ignoreChapters: ignore })).filter((it) => !V.matches || V.matches.has(it.id))
    .sort((a, b) => a.anchor - b.anchor || a.start - b.start);
}

function step(dir){
  const list = stepList();
  if(!list.length) return;
  let k = list.findIndex((it) => it.id === V.selected);
  if(k < 0){
    // From an entry outside the view: the nearest visible one in that direction.
    const cur = T.byId.get(V.selected);
    const at = cur ? list.findIndex((x) => x.anchor > cur.anchor) : 0;
    k = dir > 0 ? (at < 0 ? list.length - 1 : at) : Math.max(0, (at < 0 ? list.length : at) - 1);
  } else k = Math.max(0, Math.min(list.length - 1, k + dir));
  showDetail(list[k].id);
}

/** Light up the cards linked to the selected one: a person's doings, an event's people. */
function markLinked(it){
  root.querySelectorAll('.tp-card.rel,.tp-ln.rel').forEach((n) => n.classList.remove('rel'));
  for(const id of it ? [...(it.did || []), ...(it.who || [])] : []){
    root.querySelector(`.tp-card[data-id="${CSS.escape(id)}"],.tp-ln[data-id="${CSS.escape(id)}"]`)?.classList.add('rel');
  }
}

function closeDetail(){
  markLinked(null);
  V.selected = null;
  root.querySelector('#tpDetail')?.classList.remove('open');
  root.querySelectorAll('.tp-card.sel,.tp-row.sel,.tp-era.sel,.tp-ln.sel').forEach((n) => n.classList.remove('sel'));
  root.querySelectorAll('.tp-life.hl,.tp-span.hl').forEach((n) => n.classList.remove('hl'));
}

// ---------------------------------------------------------------------------
// Search: keywords in the browser, hybrid from the server when it is there.
// ---------------------------------------------------------------------------

async function runSearch(q){
  V.query = q;
  const my = ++searchSeq;
  if(!q.trim()){ V.matches = null; V.semantic = false; redraw(); return; }

  /*
   * A year or span ("1294", "1290s", "13th century") matches by DATE: what
   * happened, began or ended then, or was under way. Searching "1294" in the
   * Mongol Empire finds Kublai Khan (1215–1294), whose death split the empire;
   * as a keyword it found nothing. Words left over ("kublai 1294") narrow it.
   */
  const when = parseWhen(q);
  if(when){
    const words = when.rest ? new Set(kwIndex.search(when.rest, { limit: 400 }).map((h) => h.id)) : null;
    V.matches = new Set(T.items.filter((it) => it.start != null && it.start <= when.hi && (it.openEnded ? it.start : it.end ?? it.start) >= when.lo && (!words || words.has(it.id))).map((it) => it.id));
    V.semantic = false; V.when = when;
    if(V.show === 'key' && ![...V.matches].some((id) => T.byId.get(id)?.key)){ V.show = 'all'; drawShell(); }
    redraw();
    return;
  }
  V.when = null;
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
  if(V.mode === 'learn'){ drawLearn(); refreshCount(); return; }
  // Dim in place rather than rebuilding, so the scroll position and images stay put.
  root.querySelectorAll('.tp-card,.tp-era,.tp-ln').forEach((n) => n.classList.toggle('dim', !!V.matches && !V.matches.has(n.dataset.id)));
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
  const also = t.closest('[data-also]');
  if(also){ ev.preventDefault(); pendingSelect = V.selected; location.hash = `#/topic/${also.dataset.also}`; return; }
  const mw = t.closest('[data-mw]');
  if(mw){ ev.preventDefault(); pendingSelect = mw.dataset.mwid; location.hash = `#/topic/${mw.dataset.mw}`; return; }
  const b = t.closest('[data-act],[data-mode],[data-show],[data-toc],[data-zoom],[data-layout],[data-pin],[data-nav],[data-band],[data-fit],[data-check],[data-goch],[data-id]');
  if(!b) return;
  if(b.tagName === 'A' && b.getAttribute('href') === '#') ev.preventDefault();
  const host = root.querySelector('#tpScroll');
  if(b.dataset.act === 'list'){ location.hash = '#/topics'; return; }
  if(b.dataset.act === 'close'){ closeDetail(); return; }
  if(b.dataset.act === 'toc'){ root.querySelector('#tpRail')?.classList.toggle('open'); return; }
  if(b.dataset.act === 'atlas'){ localStorage.setItem('atlas:course', T.slug); window.openAtlas?.(); return; }
  if(b.dataset.act === 'ontl'){
    const id = V.selected;
    V.chapters.clear(); go('timeline');
    setTimeout(() => { if(V.pos?.get(id)) showDetail(id); }, 60);
    return;
  }
  if(b.dataset.mode){ V.chapters.clear(); go(b.dataset.mode); return; }
  if(b.dataset.show){ V.show = b.dataset.show; savePrefs(); drawShell(); drawMode(); return; }
  if(b.dataset.toc != null){
    root.querySelector('#tpRail')?.classList.remove('open');
    if(V.mode === 'quiz'){
      V.chapters = b.dataset.toc === 'all' ? new Set() : new Set([Number(b.dataset.toc)]);
      savePrefs(); drawMode();
    } else {
      root.querySelector(`#ch-${b.dataset.toc}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    return;
  }
  if(b.dataset.check != null){
    V.chapters = new Set([Number(b.dataset.check)]);
    savePrefs(); go('quiz');
    return;
  }
  if(b.dataset.goch != null){ root.querySelector(`#ch-${b.dataset.goch}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if(b.dataset.band != null || b.dataset.fit != null){
    // A click on the overview strip's empty part is handled by the strip itself.
    fitChapter(b.dataset.band ?? b.dataset.fit);
    return;
  }
  if(b.dataset.zoom){ zoom(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5); return; }
  if(b.dataset.pin){
    const k = b.dataset.pin;
    V.pinned = V.pinned.includes(k) ? V.pinned.filter((x) => x !== k) : [...V.pinned, k];
    localStorage.setItem(pinKey(), JSON.stringify(V.pinned));
    drawTimeline();
    return;
  }
  if(b.dataset.layout){ V.layout = b.dataset.layout; localStorage.setItem('topic:layout', V.layout); drawShell(); drawMode(); return; }
  if(b.dataset.nav){ step(Number(b.dataset.nav)); return; }
  if(b.dataset.id && V.mode !== 'quiz'){
    if(host?.classList.contains('dragging')) return;
    if(V.selected === b.dataset.id && (b.classList.contains('tp-card') || b.classList.contains('tp-era') || b.classList.contains('tp-ln'))){ closeDetail(); return; }
    showDetail(b.dataset.id);
  }
  else if(b.dataset.id && V.mode === 'quiz') showDetail(b.dataset.id);
}

function onKey(ev){
  if(!T || !V) return;
  if(ev.target.closest?.('input,textarea,select')) return;
  if(ev.key === 'Escape'){ closeDetail(); return; }
  if(V.mode === 'quiz') return;
  if(ev.key === 'ArrowRight'){ ev.preventDefault(); step(1); }
  else if(ev.key === 'ArrowLeft'){ ev.preventDefault(); step(-1); }
  else if(ev.key === '/'){ ev.preventDefault(); root.querySelector('#tpSearch')?.focus(); }
  else if((ev.key === '+' || ev.key === '=') && V.mode === 'timeline') zoom(1.5);
  else if(ev.key === '-' && V.mode === 'timeline') zoom(1 / 1.5);
}
