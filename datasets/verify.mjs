#!/usr/bin/env node
/**
 * Invariant checks over the built atlas. Pure Node, about a second, no browser.
 *
 *     node datasets/verify.mjs
 *
 * These are the properties the design rests on. Each one, if it silently breaks,
 * produces an atlas that still renders and is still wrong — which is why they
 * are asserted rather than eyeballed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readEntries, readVectors, readJSON, PATHS, REPO_DIR, entryText } from './lib/store.mjs';
import { cosine, nearestLeaf } from './lib/cluster.mjs';
import { parseYears, findDate } from './lib/years.mjs';

let pass = 0;
const fails = [];

const check = (name, fn) => {
  try {
    const detail = fn();
    pass++;
    console.log(`  ok    ${name}${detail ? `   ${detail}` : ''}`);
  } catch(e){
    fails.push([name, e.message]);
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  }
};

const assert = (cond, msg) => { if(!cond) throw new Error(msg); };

// ---------------------------------------------------------------------------

const entries = readEntries();
const atlas = readJSON(PATHS.atlas);
const layout = readJSON(PATHS.layout);
const details = readJSON(PATHS.details);

if(!entries.length || !atlas){
  console.error('  Nothing built. Run: node datasets/migrate.mjs && node datasets/embed-all.mjs && node datasets/atlas.mjs --rebuild');
  process.exit(1);
}

const P = atlas.points;
const N = atlas.count;
const nodes = atlas.nodes;

console.log(`\n  ${entries.length} entries · ${N} placed · ${nodes.length} nodes · model ${atlas.model}\n`);

// ---- store -----------------------------------------------------------------

check('entry ids are unique', () => {
  const seen = new Set();
  for(const e of entries){
    assert(!seen.has(e.id), `duplicate id ${e.id}`);
    seen.add(e.id);
  }
  return `${seen.size} ids`;
});

check('every entry has a parseable year', () => {
  const bad = entries.filter((e) => typeof e.start !== 'number' || Number.isNaN(e.start));
  assert(!bad.length, `${bad.length} without a year, e.g. ${bad[0]?.id}`);
});

check('spans run forwards', () => {
  const bad = entries.filter((e) => e.end != null && e.end < e.start);
  assert(!bad.length, `${bad.length} end-before-start, e.g. ${bad[0]?.id} (${bad[0]?.yearText})`);
});

/*
 * The atlas's x extent is a max over every row, so one misread date moves the
 * whole axis. Five rows once ran past the present — three BC ranges that lost
 * their era token and two percentages read as the far half of a range — and the
 * visible symptom was a time axis reaching the year 3200 with a millennium of
 * empty space on the right. Cheaper to assert than to notice.
 */
check('nothing is dated after the present', () => {
  const now = new Date().getFullYear();
  const bad = entries.filter((e) => Math.max(e.start ?? -Infinity, e.end ?? -Infinity) > now);
  assert(!bad.length,
    `${bad.length} past ${now}, e.g. ${bad[0]?.id} (${bad[0]?.yearText}) -> ${bad[0]?.start}..${bad[0]?.end}`);
});

/*
 * A QID identifies a thing, so two rows holding one are the same thing twice.
 * They are invisible in aggregate — the count looks right — and obvious on the
 * map, where the pair draws as one mark you cannot select and inflates whatever
 * cluster it lands in. `ingest.mjs` only deduped against the store as it was at
 * startup, so a QID reached twice within a single run passed both times.
 */
check('no QID appears twice', () => {
  const byQid = new Map();
  for(const e of entries){
    const q = e.origin?.qid;
    if(!q) continue;
    byQid.set(q, [...(byQid.get(q) || []), e.id]);
  }
  const dupes = [...byQid].filter(([, ids]) => ids.length > 1);
  assert(!dupes.length,
    `${dupes.length} QIDs held by more than one entry, e.g. ${dupes[0]?.[0]} -> ${dupes[0]?.[1].join(', ')}`);
});

