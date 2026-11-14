/*
 * The quiz for one topic. Three modes, each aimed at a different part of
 * actually knowing a subject:
 *
 *   Order   put four events in chronological order. The skill a timeline is
 *           for — "piecing several events together" — and much more learnable
 *           than recalling one year in isolation. Drawn from the same or
 *           neighbouring chapters, so it tests sequence, not era.
 *   Era     which chapter does this belong to? Periodisation is the skeleton
 *           everything else hangs on, and the chapters are the article's own.
 *   Ideas   which idea is this? Its definition with the name blanked out, and
 *           four names from the same topic. For what a chapter is ABOUT when
 *           that is a concept (Energy, Natural selection), which has no date.
 *   Recall  the existing typed questions (year, span, artist, role…) from
 *           quiz/questions.js, minus year questions for places and concepts —
 *           "What year: Trinovantes?" is not a question.
 *
 * The pool honours the topic page's Essentials/Everything, chapter and subject
 * filters.
 *
 * ## Memory: spaced repetition
 *
 * Every answer is recorded per entry in localStorage (`topic:mastery:<slug>`):
 * right and wrong counts, whether the LAST answer was right, a Leitner box and
 * when it is next due. Right moves an entry up a box (due again in 1, 3, 7, 16,
 * 35, then 90 days); wrong sends it back to box 0 (due in 10 minutes). Questions
 * are drawn weighted towards what is due, missed or never seen. The home page's
 * Review collects everything due across all topics. "Known" (the ticks and
 * progress bars) still means the last answer was right.
 *
 * A quiz over several topics (#/quiz, #/review) passes a synthetic topic whose
 * item ids are "<slug>|<entry id>"; `memOf` and `remember` route each answer to
 * the topic it belongs to, so it counts there too.
 */

