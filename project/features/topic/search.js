/*
 * The search page: #/search/<query>. A page built on the spot from the WHOLE
 * store (every entry, not only those in topics) and the topics, fetched in
 * small pieces (webdata.js: time buckets for a date, the word index for words).
 *
 *   a year        "1294", "1294 AD", "300 BC"
 *   a span        "1290-1300", "300-200 BC", "1290s", "13th century",
 *                 "3rd millennium BC", "66 million years ago"
 *   anything else "mongol", "printing press", "mongol 1294" (words + a date)
 *
 * For a date the page answers "what was going on": what happened, began and
 * ended then (people born and died), what was under way, and what each of your
 * topics says about those years. For words it lists every matching entry in
 * time order, so a query reads as an instant timeline of that subject. Subject
 * chips narrow either. Clicking an entry opens it, with links into the topics
 * that contain it.
 */

import { anchorYear, fmtYear, fmtRange, summary } from './layout.js';
import { storeRowsIn, findRows, topicRowsIn, topicsMeta } from './webdata.js';
import { thumbUrl } from '../../utils/helpers.js';

const BASE = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NOW = new Date().getFullYear();
const TYPE = { event: 'Event', person: 'Person', work: 'Work', period: 'Period', place: 'Place', group: 'Group', concept: 'Idea' };

let titlesP = null;
const getJSON = (p) => fetch(BASE + p, { cache: 'no-store' }).then((r) => { if(!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });

function loadTopicTitles(){
  if(!titlesP) titlesP = getJSON('datasets/topics/index.json').then((d) => d.topics).catch(() => []);
  return titlesP;
}

// ---------------------------------------------------------------------------
// Reading a date out of a query
// ---------------------------------------------------------------------------

const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, 'twenty-first': 21 };
const num = (s) => Number(String(s).replace(/,/g, ''));

/**
 * { lo, hi, label, rest } if the query names a date or span (rest = the words
 * left over), else null. BC years are negative.
 */
export function parseWhen(q){
  let s = ` ${String(q).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()} `;
  const take = (re, f) => { const m = s.match(re); if(!m) return null; const r = f(m); if(r){ s = s.replace(m[0], ' '); } return r; };
  const era = (e) => (/b\.?c/.test(e || '') ? -1 : 1);
  const r =
    // 66 million years ago, 2.5 mya, 10,000 years ago
    take(/ ([\d.,]+) ?(thousand|million|billion)? ?(years ago|ya|mya|bya|kya) /, (m) => {
      const mult = { thousand: 1e3, million: 1e6, billion: 1e9 }[m[2]] || (m[3] === 'mya' ? 1e6 : m[3] === 'bya' ? 1e9 : m[3] === 'kya' ? 1e3 : 1);
      const y = NOW - num(m[1]) * mult;
      const w = Math.max(5, Math.abs(num(m[1]) * mult) * 0.05);
      return { lo: Math.round(y - w), hi: Math.round(y + w), label: `${m[1]} ${m[2] || ''} years ago`.replace(/ +/g, ' ') };
    }) ||
    // 3rd millennium BC
    take(/ (\d+)(?:st|nd|rd|th)[ -]millenni(?:um|a) ?(bc|bce|ad|ce)? /, (m) => {
      const n = +m[1], bc = era(m[2]) < 0;
      return bc ? { lo: -n * 1000, hi: -(n - 1) * 1000 - 1, label: `${m[1]}${m[0].match(/st|nd|rd|th/)[0]} millennium BC` } : { lo: (n - 1) * 1000, hi: n * 1000 - 1, label: `${n}th millennium` };
    }) ||
    // 13th century, 13th-century, thirteenth century BC
    take(/ (\d{1,2}|[a-z-]+?)(?:st|nd|rd|th)?[ -]centur(?:y|ies) ?(bc|bce|ad|ce)? /, (m) => {
      const n = /^\d+$/.test(m[1]) ? +m[1] : ORD[m[1]];
      if(!n) return null;
      return era(m[2]) < 0 ? { lo: -n * 100, hi: -(n - 1) * 100 - 1, label: `${n}${['st', 'nd', 'rd'][((n + 90) % 100 - 10) % 10 - 1] || 'th'} century BC` }
        : { lo: (n - 1) * 100, hi: n * 100 - 1, label: `${n}${['st', 'nd', 'rd'][((n + 90) % 100 - 10) % 10 - 1] || 'th'} century` };
    }) ||
    // 1290s (a decade), 1200s (a century)
    take(/ (\d{2,4})0s /, (m) => {
      const base = +m[1] * 10;
      return base % 100 === 0 && m[1].length >= 2 && +m[1] % 10 === 0 ? { lo: base, hi: base + 99, label: `${base}s` } : { lo: base, hi: base + 9, label: `${base}s` };
    }) ||
    // 1290-1300, 300-200 BC, 300 BC - AD 14, 1290 to 1300
    take(/ (?:ad )?(\d{1,7}) ?(bc|bce|ad|ce)? ?(?:-|to|until) ?(?:ad )?(\d{1,7}) ?(bc|bce|ad|ce)? /, (m) => {
      const e2 = era(m[4]), e1 = m[2] ? era(m[2]) : e2;
      let a = num(m[1]) * e1, b = num(m[3]) * e2;
      if(m[3].length < m[1].length && e1 > 0 && e2 > 0) b = num(m[1].slice(0, m[1].length - m[3].length) + m[3]);   // 1290-99
      if(a > b) [a, b] = [b, a];
      return { lo: a, hi: b, label: `${fmtYear(a)}–${fmtYear(b)}` };
    }) ||
    // 1294, 1294 AD, AD 1294, 300 BC
    take(/ (?:ad |ce )?(\d{1,7}) ?(bc|bce|ad|ce)? /, (m) => {
      if(!m[2] && m[1].length < 3) return null;   // "42" alone is not a year; "42 BC" is
      const y = num(m[1]) * era(m[2]);
      if(y > NOW + 5) return null;
      return { lo: y, hi: y, label: fmtYear(y) };
    });
  if(!r) return null;
  return { ...r, rest: s.trim() };
}

