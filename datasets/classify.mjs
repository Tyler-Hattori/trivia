#!/usr/bin/env node
/**
 * Give every entry a place in a KNOWN subject taxonomy, plus a region and its
 * own Wikipedia categories. Free: Wikimedia APIs only, no local model.
 *
 *     node datasets/classify.mjs            # label anything not yet labelled (resumable)
 *     node datasets/classify.mjs --refresh  # recompute assignments (fetched labels are cached)
 *     node datasets/classify.mjs --report   # coverage and the tree, no network
 *
 * Writes datasets/atlas/taxonomy.json (a sidecar, so migrate.mjs rewriting
 * entries.jsonl cannot lose it).
 *
 * ## Why a known taxonomy at the top and embeddings only below
 *
 * The atlas used to derive EVERY level of its hierarchy from embeddings, and the
 * top levels were the bad part: "Politician · President" x5 sibling rows,
 * "Rococo" bands over the year 1400. Broad subject areas are not something to
 * rediscover from 8,000 vectors; Wikimedia already maintains them.
 *
 * Wikipedia's category GRAPH is not usable for this. It is a web, not a tree:
 * walking up from *Battle of Hastings* touches 1,260 categories in six levels and
 * reaches "Politics" before "History"; *Les Demoiselles d'Avignon* reaches "Food
 * and drink". But Wikimedia's **articletopic** model (outlink-topic-model on
 * Lift Wing) assigns every article to a fixed 64-topic taxonomy in layers —
 * Culture › Visual arts, History and Society › Military and warfare, STEM ›
 * Physics — with Geography as a separate REGION axis. That is the known top.
 *
 * ## Three sources of a label, in order of trust
 *
 *   page     the entry has its own Wikipedia page: ask the model (3,253 entries)
 *   dataset  a CSV row with no page: art -> Visual arts, film -> Films
 *   knn      everything else (mined timeline events, hand rows): a similarity-
 *            weighted vote of its 15 nearest LABELLED neighbours by embedding,
 *            mixed with the labels of the page it was mined from. This is the
 *            part ML is for: distance between things below the known layers.
 *
 * ## Placement rule for people
 *
 * Biography is a topic in the taxonomy, but filing every person under it would
 * put Henry VIII in a different band from the Battle of Bosworth. A person is
 * placed by their best NON-biography subject when it scores at least 0.15
 * (Henry VIII: Biography 0.87, History 0.29 -> History).
 */

import fs from 'node:fs';
import path from 'node:path';
import { readEntries, readSearchVectors, ATLAS_DIR, PATHS } from './lib/store.mjs';

const OUT = PATHS.taxonomy;
const UA = 'trivia-dev/0.1 (tylerwhattori@gmail.com; personal study project)';
const LW = 'https://api.wikimedia.org/service/lw/inference/v1/models/outlink-topic-model:predict';
const WP = 'https://en.wikipedia.org/w/api.php';

const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh');
const REPORT = argv.includes('--report');
const CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
store.pages ||= {};       // page title -> { t: {topic: score}, cats: [...] }  (fetch cache)
store.entries ||= {};     // entry id   -> assignment
const save = () => fs.writeFileSync(OUT, JSON.stringify(store) + '\n');

// ---------------------------------------------------------------------------
// The taxonomy, as the model names it
// ---------------------------------------------------------------------------