import { questionsFor, gradeField } from '../quiz/questions.js';
import { thumbUrl } from '../../utils/helpers.js';
import { fmtYear, summary } from './layout.js';
import { parseWhen } from './search.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DATE_TYPES = new Set(['event', 'person', 'work', 'period']);
const UNFAIR = new Set(['facet:occupation', 'facet:country', 'facet:category', 'facet:field', 'facet:region']);
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const shuffle = (a) => { for(let i = a.length - 1; i > 0; i--){ const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let Q = null;   // quiz state, kept across redraws of the same topic
let keysBound = false;

// --- memory ------------------------------------------------------------------

const MEM_PREFIX = 'topic:mastery:';
const memKey = (slug) => `${MEM_PREFIX}${slug}`;
export function loadMastery(slug){
  try { return JSON.parse(localStorage.getItem(memKey(slug))) || {}; } catch { return {}; }
}
/** Known = answered at least once, and right the last time. */
export const isKnown = (m) => !!m && m.last === 1;

const MIN = 60e3, DAY = 864e5;
const INTERVALS = [10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY, 90 * DAY];
/** When an entry is next due. Records from before boxes existed: a day after a right answer, ten minutes after a wrong one. */
export const dueAt = (m) => (!m ? Infinity : m.due ?? (m.at || 0) + (m.last ? DAY : 10 * MIN));
export const isDue = (m, now = Date.now()) => !!m && dueAt(m) <= now;

/** Record one answer for one entry of one topic. */
export function recordAnswer(slug, id, ok){
  const m = loadMastery(slug);
  const x = m[id] || { r: 0, w: 0, last: 0 };
  const box = x.box ?? (x.last ? 1 : 0);
  if(ok) x.r++; else x.w++;
  x.last = ok ? 1 : 0;
  x.box = ok ? Math.min(INTERVALS.length - 1, box + 1) : 0;
  x.at = Date.now();
  x.due = x.at + INTERVALS[x.box];
  m[id] = x;
  localStorage.setItem(memKey(slug), JSON.stringify(m));
}

/** Everything due, across every topic: { n, per: { slug: count }, next: ms until the next one }. */
export function dueSummary(now = Date.now()){
  const per = {};
  let n = 0, next = Infinity;
  for(let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if(!k?.startsWith(MEM_PREFIX)) continue;
    const slug = k.slice(MEM_PREFIX.length);
    for(const x of Object.values(loadMastery(slug))){
      const d = dueAt(x);
      if(d <= now){ per[slug] = (per[slug] || 0) + 1; n++; }
      else next = Math.min(next, d - now);
    }
  }
  return { n, per, next };
}

const memOf = (T) => (T.loadMem ? T.loadMem() : loadMastery(T.slug));

function remember(ids, ok){
  for(const id of [].concat(ids)){
    const [slug, eid] = Q.T.memRef ? Q.T.memRef(id) : [Q.T.slug, id];
    recordAnswer(slug, eid, ok);
  }
  Q.mem = memOf(Q.T);
  Q.opts.onAnswer?.();
}

/** Weighted pick: due and missed entries most, unseen next, known ones rarely. */
function pickWeighted(pool){
  const now = Date.now();
  const w = pool.map((it) => {
    const m = Q.mem[it.id];
    if(!m) return 3;
    if(m.last === 0) return 5;
    if(isDue(m, now)) return 4;
    return m.w > 0 ? 0.6 : 0.25;
  });
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for(let i = 0; i < pool.length; i++){ r -= w[i]; if(r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

// --- settings --------------------------------------------------------------------

/*
 * The quiz is a session: a length (10, 20, 50 or endless), a mix of question
 * kinds, a focus (everything / weak spots / only new) and optionally a span of
 * years. Saved in localStorage and shared by every quiz (a topic's, Quiz,
 * Review), because they are the same habits.
 */
const SET_KEY = 'quiz:settings:v1';
const KINDS = ['order', 'recall', 'ideas', 'era'];
const DEFAULTS = { length: 20, kinds: { order: true, recall: true, ideas: true, era: true }, focus: 'mixed', years: '' };
export function loadSettings(){
  try { const s = JSON.parse(localStorage.getItem(SET_KEY)) || {}; return { ...DEFAULTS, ...s, kinds: { ...DEFAULTS.kinds, ...(s.kinds || {}) } }; }
  catch { return { ...DEFAULTS, kinds: { ...DEFAULTS.kinds } }; }
}
const saveSettings = (x) => localStorage.setItem(SET_KEY, JSON.stringify(x));

function restart(){
  const { T, opts, host } = Q;
  Q = null;
  renderQuiz(host, T, opts);
}

export function renderQuiz(host, T, opts){
  const { show, chapters, subjects = new Set() } = opts;
  const key = `${T.slug}|${show}|${[...chapters].sort()}|${[...subjects].sort()}|${T.reviewOnly ? 'review' : ''}`;
  if(!Q || Q.key !== key){
    Q = { key, T, mode: Q?.mode || 'order', right: 0, total: 0, streak: 0, cur: null, host, showSet: Q?.showSet || false };
    Q.set = loadSettings();
    Q.sess = { n: 0, right: 0, log: [] };
    // An optional span of years narrows the pool (ideas have none, so they go).
    Q.when = Q.set.years ? parseWhen(Q.set.years) : null;
    const inYears = (it) => !Q.when || (it.start != null && it.start <= Q.when.hi && (it.end ?? it.start) >= Q.when.lo);
    Q.pool = T.items.filter((it) => it.onTimeline && (show === 'all' || it.key) && inYears(it) &&
      (!chapters.size || chapters.has(it.chapter)) && (!subjects.size || subjects.has(it.subject)));
    Q.scope = chapters.size === 1 ? T.chapters[[...chapters][0]]?.title : null;
    // Ideas in scope; distractors may come from anywhere in the topic.
    Q.ideas = Q.when ? [] : T.items.filter((it) => (show === 'all' ? it.isIdea : it.keyIdea) && (!chapters.size || chapters.has(it.chapter)) && defOf(it));
    Q.allIdeas = T.items.filter((it) => it.isIdea && defOf(it));
    Q.mem = memOf(T);
    Q.opts = opts;
    next();
  }
  Q.opts = opts;
  Q.host = host;
  draw();
}

/**
 * What a question may be ABOUT. Normally the whole pool; in a review session
 * only what is due (an Order question still borrows undue neighbours).
 */
function seeds(pool = Q.pool){
  const now = Date.now();
  if(Q.T.reviewOnly) return pool.filter((it) => isDue(Q.mem[it.id], now));
  // Focus: weak spots = missed last time or due again; new = never answered.
  if(Q.set.focus === 'weak') return pool.filter((it) => { const m = Q.mem[it.id]; return m && (m.last === 0 || isDue(m, now)); });
  if(Q.set.focus === 'new') return pool.filter((it) => !Q.mem[it.id]);
  return pool;
}

const MAKERS = () => ({ order: makeOrder, era: makeEra, recall: makeRecall, ideas: makeIdeas });
function next(){
  Q.cur = null;
  if(Q.set.length && Q.sess.n >= Q.set.length){ Q.cur = { kind: 'end' }; return; }
  // A random kind among those switched on; if it cannot make a question here
  // (a chapter with three entries cannot be put in order), the next one.
  let kinds = KINDS.filter((k) => Q.set.kinds[k]);
  if(!kinds.length) kinds = [...KINDS];
  for(let i = kinds.length - 1; i > 0; i--){ const j = rnd(i + 1); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  for(const mode of kinds){
    const make = MAKERS()[mode];
    for(let tries = 0; tries < 40 && !Q.cur; tries++) Q.cur = make();
    if(Q.cur){ Q.mode = mode; return; }
  }
}

// --- Order -------------------------------------------------------------------

function makeOrder(){
  const pool = Q.pool.filter((it) => DATE_TYPES.has(it.type));
  const from = seeds().filter((it) => DATE_TYPES.has(it.type));
  if(pool.length < 4 || !from.length) return null;
  const seed = pickWeighted(from);
  // Neighbours: same chapter or adjacent, so the question is about sequence
  // within a stretch of history rather than "which is the Roman one". Across
  // topics, the nearest in time: "which came first, X in Japan or Y in France".
  const near = Q.T.synthetic
    ? pool.filter((it) => it !== seed).sort((a, b) => Math.abs(a.anchor - seed.anchor) - Math.abs(b.anchor - seed.anchor)).slice(0, 14)
    : pool.filter((it) => it !== seed && Math.abs(it.chapter - seed.chapter) <= 1);
  const src = near.length >= 6 ? near : pool.filter((it) => it !== seed);
  const chosen = [seed];
  for(const it of shuffle([...src])){
    // Distinct enough that the order is a fact, not a coin toss on circa dates.
    if(chosen.every((c) => Math.abs(c.anchor - it.anchor) >= 2)) chosen.push(it);
    if(chosen.length === 4) break;
  }
  if(chosen.length < 4) return null;
  return { kind: 'order', items: shuffle(chosen), picked: [], done: false };
}

// --- Ideas -------------------------------------------------------------------

/** An idea's definition: the first sentence of its own lead. */
const defOf = (it) => it.def || summary(String(it.excerpt || '').split(/(?<=[.!?])\s+(?=[A-Z])/)[0], 260);
const GENERIC = new Set(['the', 'and', 'law', 'laws', 'theory', 'principle', 'effect', 'of', 'in', 'on']);
/** Blank the idea's own name out of its definition, or the question answers itself. */
function mask(text, title){
  const plain = String(title).replace(/\s*\([^)]*\)$/, '');
  let out = String(text).replace(new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '▁▁▁');
  for(const w of plain.split(/[\s'’-]+/)){
    if(w.length < 4 || GENERIC.has(w.toLowerCase())) continue;
    out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/s$/i, '')}\\w*`, 'gi'), '▁▁▁');
  }
  return out;
}

function makeIdeas(){
  const from = seeds(Q.ideas);
  if(!from.length || Q.allIdeas.length < 4) return null;
  const it = pickWeighted(from);
  // Distractors: same chapter first (the confusable ones), then same topic.
  const near = Q.allIdeas.filter((x) => x !== it && x.title !== it.title);
  const same = shuffle(near.filter((x) => x.chapter === it.chapter));
  const other = shuffle(near.filter((x) => x.chapter !== it.chapter));
  const opts = [];
  for(const x of [...same, ...other]){ if(!opts.some((o) => o.title === x.title)) opts.push(x); if(opts.length === 3) break; }
  if(opts.length < 3) return null;
  return { kind: 'ideas', item: it, prompt: mask(defOf(it), it.title), options: shuffle([it, ...opts]), chosen: null };
}

function drawIdeas(c){
  const done = c.chosen != null;
  return `<div class="tp-q">
    <h3>Which idea is this?</h3>
    <div class="tp-defq">${esc(c.prompt)}</div>
    ${c.options.map((o) => {
      const cls = !done ? '' : o.id === c.item.id ? 'ok' : o.id === c.chosen ? 'bad' : '';
      return `<button class="tp-opt ${cls}" data-idea="${esc(o.id)}" ${done ? 'disabled' : ''}>${card(o)}</button>`;
    }).join('')}
    ${done ? reveal(c.item) : ''}
  </div>`;
}

// --- Era ---------------------------------------------------------------------

function makeEra(){
  if(Q.scope || Q.T.synthetic) return null;     // "which chapter?" while quizzing on one chapter is a giveaway
  const chs = Q.T.chapters.filter((c) => Q.T.items.some((it) => it.onTimeline && it.chapter === c.id));
  const from = seeds();
  if(chs.length < 3 || !from.length) return null;
  const it = pickWeighted(from);
  const right = Q.T.chapters[it.chapter];
  // The right chapter plus up to three others, preferring its neighbours —
  // "Tudor or Stuart?" is the useful distinction, "Tudor or Roman?" is not.
  const others = chs.filter((c) => c.id !== right.id).sort((a, b) => Math.abs(a.id - right.id) - Math.abs(b.id - right.id)).slice(0, 3);
  return { kind: 'era', item: it, options: [right, ...others].sort((a, b) => a.id - b.id), answer: right.id, chosen: null };
}

// --- Recall --------------------------------------------------------------------

function makeRecall(){
  const from = seeds();
  if(!from.length) return null;
  const it = pickWeighted(from);
  const e = { ...it, x0: it.start, x1: it.end ?? it.start, isSpan: it.kind === 'span', dataset: Q.T.title };
  const q = questionsFor(e);
  if(!DATE_TYPES.has(it.type)) q.fields = q.fields.filter((f) => f.key !== 'year' && f.key !== 'span');
  // Inside one topic, "Country" is nearly always the topic itself, and
  // "Occupation" is a raw Wikidata list ("military personnel, land owner,
  // administrator" for Owain Glyndŵr). Neither is a fair question.
  q.fields = q.fields.filter((f) => !UNFAIR.has(f.key));
  if(!q.fields.length) return null;
  return { kind: 'recall', item: it, e, q, marks: null };
}

// --- Drawing -------------------------------------------------------------------

function draw(){
  const c = Q.cur;
  const now = Date.now();
  const known = Q.pool.filter((it) => isKnown(Q.mem[it.id])).length;
  const due = Q.pool.filter((it) => isDue(Q.mem[it.id], now)).length;
  const what = Q.T.reviewOnly ? `Review${Q.scope ? `: <b>${esc(Q.scope)}</b>` : ''}` : Q.scope ? `Quiz: <b>${esc(Q.scope)}</b>` : `Quiz: <b>${Q.T.synthetic ? '' : 'all of '}${esc(Q.T.title)}</b>`;
  const head = `
    <div class="tp-qhead">${what}
      <span class="tp-meta">· ${Q.T.reviewOnly ? `${due} due` : `${known} of ${Q.pool.length} known${due ? `, ${due} due for review` : ''}`}</span></div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="tp-qprog">${Q.set.length ? `Question <b>${Math.min(Q.sess.n + (isDone() ? 0 : 1), Q.set.length)}</b> of ${Q.set.length}` : `<b>${Q.sess.n}</b> answered`}${c && c.kind !== 'end' ? ` · ${esc(MODE_NAME[c.kind] || '')}` : ''}</span>
      <span class="tp-spacer"></span>
      <span class="tp-score"><span><b>${Q.sess.right}</b>/${Q.sess.n} right</span><span>streak <b>${Q.streak}</b></span></span>
      <button class="tp-btn sm ${Q.showSet ? 'primary' : ''}" data-qact="settings" title="Length, kinds of question, focus, years">⚙ Settings</button>
    </div>
    ${Q.set.length ? `<div class="tp-qbar"><i style="width:${(100 * Q.sess.n / Q.set.length).toFixed(1)}%"></i></div>` : ''}
    ${Q.showSet ? drawSettings() : ''}`;
  let body = '';
  if(!c && Q.T.reviewOnly) body = `<div class="tp-q"><h3>All caught up</h3><div class="tp-meta">Nothing is due${Q.scope ? ' here' : ''}. Answers you get right come back after 1, 3, 7, 16, 35 and 90 days; misses come back in ten minutes.</div>
    ${Q.opts.onWiden ? '<button class="tp-btn primary" style="margin-top:12px" data-qact="widen">Quiz everything instead →</button>' : ''}</div>`;
  else if(!c) body = `<div class="tp-q">Not enough entries for a question here.
    ${Q.opts.onWiden ? '<button class="tp-btn primary" style="margin-left:8px" data-qact="widen">Quiz on everything →</button>' : ''}</div>`;
  else if(c.kind === 'end') body = drawEnd();
  else if(c.kind === 'order') body = drawOrder(c);
  else if(c.kind === 'era') body = drawEra(c);
  else if(c.kind === 'ideas') body = drawIdeas(c);
  else body = drawRecall(c);
  Q.host.innerHTML = `<div class="tp-quiz">${head}${body}</div>`;
  Q.host.onclick = onClick;
  const first = Q.host.querySelector('.tp-in:not([disabled])');
  if(first) first.focus();
  // On the document, not the host: a redraw drops focus to <body>, and Enter
  // for "Next" has to keep working after a click.
  if(!keysBound){
    keysBound = true;
    document.addEventListener('keydown', (ev) => {
      if(!Q?.host?.isConnected || ev.key !== 'Enter' || ev.target.closest?.('select')) return;
      ev.preventDefault();
      if(Q.cur?.kind === 'recall' && !Q.cur.marks) gradeRecall(); else if(isDone()) { next(); draw(); }
    });
  }
}

const MODE_NAME = { order: 'Order', era: 'Era', recall: 'Recall', ideas: 'Ideas' };
const isDone = () => { const c = Q.cur; return c && (c.kind === 'order' ? c.done : c.kind === 'era' || c.kind === 'ideas' ? c.chosen != null : !!c.marks); };

function card(it, extra = ''){
  return `<div style="display:flex;gap:12px;align-items:center">
    ${it.image ? `<img src="${esc(thumbUrl(it.image, 120))}" style="width:56px;height:44px;object-fit:contain;background:#f8fafc;border-radius:6px" alt="" onerror="imgRetry(this,'hide')">` : ''}
    <div style="flex:1"><b>${esc(it.title)}</b>${extra}</div></div>`;
}

function drawOrder(c){
  const sorted = [...c.items].sort((a, b) => a.anchor - b.anchor);
  return `<div class="tp-q">
    <h3>Put these in order, earliest first</h3>
    <div class="tp-meta" style="margin-bottom:8px">Click them in order. ${c.picked.length && !c.done ? '<a href="#" data-qact="undo">undo</a>' : ''}</div>
    ${c.items.map((it) => {
      const k = c.picked.indexOf(it.id);
      const cls = c.done ? (sorted[k]?.id === it.id ? 'ok' : 'bad') : '';
      return `<button class="tp-opt ${cls}" data-pick="${esc(it.id)}" ${c.done ? 'disabled' : ''}>
        ${card(it, c.done ? ` <span class="tp-meta">· ${esc(it.yearText || fmtYear(it.start))}</span>` : '')}
        <span class="num ${k < 0 ? 'empty' : ''}" style="position:relative;float:right;margin-top:-30px">${k < 0 ? '' : k + 1}</span>
      </button>`;
    }).join('')}
    ${c.done ? `<div style="margin-top:12px"><div class="tp-meta" style="margin-bottom:4px">Correct order</div>
      ${sorted.map((it, i) => `<div class="tp-ordr"><b>${i + 1}. ${esc(it.yearText || fmtYear(it.start))}</b> — <a href="#" data-open="${esc(it.id)}">${esc(it.title)}</a>
        <div class="tp-meta">${esc(summary(it.context || it.excerpt, 200))}</div></div>`).join('')}
      <button class="tp-btn primary" style="margin-top:12px" data-qact="next">Next → <span class="tp-meta" style="color:#cbd5e1">Enter</span></button></div>` : ''}
  </div>`;
}

function drawEra(c){
  const it = c.item;
  const done = c.chosen != null;
  return `<div class="tp-q">
    ${it.image ? `<img src="${esc(thumbUrl(it.image, 500))}" style="width:100%;max-height:300px;object-fit:contain;background:#f8fafc;border-radius:12px;margin-bottom:12px" alt="" onerror="imgRetry(this)">` : ''}
    <h3>${esc(it.title)}</h3>
    <div class="tp-meta" style="margin-bottom:8px">Which chapter of ${esc(Q.T.title)} does this belong to?</div>
    ${c.options.map((o) => {
      const cls = !done ? '' : o.id === c.answer ? 'ok' : o.id === c.chosen ? 'bad' : '';
      return `<button class="tp-opt ${cls}" data-era="${o.id}" ${done ? 'disabled' : ''}>
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${o.color};margin-right:8px"></span>${esc(o.title)}</button>`;
    }).join('')}
    ${done ? reveal(it) : ''}
  </div>`;
}

function drawRecall(c){
  const it = c.item;
  const p = c.q.prompt;
  return `<div class="tp-q">
    ${p.image ? `<img src="${esc(thumbUrl(p.image, 900))}" style="width:100%;max-height:340px;object-fit:contain;background:#f8fafc;border-radius:12px;margin-bottom:12px" alt="" onerror="imgRetry(this)">` : ''}
    ${p.title ? `<h3>${esc(p.title)}</h3>` : ''}
    ${c.q.fields.map((f, i) => {
      const m = c.marks?.[i];
      return `<label class="tp-meta" style="display:block;margin:10px 0 4px">${esc(f.label)}</label>
        <input class="tp-in ${m ? (m.ok ? 'ok' : 'bad') : ''}" data-field="${i}" autocomplete="off" ${m ? 'disabled' : ''} value="${esc(m?.typed || '')}">
        ${m && !m.ok ? `<div style="margin-top:4px"><span class="tp-meta">Answer:</span> <b>${esc(f.answer)}</b></div>` : ''}`;
    }).join('')}
    ${c.marks ? reveal(it) : '<button class="tp-btn primary" style="margin-top:14px" data-qact="grade">Check</button>'}
  </div>`;
}

/** After answering: what the entry is, in a sentence or two. The point of the quiz is to learn. */
function reveal(it){
  const ch = Q.T.chapters[it.chapter];
  return `<div style="margin-top:14px;border-left:3px solid ${ch?.color || '#cbd5e1'};padding-left:12px">
    <div class="tp-meta">${esc([it.start == null ? it.title : it.yearText || fmtYear(it.start), ch?.title].filter(Boolean).join(' · '))}</div>
    ${it.start == null && defOf(it) ? `<div style="color:#334155;margin-top:4px">${esc(defOf(it))}</div>` : ''}
    ${it.start == null && !it.context ? '' : `<div style="color:#334155;margin-top:4px">${esc(it.context || summary(it.excerpt, 420))}</div>`}
    <a href="#" class="tp-src" data-open="${esc(it.id)}">More about ${esc(it.title)}</a>
  </div>
  <button class="tp-btn primary" style="margin-top:12px" data-qact="next">Next → <span class="tp-meta" style="color:#cbd5e1">Enter</span></button>`;
}

/** Score one question of the session; `missed` = the entries to show again at the end. */
function score(ok, missed = []){
  Q.total++;
  if(ok){ Q.right++; Q.streak++; } else Q.streak = 0;
  Q.sess.n++;
  if(ok) Q.sess.right++;
  Q.sess.log.push({ ok, missed: [].concat(missed) });
}

function drawSettings(){
  const st = Q.set;
  const seg = (name, val, label) => `<button data-set-${name}="${val}" class="${String(st[name]) === String(val) ? 'on' : ''}">${label}</button>`;
  const avail = { order: true, recall: true, ideas: Q.allIdeas.length >= 4 && !Q.when, era: !Q.scope && !Q.T.synthetic };
  const tips = { order: 'Put four in time order', recall: 'Type the year', ideas: 'Pick the idea from its definition', era: 'Which chapter is it from?' };
  return `<div class="tp-qset">
    <div><span class="lb">Length</span><span class="tp-seg">${seg('length', 10, '10')}${seg('length', 20, '20')}${seg('length', 50, '50')}${seg('length', 0, 'Endless')}</span></div>
    <div><span class="lb">Questions</span>${KINDS.filter((k) => avail[k]).map((k) =>
      `<button class="tp-chip ${st.kinds[k] ? 'on' : ''}" style="--c:#0f172a" data-set-kind="${k}" title="${tips[k]}">${MODE_NAME[k]}</button>`).join(' ')}</div>
    ${Q.T.reviewOnly ? '' : `<div><span class="lb">Focus</span><span class="tp-seg">${seg('focus', 'mixed', 'Everything')}${seg('focus', 'weak', 'Weak spots')}${seg('focus', 'new', 'New only')}</span></div>`}
    <div><span class="lb">Years</span><input class="tp-search" id="qYears" value="${esc(st.years)}" placeholder="any · 1500-1700 · 13th century" style="width:200px">
      <button class="tp-btn sm" data-qact="years">Apply</button>${Q.when ? ` <span class="tp-meta">${esc(Q.when.label)}: ${Q.pool.length} entries</span>` : ''}</div>
  </div>`;
}

function drawEnd(){
  const n = Q.sess.n, r = Q.sess.right;
  const missed = [...new Set(Q.sess.log.flatMap((x) => x.missed))].map((id) => Q.T.byId.get(id)).filter(Boolean);
  return `<div class="tp-q">
    <h3>${r} of ${n} right · ${n ? Math.round(100 * r / n) : 0}%</h3>
    ${missed.length ? `<div class="tp-meta" style="margin-bottom:6px">To go over (they will come back sooner):</div>
      ${missed.map((it) => `<div class="tp-ordr"><a href="#" data-open="${esc(it.id)}">${esc(it.title)}</a> <span class="tp-meta">${esc(it.yearText || fmtYear(it.start) || '')}</span>
        <div class="tp-meta">${esc(summary(it.context || it.def || it.excerpt, 180))}</div></div>`).join('')}` : '<div class="tp-meta">Nothing missed.</div>'}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
      <button class="tp-btn primary" data-qact="again">Another ${Q.set.length}</button>
      ${missed.length && !Q.T.reviewOnly ? '<button class="tp-btn" data-qact="weak">Practise weak spots</button>' : ''}
      <button class="tp-btn" data-qact="settings">Settings</button>
    </div>
  </div>`;
}

function gradeRecall(){
  const c = Q.cur;
  const marks = c.q.fields.map((f, i) => {
    const typed = Q.host.querySelector(`[data-field="${i}"]`)?.value || '';
    return { typed, ok: gradeField(f, typed, c.e).ok };
  });
  c.marks = marks;
  const ok = marks.every((m) => m.ok);
  score(ok, ok ? [] : [c.item.id]);
  remember(c.item.id, ok);
  draw();
}

function onClick(ev){
  const b = ev.target.closest('[data-qact],[data-pick],[data-era],[data-idea],[data-open],[data-set-length],[data-set-kind],[data-set-focus]');
  if(!b) return;
  ev.preventDefault();
  ev.stopPropagation();
  if(b.dataset.open){ Q.opts.onOpen?.(b.dataset.open); return; }
  const c = Q.cur;
  // Settings: length and focus restart the session; kinds apply from the next question.
  if(b.dataset.setLength != null){ Q.set.length = Number(b.dataset.setLength); saveSettings(Q.set); if(Q.cur?.kind === 'end' || (Q.set.length && Q.sess.n >= Q.set.length)) restart(); else draw(); return; }
  if(b.dataset.setKind){ const k = b.dataset.setKind; Q.set.kinds[k] = !Q.set.kinds[k]; saveSettings(Q.set); if(!isDone() && Q.cur?.kind !== 'end' && !Q.set.kinds[Q.cur?.kind]) next(); draw(); return; }
  if(b.dataset.setFocus){ Q.set.focus = b.dataset.setFocus; saveSettings(Q.set); restart(); return; }
  if(b.dataset.qact === 'settings'){ Q.showSet = !Q.showSet; draw(); return; }
  if(b.dataset.qact === 'years'){ Q.set.years = Q.host.querySelector('#qYears')?.value.trim() || ''; saveSettings(Q.set); restart(); return; }
  if(b.dataset.qact === 'again'){ restart(); return; }
  if(b.dataset.qact === 'weak'){ Q.set.focus = 'weak'; saveSettings(Q.set); restart(); return; }
  if(b.dataset.qact === 'next'){ next(); draw(); return; }
  if(b.dataset.qact === 'widen'){ Q.opts.onWiden?.(); return; }
  if(b.dataset.qact === 'grade'){ gradeRecall(); return; }
  if(b.dataset.qact === 'undo'){ c.picked.pop(); draw(); return; }
  if(b.dataset.pick && c?.kind === 'order' && !c.done){
    const id = b.dataset.pick;
    const k = c.picked.indexOf(id);
    if(k >= 0) c.picked.splice(k, 1); else c.picked.push(id);
    if(c.picked.length === c.items.length){
      c.done = true;
      const sorted = [...c.items].sort((a, b2) => a.anchor - b2.anchor).map((it) => it.id);
      // Ties in anchor year are both acceptable orders.
      const placed = c.picked.map((id2, i) => id2 === sorted[i] || Q.T.byId.get(id2).anchor === Q.T.byId.get(sorted[i]).anchor);
      const ok = placed.every(Boolean);
      score(ok, c.picked.filter((_, i) => !placed[i]));
      // Each entry is marked by whether IT landed in the right place.
      remember(c.picked.filter((_, i) => placed[i]), true);
      if(!ok) remember(c.picked.filter((_, i) => !placed[i]), false);
    }
    draw();
    return;
  }
  if(b.dataset.idea != null && c?.kind === 'ideas' && c.chosen == null){
    c.chosen = b.dataset.idea;
    const ok = c.chosen === c.item.id;
    score(ok, ok ? [] : [c.item.id]);
    remember(c.item.id, ok);
    draw();
    return;
  }
  if(b.dataset.era != null && c?.kind === 'era' && c.chosen == null){
    c.chosen = Number(b.dataset.era);
    score(c.chosen === c.answer, c.chosen === c.answer ? [] : [c.item.id]);
    remember(c.item.id, c.chosen === c.answer);
    draw();
  }
}
