#!/usr/bin/env node
/**
 * Content audit by a small model (Claude Haiku): for every dated timeline
 * entry that comes from Wikidata (not a mined event), ask
 *   1. is the stored date plausible for it?          ok | wrong (+ the right year)
 *   2. what kind of thing is it?                      person event period work place group concept
 *   3. how relevant is it to this topic?              core | context | off
 *
 *   node datasets/audit-entries.mjs                every built topic
 *   node datasets/audit-entries.mjs physics inca-empire
 *   node datasets/audit-entries.mjs --dry          print, write nothing
 *   node datasets/audit-entries.mjs --redo         ask again even if answered
 *
 * Output: datasets/audit-auto.json (see lib/audit.mjs). Date and type hold for
 * every topic, so they are stored by entry id; relevance by topic slug -> id.
 * Hand corrections go in datasets/audit.json, which wins. Rebuild topics
 * afterwards (topic.mjs --all).
 *
 * Why: Wikidata dates are sometimes not the date that matters (YBC 7289, a
 * Babylonian tablet, at 1945, its publication) or plain wrong (the
 * Mesoproterozoic ending in 1 BC); its descriptions typed Apollo program and
 * Smallpox as people; and an article's passing links (the First Punic War in
 * Physics) became essentials on fame alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_AUTO, AUDIT_TYPES } from './lib/audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.AUDIT_MODEL || 'claude-haiku-4-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const REDO = argv.includes('--redo');
// --bare: only entries whose description is a bare name ("Spain — Pedro Sánchez"), asked again.
const BARE = argv.includes('--bare');
const BARE_RX = /^[A-Z][\p{L}'’.-]*( (de|da|von|van|al|bin|ibn|[A-Z][\p{L}'’.-]*)){0,4}$/u;
const slugs = argv.filter((a) => !a.startsWith('--'));
if(!KEY){ console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const audit = read(AUDIT_AUTO);
audit.entries ||= {}; audit.topics ||= {};
const save = () => {
  if(DRY) return;
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
  const topics = Object.fromEntries(Object.entries(audit.topics).sort().map(([s, m]) => [s, sorted(m)]));
  fs.writeFileSync(AUDIT_AUTO, JSON.stringify({ entries: sorted(audit.entries), topics }) + '\n');
};


const firstSentence = (s) => String(s || '').split(/\n/)[0].split(/(?<=[.!?])\s+(?=[A-Z0-9])/)[0].replace(/\s+/g, ' ').slice(0, 260);
const yearOf = (y) => (y < 0 ? `${-y} BC` : `${y}`);
const span = (it) => it.end != null && it.end !== it.start ? `${yearOf(it.start)} – ${yearOf(it.end)}` : yearOf(it.start);

// One job per topic: its dated Wikidata entries not yet judged for it.
const index = read(path.join(HERE, 'topics', 'index.json')).topics || [];
const jobs = [];
let total = 0;
for(const t of index){
  if(slugs.length && !slugs.includes(t.slug)) continue;
  let T; try { T = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', `${t.slug}.json`), 'utf8')); } catch { continue; }
  const have = audit.topics[t.slug] || {};
  const chTitle = (i) => T.chapters?.[i]?.title || '';
  const list = T.items.filter((it) => it.via !== 'events' && it.start != null &&
    (BARE ? BARE_RX.test(it.subtitle || '') && it.type !== 'work' : REDO || !(it.id in have)))
    .map((it) => ({ id: it.id, line: `${it.title}${it.subtitle ? ` — ${it.subtitle}` : ''} | date: ${span(it)} | typed: ${it.type} | chapter: ${chTitle(it.chapter)} | ${firstSentence(it.excerpt)}` }));
  for(let i = 0; i < list.length; i += 30) jobs.push({ slug: t.slug, topic: T.title, batch: list.slice(i, i + 30) });
  total += list.length;
}
/*
 * --spans: periods (states, dynasties, eras) stored with a start but no end
 * (the Akkadian Empire, the Abbasid Caliphate). The eras track draws a period
 * as a bar across its years; without an end it can only be a card. Asks for
 * the span and stores it as `span: [start, end]` (topic.mjs applies it when
 * the start agrees with the stored one).
 */
/*
 * --kinds: what kind of span a period is, for the timeline's tracks:
 *   state  a state, kingdom, empire, dynasty, ruling house, regime or colony
 *          (a political power: the States & dynasties track)
 *   era    an age, era, culture, movement or other span of time (Eras & movements)
 *   event  something that happened over years: a war, a policy, a migration,
 *          a persecution (Reign of Terror, Reconquista, Haijin): the Events lane
 *   other  not a span at all (Wehrmacht, Homo erectus): stays where its type puts it
 * Stored as `pk` on the entry.
 */
