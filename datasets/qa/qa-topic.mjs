#!/usr/bin/env node
/**
 * Invariants for built topics, and for the topic timeline's layout. Node only,
 * no browser, ~1s.
 *
 *     node datasets/qa/qa-topic.mjs              # every topic in datasets/topics/
 *     node datasets/qa/qa-topic.mjs england
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/store.mjs';
import { GEO, anchorYear, layoutTimeline, layoutLanes } from '../../project/features/topic/layout.js';

const want = process.argv[2];
const idx = JSON.parse(fs.readFileSync(path.join(PATHS.topics, 'index.json'), 'utf8'));
let OVR = {};
try { OVR = JSON.parse(fs.readFileSync(path.join(PATHS.topics, '..', 'topic-overrides.json'), 'utf8')); } catch {}
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${info ? `   ${info}` : ''}`);
};

for(const row of idx.topics){
  if(want && row.slug !== want) continue;
  const T = JSON.parse(fs.readFileSync(path.join(PATHS.topics, `${row.slug}.json`), 'utf8'));
  console.log(`\n  ${T.title}  (${T.items.length} items, ${T.chapters.length} chapters)`);

  const ids = new Set(T.items.map((it) => it.id));
  check('item ids are unique', ids.size === T.items.length);
  check('every item has a valid chapter', T.items.every((it) => Number.isInteger(it.chapter) && it.chapter >= 0 && it.chapter < T.chapters.length));
  check('key items are all on the timeline', T.items.every((it) => !it.key || it.onTimeline));
  check('no concept is on the timeline', !T.items.some((it) => it.onTimeline && it.type === 'concept'),
    T.items.filter((it) => it.onTimeline && it.type === 'concept').map((it) => it.title).slice(0, 5).join(', '));
  check('no date-suspect item is on the timeline', !T.items.some((it) => it.onTimeline && it.dateSuspect));
  // Ideas (lib/ideas.mjs) are the one undated kind, and never on the timeline.
  check('every item has a start year, or is an undated idea off the timeline', T.items.every((it) => Number.isFinite(it.start) || (it.idea && !it.onTimeline)));
  check('key ideas are concepts, off the timeline', T.items.filter((it) => it.keyIdea).every((it) => it.type === 'concept' && !it.onTimeline && !it.key));
  // Except chapters a hand override keeps out of the essentials (noKeyChapters).
  const noKey = new Set((OVR[T.slug]?.noKeyChapters || []).map((x) => x.toLowerCase()));
  // Non-empty: with entries the audit did not judge off-topic (a "Waves"
  // chapter holding only the Hoover Dam has nothing to make essential).
  const onTopic = (c) => T.items.some((it) => it.onTimeline && it.chapter === c.id && !it.offTopic);
  check('every non-empty chapter has key items', T.chapters.every((c) => !c.count || c.key > 0 || !onTopic(c) || noKey.has(c.title.toLowerCase())),
    T.chapters.filter((c) => c.count && !c.key && onTopic(c) && !noKey.has(c.title.toLowerCase())).map((c) => c.title).join(', '));
  if(T.chronological){
    const main = T.chapters.filter((c) => !c.overlaps && c.from != null);
    check('chronological chapters ascend', main.every((c, i) => i === 0 || c.from >= main[i - 1].from));
  }
  check('index row matches the file', row.count === T.items.filter((it) => it.onTimeline).length);

  // The Learn view's text: the article's own words, decoded, and not repeated.
  const key = T.items.filter((it) => it.key);
  // The article's own links. Works pulled in by their creator and mined
  // timeline events are not in the article's prose, by design.
  const linked = key.filter((it) => it.via === 'link');
  // Told only in the chapter intro counts: Learn shows its own lead instead.
  const withCtx = linked.filter((it) => it.context || it.inIntro).length;
  check('most key links have an in-article sentence', withCtx >= linked.length * 0.7, `${withCtx}/${linked.length}`);
  check('every chapter with entries has an intro', T.chapters.every((c) => !c.count || c.intro),
    T.chapters.filter((c) => c.count && !c.intro).map((c) => c.title).join(', '));
  const texts = [T.intro, ...T.chapters.map((c) => c.intro), ...T.items.map((it) => it.context)].filter(Boolean);
  check('no HTML entities or tags left in article text', !texts.some((s) => /&#?\w+;|<\/?[a-z]/i.test(s)),
    texts.find((s) => /&#?\w+;|<\/?[a-z]/i.test(s))?.slice(0, 80));
  const seenCtx = new Set(); let dup = 0;
  for(const it of T.items) if(it.context){ const k = `${it.chapter}|${it.context}`; if(seenCtx.has(k)) dup++; seenCtx.add(k); }
  check('no two entries in a chapter share a context sentence', dup === 0, `${dup} repeats`);
  check('related ids all resolve, never self', T.items.every((it) => (it.related || []).every((r) => ids.has(r) && r !== it.id)));
  // Exempt: a chapter with nothing else to offer gets its best two anyway.
  const thing = (it) => ['place', 'group', 'concept'].includes(it.type) && !it.hat;
  const unkeyed = new Set((OVR[T.slug]?.unkey || []).map((x) => x.toLowerCase()));
  const onlyThings = (ch) => T.items.filter((it) => it.onTimeline && it.chapter === ch && !it.offTopic && !unkeyed.has(it.title.toLowerCase())).every(thing);
  const badKey = key.filter((it) => thing(it) && !onlyThings(it.chapter));
  check('no place/group/concept is key without a main-article hatnote', !badKey.length, badKey.map((it) => it.title).join(', '));
  check('works pulled in by a creator name a member creator', T.items.filter((it) => it.via === 'works').every((it) => ids.has(it.by)));

  // Layout (layoutTimeline, as the page draws it): in every lane no two cards
  // overlap; time runs left to right; era bars do not overlap in their row;
  // in Essentials every essential is drawn (a card or a bar) and the fill
  // stays within max(essential rows, 8).
  const byId = new Map(T.items.map((it) => [it.id, it]));
  const pool = T.items.filter((it) => it.onTimeline);
  for(const show of ['key', 'all']){
    for(const ppy of [0.5, 3, 12]){
      const L = layoutTimeline(pool, { show, ppy, lookup: (id) => byId.get(id) });
      const lanes = new Map();
      for(const it of L.cards){ const p = L.pos.get(it.id); for(let k = 0; k < p.rows; k++) (lanes.get(p.lane + k) || lanes.set(p.lane + k, []).get(p.lane + k)).push(p.x); }
      let overlaps = 0;
      for(const xs of lanes.values()){
        xs.sort((a, b) => a - b);
        for(let i = 1; i < xs.length; i++) if(xs[i] - xs[i - 1] < GEO.CARD_W) overlaps++;
      }
      const sorted = [...L.cards].sort((a, b) => anchorYear(a) - anchorYear(b));
      let back = 0;
      for(let i = 1; i < sorted.length; i++) if(L.pos.get(sorted[i].id).x < L.pos.get(sorted[i - 1].id).x - 0.5) back++;
      const drawn = new Set([...L.cards.map((it) => it.id), ...L.eras.map((b) => b.it.id), ...(L.umbrellas || []).map((it) => it.id)]);
      const lost = show === 'key' ? pool.filter((it) => it.key && !drawn.has(it.id)) : [];
      // The lanes layout: within a row of a lane, no two marks (with labels) overlap.
      const LL = layoutLanes(pool, { show, ppy });
      let barOver = 0;
      for(const list of [...L.header, ...LL.header, ...LL.body].map((t) => t.bars)){
        const rows = new Map();
        for(const b of list) (rows.get(b.row) || rows.set(b.row, []).get(b.row)).push(b);
        for(const r of rows.values()){ r.sort((a, b) => a.x0 - b.x0); for(let i = 1; i < r.length; i++) if(r[i].x0 < r[i - 1].x1) barOver++; }
      }
      const rows = new Map();
      for(const m of LL.marks) (rows.get(`${m.lane}|${m.row}`) || rows.set(`${m.lane}|${m.row}`, []).get(`${m.lane}|${m.row}`)).push(m);
      let laneOver = 0;
      for(const r of rows.values()){ r.sort((a, b) => a.l - b.l); for(let i = 1; i < r.length; i++) if(r[i].l < r[i - 1].r) laneOver++; }
      const drawnL = new Set([...LL.items.map((it) => it.id), ...LL.header.flatMap((t) => t.bars.map((b) => b.it.id)), ...LL.bars.map((b) => b.it.id), ...(LL.umbrellas || []).map((it) => it.id)]);
      const lostL = show === 'key' ? pool.filter((it) => it.key && !drawnL.has(it.id)) : [];
      check(`lanes ${show} @${ppy}px/yr: no overlaps in a row, essentials all drawn`, !laneOver && !lostL.length,
        `${LL.marks.length} marks (${LL.minor.size} fill), ${LL.lanes.length} lanes, ${LL.height}px${laneOver ? `, ${laneOver} overlaps` : ''}${lostL.length ? `, lost: ${lostL.slice(0, 3).map((it) => it.title).join(', ')}` : ''}`);
      check(`layout ${show} @${ppy}px/yr: no overlaps, time runs left to right, essentials all drawn`, !overlaps && !back && !barOver && !lost.length,
        `${L.cards.length} cards (${L.minor.size} fill), ${L.eras.length} era bars, ${lanes.size} lanes, ${L.scale.breaks.length} breaks${overlaps ? `, ${overlaps} overlaps` : ''}${back ? `, ${back} out of order` : ''}${barOver ? `, ${barOver} bar overlaps` : ''}${lost.length ? `, lost: ${lost.slice(0, 3).map((it) => it.title).join(', ')}` : ''}`);
    }
  }
}

// Across topics: the list's fields and the membership files the detail panel
// ("Also in") and the atlas's Topic filter read.
if(!want){
  console.log('\n  all topics');
  check('every topic has a group and a blurb', idx.topics.every((t) => t.group && t.blurb),
    idx.topics.filter((t) => !t.group || !t.blurb).map((t) => t.slug).join(', '));
  check('topic slugs are unique', new Set(idx.topics.map((t) => t.slug)).size === idx.topics.length);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PATHS.topics, f), 'utf8')); } catch { return null; } };
  const all = read('members-all.json'), multi = read('members.json');
  check('members files exist', !!all && !!multi);
  if(all && multi){
    const slugs = new Set(idx.topics.map((t) => t.slug));
    check('members only name built topics', Object.values(all).every((v) => v.every((s) => slugs.has(s))));
    check('members.json is exactly the entries in 2+ topics',
      Object.keys(multi).length === Object.values(all).filter((v) => v.length > 1).length &&
      Object.values(multi).every((v) => v.length > 1));
    for(const t of idx.topics){
      const n = Object.values(all).filter((v) => v.includes(t.slug)).length;
      if(n !== t.count) check(`members-all matches ${t.slug}`, false, `${n} vs ${t.count} on its timeline`);
    }
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
