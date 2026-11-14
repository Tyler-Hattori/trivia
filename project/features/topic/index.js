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
 *   #/topics                      the list
 *   #/topic/<slug>                learn
 *   #/topic/<slug>/timeline       timeline
 *   #/topic/<slug>/quiz           quiz
 *   (#/topic/<slug>/read still works, as learn)
 *
 * Per-topic prefs and quiz memory live in localStorage.
 */

import { injectStyles } from './styles.js';
import { GEO, makeScale, ticks, pack, anchorYear, fmtYear, fmtRange, summary } from './layout.js';
import { bm25Index, docText } from '../../../datasets/lib/textsearch.mjs';
import { renderQuiz, loadMastery, isKnown } from './quiz.js';
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
  cache.set(slug, t);
  return t;
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

  root.innerHTML = `
    <div class="tp-bar">
      <button class="tp-btn" data-act="home" title="Home">←</button>
      <div class="tp-title">Topics</div>
      <input class="tp-search" id="tlSearch" placeholder="Search ${all.length} topics…  ( / )" value="${esc(L.q)}">
      <select class="tp-select" id="tlSort" title="Order">
        ${[['group', 'By shelf'], ['az', 'A–Z'], ['size', 'Largest first'], ['progress', 'Most known first']].map(([v, l]) =>
          `<option value="${v}" ${L.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="tp-spacer"></span>
      <span class="tp-meta">Each topic is one Wikipedia article as a short course: the story, a timeline, a quiz.</span>
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
          <div class="tp-meta">${esc(fmtYear(t.from))} – ${esc(fmtYear(t.to))} · ${t.chapters} ch · ${t.key} essentials</div>
          ${t.blurb ? `<div class="bl">${esc(t.blurb)}</div>` : ''}
          ${t.seen ? `<div class="tp-prog" title="${t.known} of ${t.key} essentials known"><i style="width:${Math.min(100, 100 * t.known / Math.max(1, t.key)).toFixed(0)}%"></i></div>` : ''}
        </div>
        <button class="x" data-hide="${esc(t.slug)}" title="${hidden.has(t.slug) ? 'Unhide' : 'Hide this topic'}">${hidden.has(t.slug) ? '↺' : '×'}</button>
      </div>`;

    const started = !q && !L.group ? vis.filter((t) => t.touched && !hidden.has(t.slug)).sort((a, b) => b.touched - a.touched).slice(0, 6) : [];
    let html = '';
    if(started.length) html += `<h2 class="tp-shelf">Continue</h2><div class="tp-tgrid">${started.map(card).join('')}</div>`;
    if(L.sort === 'group' && !L.group){
      for(const g of [...new Set(vis.map((t) => t.group))]){
        const its = vis.filter((t) => t.group === g);
        html += `<h2 class="tp-shelf">${esc(g)} <span class="tp-meta">${its.length}</span></h2><div class="tp-tgrid">${its.map(card).join('')}</div>`;
      }
    } else if(vis.length) html += `${started.length ? '<h2 class="tp-shelf">All</h2>' : ''}<div class="tp-tgrid">${vis.map(card).join('')}</div>`;
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
    if(ev.key === 'Enter'){ const first = root.querySelector('.tp-tcard'); if(first) location.hash = `#/topic/${first.dataset.topic}`; }
  };
  root.querySelector('#tlSort').onchange = (ev) => { L.sort = ev.target.value; draw(); };
  root.onclick = (ev) => {
    const b = ev.target.closest('[data-topic],[data-act],[data-group],[data-hide]');
    if(!b) return;
    if(b.dataset.hide){
      ev.stopPropagation();
      const h = new Set(L.hidden);
      if(h.has(b.dataset.hide)) h.delete(b.dataset.hide); else h.add(b.dataset.hide);
      L.hidden = [...h]; draw(); return;
    }
    if(b.dataset.act === 'home'){ location.hash = ''; return; }
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
// Topic
// ---------------------------------------------------------------------------

const prefsKey = (slug) => `topic:prefs:v2:${slug}`;

function loadPrefs(slug){
  try { return JSON.parse(localStorage.getItem(prefsKey(slug))) || {}; } catch { return {}; }
}
function savePrefs(){
  if(!T || !V) return;
  localStorage.setItem(prefsKey(T.slug), JSON.stringify({
    show: V.show, chapters: [...V.chapters], subject: V.subject, ppy: V.ppy, readAt: V.readAt,
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
      chapters: new Set(p.chapters || []),   // timeline/quiz focus; empty = every chapter
      subject: p.subject || '',
      ppy: p.ppy || defaultPpy(T),
      readAt: p.readAt ?? null,              // learn: chapter you were last reading
      query: '',
      matches: null,                         // Set of ids, or null when no search
      semantic: false,
      selected: null,
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
      <span class="tp-seg tp-modes">${tab('learn', 'Learn', 'The story, chapter by chapter')}${tab('timeline', 'Timeline', 'Everything on a time axis')}${tab('quiz', 'Quiz', 'Test yourself')}</span>
      <span class="tp-seg" title="Essentials: what the article leans on most. Everything: all it links to that has a date.">
        <button data-show="key" class="${V.show === 'key' ? 'on' : ''}">Essentials</button>
        <button data-show="all" class="${V.show === 'all' ? 'on' : ''}">Everything</button>
      </span>
      ${subs.length > 1 ? `<select class="tp-select" id="tpSubj" title="Only one kind of subject">
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
        <button class="tp-btn" data-zoom="out" title="Zoom out (−)">−</button>
        <button class="tp-btn" data-zoom="in" title="Zoom in (+)">+</button>` : ''}
      <button class="tp-btn" data-act="atlas" title="See this topic's entries among everything else on the atlas">Atlas ↗</button>
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
  el.textContent = `${n} match${n === 1 ? '' : 'es'}${V.semantic ? '' : ' (keywords)'}`;
}

// ---------------------------------------------------------------------------
// Contents rail (Learn and Quiz)
// ---------------------------------------------------------------------------

function chapterStats(c){
  const its = T.items.filter((it) => it.chapter === c.id && it.onTimeline && (V.show === 'all' || it.key));
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
        <div class="yr">${esc(it.yearText || fmtYear(it.start))}</div>
        <div class="mid">
          <div class="t">${esc(it.title)}${known ? '<span class="ok" title="You answered this right">✓</span>' : ''}<span class="ty">${esc(TYPE_LABEL[it.type] || '')}</span></div>
          ${lineOf(it) ? `<div class="s">${esc(lineOf(it))}</div>` : ''}
        </div>
        <div class="im">${it.image ? `<img src="${esc(thumbUrl(it.image, 120))}" loading="lazy" alt="" onerror="imgRetry(this)">` : ''}</div>
      </div>`;
  };

  const chapterHtml = T.chapters.map((c, ci) => {
    const its = items.filter((it) => it.chapter === c.id).sort((a, b) => a.anchor - b.anchor);
    if(!its.length && (V.matches || V.subject)) return '';
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
          <div class="yr">${[fmtRange(c.from, c.to), `${its.length} ${V.show === 'key' ? 'essentials' : 'entries'}`].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        ${c.intro && !V.matches ? `<div class="tp-intro" style="--c:${c.color}">${paras(c.intro)}</div>` : ''}
        ${groups.map((g) => `
          ${g.sub ? `<h3 class="tp-sub">${esc(g.sub)}</h3>` : ''}
          ${g.its.map(row).join('')}`).join('')}
        ${its.length >= 3 && !V.matches ? `<div class="tp-chend">
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
  const keepX = host.scrollLeft, keepW = host.scrollWidth || 1;
  const items = visibleItems();
  const scale = makeScale(items, V.ppy);
  const { pos, laneCount } = pack(items, scale);
  const laneH = GEO.CARD_H + GEO.LANE_GAP;
  const top = GEO.BANDS_H + 16;
  const height = top + laneCount * laneH + 60;

  // Chapter bands: one row, or two when a chapter overlaps its neighbours.
  // Bands are eras. In a thematic article ("Female Impressionists", "Beyond
  // France") chapters overlap in time and the bands just pile up; there the
  // card's colour strip and the Chapter menu carry the chapter instead.
  const extent = new Map();
  const bands = T.chapters.map((c) => {
    const its = items.filter((it) => it.chapter === c.id);
    if(!its.length) return '';
    const x0 = Math.min(...its.map((it) => pos.get(it.id).x)) - GEO.CARD_W / 2;
    const x1 = Math.max(...its.map((it) => pos.get(it.id).x)) + GEO.CARD_W / 2;
    extent.set(c.id, [x0, x1]);
    if(!T.chronological) return '';
    const row = c.overlaps ? 1 : 0;
    return `<div class="tp-band" data-band="${c.id}" style="left:${x0}px;width:${Math.max(40, x1 - x0)}px;top:${6 + row * 24}px;background:${c.color}"
      title="${esc(c.title)} · ${esc(fmtRange(c.from, c.to))} — click to fit">${esc(c.title)} <span style="opacity:.75;font-weight:500">${esc(fmtRange(c.from, c.to))}</span></div>`;
  }).join('');

  const tk = ticks(scale);
  const tickHtml = tk.map((t) => `<div class="tp-tick" style="left:${t.x}px;top:${GEO.BANDS_H - 16}px">${esc(fmtYear(t.year))}</div>`).join('');
  const gridHtml = tk.map((t) => `<div class="tp-grid" style="left:${t.x}px;top:${GEO.BANDS_H}px;height:${height - GEO.BANDS_H}px"></div>`).join('');

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
    const known = isKnown(V.mastery[it.id]);
    return `${span}
      <div class="tp-card ${dim ? 'dim' : ''} ${it.key ? '' : 'minor'} ${V.selected === it.id ? 'sel' : ''}" data-id="${esc(it.id)}"
        style="--w:${GEO.CARD_W}px;--ih:${GEO.IMG_H}px;left:${p.x - GEO.CARD_W / 2}px;top:${y}px">
        <div class="strip" style="background:${c}"></div>
        ${it.image
          // A dead image swaps to the text fallback that follows it. No text
          // inside the handler: an apostrophe ("Britain's") once broke it as JS.
          ? `<img src="${esc(thumbUrl(it.image, 330))}" loading="lazy" alt="" onerror="imgRetry(this,'card')"><div class="noimg" style="display:none">${esc(summary(lineOf(it), 180))}</div>`
          : `<div class="noimg">${esc(summary(lineOf(it), 180))}</div>`}
        <div class="cap">
          <div class="t">${known ? '<span class="ok">✓</span> ' : ''}${esc(it.title)}</div>
          <div class="y">${esc(it.yearText || fmtYear(it.start))}${it.type ? ` · <span class="ty">${esc(TYPE_LABEL[it.type] || it.type)}</span>` : ''}</div>
        </div>
      </div>`;
  }).join('');

  host.innerHTML = items.length ? `
    <div class="tp-canvas" style="width:${scale.width}px;height:${height}px">
      <div class="tp-bands" style="width:${scale.width}px;height:${GEO.BANDS_H}px">
        <div style="position:relative;height:100%">${bands}${tickHtml}</div>
      </div>
      ${gridHtml}
      ${brk}
      ${cards}
    </div>` : '<div class="tp-empty">Nothing to show with these filters.</div>';

  // Keep the same proportional scroll position across zoom/filter changes.
  if(keepW > 1) host.scrollLeft = (keepX / keepW) * host.scrollWidth;
  V.scale = scale; V.pos = pos; V.extent = extent;
  bindTimelineGestures(host);
  drawOverview();
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
    ? ticks(V.scale).filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 12)) === 0).map((t) =>
      `<span class="yr" style="left:${(100 * t.x / W).toFixed(2)}%">${esc(fmtYear(t.year))}</span>`).join('')
    : T.chapters.filter((c) => V.extent.has(c.id)).map((c) => {
    const [x0, x1] = V.extent.get(c.id);
    return `<div class="seg" data-fit="${c.id}" style="left:${(100 * Math.max(0, x0) / W).toFixed(2)}%;width:${(100 * (x1 - x0) / W).toFixed(2)}%;background:${c.color}" title="${esc(c.title)} — click to fit">${esc(c.title)}</div>`;
  }).join('');
  el.innerHTML = `
    ${V.chapters.size ? `<button class="tp-btn sm" data-fit="all" title="Show every chapter">← All chapters</button>` : ''}
    <div class="strip" id="tpStrip">${segs}<div class="win" id="tpWin"></div></div>`;
  const win = el.querySelector('#tpWin');
  const sync = () => {
    win.style.left = `${(100 * host.scrollLeft / W).toFixed(2)}%`;
    win.style.width = `${Math.min(100, 100 * host.clientWidth / W).toFixed(2)}%`;
  };
  sync();
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
    if(ev.button !== 0 || ev.target.closest('.tp-card,.tp-band')) return;
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

/** Hovering a card shows how the article puts it, without opening anything. */
function hover(ev){
  const tip = root?.querySelector('#tpHover');
  if(!tip) return;
  const card = ev?.target.closest?.('.tp-card');
  if(!card || V.mode !== 'timeline'){ tip.classList.remove('on'); return; }
  const it = T.byId.get(card.dataset.id);
  if(!it) return;
  if(tip.dataset.id !== it.id){
    tip.dataset.id = it.id;
    tip.innerHTML = `<b>${esc(it.title)}</b> <span class="tp-meta">${esc(it.yearText || fmtYear(it.start))}</span><div>${esc(summary(lineOf(it), 320))}</div>`;
  }
  const r = card.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 340, r.right + 8);
  tip.style.left = `${left < r.right ? Math.max(8, r.left - 338) : left}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - 160, r.top))}px`;
  tip.classList.add('on');
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
  root.querySelectorAll('.tp-card.sel,.tp-row.sel').forEach((n) => n.classList.remove('sel'));
  root.querySelector(`.tp-card[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  root.querySelector(`.tp-row[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  const ch = T.chapters[it.chapter];
  const list = stepList();
  const k = list.findIndex((x) => x.id === id);
  // Outside the current view (a related entry): step from where it would sit.
  const at = k >= 0 ? k : list.findIndex((x) => x.anchor > it.anchor);
  const prev = k >= 0 ? list[k - 1] : list[(at < 0 ? list.length : at) - 1];
  const next = k >= 0 ? list[k + 1] : list[at < 0 ? list.length : at];
  const related = (it.related || []).map((r) => T.byId.get(r)).filter(Boolean).slice(0, 8);
  const m = V.mastery[it.id];
  const about = String(it.excerpt || '').split(/\n+/).filter(Boolean);
  el.classList.add('open');
  el.innerHTML = `
    <div class="hd">
      <button class="tp-btn" data-nav="-1" title="Earlier (←)" ${prev ? '' : 'disabled'}>←</button>
      <button class="tp-btn" data-nav="1" title="Later (→)" ${next ? '' : 'disabled'}>→</button>
      <span class="tp-meta" style="flex:1;text-align:center">${k >= 0 ? `${k + 1} of ${list.length}` : 'not in this view'}</span>
      <button class="tp-btn" data-act="close" title="Close (Esc)">✕</button>
    </div>
    ${it.image ? `<a href="${esc(fullUrl(it.image))}" target="_blank" rel="noopener"><img src="${esc(thumbUrl(it.image, 960))}" alt="" onerror="imgRetry(this)"></a>` : ''}
    <div class="in">
      <h2>${esc(it.title)}</h2>
      <div class="sub">${esc(it.yearText || fmtYear(it.start))}${it.subtitle ? ` · ${esc(it.subtitle)}` : ''}</div>
      <div style="margin-bottom:12px">
        ${ch ? `<span class="tp-badge" style="border-color:${ch.color};color:${ch.color}">${esc(ch.title)}</span>` : ''}
        <span class="tp-badge">${esc(TYPE_LABEL[it.type] || it.type)}</span>
        ${it.key ? '<span class="tp-badge" style="border-color:#f59e0b;color:#b45309">Essential</span>' : ''}
        ${m ? `<span class="tp-badge" style="${isKnown(m) ? 'border-color:#16a34a;color:#15803d' : 'border-color:#f87171;color:#b91c1c'}">${isKnown(m) ? '✓ known' : 'missed'} · ${m.r}/${m.r + m.w}</span>` : ''}
      </div>
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
        `<button class="tp-relc" data-id="${esc(r.id)}">${esc(r.title)} <span>${esc(fmtYear(r.start))}</span></button>`).join('')}</div>` : ''}
      ${about.length ? `<div class="lb">About ${esc(it.title)}</div>
        <div class="tp-about">${about.slice(0, 1).map((p) => `<p>${esc(p)}</p>`).join('')}
        ${about.length > 1 ? `<details><summary>More</summary>${about.slice(1).map((p) => `<p>${esc(p)}</p>`).join('')}</details>` : ''}</div>` : ''}
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

/** What ←/→ steps through: visible (and matching) entries, in time order. */
function stepList(){
  const ignore = V.mode === 'learn';
  return visibleItems({ ignoreChapters: ignore }).filter((it) => !V.matches || V.matches.has(it.id))
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

function closeDetail(){
  V.selected = null;
  root.querySelector('#tpDetail')?.classList.remove('open');
  root.querySelectorAll('.tp-card.sel,.tp-row.sel').forEach((n) => n.classList.remove('sel'));
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
  if(V.mode === 'learn'){ drawLearn(); refreshCount(); return; }
  // Dim in place rather than rebuilding, so the scroll position and images stay put.
  root.querySelectorAll('.tp-card').forEach((n) => n.classList.toggle('dim', !!V.matches && !V.matches.has(n.dataset.id)));
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
  const b = t.closest('[data-act],[data-mode],[data-show],[data-toc],[data-zoom],[data-nav],[data-band],[data-fit],[data-check],[data-goch],[data-id]');
  if(!b) return;
  if(b.tagName === 'A' && b.getAttribute('href') === '#') ev.preventDefault();
  const host = root.querySelector('#tpScroll');
  if(b.dataset.act === 'list'){ location.hash = '#/topics'; return; }
  if(b.dataset.act === 'close'){ closeDetail(); return; }
  if(b.dataset.act === 'atlas'){ localStorage.setItem('atlas:course', T.slug); window.openAtlas?.(); return; }
  if(b.dataset.act === 'ontl'){
    const id = V.selected;
    V.chapters.clear(); go('timeline');
    setTimeout(() => { if(V.pos?.get(id)) showDetail(id); }, 60);
    return;
  }
  if(b.dataset.mode){ go(b.dataset.mode); return; }
  if(b.dataset.show){ V.show = b.dataset.show; savePrefs(); drawShell(); drawMode(); return; }
  if(b.dataset.toc != null){
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
  if(b.dataset.nav){ step(Number(b.dataset.nav)); return; }
  if(b.dataset.id && V.mode !== 'quiz'){
    if(host?.classList.contains('dragging')) return;
    if(V.selected === b.dataset.id && b.classList.contains('tp-card')){ closeDetail(); return; }
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
