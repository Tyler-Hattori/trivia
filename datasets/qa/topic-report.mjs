#!/usr/bin/env node
/**
 * What a reader would trip over in each built topic, so a new topic can be
 * judged in a minute instead of by reading all of it.
 *
 *     node datasets/qa/topic-report.mjs              every topic, summary + worst lines
 *     node datasets/qa/topic-report.mjs england      one topic, every finding
 *     node datasets/qa/topic-report.mjs --summary    one line per topic
 *
 * Fix a finding with datasets/topic-overrides.json (drop / unkey / key /
 * intro / blurb / chapterYears, see docs/TOPICS.md), or with a builder rule if
 * the same kind of finding shows up in several topics.
 *
 * Findings, worst first:
 *   generic       an essential whose title is a common noun ("World war",
 *                 "Geography"): a word, not a thing that happened
 *   no-context    an essential the article never puts in a sentence; Learn
 *                 falls back to its own Wikipedia lead, which is generic
 *   dup-intro     an essential whose sentence repeats the chapter's intro
 *   far-date      an essential dated well outside its chapter
 *   boilerplate   an intro that is about the website, not the subject
 *   thin-chapter  a chapter with fewer than 2 essentials
 *   thin-topic    fewer than 60 entries on the timeline
 *   apparatus     pronunciation or other apparatus left in an intro
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'topics');
const argv = process.argv.slice(2);
const only = argv.find((a) => !a.startsWith('--'));
const summaryOnly = argv.includes('--summary');

export const BOILERPLATE = /\b(welcome to|this (web ?site|web ?page|page|site)|homepage|home page|web browser|click (here|on)|quicktime|download|bookmark|copyright|all rights reserved)\b/i;
const APPARATUS = /[ɪəɛʊʌæɑɔŋθðʃʒˈˌː]|\b[a-z]+-[A-Z]{2,}[a-z]*-/;
// A common noun: no capital letter after the first word ("World war",
// "Printing press"), or a single word that is a field rather than a name.
const FIELDS = /^(geography|astronomy|physics|chemistry|biology|mathematics|philosophy|religion|science|history|art|music|literature|architecture|economics|politics|law|medicine|technology|engineering|agriculture|trade|war|warfare|government|society|culture|language|writing|education)$/i;
// Sentence-case titles hide proper names ("Xia dynasty", "Shōwa era"), so a
// two-word title is generic only when its first word is an ordinary dictionary
// word too ("World war", "Classical antiquity"). Report only: some are fine.
let DICT = null;
try { DICT = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n')); } catch {}
const isGeneric = (it) => {
  if(it.type === 'person' || it.type === 'work') return false;
  const t = String(it.title || '').replace(/\s*\(.*\)$/, '');
  if(FIELDS.test(t)) return true;
  const w = t.split(/\s+/);
  if(w.length !== 2 || /^[A-Z0-9]/.test(w[1]) || !DICT) return false;
  const first = w[0].toLowerCase();
  return DICT.has(first) && !DICT.has(w[0][0].toUpperCase() + first.slice(1)) && DICT.has(w[1]);
};

export function reportTopic(T){
  const F = [];
  const add = (kind, msg) => F.push({ kind, msg });
  const key = T.items.filter((it) => it.key);
  const intros = new Map(T.chapters.map((c) => [c.id, String(c.intro || '')]));
  for(const it of key){
    const ch = T.chapters[it.chapter];
    if(isGeneric(it)) add('generic', `${it.title} [${it.type}] in "${ch?.title}"`);
    if(!it.context && !it.note && !it.inIntro && it.via !== 'works' && it.via !== 'events') add('no-context', `${it.title} in "${ch?.title}"`);
    const intro = intros.get(it.chapter) || '';
    if(it.context && intro && (intro.includes(it.context.slice(0, 90)) || it.context.includes(intro.slice(0, 90)))) add('dup-intro', `${it.title} repeats the intro of "${ch?.title}"`);
    if(T.chronological && ch?.from != null && it.type !== 'person'){
      const len = Math.max(30, ch.to - ch.from);
      const y = it.start;
      if(y < ch.from - len || y > ch.to + len) add('far-date', `${it.title} (${it.yearText || y}) in "${ch.title}" ${ch.from}–${ch.to}`);
    }
  }
  for(const [label, text] of [['topic intro', T.intro], ...T.chapters.map((c) => [`intro of "${c.title}"`, c.intro])]){
    if(BOILERPLATE.test(text || '')) add('boilerplate', `${label}: "${String(text).slice(0, 100)}…"`);
    if(APPARATUS.test(String(text || '').slice(0, 300))) add('apparatus', `${label}: "${String(text).slice(0, 100)}…"`);
  }
  for(const c of T.chapters){
    const n = key.filter((it) => it.chapter === c.id).length;
    const all = T.items.filter((it) => it.chapter === c.id && it.onTimeline).length;
    if(n < 2 && all) add('thin-chapter', `"${c.title}" has ${n} essential${n === 1 ? '' : 's'} (${all} entries)`);
  }
  const noPts = T.chapters.filter((c) => !(c.points || []).length && (c.intro || T.items.some((it) => it.chapter === c.id && (it.key || it.keyIdea))));
  if(noPts.length) add('no-points', `${noPts.length} chapter${noPts.length === 1 ? '' : 's'} without key points (datasets/topic-notes/${T.slug}.json): ${noPts.slice(0, 3).map((c) => `"${c.title}"`).join(', ')}${noPts.length > 3 ? '…' : ''}`);
  const onTl = T.items.filter((it) => it.onTimeline).length;
  if(onTl < 60) add('thin-topic', `${onTl} entries on the timeline`);
  return F;
}

const ORDER = ['generic', 'boilerplate', 'dup-intro', 'far-date', 'no-context', 'apparatus', 'thin-chapter', 'thin-topic', 'no-points'];

if(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])){
  const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
  const list = idx.topics.filter((t) => !only || t.slug === only);
  if(!list.length){ console.error(`no topic "${only}"`); process.exit(1); }
  let total = 0;
  for(const t of list){
    const T = JSON.parse(fs.readFileSync(path.join(DIR, `${t.slug}.json`), 'utf8'));
    const F = reportTopic(T);
    total += F.length;
    const counts = ORDER.map((k) => [k, F.filter((f) => f.kind === k).length]).filter(([, n]) => n);
    console.log(`\n${t.title.padEnd(20)} ${counts.map(([k, n]) => `${k} ${n}`).join(' · ') || 'clean'}`);
    if(summaryOnly) continue;
    const lim = only ? Infinity : 4;
    for(const k of ORDER){
      const fs2 = F.filter((f) => f.kind === k);
      for(const f of fs2.slice(0, lim)) console.log(`   ${k.padEnd(13)} ${f.msg}`);
      if(fs2.length > lim) console.log(`   ${''.padEnd(13)} … ${fs2.length - lim} more (node datasets/qa/topic-report.mjs ${t.slug})`);
    }
  }
  console.log(`\n${total} findings in ${list.length} topic${list.length === 1 ? '' : 's'}`);
}
