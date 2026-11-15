#!/usr/bin/env node
/**
 * Are these two mined events the same happening? Asked of Claude Haiku for each
 * candidate pair (lib/dupes.mjs: same year ±1, shared words or names) in the
 * built topics, so topic.mjs can merge them.
 *
 *   node datasets/dedupe-events.mjs            every built topic
 *   node datasets/dedupe-events.mjs mughal-empire
 *   node datasets/dedupe-events.mjs --dry
 *
 * Output: datasets/dupes-auto.json { "idA|idB": true | false }. Then rebuild
 * (topic.mjs --all). Merged events leave the topic file, so a later run sees
 * fewer pairs; answers are kept by pair.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUPES_AUTO, dupCandidates, pairKey, readDupes } from './lib/dupes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.DEDUPE_MODEL || 'claude-haiku-4-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const slugs = argv.filter((a) => !a.startsWith('--'));
if(!KEY){ console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }

const dupes = readDupes();
const index = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', 'index.json'), 'utf8')).topics;
const firstLine = (it) => String(it.excerpt || '').split(/\n/)[0].replace(/\s+/g, ' ').slice(0, 240);
const yr = (y) => (y < 0 ? `${-y} BC` : `${y}`);
const pairs = [];
for(const t of index){
  if(slugs.length && !slugs.includes(t.slug)) continue;
  let T; try { T = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', `${t.slug}.json`), 'utf8')); } catch { continue; }
  // Mined events among themselves, and against the article's own linked
  // events ("Mongol invasions of Japan" and the mined "First Mongol invasion
  // repelled"); two linked entries are different pages, never merged.
  const ev = T.items.filter((it) => it.onTimeline && (it.via === 'events' || (it.via === 'link' && (it.type === 'event' || it.type === 'work'))));
  for(const [a, b] of dupCandidates(ev)){
    if(a.via !== 'events' && b.via !== 'events') continue;
    const k = pairKey(a, b);
    if(k in dupes || pairs.some((p) => p.k === k)) continue;
    pairs.push({ k, topic: T.title, a: `${yr(a.start)}: ${a.title} — ${firstLine(a)}`, b: `${yr(b.start)}: ${b.title} — ${firstLine(b)}` });
  }
}
console.log(`\n  ${pairs.length} candidate pairs to judge with ${MODEL}${DRY ? ' (dry run)' : ''}`);
if(!pairs.length) process.exit(0);

const SYSTEM = `Each numbered item is a pair of timeline events (A and B) mined from different Wikipedia pages.
Say whether they describe the SAME happening, so that one card would do: true or false.
Same: the same battle, treaty, death, conquest, founding or decision told in other words, even if one adds a detail
or the years differ by one. Different: two steps of a story (capture vs. execution, accession vs. death, a
siege vs. a later battle), or two separate events with the same people.
Reply with one JSON object mapping each number to true or false, nothing else.`;

async function ask(batch){
  const user = batch.map((p, i) => `${i + 1}. [${p.topic}]\nA: ${p.a}\nB: ${p.b}`).join('\n');
  for(let attempt = 0; attempt < 6; attempt++){
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
      });
    } catch { await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if(r.status === 429 || r.status >= 500){ await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); continue; }
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    const txt = d.content?.map((c) => c.text || '').join('') || '';
    try { return { out: JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)), usage: d.usage }; }
    catch { if(attempt >= 2) throw new Error(`unparseable reply: ${txt.slice(0, 200)}`); }
  }
  throw new Error('gave up after retries');
}

const batches = [];
for(let i = 0; i < pairs.length; i += 25) batches.push(pairs.slice(i, i + 25));
let next = 0, same = 0, diff = 0, tokIn = 0, tokOut = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while(next < batches.length){
    const b = batches[next++];
    try {
      const { out, usage } = await ask(b);
      tokIn += usage?.input_tokens || 0; tokOut += usage?.output_tokens || 0;
      b.forEach((p, i) => {
        const v = out[i + 1] ?? out[String(i + 1)];
        if(typeof v !== 'boolean') return;
        dupes[p.k] = v; v ? same++ : diff++;
        if(DRY) console.log(`  ${v ? 'SAME' : 'diff'}  ${p.a.split(' — ')[0]}  ||  ${p.b.split(' — ')[0]}`);
      });
    } catch(e){ console.log(`  !! batch failed: ${e.message}`); }
  }
}));
if(!DRY) fs.writeFileSync(DUPES_AUTO, JSON.stringify(Object.fromEntries(Object.entries(dupes).sort()), null, 1) + '\n');
console.log(`\n  ${same} same, ${diff} different · ${tokIn} in + ${tokOut} out tokens ≈ $${(tokIn / 1e6 + tokOut * 5 / 1e6).toFixed(2)}`);