check('yearText still parses to the stored start', () => {
  const bad = entries.filter((e) => {
    if(!e.yearText) return false;
    const { start } = parseYears(e.yearText);
    return start != null && start !== e.start;
  });
  // A mismatch means the stored number and the displayed text disagree — the
  // card would show one year and sit at another.
  assert(bad.length === 0, `${bad.length} disagree, e.g. ${bad[0]?.id}: text "${bad[0]?.yearText}" vs start ${bad[0]?.start}`);
});

check('a span\'s yearText still parses to its stored end', () => {
  /*
   * The start check above passes on a range whose second half was misread, which is
   * how "320 kya – 305 kya" once stored 320 kya with "305 kya:" left sitting in the
   * title. A span's far edge needs asserting too.
   *
   * Spans only. A point-kind dataset collapses a range on purpose — art.csv dates a
   * painting "1330-1340" and the entry is a point at 1330 — so a point whose text is
   * a range is intended, not a parse failure. 155 rows are in that state.
   */
  const bad = entries.filter((e) => {
    if(e.kind !== 'span' || !e.yearText || e.end == null) return false;
    const { end } = parseYears(e.yearText);
    return end != null && end !== e.end;
  });
  assert(bad.length === 0,
    `${bad.length} disagree, e.g. ${bad[0]?.id}: text "${bad[0]?.yearText}" vs end ${bad[0]?.end}`);
});

check('the year parser reads deep time', () => {
  /*
   * Not a property of the data but of the code the data depends on, and it belongs
   * here because breaking it is invisible: every one of these forms appears in the
   * geologic timeline articles `ingest.mjs --events` mines, and a regression does
   * not throw — it files the Archean inside the Pleistocene, three orders of
   * magnitude out, on an axis where nothing looks wrong.
   *
   * The epoch cases are the fragile ones. A relative date is converted with a FIXED
   * 1950 reference, so if that ever becomes `new Date()` these assertions start
   * failing every January while the atlas still renders.
   */
  const cases = [
    ['66 Ma',                              -66000000,   -66000000],
    ['c. 4,570 Ma',                        -4570000000, -4570000000],
    ['4.54 billion years ago',             -4540000000, -4540000000],
    ['541 to 485 million years ago',       -541000000,  -485000000],
    ['252-201 Ma',                         -252000000,  -201000000],
    ['320 kya – 305 kya',                  -320000,     -305000],   // unit on both sides
    ['2 Ma – 500 ka',                      -2000000,    -500000],   // mixed units
    ['c. 4,567 ±3 Ma',                     -4567000000, -4567000000], // tolerance, not a range
    ['11,700 BP',                          -9750,       -9750],
    ['300,000 years ago',                  -300000,     -300000],
    // Absolute dates must NOT be dragged into the relative reading.
    ['3000 BC',                            -3000,       -3000],
    ['1879-1955',                          1879,        1955],
    ['27 BC - 14 AD',                      -27,         14],
    ['c. 251.9 Ma ± 0.024 Ma',             -251900000,  -251900000], // unit on the tolerance
    // Ranges that would otherwise run backwards, which `spans run forwards` forbids.
    ['1601–03',                            1601,        1603],       // abbreviated far half
    ['1899-01',                            1899,        1901],       // …across the century
    ['180–10 AD',                          -180,        10],          // straddles the era
    ['between 1850 and 1900',              1850,        1900],
    // Both ends hedged with the era stated once at the close — how an
    // archaeological culture is dated. Read as bare "c. 3200" this filed
    // Neolithic Greece under AD 3200.
    ['c. 3200 – c. 2650 BC',               -3200,       -2650],
    // Three digits is not an abbreviated year. Carrying the leading digit turned
    // a percentage the miner mistook for a date into the year 2170.
    ['1913 to 170',                        1913,        170],
  ];
  for(const [text, start, end] of cases){
    const got = parseYears(text);
    assert(got.start === start && got.end === end,
      `"${text}" -> ${got.start}..${got.end}, expected ${start}..${end}`);
  }
  return `${cases.length} forms`;
});