if(argv.includes('--kinds')){
  const want = new Map();
  for(const t of index){
    if(slugs.length && !slugs.includes(t.slug)) continue;
    let T; try { T = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', `${t.slug}.json`), 'utf8')); } catch { continue; }
    for(const it of T.items){
      if(it.via === 'events' || it.type !== 'period' || it.start == null || want.has(it.id)) continue;
      if(!REDO && audit.entries[it.id]?.pk) continue;
      want.set(it.id, `${it.title}${it.subtitle ? ` — ${it.subtitle}` : ''} | ${span(it)} | ${firstSentence(it.excerpt)}`);
    }
  }
  const list = [...want];
  console.log(`\n  ${list.length} periods to classify with ${MODEL}${DRY ? ' (dry run)' : ''}`);
  const SYS = `Each numbered entry is something a history timeline treats as a span of years. Classify it:
"state": a political power: a state, country, kingdom, empire, dynasty, ruling house or royal family (House of Capet, House of Habsburg), republic, regime, colony, city-state, khanate.
"era": a named age, era, period, culture, archaeological culture, civilisation, cultural or intellectual movement, or geological time span.
"event": something that happened over years: a war, conquest, campaign, policy, persecution, trade, migration, crisis.
"other": not a span of time at all: an army, a species, an institution, an organisation.
Reply with one JSON object mapping each number to "state", "era", "event" or "other", nothing else.`;
  let next = 0, n = 0, tokIn = 0, tokOut = 0;
  const batches = [];
  for(let i = 0; i < list.length; i += 50) batches.push(list.slice(i, i + 50));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while(next < batches.length){
      const b = batches[next++];
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: SYS, messages: [{ role: 'user', content: b.map(([, line], i) => `${i + 1}. ${line}`).join('\n') }] }),
        });
        const d = await r.json();
        tokIn += d.usage?.input_tokens || 0; tokOut += d.usage?.output_tokens || 0;
        const txt = d.content?.map((c) => c.text || '').join('') || '';
        const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
        b.forEach(([id, line], i) => {
          const k = out[i + 1] ?? out[String(i + 1)];
          if(!['state', 'era', 'event', 'other'].includes(k)) return;
          (audit.entries[id] ||= {}).pk = k; n++;
          if(DRY) console.log(`  ${k.padEnd(6)} ${line.slice(0, 100)}`);
        });
      } catch(e){ console.log(`  !! batch failed: ${e.message}`); }
    }
  }));
  save();
  console.log(`  ${n} classified · ≈ $${(tokIn / 1e6 + tokOut * 5 / 1e6).toFixed(2)}`);
  process.exit(0);
}

if(argv.includes('--spans')){
  const want = new Map();
  for(const t of index){
    if(slugs.length && !slugs.includes(t.slug)) continue;
    let T; try { T = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', `${t.slug}.json`), 'utf8')); } catch { continue; }
    for(const it of T.items){
      if(it.via === 'events' || it.type !== 'period' || it.start == null || (it.end != null && it.end !== it.start) || want.has(it.id)) continue;
      if(!REDO && audit.entries[it.id]?.span !== undefined) continue;
      want.set(it.id, `${it.title}${it.subtitle ? ` — ${it.subtitle}` : ''} | stored start: ${span(it)} | ${firstSentence(it.excerpt)}`);
    }
  }
  const list = [...want];
  console.log(`\n  ${list.length} periods without an end, to ask ${MODEL} for their span${DRY ? ' (dry run)' : ''}`);
  const SPAN_SYS = `Each numbered entry is a historical state, dynasty, era, culture or period from Wikipedia.
Give the years it lasted: {"s": start year, "e": end year} as integers (NEGATIVE for BC, e.g. -2334; deep time in years, e.g. -66000000).
Use the standard dates a textbook would give. If it still exists today, e is null. If you do not know, reply null for that entry.
Reply with one JSON object mapping each number to {"s":..,"e":..} or null, nothing else.`;
  let next = 0, got = 0, tokIn = 0, tokOut = 0;
  const batches = [];
  for(let i = 0; i < list.length; i += 40) batches.push(list.slice(i, i + 40));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while(next < batches.length){
      const b = batches[next++];
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SPAN_SYS, messages: [{ role: 'user', content: b.map(([, line], i) => `${i + 1}. ${line}`).join('\n') }] }),
        });
        const d = await r.json();
        tokIn += d.usage?.input_tokens || 0; tokOut += d.usage?.output_tokens || 0;
        const txt = d.content?.map((c) => c.text || '').join('') || '';
        const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
        b.forEach(([id, line], i) => {
          const a = out[i + 1] ?? out[String(i + 1)];
          if(a === undefined) return;
          const v = a && Number.isInteger(a.s) ? [a.s, Number.isInteger(a.e) ? a.e : null] : null;
          (audit.entries[id] ||= {}).span = v;
          if(v) got++;
          if(DRY) console.log(`  ${line.slice(0, 80).padEnd(80)} → ${JSON.stringify(v)}`);
        });
      } catch(e){ console.log(`  !! batch failed: ${e.message}`); }
    }
  }));
  save();
  console.log(`  ${got} spans · ≈ $${(tokIn / 1e6 + tokOut * 5 / 1e6).toFixed(2)}`);
  process.exit(0);
}
console.log(`\n  ${total} entries in ${jobs.length} batches to audit with ${MODEL}${DRY ? ' (dry run)' : ''}`);
if(!total) process.exit(0);

