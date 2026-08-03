#!/usr/bin/env node
/**
 * Rewrite a dataset's `excerpt` column: fetch the real Wikipedia lead, then
 * reshape it into the house voice with the LOCAL model. Free at both steps.
 *
 *   node datasets/excerpts.mjs leaders.csv --dry --limit 5
 *   node datasets/excerpts.mjs leaders.csv
 *   node datasets/excerpts.mjs leaders.csv --no-reshape    # raw leads, no model
 *
 * ## It is safe to kill this
 *
 * Re-run the same command and it picks up where it stopped. That was NOT true of
 * the first version, which wrote the CSV once at the end — a run killed at reshape
 * 250 of 886 lost every fetched lead and every reshape, three hours of them. Two
 * things make it true now:
 *
 *   - The CSV is checkpointed every `--checkpoint` rows (default 25), and the CSV
 *     *is* the resume state: a committed row holds a long excerpt, so the
 *     `< --rewrite-under` filter that picks targets will not pick it again.
 *   - Fetched leads are cached in `<base>.excerpt-leads.json`, so the minutes of
 *     Wikipedia fetching are not repeated for rows whose reshape never ran.
 *
 * The worst a kill can cost is `--checkpoint` rows of generation. A row is only
 * ever committed once its reshape has been decided, so nothing is silently left
 * holding a raw lead that a later run would then skip.
 *
 * ## Why this is not `enrich.mjs`
 *
 * `enrich.mjs` only ever fills a BLANK cell, and every one of `leaders.csv`'s
 * 999 excerpts is already full — of the fragment style the project explicitly
 * does not want: `"Cold War end. Gulf War. Single term."` Median length 77
 * characters, against 250 in `people.csv` and 420 in `science.csv`, which are
 * the quality bar.
 *
 * That is not a cosmetic gap. `entryText` in lib/store.mjs feeds the excerpt to
 * EmbeddingGemma, so a 77-character excerpt makes a weak vector; 612 unrelated
 * world leaders landed in one cluster because of it, and the label vocabulary —
 * harvested from the corpus — had no word for what any of them were.
 *
 * `enrich.mjs --force` would overwrite, but it would also re-run the search that
 * produced those matches, and on this dataset that search is the problem: see
 * roles.mjs on why appending the country returns *Arch of Septimius Severus*.
 *
 * ## Where the page comes from
 *
 * From `<base>.roles-log.json` when it exists. `roles.mjs` already resolved each
 * leader to a Wikipedia page and a Wikidata QID and **verified it against the
 * row's own year span** via P39 qualifier dates, which is a far stronger match
 * than title similarity. Reusing that costs nothing and inherits the check.
 *
 * Rows the log does not cover fall back to a bare-name search, and are recorded
 * separately so the two confidence levels stay distinguishable.
 *
 * ## Two steps, and either can be skipped
 *
 *   1. FETCH the lead (`exintro`, plain text). Accurate, sourced, already
 *      flowing prose. `--no-reshape` stops here and the result is usable.
 *   2. RESHAPE with qwen3:8b via Ollama, using the shared brief in lib/style.mjs.
 *      Local, so free. A rewrite that trips `styleReject` is discarded and the
 *      encyclopedia text kept — the fetched lead is always the floor, never a
 *      thing the model can make worse.
 *
 * No Claude at any step, which is the standing rule: retrieval is not a language
 * model's job, and this reshape is a local model's.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDataset, writeDataset, cfgFor, getJSON, wpSearch, wpSummary, mapPool, sleep }
  from './wikilib.mjs';
import { generate, ensureUp, WRITE_MODEL } from './lib/ollama.mjs';
import { STYLE, styleReject } from './lib/style.mjs';
import { stripApparatus } from './lib/wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WP = 'https://en.wikipedia.org';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const a = argv.find((x) => x.startsWith(`--${f}=`));
  if(a) return a.split('=')[1];
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DRY = has('--dry');
const RESHAPE = !has('--no-reshape');
const LIMIT = val('limit') ? parseInt(val('limit'), 10) : Infinity;
const CONC = parseInt(val('concurrency', '3'), 10);
// Ollama serves generations one at a time by default; two in flight keeps it fed
// without queueing so deep that a failure is hard to attribute. Do not raise this
// — see the memory notes further down; 4 is what had to be killed.
const GEN_CONC = parseInt(val('gen-concurrency', '2'), 10);
// Below this the existing cell is already prose and not worth replacing.
const MIN_EXISTING = parseInt(val('rewrite-under', '160'), 10);
// Rows of generation a kill is allowed to cost. Writing the CSV is milliseconds
// against ~11s a row, so this can be small; 25 is ~5 minutes of work.
const CKPT_EVERY = parseInt(val('checkpoint', '25'), 10);
// These prompts peak near 800 tokens. See lib/ollama.mjs on why that number is
// the difference between 4.5 GB resident and comfortably less.
const NUM_CTX = parseInt(val('num-ctx', '2048'), 10);
const REFETCH = has('--refetch');           // ignore the cached leads

const name = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if(!name){
  console.error('Usage: node excerpts.mjs <dataset.csv> [--dry] [--limit N] [--no-reshape]');
  process.exit(1);
}
const FILE = path.isAbsolute(name) ? name : path.join(HERE, name);
const BASE = FILE.replace(/\.csv$/, '');
const cfg = cfgFor(FILE);

/*
 * Encyclopedia apparatus is stripped before the model sees the text, because
 * every instruction the model has to follow is another chance for it to
 * paraphrase, and paraphrase is where a local 8B model invents. Deleting it
 * deterministically means the model is asked only to shorten prose that is
 * already clean. `stripApparatus` lives in lib/wiki.mjs — era-excerpts.mjs needs
 * the same cleaning and a second copy of that regex list would drift.
 */