check('a duration is not read as a date', () => {
  // "flora recovered over 1.7 million years" is a length of time. Read as a date it
  // became a year in the Pleistocene, so `findDate` requires "ago" on the spelled-out
  // form. The symbol form is a date on its own and must still be found.
  assert(!findDate('flora recovered over 1.7 million years'), '"1.7 million years" read as a date');
  assert(!findDate('diversifying approximately 30 million years after the event'),
    '"30 million years after" read as a date');
  assert(findDate('the impact 66 million years ago')?.start === -66000000, '"66 million years ago" not found');
  assert(findDate('the Judith River Formation at 75 Ma')?.start === -75000000, '"75 Ma" not found');
  assert(!findDate('It has 400 members and covers 12 states'), 'a bare quantity read as a year');
});

check('a year followed by punctuation is still a year', () => {
  /*
   * The guard after a bare year is there to stop a fragment of a longer number
   * reading as one. It used to reject any following comma or period, which threw
   * away the commonest timeline line there is and — worse — half-matched ranges,
   * leaving the second date sitting in the title. Both shapes are asserted because
   * neither failed loudly: the page simply mined fewer events.
   */
  const head = (s) => findDate(s, { anchored: true });
  assert(head('1066, the Norman conquest of England')?.text === '1066', '"1066," not read as a year');
  assert(head('1914–1918, the Great War')?.end === 1918, 'a range before a comma was truncated');
  assert(findDate('published in 1900, he said')?.start === 1900, 'a mid-sentence year before a comma');
  assert(head('1920s Droughts on Euboea')?.text === '1920s', 'a decade left its "s" behind');
  // Still not a year: these are what the guard is actually for.
  assert(!findDate('1,900 members attended'), '"1,900" read as the year 900');
  assert(!findDate('the figure rose to 1955.5 units'), '"1955.5" read as the year 1955');
});

check('the loose prose grammar stays narrower than prose', () => {
  /*
   * `--events-prose` accepts attributive and parenthetical years, which is the only
   * way narrative history yields anything. The bound that keeps it honest is the
   * 4-digit year range plus a unit lookahead — with those gone it reads every
   * quantity on the page as a date, and a quantity misread as a year lands an entry
   * in the wrong millennium with nothing to flag it.
   */
  const loose = (s) => findDate(s, { loose: true });
  assert(loose('Planck won the 1918 Nobel Prize')?.start === 1918, 'an attributive year not found');
  assert(loose('the planetary model of the atom (1911).')?.start === 1911, 'a parenthesised year not found');
  assert(loose('Throughout the 1800s many studies')?.start === 1800, 'a decade not found');
  assert(loose('between 1850 and 1900, which')?.end === 1900, 'an unprepositioned range not found');
  assert(!loose('It has 400 members and covers 12 states'), 'a 3-digit quantity read as a year');
  assert(!loose('the tunnel runs 1500 metres beneath the ridge'), '"1500 metres" read as a year');
  assert(!loose('a crowd of 2000 people gathered'), '"2000 people" read as a year');
  assert(!loose('a print run of 1,200 copies'), '"1,200 copies" read as a year');
});

check('every entry migrate.mjs cannot rebuild is marked', () => {
  /*
   * migrate.mjs rewrites entries.jsonl from the CSVs and carries everything else
   * over. A row it can neither regenerate nor recognise is a row it deletes, and the
   * marker that saves one is `origin.manual`. This asserts the store holds no entry
   * relying on the old, weaker rule.
   */
  const bad = entries.filter((e) => {
    if(e.origin?.wiki || e.origin?.qid || e.origin?.manual) return false;
    return !fs.existsSync(path.join(path.dirname(PATHS.entries), '..', `${e.origin?.dataset || ''}.csv`));
  });
  assert(!bad.length,
    `${bad.length} entry/entries have no provenance and no CSV, e.g. ${bad[0]?.id} ` +
    `(dataset "${bad[0]?.origin?.dataset}") — set origin.manual = true`);
  return `${entries.filter((e) => e.origin?.manual).length} marked manual`;
});