/** "Culture.Visual_arts.Visual_arts*" -> ["Culture", "Visual arts"] (the * marks a catch-all). */
export function topicPath(topic){
  const parts = topic.replace(/\*$/, '').split('.').map((s) => s.replace(/_/g, ' '));
  // Drop a repeated last segment ("Visual arts.Visual arts").
  if(parts.length > 2 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop();
  return parts;
}
const TOP_NAME = { 'History and Society': 'History & Society', 'Culture': 'Culture', 'STEM': 'Science & Technology', 'Geography': 'Geography' };
const isRegion = (t) => t.startsWith('Geography.Regions');
const isBio = (t) => t.startsWith('Culture.Biography');

/**
 * The subject an entry is FILED under: [top, mid]. Region topics never; a
 * biography topic only when nothing else clears 0.15.
 */
function primaryOf(scores){
  const subj = Object.entries(scores).filter(([t]) => !isRegion(t)).sort((a, b) => b[1] - a[1]);
  if(!subj.length) return null;
  const nonBio = subj.filter(([t]) => !isBio(t));
  let pick = nonBio.length && (nonBio[0][1] >= 0.15 || !subj.some(([t]) => isBio(t))) ? nonBio[0] : subj[0];
  /*
   * A catch-all ("STEM.STEM*", "Culture.Media.Media*") says only which group.
   * When a specific subject in the same group also clears 0.15, file it there:
   * otherwise 656 entries land in a band called "STEM" while Physics has 23.
   */
  if(pick[0].endsWith('*')){
    const group = pick[0].split('.')[0];
    const specific = subj.find(([t, sc]) => !t.endsWith('*') && t.startsWith(group + '.') && !isBio(t) && sc >= 0.15);
    if(specific) pick = specific;
  }
  const p = topicPath(pick[0]);
  // Two levels for the band structure; "Culture.Media.Films" files under Films.
  let mid = p.length >= 3 ? p[p.length - 1] : (p[1] || p[0]);
  if(mid === p[0]) mid = `${TOP_NAME[p[0]] || p[0]} (general)`;   // the bare catch-all
  return { top: TOP_NAME[p[0]] || p[0], mid, topic: pick[0], score: +pick[1].toFixed(3) };
}

/** Best region, most specific first ("Northern Europe" over "Europe"). */
function regionOf(scores){
  const r = Object.entries(scores).filter(([t, s]) => isRegion(t) && s >= 0.4).sort((a, b) => b[1] - a[1]);
  if(!r.length) return null;
  const specific = r.filter(([t]) => !t.endsWith('*'));
  const [t] = (specific[0] || r[0]);
  return topicPath(t).slice(2).join(' › ') || topicPath(t).pop();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchTopics(title){
  for(let attempt = 0; attempt < 6; attempt++){
    try {
      const r = await fetch(LW, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ page_title: title, lang: 'en', threshold: 0.05 }),
      });
      if(r.status === 429 || r.status >= 500){ await sleep(2000 * (attempt + 1)); continue; }
      if(!r.ok) return {};
      const d = await r.json();
      return Object.fromEntries((d.prediction?.results || []).map((x) => [x.topic, +x.score.toFixed(3)]));
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return null;   // null = try again next run; {} = the model has nothing for it
}

/*
 * An entry's own categories are the precise bottom layer ("Battles involving the
 * Normans", "Paintings by Pablo Picasso"). Hidden maintenance categories are
 * excluded by the API; date bins ("1066 in England", "1491 births") are dropped
 * here, because time is the x axis and a number, not a subject.
 */
const DATE_CAT = /\b\d{1,4}s?\b|\bcentury\b|\bmillennium\b|\bbirths\b|\bdeaths\b|\bestablishments\b|\bdisestablishments\b|\bannounced in\b/i;
const JUNK_CAT = /^(articles|pages|all |wikipedia|cs1|webarchive|use |short description|commons|good articles|featured articles|wikidata)/i;

async function fetchCategories(titles){
  const out = {};
  for(let i = 0; i < titles.length; i += 50){
    const chunk = titles.slice(i, i + 50);
    const u = `${WP}?action=query&format=json&formatversion=2&redirects=1&prop=categories&clshow=!hidden&cllimit=max&titles=${encodeURIComponent(chunk.join('|'))}`;
    let d = null;
    for(let a = 0; a < 4 && !d; a++){ try { const r = await fetch(u, { headers: { 'User-Agent': UA } }); d = r.ok ? await r.json() : null; } catch { await sleep(800); } }
    if(!d) continue;
    const back = new Map();
    for(const n of d.query?.normalized || []) back.set(n.to, n.from);
    for(const rd of d.query?.redirects || []) back.set(rd.to, back.get(rd.from) || rd.from);
    for(const p of d.query?.pages || []){
      const cats = (p.categories || []).map((c) => c.title.replace(/^Category:/, ''))
        .filter((c) => !DATE_CAT.test(c) && !JUNK_CAT.test(c));
      out[back.get(p.title) || p.title] = cats;
      out[p.title] = cats;
    }
  }
  return out;
}

const pageTitle = (e) => {
  const w = e.origin?.wiki || '';
  const m = w.match(/\/wiki\/(.+)$/);
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const entries = readEntries();
const own = entries.filter((e) => !e.origin?.manual && pageTitle(e));
const sources = [...new Set(entries.filter((e) => e.origin?.manual && pageTitle(e)).map(pageTitle))];

if(!REPORT){
  const todo = [...new Set([...own.map(pageTitle), ...sources])].filter((t) => !store.pages[t]?.t);
  if(todo.length){
    console.log(`  fetching subject labels for ${todo.length} pages (free, ~${Math.ceil(todo.length / 18 / 60)} min)…`);
    let k = 0, done = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while(k < todo.length){
        const t = todo[k++];
        const topics = await fetchTopics(t);
        if(topics) (store.pages[t] ||= {}).t = topics;
        if(++done % 100 === 0){
          save();
          process.stdout.write(`\r    ${done}/${todo.length}  ${(done / ((Date.now() - t0) / 1000)).toFixed(1)}/s   `);
        }
      }
    }));
    save();
    console.log(`\r    ${done}/${todo.length} done in ${Math.round((Date.now() - t0) / 1000)}s          `);
  }
  const catTodo = own.map(pageTitle).filter((t) => !store.pages[t]?.cats);
  if(catTodo.length){
    console.log(`  fetching own categories for ${catTodo.length} pages…`);
    const cats = await fetchCategories([...new Set(catTodo)]);
    for(const t of catTodo) (store.pages[t] ||= {}).cats = cats[t] || [];
    save();
  }
}

// --- assignment --------------------------------------------------------------