/**
 * The lead paragraphs as plain text — `exintro`, not the REST summary.
 *
 * The REST summary is one or two sentences; the lead is the several paragraphs
 * that actually carry the substance, and substance is the whole point here.
 */
async function leadText(title, maxChars = 900){
  const d = await getJSON(
    `${WP}/w/api.php?format=json&action=query&prop=extracts&explaintext=1&exintro=1` +
    `&redirects=1&titles=${encodeURIComponent(title)}`);
  const page = d?.query?.pages ? Object.values(d.query.pages)[0] : null;
  let text = stripApparatus(String(page?.extract || '').trim());
  if(!text) return '';
  // Trim to a sentence boundary rather than mid-word.
  if(text.length > maxChars){
    const cut = text.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    text = stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut;
  }
  return text.replace(/\n{2,}/g, '\n\n').trim();
}

// --- resolve each row to a page ---------------------------------------------

const { headers, rows } = readDataset(FILE);
if(!headers.includes('excerpt')){
  console.error(`  ${path.basename(FILE)} has no excerpt column`);
  process.exit(1);
}

const rolesLog = `${BASE}.roles-log.json`;
const verified = new Map();
if(fs.existsSync(rolesLog)){
  for(const l of JSON.parse(fs.readFileSync(rolesLog, 'utf8'))){
    if(l.title) verified.set(l.row - 2, l.title);       // row 2 is data index 0
  }
  console.log(`  ${verified.size} page titles reused from ${path.basename(rolesLog)}` +
              ` (already verified against each row's year span)`);
}

const targets = rows.map((r, i) => ({ r, i }))
  .filter(({ r }) => String(r.excerpt || '').trim().length < MIN_EXISTING)
  .slice(0, LIMIT);

/*
 * The lead cache.
 *
 * A run is two phases with wildly different costs: fetching ~890 leads takes
 * minutes, reshaping them takes hours. The CSV checkpoint below is what makes
 * finished rows survive a kill; this file is what makes the fetched-but-not-yet-
 * reshaped ones survive too. On the run that was killed at reshape 250, that was
 * 636 leads thrown away for no reason.
 *
 * Keyed by row index and validated against the row's *current* name, so an edited
 * or reordered CSV falls back to fetching rather than pairing a lead with the
 * wrong person — silently attaching Nixon's biography to Nasser is the one failure
 * mode a cache like this can have, and it would be invisible afterwards.
 *
 * Misses are deliberately not cached. A contiguous block of them is usually
 * throttling rather than absent articles — that is what cost roles.mjs a whole
 * second pass — and re-fetching is cheap, so they get another chance every run.
 */
const LEADS_FILE = `${BASE}.excerpt-leads.json`;
const leadCache = new Map();
if(fs.existsSync(LEADS_FILE) && !REFETCH){
  let stale = 0;
  for(const e of JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'))){
    const idx = e.row - 2;
    if(rows[idx] && String(rows[idx][cfg.name] || '').trim() === e.name) leadCache.set(idx, e);
    else stale++;
  }
  console.log(`  ${leadCache.size} leads cached in ${path.basename(LEADS_FILE)}` +
              `${stale ? ` · ${stale} ignored, that row no longer holds that name` : ''}`);
}
const saveLeads = () => {
  if(!DRY) fs.writeFileSync(LEADS_FILE, JSON.stringify([...leadCache.values()], null, 2));
};

console.log(`${path.basename(FILE)}: ${targets.length} rows under ${MIN_EXISTING} chars` +
            ` (of ${rows.length} total)`);