check('vectors exist for every placed point', () => {
  const vec = readVectors();
  const missing = P.id.filter((id) => !vec.has(id));
  assert(!missing.length, `${missing.length} placed points have no vector`);
  return `${vec.ids.length} vectors x ${vec.dim}`;
});

check('vectors are unit length', () => {
  const vec = readVectors();
  let worst = 0, worstId = null;
  for(const id of vec.ids.slice(0, 400)){
    const v = vec.get(id);
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    if(Math.abs(n - 1) > worst){ worst = Math.abs(n - 1); worstId = id; }
  }
  // int8 quantisation perturbs the norm slightly; more than 2% means the
  // per-row scale is wrong, not rounding.
  assert(worst < 0.02, `norm off by ${worst.toFixed(4)} on ${worstId}`);
  return `max norm error ${worst.toExponential(1)}`;
});

// ---- geometry --------------------------------------------------------------

check('y is inside [0,1]', () => {
  for(let i = 0; i < N; i++) assert(P.y[i] >= 0 && P.y[i] <= 1, `point ${P.id[i]} at y=${P.y[i]}`);
});

check('every point sits inside its own leaf band', () => {
  for(let i = 0; i < N; i++){
    const nd = nodes[P.leaf[i]];
    assert(nd, `point ${P.id[i]} references missing node ${P.leaf[i]}`);
    assert(!nd.children.length, `point ${P.id[i]} is attached to non-leaf ${nd.id}`);
    // 1e-5 rounding is applied on output.
    assert(P.y[i] >= nd.y0 - 1e-4 && P.y[i] <= nd.y1 + 1e-4,
      `${P.id[i]} y=${P.y[i]} outside leaf ${nd.id} band ${nd.y0}–${nd.y1}`);
  }
});

check('parent bands contain their children', () => {
  for(const nd of nodes){
    for(const c of nd.children){
      assert(nodes[c].y0 >= nd.y0 - 1e-4 && nodes[c].y1 <= nd.y1 + 1e-4,
        `node ${c} band ${nodes[c].y0}–${nodes[c].y1} escapes parent ${nd.id} ${nd.y0}–${nd.y1}`);
    }
  }
});

check('sibling bands do not overlap', () => {
  for(const nd of nodes){
    const kids = nd.children.map((c) => nodes[c]).sort((a, b) => a.y0 - b.y0);
    for(let i = 1; i < kids.length; i++){
      assert(kids[i].y0 >= kids[i - 1].y1 - 1e-4,
        `siblings ${kids[i - 1].id} and ${kids[i].id} overlap under ${nd.id}`);
    }
  }
});

check('leaf bands tile the axis in order, without gaps', () => {
  const leaves = nodes.filter((nd) => !nd.children.length).sort((a, b) => a.y0 - b.y0);
  assert(Math.abs(leaves[0].y0) < 1e-4, `first leaf starts at ${leaves[0].y0}, not 0`);
  assert(Math.abs(leaves[leaves.length - 1].y1 - 1) < 1e-4,
    `last leaf ends at ${leaves[leaves.length - 1].y1}, not 1`);
  for(let i = 1; i < leaves.length; i++){
    assert(Math.abs(leaves[i].y0 - leaves[i - 1].y1) < 1e-4,
      `gap between leaves ${leaves[i - 1].id} and ${leaves[i].id}`);
  }
  return `${leaves.length} leaves`;
});

