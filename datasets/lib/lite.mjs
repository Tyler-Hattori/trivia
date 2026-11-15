/**
 * topics/store-lite.json: the WHOLE store, small enough to load on a phone, for
 * the search page (#/search/<q>). A year ("1294"), a span ("1290-1300",
 * "1290s", "13th century") or a query ("mongol") becomes a page built from
 * every entry, not only those in topics: what happened, began, ended, who was
 * alive, what was going on.
 *
 * One row per entry: { id, t, s, e?, k?, ty, sub?, im?, c?, sj?, f?, x? }
 *   t title (titles.json overrides applied) · s/e years · k span · ty type
 *   sub description · im image · c the excerpt's first sentence · sj subject
 *   f fame (0–9, from Wikidata sitelinks) · x the topics it is in
 * plus undated ideas with i: 1.
 *
 * Written by topic.mjs after every build (a second or two).
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './store.mjs';
import { entryType } from './etype.mjs';
import { readIdeas } from './ideas.mjs';
import { stripApparatus } from './wiki.mjs';

const firstSentence = (s, n = 200) => {
  const t = stripApparatus(String(s || '')).split(/(?<=[.!?])\s+(?=[A-Z"“(])/)[0] || '';
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t;
};

// Image URLs share a long prefix; "~" stands for it (the browser expands it).
const shortImg = (u) => String(u).replace(/^https:\/\/upload\.wikimedia\.org\/wikipedia\//, '~').replace(/\?utm_[^#]*$/, '');

/** datasets/titles.json: { <entry id>: "short title" } for mined events whose title is a sentence fragment. */
export function readTitles(){
  // titles-auto.json: written by a small model (title-events.mjs); null = not an
  // event, so no title. titles.json, written by hand, wins.
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PATHS.topics, '..', f), 'utf8')); } catch { return {}; } };
  const auto = Object.fromEntries(Object.entries(read('titles-auto.json')).filter(([, t]) => typeof t === 'string' && t));
  return { ...auto, ...read('titles.json') };
}

export function writeLite({ entries, taxo }){
  const titles = readTitles();
  let members = {};
  try { members = JSON.parse(fs.readFileSync(path.join(PATHS.topics, 'members-all.json'), 'utf8')); } catch {}
  const rows = [];
  for(const e of entries){
    if(e.start == null) continue;
    const r = { id: e.id, t: titles[e.id] || e.title, s: e.start, ty: entryType(e) };
    if(e.end != null && e.end !== e.start) r.e = e.end;
    if(e.kind === 'span') r.k = 1;
    if(e.openEnded) r.o = 1;
    if(e.subtitle && e.subtitle.length <= 90) r.sub = e.subtitle;
    if(e.image) r.im = shortImg(e.image);
    const c = firstSentence(e.excerpt, 160);
    // Not when it only repeats the title (a mined event's title is its sentence).
    if(c && !c.toLowerCase().startsWith(String(r.t).replace(/…$/, '').toLowerCase().slice(0, 30))) r.c = c;
    const sj = taxo?.entries?.[e.id]?.mid;
    if(sj) r.sj = sj;
    if(e.sitelinks) r.f = Math.min(9, Math.round(Math.log1p(e.sitelinks)));
    if(members[e.id]) r.x = members[e.id];
    rows.push(r);
  }
  const seen = new Set();
  for(const x of readIdeas().values()){
    if(x.missing || seen.has(x.id)) continue;
    seen.add(x.id);
    const r = { id: x.id, t: x.title, i: 1, ty: 'concept' };
    if(x.subtitle) r.sub = x.subtitle;
    if(x.image) r.im = shortImg(x.image);
    const c = firstSentence(x.excerpt, 160);
    if(c) r.c = c;
    rows.push(r);
  }
  const f = path.join(PATHS.topics, 'store-lite.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ built: new Date().toISOString().slice(0, 10), n: rows.length, items: rows }) + '\n');
  fs.renameSync(tmp, f);       // atomic: a batch may be building another topic at the same moment
  return rows.length;
}