if(RESHAPE) console.log(`  reshaping with ${WRITE_MODEL} after fetching`);

// Reshaping happens on a dry run too. A dry sample of the RAW lead shows none of
// what this step is for — the fetched text opens
// "Tiberius Julius Caesar Augustus ( ty-BEER-ee-əs; 16 November 42 BC – …)" —
// so a preview that skipped the model would be a preview of the wrong thing.
if(RESHAPE) await ensureUp();

/*
 * The log is keyed by row and seeded from any existing log file, because a
 * resumed run must not truncate the record of the rows an earlier run wrote —
 * this file is the thing you spot-check an 8B model's 999 biographies with, and
 * a half log reads as a half run.
 */
const LOG_FILE = `${BASE}.excerpt-log.json`;
const log = new Map();
if(fs.existsSync(LOG_FILE) && !DRY){
  for(const e of JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))) log.set(e.row, e);
  if(log.size) console.log(`  ${log.size} rows already logged from an earlier run`);
}
const misses = [];
let fetched = 0, reusedLeads = 0;

// --- step 1: fetch -----------------------------------------------------------

const withText = [];
await mapPool(targets, CONC, async ({ r, i }) => {
  const label = String(r[cfg.name] || '').trim();

  const hit0 = leadCache.get(i);
  if(hit0){
    withText.push({ r, i, label, title: hit0.title, source: hit0.source, lead: hit0.lead });
    reusedLeads++;
    return;
  }

  await sleep(60);
  let title = verified.get(i) || null;
  let source = 'roles-log';

  if(!title){
    const hit = await wpSearch(label);
    if(hit){ title = hit; source = 'search'; }
  }
  if(!title){ misses.push({ row: i + 2, name: label, reason: 'no-page' }); return; }

  const lead = await leadText(title);
  if(!lead || lead.length < 120){
    misses.push({ row: i + 2, name: label, title, reason: 'lead-too-thin' });
    return;
  }
  withText.push({ r, i, label, title, source, lead });
  leadCache.set(i, { row: i + 2, name: label, title, source, lead });
  if(++fetched % 100 === 0){
    console.log(`  fetched ${fetched}/${targets.length - reusedLeads}`);
    saveLeads();
  }
});
saveLeads();
if(misses.length && !DRY){
  fs.writeFileSync(`${BASE}.excerpt-misses.json`, JSON.stringify(misses, null, 2));
}

const missWhy = {};
for(const m of misses) missWhy[m.reason] = (missWhy[m.reason] || 0) + 1;
console.log(`  ${withText.length} leads in hand (${fetched} fetched, ${reusedLeads} from cache)` +
            ` · ${misses.length} without one` +
            `${misses.length ? `  ${JSON.stringify(missWhy)}` : ''}`);
/*
 * A whole batch failing at once is throttling, not absent articles — the same
 * signature roles.mjs hit. Worth saying out loud, because "no-page" for every
 * row reads like a bug in the resolver.
 */
if(withText.length === 0 && targets.length > 2){
  console.log(`  Every row failed. That is the shape of rate limiting, not of missing`);
  console.log(`  pages — check nothing else is hitting the API, then re-run.`);
}

// --- committing, incrementally -----------------------------------------------

/** Paragraph breaks are the two literal characters \n\n; the record stays on one line. */
const encode = (s) => String(s).replace(/\r/g, '').replace(/\n{2,}/g, '\n\n')
  .split('\n').map((x) => x.trim()).join('\\n').replace(/(?:\\n)+/g, '\\n\\n').trim();

let committed = 0, sinceCkpt = 0;

/**
 * Fold one finished item into `rows` and the log.
 *
 * Only ever called once a row's reshape has been *decided* — done, rejected, or
 * errored. That ordering is the point: committing a row while it still holds the
 * raw lead would give it a long excerpt, and a long excerpt is exactly what makes
 * the next run skip it, so the row would be quietly stranded on encyclopedia text
 * that was only ever meant to be a floor.
 */
function commit(item){
  if(item.done) return;
  item.out = encode(item.text || item.lead);
  const was = String(item.r.excerpt || '').length;     // read BEFORE overwriting
  if(!DRY) item.r.excerpt = item.out;
  item.done = true;
  log.set(item.i + 2, {
    row: item.i + 2, name: item.label, title: item.title, pageFrom: item.source,
    reshaped: !!item.text, was, now: item.out.length,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
  });
  committed++;
  sinceCkpt++;
}