check('node time extents contain their members', () => {
  const rowsOf = new Map();
  for(let i = 0; i < N; i++){
    let l = P.leaf[i];
    while(l !== -1 && l != null){
      if(!rowsOf.has(l)) rowsOf.set(l, []);
      rowsOf.get(l).push(i);
      l = nodes[l].parent;
    }
  }
  for(const nd of nodes){
    for(const i of rowsOf.get(nd.id) || []){
      assert(P.x0[i] >= nd.x0 && P.x1[i] <= nd.x1,
        `${P.id[i]} (${P.x0[i]}–${P.x1[i]}) outside node ${nd.id} extent ${nd.x0}–${nd.x1}`);
    }
  }
});

check('node member counts match reality', () => {
  const counts = new Map();
  for(let i = 0; i < N; i++){
    let l = P.leaf[i];
    while(l !== -1 && l != null){ counts.set(l, (counts.get(l) || 0) + 1); l = nodes[l].parent; }
  }
  assert(nodes[0].n === N, `root claims ${nodes[0].n}, atlas has ${N}`);
  for(const nd of nodes){
    assert((counts.get(nd.id) || 0) === nd.n, `node ${nd.id} claims n=${nd.n}, holds ${counts.get(nd.id) || 0}`);
  }
});

// ---- semantics -------------------------------------------------------------

check('vertical neighbours are semantic neighbours', () => {
  // The load-bearing claim of the whole design: closeness in y should mean
  // similarity. Compare the mean similarity of y-adjacent pairs against random
  // pairs. If the ordering carried no information these would be equal.
  const vec = readVectors();
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => P.y[a] - P.y[b]);
  let adj = 0;
  for(let i = 1; i < order.length; i++) adj += cosine(vec.get(P.id[order[i]]), vec.get(P.id[order[i - 1]]));
  adj /= order.length - 1;

  let rnd = 0;
  const samples = 4000;
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for(let s = 0; s < samples; s++){
    rnd += cosine(vec.get(P.id[Math.floor(next() * N)]), vec.get(P.id[Math.floor(next() * N)]));
  }
  rnd /= samples;

  assert(adj > rnd + 0.15, `y-adjacent similarity ${adj.toFixed(3)} is not clearly above random ${rnd.toFixed(3)}`);
  return `adjacent ${adj.toFixed(3)} vs random ${rnd.toFixed(3)}`;
});

check('the axis is not a proxy for time', () => {
  // Year is the x-axis. If y correlates strongly with it, the embedding is
  // encoding date and the second dimension is wasted.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for(let i = 0; i < N; i++){
    const x = P.x0[i], yv = P.y[i];
    sx += x; sy += yv; sxx += x * x; syy += yv * yv; sxy += x * yv;
  }
  const r = (N * sxy - sx * sy) / Math.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy));
  assert(Math.abs(r) < 0.6, `y correlates with year at r=${r.toFixed(3)}`);
  return `r=${r.toFixed(3)}`;
});

check('knn excludes self and is sorted', () => {
  for(let i = 0; i < N; i++){
    const nb = P.knn[i];
    assert(!nb.includes(i), `point ${i} lists itself as a neighbour`);
    assert(nb.every((j) => j >= 0 && j < N), `point ${i} has an out-of-range neighbour`);
  }
  return `k=${P.knn[0]?.length}`;
});

check('columnar arrays are all the same length', () => {
  for(const [k, v] of Object.entries(P)){
    assert(Array.isArray(v) && v.length === N, `points.${k} has ${v?.length}, expected ${N}`);
  }
  return `${Object.keys(P).length} columns x ${N}`;
});

check('details.json covers every point', () => {
  const missing = P.id.filter((id) => !details?.[id]);
  assert(!missing.length, `${missing.length} points have no details entry`);
});

// ---- stability -------------------------------------------------------------

check('layout.json can reproduce every placement', () => {
  assert(layout, 'no layout.json');
  const placed = new Map(layout.placement.map(([id, leaf]) => [id, leaf]));
  const drifted = P.id.filter((id, i) => placed.get(id) !== P.leaf[i]);
  assert(!drifted.length, `${drifted.length} points disagree with layout.json`);
  const withY = layout.placement.filter((p) => p[2] != null).length;
  assert(withY === layout.placement.length, `${layout.placement.length - withY} placements lack a stored y`);
  return `${layout.placement.length} placements with y`;
});

