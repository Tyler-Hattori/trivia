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
 *   Recall  the existing typed questions (year, span, artist, role…) from
 *           quiz/questions.js, minus year questions for places and concepts —
 *           "What year: Trinovantes?" is not a question.
 *
 * The pool honours the topic page's Key/All and chapter filters.
 */

import { questionsFor, gradeField } from '../quiz/questions.js';
import { thumbUrl } from '../../utils/helpers.js';
import { fmtYear, summary } from './layout.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DATE_TYPES = new Set(['event', 'person', 'work', 'period']);
const UNFAIR = new Set(['facet:occupation', 'facet:country', 'facet:category', 'facet:field', 'facet:region']);
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const shuffle = (a) => { for(let i = a.length - 1; i > 0; i--){ const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let Q = null;   // quiz state, kept across redraws of the same topic

export function renderQuiz(host, T, { show, chapters, subjects = new Set() }){
  const key = `${T.slug}|${show}|${[...chapters].sort()}|${[...subjects].sort()}`;
  if(!Q || Q.key !== key){
    Q = { key, T, mode: Q?.mode || 'order', right: 0, total: 0, streak: 0, cur: null, host };
    Q.pool = T.items.filter((it) => it.onTimeline && (show === 'all' || it.key) &&
      (!chapters.size || chapters.has(it.chapter)) && (!subjects.size || subjects.has(it.subject)));
    next();
  }
  Q.host = host;
  draw();
}

function next(){
  const make = { order: makeOrder, era: makeEra, recall: makeRecall }[Q.mode];
  Q.cur = null;
  for(let tries = 0; tries < 40 && !Q.cur; tries++) Q.cur = make();
}

// --- Order -------------------------------------------------------------------

function makeOrder(){
  const pool = Q.pool.filter((it) => DATE_TYPES.has(it.type));
  if(pool.length < 4) return null;
  const seed = pick(pool);
  // Neighbours: same chapter or adjacent, so the question is about sequence
  // within a stretch of history rather than "which is the Roman one".
  const near = pool.filter((it) => it !== seed && Math.abs(it.chapter - seed.chapter) <= 1);
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

// --- Era ---------------------------------------------------------------------

function makeEra(){
  const chs = Q.T.chapters.filter((c) => Q.T.items.some((it) => it.onTimeline && it.chapter === c.id));
  if(chs.length < 3 || !Q.pool.length) return null;
  const it = pick(Q.pool);
  const right = Q.T.chapters[it.chapter];
  // The right chapter plus up to three others, preferring its neighbours —
  // "Tudor or Stuart?" is the useful distinction, "Tudor or Roman?" is not.
  const others = chs.filter((c) => c.id !== right.id).sort((a, b) => Math.abs(a.id - right.id) - Math.abs(b.id - right.id)).slice(0, 3);
  return { kind: 'era', item: it, options: [right, ...others].sort((a, b) => a.id - b.id), answer: right.id, chosen: null };
}

// --- Recall --------------------------------------------------------------------

function makeRecall(){
  if(!Q.pool.length) return null;
  const it = pick(Q.pool);
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
  const tab = (m, label) => `<button data-qmode="${m}" class="${Q.mode === m ? 'on' : ''}">${label}</button>`;
  const head = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="tp-seg">${tab('order', 'Order')}${tab('era', 'Era')}${tab('recall', 'Recall')}</span>
      <span class="tp-meta">${Q.pool.length} entries in the pool</span>
      <span class="tp-spacer"></span>
      <span class="tp-score"><span><b>${Q.right}</b>/${Q.total} right</span><span>streak <b>${Q.streak}</b></span></span>
    </div>`;
  let body = '';
  if(!c) body = '<div class="tp-q">Not enough entries for this mode with the current filters — widen the chapters or switch to All.</div>';
  else if(c.kind === 'order') body = drawOrder(c);
  else if(c.kind === 'era') body = drawEra(c);
  else body = drawRecall(c);
  Q.host.innerHTML = `<div class="tp-quiz">${head}${body}</div>`;
  Q.host.onclick = onClick;
  const first = Q.host.querySelector('.tp-in:not([disabled])');
  if(first) first.focus();
  Q.host.onkeydown = (ev) => {
    if(ev.key !== 'Enter') return;
    ev.preventDefault();
    if(Q.cur?.kind === 'recall' && !Q.cur.marks) gradeRecall(); else if(isDone()) { next(); draw(); }
  };
}

const isDone = () => { const c = Q.cur; return c && (c.kind === 'order' ? c.done : c.kind === 'era' ? c.chosen != null : !!c.marks); };

function card(it, extra = ''){
  return `<div style="display:flex;gap:12px;align-items:center">
    ${it.image ? `<img src="${esc(thumbUrl(it.image, 120))}" style="width:56px;height:44px;object-fit:contain;background:#f8fafc;border-radius:6px" alt="">` : ''}
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
      ${sorted.map((it, i) => `<div>${i + 1}. <b>${esc(it.yearText || fmtYear(it.start))}</b> — ${esc(it.title)}</div>`).join('')}
      <button class="tp-btn primary" style="margin-top:12px" data-qact="next">Next →</button></div>` : ''}
  </div>`;
}

function drawEra(c){
  const it = c.item;
  const done = c.chosen != null;
  return `<div class="tp-q">
    ${it.image ? `<img src="${esc(thumbUrl(it.image, 500))}" style="width:100%;max-height:300px;object-fit:contain;background:#f8fafc;border-radius:12px;margin-bottom:12px" alt="">` : ''}
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
    ${p.image ? `<img src="${esc(thumbUrl(p.image, 900))}" style="width:100%;max-height:340px;object-fit:contain;background:#f8fafc;border-radius:12px;margin-bottom:12px" alt="">` : ''}
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
    <div class="tp-meta">${esc(it.yearText || fmtYear(it.start))} · ${esc(ch?.title || '')}</div>
    <div style="color:#334155;margin-top:4px">${esc(summary(it.excerpt, 420))}</div>
  </div>
  <button class="tp-btn primary" style="margin-top:12px" data-qact="next">Next →</button>`;
}

function score(ok){
  Q.total++;
  if(ok){ Q.right++; Q.streak++; } else Q.streak = 0;
}

function gradeRecall(){
  const c = Q.cur;
  const marks = c.q.fields.map((f, i) => {
    const typed = Q.host.querySelector(`[data-field="${i}"]`)?.value || '';
    return { typed, ok: gradeField(f, typed, c.e).ok };
  });
  c.marks = marks;
  score(marks.every((m) => m.ok));
  draw();
}

function onClick(ev){
  const b = ev.target.closest('[data-qmode],[data-qact],[data-pick],[data-era]');
  if(!b) return;
  ev.preventDefault();
  const c = Q.cur;
  if(b.dataset.qmode){ Q.mode = b.dataset.qmode; next(); draw(); return; }
  if(b.dataset.qact === 'next'){ next(); draw(); return; }
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
      const ok = c.picked.every((id2, i) => id2 === sorted[i] || Q.T.byId.get(id2).anchor === Q.T.byId.get(sorted[i]).anchor);
      score(ok);
    }
    draw();
    return;
  }
  if(b.dataset.era != null && c?.kind === 'era' && c.chosen == null){
    c.chosen = Number(b.dataset.era);
    score(c.chosen === c.answer);
    draw();
  }
}