/**
 * Write the CSV and the log mid-run. This is the whole of what makes the script
 * resumable, and it works *because the CSV is the state* — nothing extra records
 * progress. `writeDataset` only creates its `.bak` when none exists, so calling
 * this forty times cannot overwrite the pre-run original with a half-done copy.
 */
function checkpoint(){
  sinceCkpt = 0;
  if(DRY) return;
  writeDataset(FILE, rows, headers);
  fs.writeFileSync(LOG_FILE, JSON.stringify([...log.values()].sort((a, b) => a.row - b.row), null, 2));
}

// --- keeping the machine usable ----------------------------------------------

/*
 * Why this guard exists: the first full run drove swap to 16.35 of 17.4 GB with
 * 1 GB of memory free and had to be killed after 75 minutes. Two causes, and the
 * smaller one is the obvious one.
 *
 *   - `--gen-concurrency 4`. Now defaulted to 2 and documented as a ceiling.
 *   - `num_ctx: 8192`. Invisible from here, and larger: Ollama reserves a KV
 *     cache of num_ctx x OLLAMA_NUM_PARALLEL tokens at load time, so an 8192
 *     context served four ways reserves 32k tokens of cache on top of 8B of
 *     weights. NUM_CTX asks for 2048, which these ~800-token prompts do not
 *     notice, and the reservation drops by a factor of four.
 *
 * More node workers cannot help with either. Every generation from every worker
 * is one HTTP request to the same single `ollama serve`, holding exactly one copy
 * of the weights — added parallelism buys queued requests and more KV cache, never
 * a second model, so it can only raise the peak. Separate node *processes* are the
 * same request to the same daemon.
 *
 * So the guard does the only two useful things: serialise, then stop. Stopping is
 * safe now that a checkpoint exists, and a controlled stop that has saved 800 rows
 * beats the OOM killer taking the process at an arbitrary moment.
 */
let solo = false, bail = null, lastCheck = 0;
let chain = Promise.resolve();

/*
 * Free swap is NOT the signal, even though "swap was at 16.35 of 17.4 GB" is how
 * the bad run was described. macOS grows the swapfile on demand and shrinks it
 * lazily, so hours after the pressure is gone it still reports ~1 GB free of an
 * 8 GB file — measured here at 42% memory free and pressure level 1, which is a
 * machine with nothing wrong with it. A first cut of this guard read that as an
 * emergency and serialised immediately.
 *
 * `kern.memorystatus_vm_pressure_level` is the kernel's own verdict: 1 normal,
 * 2 warning, 4 critical. That plus the free-page share is what to act on; swap is
 * carried along only so the log line is comparable to the earlier report.
 */
function memoryNow(){
  try {
    const num = (args) => execFileSync('sysctl', ['-n', ...args], { encoding: 'utf8' }).trim();
    const pressure = parseInt(num(['kern.memorystatus_vm_pressure_level']), 10) || 1;
    const swap = num(['vm.swapusage']);
    const swapUsedMB = parseFloat(/used\s*=\s*([\d.]+)M/.exec(swap)?.[1] ?? 'NaN');
    const vm = execFileSync('vm_stat', [], { encoding: 'utf8' });
    const pages = (k) => parseInt(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? '0', 10);
    const pageSize = parseInt(/page size of (\d+)/.exec(vm)?.[1] ?? '16384', 10);
    const total = parseInt(num(['hw.memsize']), 10);
    const free = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize;
    return { freePct: (free / total) * 100, swapUsedMB, pressure };
  } catch { return null; }
}

/** Sampled, not measured per row — `vm_stat` is a fork and this runs 886 times. */
function watchMemory(){
  const now = Date.now();
  if(now - lastCheck < 15_000) return;
  lastCheck = now;
  const m = memoryNow();
  if(!m || !Number.isFinite(m.freePct)) return;
  const tight = m.pressure >= 2 || m.freePct < 12;
  const dire  = m.pressure >= 4 || m.freePct < 6;
  const where = `pressure ${m.pressure}, ${m.freePct.toFixed(0)}% memory free,` +
                ` ${(m.swapUsedMB / 1024).toFixed(1)}GB swap in use`;
  // Never un-serialise: flapping between 1 and 2 in flight would reload nothing
  // but would make the run's behaviour unreproducible.
  if(tight && !solo){
    solo = true;
    console.log(`  ! memory tight (${where}) — one generation at a time from here`);
  }
  if(dire && solo && !bail) bail = where;
}

