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
import { makeScale, pack, GEO, anchorYear } from '../../project/features/topic/layout.js';

const want = process.argv[2];
const idx = JSON.parse(fs.readFileSync(path.join(PATHS.topics, 'index.json'), 'utf8'));
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
  check('every item has a start year', T.items.every((it) => Number.isFinite(it.start)));
  check('every non-empty chapter has key items', T.chapters.every((c) => !c.count || c.key > 0),
    T.chapters.filter((c) => c.count && !c.key).map((c) => c.title).join(', '));
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
  const withCtx = linked.filter((it) => it.context).length;
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
  const onlyThings = (ch) => T.items.filter((it) => it.onTimeline && it.chapter === ch).every(thing);
  const badKey = key.filter((it) => thing(it) && !onlyThings(it.chapter));
  check('no place/group/concept is key without a main-article hatnote', !badKey.length, badKey.map((it) => it.title).join(', '));
  check('works pulled in by a creator name a member creator', T.items.filter((it) => it.via === 'works').every((it) => ids.has(it.by)));

  // Layout: in every lane, no two cards overlap, at several zooms and both modes.
  for(const show of ['key', 'all']){
    const items = T.items.filter((it) => it.onTimeline && (show === 'all' || it.key));
    for(const ppy of [0.5, 3, 12]){
      const scale = makeScale(items, ppy);
      const { pos } = pack(items, scale);
      const lanes = new Map();
      for(const p of pos.values()) (lanes.get(p.lane) || lanes.set(p.lane, []).get(p.lane)).push(p.x);
      let overlaps = 0;
      for(const xs of lanes.values()){
        xs.sort((a, b) => a - b);
        for(let i = 1; i < xs.length; i++) if(xs[i] - xs[i - 1] < GEO.CARD_W) overlaps++;
      }
      // x must be monotone in time: an earlier anchor never draws right of a later one.
      const sorted = [...items].sort((a, b) => anchorYear(a) - anchorYear(b));
      let back = 0;
      for(let i = 1; i < sorted.length; i++) if(pos.get(sorted[i].id).x < pos.get(sorted[i - 1].id).x - 0.5) back++;
      check(`layout ${show} @${ppy}px/yr: no overlaps, time runs left to right`, !overlaps && !back,
        `${items.length} cards, ${lanes.size} lanes, ${scale.breaks.length} breaks${overlaps ? `, ${overlaps} overlaps` : ''}${back ? `, ${back} out of order` : ''}`);
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