const DATASET_PRIOR = {
  art: { 'Culture.Visual_arts.Visual_arts*': 0.9 },
  film: { 'Culture.Media.Films': 0.95, 'Culture.Media.Media*': 0.9 },
  leaders: { 'History_and_Society.Politics_and_government': 0.6, 'History_and_Society.History': 0.5, 'Culture.Biography.Biography*': 0.8 },
  people: { 'Culture.Biography.Biography*': 0.8 },
  literature: { 'Culture.Literature': 0.9 },
  philosophy: { 'Culture.Philosophy_and_religion': 0.9 },
  religion: { 'Culture.Philosophy_and_religion': 0.9 },
};

const assigned = REFRESH ? {} : { ...store.entries };
let fromPage = 0, fromDataset = 0, fromKnn = 0;

// Pass 1: entries with their own page, and dataset rows.
for(const e of entries){
  if(assigned[e.id] && !REFRESH) continue;
  const pt = !e.origin?.manual ? pageTitle(e) : null;
  const page = pt ? store.pages[pt] : null;
  let scores = page?.t && Object.keys(page.t).length ? page.t : null;
  let source = 'page';
  if(!scores && DATASET_PRIOR[e.origin?.dataset]){ scores = DATASET_PRIOR[e.origin.dataset]; source = 'dataset'; }
  if(!scores) continue;
  const primary = primaryOf(scores);
  if(!primary) continue;
  assigned[e.id] = { ...primary, region: regionOf(scores), source, conf: primary.score, cats: page?.cats || [] , s: compact(scores) };
  if(source === 'page') fromPage++; else fromDataset++;
}

// Pass 2: everything else, by nearest labelled neighbours (+ its source page).
const unlabelled = entries.filter((e) => !assigned[e.id]);
if(unlabelled.length){
  const vec = readSearchVectors();
  if(!vec) console.warn('  no search vectors — run embed-all.mjs; skipping the neighbour vote');
  else {
    const labelled = entries.filter((e) => assigned[e.id] && assigned[e.id].source === 'page' && vec.has(e.id));
    const D = vec.dim;
    const L = new Float32Array(labelled.length * D);
    labelled.forEach((e, i) => L.set(vec.get(e.id), i * D));
    const K = 15;
    for(const e of unlabelled){
      const v = vec.get(e.id);
      if(!v) continue;
      // top-K labelled neighbours
      const best = [];
      for(let i = 0; i < labelled.length; i++){
        let s = 0; const o = i * D;
        for(let d = 0; d < D; d++) s += L[o + d] * v[d];
        if(best.length < K || s > best[best.length - 1][0]){
          best.push([s, i]); best.sort((a, b) => b[0] - a[0]); if(best.length > K) best.pop();
        }
      }
      // Similarity-weighted mean of their score vectors…
      const acc = {};
      let wsum = 0;
      for(const [s, i] of best){
        const w = Math.max(0, s) ** 3;      // sharpen: the nearest few dominate
        wsum += w;
        for(const [t, sc] of Object.entries(assigned[labelled[i].id].s)) acc[t] = (acc[t] || 0) + w * sc;
      }
      for(const t in acc) acc[t] /= wsum || 1;
      // …mixed with the page it was mined from: an event on "Timeline of
      // mathematics" is mathematics even when its nearest neighbours disagree.
      const src = e.origin?.manual ? store.pages[pageTitle(e)]?.t : null;
      if(src) for(const [t, sc] of Object.entries(src)) acc[t] = 0.6 * (acc[t] || 0) + 0.4 * sc;
      const primary = primaryOf(acc);
      if(!primary) continue;
      assigned[e.id] = { ...primary, region: regionOf(acc), source: 'knn', conf: +(primary.score * (best[0]?.[0] || 0)).toFixed(3), cats: [], s: compact(acc) };
      fromKnn++;
    }
  }
}

function compact(scores){
  return Object.fromEntries(Object.entries(scores).filter(([, s]) => s >= 0.1).map(([t, s]) => [t, +(+s).toFixed(3)]));
}

// Drop assignments for entries that no longer exist.
const live = new Set(entries.map((e) => e.id));
for(const id of Object.keys(assigned)) if(!live.has(id)) delete assigned[id];
store.entries = assigned;
store.updated = new Date().toISOString();
if(!REPORT) save();

// --- report ------------------------------------------------------------------
const all = Object.values(assigned);
console.log(`\n  ${all.length}/${entries.length} entries placed in the taxonomy` +
  `${fromPage + fromDataset + fromKnn ? `  (this run: ${fromPage} by page, ${fromDataset} by dataset, ${fromKnn} by neighbours)` : ''}`);
const by = {};
for(const a of all){ (by[a.top] ||= {})[a.mid] = ((by[a.top] ||= {})[a.mid] || 0) + 1; }
for(const [top, mids] of Object.entries(by).sort((a, b) => sum(b[1]) - sum(a[1]))){
  console.log(`\n  ${top}  ${sum(mids)}`);
  for(const [m, c] of Object.entries(mids).sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(5)}  ${m}`);
}
const regions = {};
for(const a of all) if(a.region) regions[a.region] = (regions[a.region] || 0) + 1;
console.log(`\n  regions: ${Object.entries(regions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, c]) => `${r} ${c}`).join(' · ')}`);
function sum(o){ return Object.values(o).reduce((a, b) => a + b, 0); }
