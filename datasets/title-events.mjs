#!/usr/bin/env node
/**
 * Short titles for mined events, written by a small model (Claude Haiku).
 *
 *   node datasets/title-events.mjs              every built topic
 *   node datasets/title-events.mjs inca-empire  one or more slugs
 *   node datasets/title-events.mjs --dry        print, write nothing
 *
 * A mined event is titled by its own first words, a sentence fragment ("The
 * Portuguese explorer Aleixo Garcia was the first European to reach"). Prose
 * events (from narrative pages) stay off the timeline until titled. This asks
 * the model, 30 at a time, for a timeline label of at most ~8 words, or null
 * when the sentence is not an event at all (commentary on historians, a
 * citation, a statistic, a restatement of a period's span).
 *
 * Output: datasets/titles-auto.json  { id: "title" | null }. null = rejected,
 * never asked again. datasets/titles.json (written by hand) always wins; see
 * lib/lite.mjs readTitles. Rebuild topics afterwards (topic.mjs --all).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTO = path.join(HERE, 'titles-auto.json');
const HAND = path.join(HERE, 'titles.json');
const MODEL = process.env.TITLE_MODEL || 'claude-haiku-4-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const slugs = argv.filter((a) => !a.startsWith('--'));
if(!KEY){ console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const auto = read(AUTO);
const hand = read(HAND);

// What needs a title: prose events (all), and timeline-line events whose title
// is a sentence (5+ words, or longer than 48 characters).
const index = read(path.join(HERE, 'topics', 'index.json')).topics || [];
const want = new Map();   // id -> { topic, year, text }
for(const t of index){
  if(slugs.length && !slugs.includes(t.slug)) continue;
  let T; try { T = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', `${t.slug}.json`), 'utf8')); } catch { continue; }
  for(const it of T.items){
    if(it.via !== 'events' || it.id in hand || it.id in auto || want.has(it.id)) continue;
    const title = it.origTitle || it.title;
    const sentence = it.prose || title.split(/\s+/).length >= 5 || title.length > 48;
    if(!sentence) continue;
    const text = String(it.excerpt || title).split(/\n/)[0].replace(/\s+/g, ' ').slice(0, 420);
    want.set(it.id, { topic: T.title, year: it.yearText || String(it.start), text });
  }
}
console.log(`\n  ${want.size} events to title with ${MODEL}${DRY ? ' (dry run)' : ''}`);
if(!want.size) process.exit(0);

const SYSTEM = `You write labels for a history timeline. Each input is a sentence from Wikipedia with its date.
For each, return a short title naming WHAT HAPPENED, like a timeline label:
- at most 8 words, ideally 3-6; no year or date in the title; no trailing period
- active and specific: "Pizarro reaches Inca territory", "Battle of Las Salinas", "Cyrus captures Babylon", "Haber process for ammonia", "Death of Huayna Capac"
- name the people, places and things involved; keep proper nouns and their accents
- use English sentence case (capitalise only the first word and proper nouns)
Return null instead of a title when the sentence is NOT a datable event or development of the topic:
commentary or arguments by modern historians or scholars, citations, publication years of modern books,
statistics or estimates with no event, a sentence that only restates a period's or reign's span,
or anything too vague to label.
Reply with one JSON object mapping each id to its title or null, and nothing else.`;

async function ask(batch){
  const user = batch.map(([id, w]) => `${id}\t[${w.topic}] ${w.year} — ${w.text}`).join('\n');
  for(let attempt = 0; attempt < 6; attempt++){
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    if(r.status === 429 || r.status >= 500){ await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    const txt = d.content?.map((c) => c.text || '').join('') || '';
    const json = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    try { return { out: JSON.parse(json), usage: d.usage }; } catch { if(attempt >= 2) throw new Error(`unparseable reply: ${txt.slice(0, 200)}`); }
  }
  throw new Error('gave up after retries');
}

const clean = (t) => typeof t === 'string'
  ? t.replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim().slice(0, 80) || null
  : null;

const items = [...want.entries()];
const BATCH = 30, CONC = 4;
let done = 0, kept = 0, rejected = 0, tokIn = 0, tokOut = 0;
const save = () => { if(!DRY) fs.writeFileSync(AUTO, JSON.stringify(Object.fromEntries(Object.entries(auto).sort()), null, 1) + '\n'); };
const batches = [];
for(let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while(next < batches.length){
    const b = batches[next++];
    try {
      const { out, usage } = await ask(b);
      tokIn += usage?.input_tokens || 0; tokOut += usage?.output_tokens || 0;
      for(const [id, w] of b){
        if(!(id in out)) continue;            // not answered: ask again next run
        const t = clean(out[id]);
        auto[id] = t;
        t ? kept++ : rejected++;
        if(DRY) console.log(`  ${t ? '✓' : '✗'} ${w.year.padEnd(12)} ${t || '—'}   ⟵ ${w.text.slice(0, 90)}`);
      }
    } catch(e){ console.log(`  !! batch failed: ${e.message}`); }
    done += b.length;
    process.stdout.write(`\r  ${done}/${items.length} · ${kept} titled · ${rejected} rejected`);
    if(!DRY && next % 5 === 0) save();
  }
}));
save();
// Haiku 4.5: $1 / M input, $5 / M output
console.log(`\n  ${kept} titled, ${rejected} rejected · ${tokIn} in + ${tokOut} out tokens ≈ $${(tokIn / 1e6 + tokOut * 5 / 1e6).toFixed(2)}${DRY ? '' : ` · wrote ${path.basename(AUTO)}`}`);