// ---------------------------------------------------------------------------
// Building the page
// ---------------------------------------------------------------------------

/** The rows of the store that a date page shows, in its sections. */
function datePage(items, lo, hi){
  const point = (r) => !r.k || r.e == null || r.e === r.s;
  const out = { happened: [], born: [], died: [], began: [], ended: [], ongoing: [] };
  for(const r of items){
    if(r.s == null) continue;
    if(point(r)){ if(r.s >= lo && r.s <= hi) out.happened.push(r); continue; }
    const e = r.o ? null : r.e;
    const startsIn = r.s >= lo && r.s <= hi, endsIn = e != null && e >= lo && e <= hi;
    if(r.ty === 'person'){
      if(startsIn) out.born.push(r);
      if(endsIn) out.died.push(r);
      if(!startsIn && !endsIn && r.s < lo && e != null && e > hi && hi - r.s >= 15 && e - r.s <= 110) out.ongoing.push(r);   // alive and adult
      continue;
    }
    if(startsIn) out.began.push(r);
    if(endsIn) out.ended.push(r);
    if(!startsIn && !endsIn && r.s < lo && (e == null ? false : e > hi) && (e - r.s) < 2000 + Math.abs(lo) * 0.5) out.ongoing.push(r);
  }
  // Best first: in a topic, then things that HAPPENED, then famous, then has a
  // picture. A place or group dated by its founding (Iraq, 1932) is the weakest
  // kind of happening, however famous the place.
  const kind = (r) => r.ty === 'event' ? 3 : r.ty === 'place' || r.ty === 'group' ? -3 : 0;
  const score = (r) => (r.x ? 20 : 0) + kind(r) + (r.f || 0) * 2 + (r.im ? 1 : 0);
  for(const k of Object.keys(out)) out[k].sort((a, b) => score(b) - score(a) || a.s - b.s);
  // Under way: the specific before the vast. A war or a reign says more about
  // 1294 than "the Middle Ages" or "the Goths (1–1475)".
  const len = (r) => Math.max(1, (r.o ? NOW : r.e ?? r.s) - r.s);
  out.ongoing.sort((a, b) => (score(b) - 3 * Math.log10(len(b))) - (score(a) - 3 * Math.log10(len(a))));
  return out;
}

const SUBJECT_CHIPS_MAX = 10;