check('a re-ingest of an existing entry would be a no-op', () => {
  // Descending the frozen tree with a stored vector must land on the leaf the
  // entry is already in, or incremental placement would scatter re-ingests.
  const vec = readVectors();
  const tree = layout.nodes.map((nd) => ({ ...nd, centroid: Float32Array.from(nd.centroid) }));
  let wrong = 0;
  const step = Math.max(1, Math.floor(N / 300));
  let tested = 0;
  for(let i = 0; i < N; i += step){
    tested++;
    if(nearestLeaf(vec.get(P.id[i]), tree) !== P.leaf[i]) wrong++;
  }
  // Greedy descent is not guaranteed to match a k-means assignment exactly:
  // k-means assigns by leaf centroid globally, descent commits at each level.
  assert(wrong / tested < 0.12, `${wrong}/${tested} sampled entries would be re-placed elsewhere`);
  return `${wrong}/${tested} would move`;
});

check('embedded text excludes domains', () => {
  // Domains are perfectly correlated with the source file. If they leak into the
  // embedding the hierarchy just re-derives the original CSVs.
  const e = entries.find((x) => x.domains?.length && x.topics?.length);
  if(!e) return 'no entry has both to compare';
  const text = entryText(e);
  const leaked = e.domains.filter((d) => text.toLowerCase().includes(d.toLowerCase()) &&
                                          !e.topics.includes(d) &&
                                          !String(e.title + e.subtitle + e.excerpt).toLowerCase().includes(d));
  assert(!leaked.length, `domains leaked into entryText: ${leaked.join(', ')}`);
});

check('no JS-eaten characters inside the CSS template literal', () => {
  /*
   * A backtick in a comment inside styles.js's CSS template closes the string, and
   * the rest of the stylesheet is then parsed as JavaScript. It surfaces as
   * "Unexpected identifier" or "Invalid left-hand side expression in postfix
   * operation" (`--bg` read as a decrement) pointing at a line of CSS, with the
   * whole atlas failing to load — three separate sessions have lost time to it.
   * One grep is cheaper than rediscovering it a fourth time.
   *
   * A backslash is the same trap from the other end: the stylesheet is a JS
   * template literal, so JS eats the escape before CSS ever sees it. A CSS escape
   * is at best silently wrong and at worst fatal — `content:'\00a0'` is an outright
   * "Octal escape sequences are not allowed in template strings". Write the literal
   * character instead; there is no legitimate backslash in this stylesheet.
   */
  const file = path.join(REPO_DIR, 'project/features/atlas/styles.js');
  if(!fs.existsSync(file)) return 'styles.js not found';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const open = lines.findIndex((l) => /export const CSS = `/.test(l));
  assert(open >= 0, 'could not find the CSS template literal');
  const close = lines.findIndex((l, i) => i > open && /^\s*`;\s*$/.test(l));
  assert(close > open, 'could not find the end of the CSS template literal');
  const ticks = [], slashes = [];
  for(let i = open + 1; i < close; i++){
    if(lines[i].includes('`')) ticks.push(i + 1);
    if(lines[i].includes('\\')) slashes.push(i + 1);
  }
  assert(!ticks.length, `backtick inside the template at styles.js:${ticks.join(', ')}`);
  assert(!slashes.length,
    `backslash escape inside the template at styles.js:${slashes.join(', ')} — use the literal character`);
  return `${close - open - 1} lines clean`;
});

// ---------------------------------------------------------------------------

const sizeKB = (p) => (fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) : 0);
console.log(`\n  payload: atlas.json ${sizeKB(PATHS.atlas)}KB · details.json ${sizeKB(PATHS.details)}KB · vectors.bin ${sizeKB(PATHS.vectors)}KB`);
console.log(`  ${pass} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