/** Concurrency 1 without unwinding mapPool: chain the calls instead. */
function serialised(fn){
  if(!solo) return fn();
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

// --- step 2: reshape ---------------------------------------------------------

let reshaped = 0, kept = 0;
const rejects = new Map();

if(RESHAPE){
  let n = 0;
  await mapPool(withText, GEN_CONC, async (item) => {
    watchMemory();
    if(bail) return;
    try {
      /*
       * The word target is restated per call rather than tightened in STYLE,
       * which ingest.mjs shares. Left to the system prompt alone qwen3 lands
       * around 150 words — and `entryText` truncates the excerpt at 700
       * characters before embedding it, so everything past that is invisible to
       * the thing this rewrite is for.
       */
      const out = await serialised(() => generate(
        `Condense the SOURCE below into 60-110 words in the house style.\n\n` +
        `Reuse the source's own wording wherever you can. Do not restate a ` +
        `relationship, title or date in your own words — copy it. If the source ` +
        `does not say something, leave it out.\n\n` +
        `TITLE: ${item.label}\nDATE: ${item.r[cfg.year] || ''}\n\nSOURCE:\n${item.lead}`,
        { system: STYLE, temperature: 0.2, numCtx: NUM_CTX }));
      const bad = styleReject(out, item.lead.length);
      if(bad){
        rejects.set(bad, (rejects.get(bad) || 0) + 1);
        kept++;
      } else {
        item.text = String(out).trim();
        reshaped++;
      }
    } catch(e){
      rejects.set(`error: ${e.message}`, (rejects.get(`error: ${e.message}`) || 0) + 1);
      kept++;
    }
    commit(item);
    if(sinceCkpt >= CKPT_EVERY) checkpoint();
    if(++n % 50 === 0){
      console.log(`  reshaped ${n}/${withText.length}` +
                  `  (${committed} committed to ${path.basename(FILE)})`);
    }
  });
  // Give the ~4.5 GB back rather than waiting out the 5-minute default.
  try { await generate('', { keepAlive: '0s', numCtx: NUM_CTX }); } catch {}
}

// --- write -------------------------------------------------------------------

// Without the model there is nothing to decide, so every fetched lead commits.
if(!RESHAPE) for(const item of withText) commit(item);
checkpoint();

const done = withText.filter((x) => x.done);
const lens = done.map((x) => x.out.length).sort((a, b) => a - b);
console.log('\n=== summary ===');
console.log(`  ${done.length} excerpts rewritten` +
            `${RESHAPE ? ` (${reshaped} reshaped, ${kept} kept as the fetched lead)` : ' (raw leads)'}`);
if(lens.length){
  console.log(`  length: min ${lens[0]} · median ${lens[lens.length >> 1]} · max ${lens[lens.length - 1]}` +
              `   (was: median 77)`);
}
console.log(`  sources: ${done.filter((x) => x.source === 'roles-log').length} from the verified log,` +
            ` ${done.filter((x) => x.source === 'search').length} from a fresh search`);
if(misses.length) console.log(`  ${misses.length} rows left alone (no page / thin lead)`);
if(rejects.size){
  console.log('  reshapes rejected, encyclopedia text kept instead:');
  for(const [why, n] of [...rejects].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${why}`);
}

if(DRY){
  console.log('\nDRY RUN — nothing written. Sample:\n');
  for(const item of done.slice(0, 4)){
    console.log(`  ${item.label}  <- ${item.title}`);
    console.log(`    WAS: ${String(item.r.excerpt || '').slice(0, 100)}`);
    console.log(`    NOW: ${item.out.slice(0, 320)}\n`);
  }
} else {
  console.log(`\nwrote ${path.basename(FILE)} (backup at ${path.basename(FILE)}.bak)`);
  console.log(`     ${path.basename(LOG_FILE)} (${log.size} rows, ${committed} this run)`);
  console.log(`     ${path.basename(LEADS_FILE)} (${leadCache.size} cached leads)`);
}

/*
 * A bail is not a failure — everything committed is on disk and the leads for the
 * rest are cached, so the same command resumes. Say so loudly, because the last
 * time this run stopped it looked like three hours had evaporated.
 */
const remaining = withText.length - done.length;
if(bail){
  console.log(`\nSTOPPED EARLY to keep the machine usable: ${bail}`);
  console.log(`  ${committed} rows are written and safe. ${remaining} still to do.`);
  console.log(`  Close what else is holding memory, then re-run the same command —`);
  console.log(`  the leads are cached, so it resumes at the generation step.`);
  process.exitCode = 3;
} else if(remaining > 0 && !DRY){
  console.log(`\n${remaining} of ${withText.length} rows were not reached. Re-run to finish them.`);
} else if(!DRY){
  console.log(`\nNext: node datasets/migrate.mjs && node datasets/embed-all.mjs --force` +
              ` && node datasets/atlas.mjs --rebuild && node datasets/verify.mjs`);
}