export async function renderSearch(root, rawQ){
  const q = decodeURIComponent(rawQ || '').trim();
  root.innerHTML = `
    <div class="tp-bar">
      <a class="tp-btn" href="#/home" title="Home">←</a>
      <form class="tp-sform" id="sForm"><input class="tp-search tp-sq" id="sQ" value="${esc(q)}" placeholder="A year, a span or anything: 1294 · 1290s · 13th century · mongol" autocomplete="off"></form>
      <span class="tp-spacer"></span>
      <a class="tp-btn tp-hide-m" href="#/topics">Topics</a>
    </div>
    <div class="tp-body"><div class="tp-main"><div class="tp-scroll" id="sBody"><div class="tp-empty">Loading everything…</div></div></div>
      <div class="tp-detail" id="tpDetail"></div></div>`;
  root.querySelector('#sForm').onsubmit = (ev) => {
    ev.preventDefault();
    const v = root.querySelector('#sQ').value.trim();
    if(v) location.hash = `#/search/${encodeURIComponent(v)}`;
  };
  if(!q){ root.querySelector('#sBody').innerHTML = '<div class="tp-empty">Type a year (1294), a span (1290–1300, 1290s, 13th century) or anything (mongol).</div>'; return; }

  const when = parseWhen(q);
  const words = when ? when.rest : q;
  // Only what this page needs: the date's time buckets, or the word index's
  // best hits (then narrowed to the date when both are given).
  let items, partial = false;
  const hits = new Map();
  try {
    if(words){
      items = await findRows(words, 600);
      items.forEach((r, i) => hits.set(r.id, i));
    } else ({ rows: items, partial } = await storeRowsIn(when.lo, when.hi));
  } catch(e){ root.querySelector('#sBody').innerHTML = `<div class="tp-empty">Could not load the store index. ${esc(e.message)}</div>`; return; }
  const [M, topics] = await Promise.all([topicsMeta().catch(() => ({ topics: {} })), loadTopicTitles()]);
  const trows = when ? await topicRowsIn(when.lo, when.hi).catch(() => []) : [];
  const A = { topics: M.topics, items: trows };
  const byId = new Map(items.map((r) => [r.id, r]));
  const topicTitle = new Map(topics.map((t) => [t.slug, t.title]));
  const S = { subject: '', sort: when ? 'date' : 'date', q, when, words };
  const pool = () => items.filter((r) => (!words || hits.has(r.id)) && (!S.subject || r.sj === S.subject));

  const draw = () => {
    const P = pool();
    const host = root.querySelector('#sBody');
    // Subject chips from what is on the page.
    const sj = new Map();
    for(const r of (when ? P.filter((r) => overlaps(r, when.lo, when.hi)) : P)) if(r.sj) sj.set(r.sj, (sj.get(r.sj) || 0) + 1);
    const chips = [...sj].sort((a, b) => b[1] - a[1]).slice(0, SUBJECT_CHIPS_MAX);
    const chipHtml = chips.length > 1 ? `<div class="tp-schips">
      <button class="tp-chip ${S.subject ? '' : 'on'}" style="--c:#0f172a" data-subj="">All</button>
      ${chips.map(([k, n]) => `<button class="tp-chip ${S.subject === k ? 'on' : ''}" style="--c:#475569" data-subj="${esc(k)}">${esc(k)}<span class="n">${n}</span></button>`).join('')}</div>` : '';

    let html = '';
    if(when){
      const span = when.hi - when.lo + 1;
      const step = Math.max(1, span);
      const nav = (d) => { const a = when.lo + d * step, b = when.hi + d * step; return a === b ? fmtYear(a) : `${fmtYear(a)}-${fmtYear(b)}`; };
      const D = datePage(P, when.lo, when.hi);
      const topicsHtml = topicSection(A, when.lo, when.hi, words ? hits : null);
      const n = Object.values(D).reduce((s, a) => s + a.length, 0);
      const wide = when.lo === when.hi ? `${fmtYear(when.lo - 5)}-${fmtYear(when.hi + 5)}` : null;
      html += `<header class="tp-shead">
        <div class="tp-snav"><a class="tp-btn sm" href="#/search/${encodeURIComponent((words ? words + ' ' : '') + nav(-1))}">← ${esc(nav(-1))}</a>
          <a class="tp-btn sm" href="#/search/${encodeURIComponent((words ? words + ' ' : '') + nav(1))}">${esc(nav(1))} →</a>
          ${wide ? `<a class="tp-btn sm" href="#/search/${encodeURIComponent((words ? words + ' ' : '') + wide)}">Widen to ${esc(wide)}</a>` : ''}</div>
        <h1>${esc(when.label)}${words ? ` <span class="tp-sw">· ${esc(words)}</span>` : ''}</h1>
        <div class="tp-meta">${n} entries from the whole store${words ? ` matching “${esc(words)}”` : ''}${partial ? ' · a long span: the years around its two ends, and what lasted throughout' : ''}</div></header>
        ${chipHtml}
        ${topicsHtml}
        ${section('What happened', D.happened, 40)}
        ${section('Began', D.began, 30)}
        ${section('Ended', D.ended, 30)}
        ${section('Born', D.born, 20)}
        ${section('Died', D.died, 20)}
        ${section(when.lo === when.hi ? 'Under way' : 'Under way throughout', D.ongoing, 25, 'Wars, reigns, periods and lives that span these years')}
        ${!n ? `<div class="tp-empty">Nothing in the store is dated to ${esc(when.label)}${wide ? `. <a href="#/search/${encodeURIComponent(wide)}">Try ${esc(wide)}</a>` : ''}.</div>` : ''}`;
    } else {
      const tps = topics.filter((t) => `${t.title} ${t.blurb || ''}`.toLowerCase().includes(q.toLowerCase()));
      const list = S.sort === 'date'
        ? P.filter((r) => r.s != null).sort((a, b) => a.anchor - b.anchor)
        : P.sort((a, b) => hits.get(a.id) - hits.get(b.id));
      const ideas = P.filter((r) => r.i);
      html += `<header class="tp-shead"><h1>${esc(q)}</h1>
        <div class="tp-meta">${P.length} entries from the whole store · <a href="#" data-sort="${S.sort === 'date' ? 'rel' : 'date'}">${S.sort === 'date' ? 'sort by relevance' : 'sort by date'}</a></div></header>
        ${tps.length ? `<div class="tp-sgroup"><div class="lb">Topics</div><div class="tp-rel">${tps.map((t) => `<a class="tp-relc tp-also" href="#/topic/${esc(t.slug)}">${esc(t.title)} →</a>`).join('')}</div></div>` : ''}
        ${chipHtml}
        ${ideas.length && S.sort === 'date' ? section('Ideas', ideas, 12) : ''}
        ${section(S.sort === 'date' ? 'In time order' : 'Best matches', list, 150)}
        ${!P.length ? '<div class="tp-empty">Nothing matches. Try fewer words, or a year.</div>' : ''}`;
    }
    host.innerHTML = `<div class="tp-read tp-sread">${html}</div>`;
  };

  const overlaps = (r, lo, hi) => r.s != null && r.s <= hi && (r.o ? NOW : r.e ?? r.s) >= lo;

  /** What each topic has in these years (from all.json), as Meanwhile does for one entry. */
  function topicSection(A, lo, hi, filter){
    const by = new Map();
    for(const r of A.items){
      if(r.i || r.s == null) continue;
      const a = anchorYear({ type: r.ty, kind: r.k ? 'span' : 'point', start: r.s, end: r.e, dataset: r.d });
      const hit = (a >= lo && a <= hi) || (r.s >= lo && r.s <= hi) || (r.e != null && r.e >= lo && r.e <= hi);
      if(!hit || (filter && !filter.has(r.id))) continue;
      (by.get(r.x) || by.set(r.x, []).get(r.x)).push(r);
    }
    if(!by.size) return '';
    const groups = [...by].map(([x, rows]) => ({ x, title: A.topics[x]?.title || x, rows: rows.sort((a, b) => (b.key || 0) - (a.key || 0) || a.s - b.s) }))
      .sort((a, b) => b.rows.filter((r) => r.key).length - a.rows.filter((r) => r.key).length || b.rows.length - a.rows.length);
    return `<div class="tp-sgroup"><div class="lb">In your topics</div><div class="tp-mw">${groups.slice(0, 12).map((g) => `
      <div class="g"><div class="h"><a href="#/topic/${esc(g.x)}">${esc(g.title)}</a>${g.rows.length > 4 ? ` <span>+${g.rows.length - 4}</span>` : ''}</div>
        ${g.rows.slice(0, 4).map((r) => `<a href="#/topic/${esc(g.x)}" data-open-topic="${esc(g.x)}" data-eid="${esc(r.id)}" title="${esc(r.c || '')}"><span class="y">${esc(r.ty === 'person' && r.y ? r.y : fmtYear(r.s))}</span> ${esc(r.t)}</a>`).join('')}</div>`).join('')}</div></div>`;
  }

  function section(title, rows, max, note = ''){
    if(!rows.length) return '';
    const id = title.replace(/\W+/g, '');
    const shown = S[`more:${id}`] ? rows : rows.slice(0, max);
    return `<div class="tp-sgroup"><div class="lb">${esc(title)} <span class="tp-mw-r">${rows.length}${note ? ` · ${esc(note)}` : ''}</span></div>
      ${shown.map(row).join('')}
      ${rows.length > shown.length ? `<button class="tp-btn sm" data-more="${id}">Show all ${rows.length}</button>` : ''}</div>`;
  }

  function row(r){
    const yr = r.i ? 'idea' : r.k && r.e != null && !r.o ? fmtRange(r.s, r.e) : r.o ? `${fmtYear(r.s)}–` : fmtYear(r.s);
    return `<div class="tp-row tp-srow ${r.x ? 'key' : ''}" data-sid="${esc(r.id)}">
      <div class="yr">${esc(yr)}</div>
      <div class="mid"><div class="t">${esc(r.t)}<span class="ty">${esc(TYPE[r.ty] || '')}</span>${(r.x || []).slice(0, 2).map((x) => `<span class="tp-stopic">${esc(topicTitle.get(x) || x)}</span>`).join('')}</div>
        <div class="yr2">${esc(yr)}</div>
        ${r.sub || r.c ? `<div class="s">${esc(summary(r.c || r.sub, 200))}</div>` : ''}</div>
      <div class="im">${r.im ? `<img src="${esc(thumbUrl(r.im, 120))}" loading="lazy" alt="" onerror="imgRetry(this,'hide')">` : ''}</div>
    </div>`;
  }

  function openDetail(id){
    const r = byId.get(id);
    const el = root.querySelector('#tpDetail');
    if(!r || !el) return;
    root.querySelectorAll('.tp-srow.sel').forEach((n) => n.classList.remove('sel'));
    root.querySelector(`.tp-srow[data-sid="${CSS.escape(id)}"]`)?.classList.add('sel');
    const yr = r.i ? '' : r.k && r.e != null && !r.o ? fmtRange(r.s, r.e) : fmtYear(r.s);
    const y = r.anchor;
    el.classList.add('open');
    el.innerHTML = `
      <div class="hd"><span class="tp-meta" style="flex:1">${esc(TYPE[r.ty] || '')}</span><button class="tp-btn" data-sclose>✕</button></div>
      ${r.im ? `<img src="${esc(thumbUrl(r.im, 960))}" alt="" onerror="imgRetry(this,'hide')">` : ''}
      <div class="in">
        <h2>${esc(r.t)}</h2>
        <div class="sub">${[yr, r.sub].filter(Boolean).map(esc).join(' · ')}</div>
        ${r.c ? `<div class="tp-ctx" style="--c:#0f172a">${esc(r.c)}</div>` : ''}
        ${(r.x || []).length ? `<div class="lb">Read it in</div><div class="tp-rel">${r.x.map((x) => `<a class="tp-relc tp-also" href="#/topic/${esc(x)}" data-open-topic="${esc(x)}" data-eid="${esc(r.id)}">${esc(topicTitle.get(x) || x)} →</a>`).join('')}</div>` : ''}
        ${y != null ? `<div class="lb">More</div><div class="tp-rel">
          <a class="tp-relc" href="#/search/${encodeURIComponent(fmtYear(y).replace(' BC', ' BC'))}">Everything in ${esc(fmtYear(y))}</a>
          ${r.k && r.e != null && !r.o && r.e - r.s <= 400 ? `<a class="tp-relc" href="#/search/${encodeURIComponent(`${fmtYear(r.s)}-${fmtYear(r.e)}`)}">Everything ${esc(fmtRange(r.s, r.e))}</a>` : ''}</div>` : ''}
        <div style="margin-top:14px"><a class="tp-src" href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(r.t)}&go=Go" target="_blank" rel="noopener">Wikipedia ↗</a></div>
      </div>`;
  }

  root.onclick = (ev) => {
    const t = ev.target;
    const ot = t.closest('[data-open-topic]');
    if(ot){ ev.preventDefault(); localStorage.setItem('topic:pendingSelect', ot.dataset.eid); location.hash = `#/topic/${ot.dataset.openTopic}`; return; }
    if(t.closest('[data-sclose]')){ root.querySelector('#tpDetail').classList.remove('open'); return; }
    const sj = t.closest('[data-subj]');
    if(sj){ S.subject = sj.dataset.subj; draw(); return; }
    const more = t.closest('[data-more]');
    if(more){ S[`more:${more.dataset.more}`] = true; draw(); return; }
    const so = t.closest('[data-sort]');
    if(so){ ev.preventDefault(); S.sort = so.dataset.sort; draw(); return; }
    const r = t.closest('[data-sid]');
    if(r) openDetail(r.dataset.sid);
  };
  draw();
}