const SYSTEM = `You check entries on a history timeline for a learning website. Each entry comes from Wikidata/Wikipedia: title — description | stored date | stored type | chapter | first sentence.
The description is sometimes just a related person's name (a country's current leader, a city's mayor, a founder or author): it does not say what the entry is; judge by the title and first sentence.
For each numbered entry answer three questions:
d: is the stored date the date that matters for this entry on a timeline? "ok" or "wrong".
   A person: their life span (or birth/reign). An event: when it happened. A period, state or dynasty: when it existed.
   A work or artifact: when it was made or written (NOT when a modern scholar published or catalogued it).
   A place: founding or the era it mattered. Geological and astronomical spans in years ago are fine if roughly right.
   "wrong" when clearly off: an ancient object dated by its modern publication, a geological era ending in 1 BC,
   an ancient city dated thousands of years before it existed, a modern entity dated to antiquity. If unsure, "ok".
   Small differences (a year or two, a birth year off by one) and a living person's span ending this year are "ok".
   If "wrong", also give y: the right start year and e: the right end year (null for a single date), as integers
   (negative for BC; deep time as years, e.g. -1600000000), or y null if you do not know.
t: what kind of thing it really is: person, event, period, work, place, group or concept.
   event = something that happened (battle, war, discovery, invention, expedition, program, epidemic, treaty).
   period = an era, age, dynasty, empire, kingdom or reign as a span of time. work = a book, artwork, artifact, building-as-artwork, publication.
   place = a city, country, region, site, building or geographic feature. group = a people, organisation, institution, journal, company.
   concept = an idea, field, theory, technology in general, disease in general, language, or abstract topic.
r: relevance to the TOPIC of this timeline: "core" (part of the topic's own story: its people, discoveries, events,
   works, places), "context" (closely related background the topic's story depends on: a neighbouring field, a war
   that drove the research, a patron state), or "off" (general history, places, literature or institutions mentioned
   only in passing, which a timeline of this topic should not show: the Iliad or a Punic War on a physics timeline,
   a modern country on an ancient one, a journal or university, a calendar era).
Reply with one JSON object mapping each number to {"d":..,"t":..,"r":..} (plus "y" and "e" when d is "wrong"), nothing else.`;

async function ask(job){
  const user = `TOPIC: ${job.topic}\n` + job.batch.map((b, i) => `${i + 1}. ${b.line}`).join('\n');
  for(let attempt = 0; attempt < 6; attempt++){
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
      });
    } catch { await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if(r.status === 429 || r.status >= 500){ await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    const txt = d.content?.map((c) => c.text || '').join('') || '';
    const json = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    try { return { out: JSON.parse(json), usage: d.usage }; } catch { if(attempt >= 2) throw new Error(`unparseable reply: ${txt.slice(0, 200)}`); }
  }
  throw new Error('gave up after retries');
}

let done = 0, tokIn = 0, tokOut = 0;
const tally = { wrong: 0, off: 0, context: 0, retyped: 0 };
let next = 0, sinceSave = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while(next < jobs.length){
    const job = jobs[next++];
    try {
      const { out, usage } = await ask(job);
      tokIn += usage?.input_tokens || 0; tokOut += usage?.output_tokens || 0;
      const tm = audit.topics[job.slug] ||= {};
      job.batch.forEach((b, i) => {
        const a = out[i + 1] || out[String(i + 1)];
        if(!a || typeof a !== 'object') return;            // unanswered: asked again next run
        const d = a.d === 'wrong' ? 'wrong' : 'ok';
        const t = AUDIT_TYPES.includes(a.t) ? a.t : null;
        const r = ['core', 'context', 'off'].includes(a.r) ? a.r : 'core';
        // Date and type are facts about the entry: first answer wins (unless --redo).
        if(REDO || BARE || !audit.entries[b.id]){
          const e = { d, ...(t ? { t } : {}) };
          if(d === 'wrong' && Number.isInteger(a.y)){ e.y = a.y; if(Number.isInteger(a.e)) e.e = a.e; }
          audit.entries[b.id] = e;
          if(d === 'wrong') tally.wrong++;
          if(t && !b.line.includes(`| typed: ${t} |`)) tally.retyped++;
        }
        tm[b.id] = r;
        if(r !== 'core') tally[r]++;
        if(DRY && (d === 'wrong' || r !== 'core' || (t && !b.line.includes(`| typed: ${t} |`)))) console.log(`  [${job.slug}] ${b.line.slice(0, 110)}\n      → ${JSON.stringify(a)}`);
      });
    } catch(e){ console.log(`\n  !! batch failed: ${e.message}`); }
    done += job.batch.length;
    process.stdout.write(`\r  ${done}/${total} · ${tally.wrong} wrong dates · ${tally.retyped} retyped · ${tally.off} off · ${tally.context} context`);
    if(++sinceSave >= 10){ sinceSave = 0; save(); }
  }
}));
save();
console.log(`\n  ${tokIn} in + ${tokOut} out tokens ≈ $${(tokIn / 1e6 + tokOut * 5 / 1e6).toFixed(2)}${DRY ? '' : ` · wrote ${path.basename(AUDIT_AUTO)}`}`);
