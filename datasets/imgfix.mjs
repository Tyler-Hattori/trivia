#!/usr/bin/env node
/**
 * imgfix.mjs — find image URLs that do not resolve, and repair them at the source.
 *
 *   node datasets/imgfix.mjs --dry                 # report only, touch nothing
 *   node datasets/imgfix.mjs                       # repair CSVs + entries.jsonl
 *   node datasets/imgfix.mjs --only leaders.csv    # one dataset
 *   node datasets/imgfix.mjs --limit 200           # first N broken, for a trial run
 *   node datasets/imgfix.mjs --no-cache            # ignore the resolved-file cache
 *
 * Then rebuild so the browser sees it:
 *
 *   node datasets/migrate.mjs && node datasets/atlas.mjs && node datasets/verify.mjs
 *
 * ## Why this exists
 *
 * `leaders.csv` shipped with image URLs of the form
 *
 *   https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Golda_Meir.jpg/800px-Golda_Meir.jpg
 *
 * and not one of them resolves. That `4/4f` is not decoration: Wikimedia derives it
 * from the MD5 of the filename, and for `Golda_Meir.jpg` the real prefix is `e/ef`.
 * These were written with invented hashes, so the CDN answers 404 — measured in a
 * real browser, **0 of 50 sampled `leaders` images loaded**, against 46 of 46 for
 * `art`. A failed image degrades to a text card, which is why this read as a data gap
 * rather than a bug for so long.
 *
 * Two distinct faults are mixed together, and they need different fixes:
 *
 *   1. THE PATH IS WRONG, THE FILENAME IS RIGHT. The file exists; only the derived
 *      hash directory is wrong. Asking the API for the file's real URL fixes it.
 *   2. THE FILENAME IS ALSO WRONG — `Justinian_I_(1).jpg`, or `Dhiman_Mandir.jpg` for
 *      Chandragupta Maurya. Nothing about the URL can be salvaged; the picture has to
 *      be looked up again, from Wikidata P18 or the article's lead image.
 *
 * Anything still unresolved has its `image` cleared. An entry with no image renders as
 * a clean text card; an entry with a dead one renders as a card with a hole in it.
 *
 * ## Never guess that an image is dead
 *
 * The first version of this script fetched every URL and treated any non-OK response
 * as dead. It reported 2,045 dead images and cleared 1,214 of them — including 411
 * `art` URLs that a browser had already proven healthy. Two causes, both now fixed,
 * both worth not repeating:
 *
 *   - **Rate limiting read as absence.** `Special:FilePath` is served by MediaWiki,
 *     not the CDN, and 3,161 requests at 8 concurrent got throttled. A 429 after
 *     retries is UNKNOWN, never dead — see `Verdict`.
 *   - **Not every file is on Commons.** Film posters are usually uploaded locally to
 *     en.wikipedia under fair use, so a Commons-only lookup 404s on a file that
 *     plainly exists. Both hosts are queried.
 *
 * So existence is settled by `action=query&prop=imageinfo`, 50 filenames per request:
 * 3,161 URLs become ~64 API calls, the answer is authoritative rather than inferred
 * from a status code, and it hands back the correct CDN URL as a side effect — which
 * is what gets stored, so the browser needs no redirect hop.
 *
 * ## Why it writes the CSVs
 *
 * `imgcheck.mjs` deliberately never edits a CSV, and reporting is all it is for. But
 * the CSVs are the source of truth that `migrate.mjs` rebuilds `entries.jsonl` from,
 * so a repair applied only to the JSONL is undone by the next routine migrate. Both
 * are written, and `writeDataset` keeps a one-time `.bak` of each CSV.
 *
 * Ingested entries (`origin.wiki || origin.qid`) have no CSV row — migrate carries
 * them over — so for those the JSONL is the source and is all that is written.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  USER_AGENT, readDataset, writeDataset, getJSON, mapPool,
} from './wikilib.mjs';
import { readEntries, writeEntries, DATASETS_DIR } from './lib/store.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const DRY = has('--dry');
const ONLY = val('--only');
const LIMIT = Number(val('--limit', 0)) || Infinity;
const CONC = Number(val('--concurrency', 4));
const CACHE_PATH = val('--cache', path.join(DATASETS_DIR, '.imgcache.json'));
const USE_CACHE = !has('--no-cache');

const HOSTS = ['commons.wikimedia.org', 'en.wikipedia.org'];
const BATCH = 50;                       // API limit for an anonymous titles= query

/** A probe result. `unknown` must never be acted on. */
const LIVE = 'live', DEAD = 'dead', UNKNOWN = 'unknown';

// ---------------------------------------------------------------------------
// URL shapes
// ---------------------------------------------------------------------------

/**
 * The Commons/Wikipedia filename a URL refers to, or null if it is not a Wikimedia
 * URL at all. This is the only durable part of these URLs: the hash directory is
 * derived, the width token is a request parameter, and the host depends on where the
 * file happens to live.
 */
export function wikimediaFilename(url){
  if(!url || typeof url !== 'string') return null;
  const u = url.trim();

  const fp = u.match(/\/wiki\/Special:FilePath\/([^?#]+)/i);
  if(fp) return decodeName(fp[1]);

  const thumb = u.match(/^https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/(?:thumb|trunk)\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i);
  if(thumb) return decodeName(thumb[1]);

  const bare = u.match(/^https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)$/i);
  if(bare) return decodeName(bare[1]);

  return null;
}

function decodeName(raw){
  let name = String(raw);
  try { name = decodeURIComponent(name); } catch { /* already literal */ }
  return name.replace(/ /g, '_');
}

// ---------------------------------------------------------------------------
// Existence, in batches, from the API
// ---------------------------------------------------------------------------

/*
 * filename -> { verdict, url } where url is the file's real CDN location. Persisted,
 * because a full sweep is ~3,000 filenames and iterating on the repair logic should
 * not mean asking Wikimedia the same questions again.
 */
const fileCache = new Map();

if(USE_CACHE && fs.existsSync(CACHE_PATH)){
  try {
    for(const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')))){
      if(v?.verdict === LIVE || v?.verdict === DEAD) fileCache.set(k, v);   // never cache unknown
    }
    console.log(`  cache   ${fileCache.size} filenames already resolved (${path.basename(CACHE_PATH)})`);
  } catch { /* a corrupt cache is not worth failing over */ }
}

function saveCache(){
  if(!USE_CACHE) return;
  const obj = {};
  for(const [k, v] of fileCache) obj[k] = v;
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(obj)); } catch { /* not fatal */ }
}

/**
 * Resolve a batch of filenames on one host.
 *
 * Returns a Map of filename -> real URL for the ones that exist there. A name that
 * is absent from the result is absent from THAT host, which is not the same as
 * absent from Wikimedia — hence the caller trying the next host before concluding
 * anything. `redirects=1` follows file renames, which is a large share of the
 * "filename is right but stale" cases.
 */
async function resolveOnHost(host, names){
  const titles = names.map((n) => `File:${n}`).join('|');
  const url = `https://${host}/w/api.php?format=json&formatversion=2&action=query&redirects=1`
            + `&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(titles)}`;
  const d = await getJSON(url);
  if(!d?.query) return null;                       // could not ask — not an answer

  /*
   * MEDIAWIKI RETURNS TITLES WITH SPACES, NOT UNDERSCORES. Ask for
   * `File:Socrates_Louvre.jpg` and the page comes back as `File:Socrates Louvre.jpg`.
   * Keying the result map on the raw title made every filename containing an
   * underscore fail to match, which is almost all of them: 2,890 of 3,081 files were
   * reported dead, and the 191 "live" ones were exactly the single-word names. Both
   * `normalized` and `redirects` report their pairs in the same normalised form, so
   * everything here is compared with underscores restored.
   */
  const key = (t) => String(t).replace(/ /g, '_');

  const alias = new Map();                          // asked-for title -> final title
  for(const r of d.query.normalized || []) alias.set(key(r.from), key(r.to));
  // A redirect means the file was renamed; follow it, since a stale-but-renamed
  // filename is a large share of the recoverable cases.
  for(const r of d.query.redirects || []) alias.set(key(r.from), key(r.to));

  const found = new Map();
  for(const p of d.query.pages || []){
    if(p.missing || !p.imageinfo?.[0]?.url) continue;
    found.set(key(p.title), p.imageinfo[0].url);
  }

  const out = new Map();
  for(const n of names){
    const asked = key(`File:${n}`);
    // Chase up to two hops: normalisation can feed a redirect.
    const hit = found.get(asked)
             ?? found.get(alias.get(asked))
             ?? found.get(alias.get(alias.get(asked)));
    if(hit) out.set(n, hit);
  }
  return out;
}

/**
 * Fill `fileCache` for every name not already in it.
 *
 * `quiet` because pass 3 calls this one name at a time to check a candidate, and a
 * progress line per candidate buries the actual output.
 */
async function resolveFiles(names, { quiet = false } = {}){
  const todo = names.filter((n) => !fileCache.has(n));
  if(!todo.length) return;

  const batches = [];
  for(let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let done = 0;
  await mapPool(batches, CONC, async (batch) => {
    const pending = new Set(batch);
    let answered = 0;

    for(const host of HOSTS){
      if(!pending.size) break;
      const got = await resolveOnHost(host, [...pending]);
      if(!got) continue;                            // the request failed; try elsewhere
      answered++;
      for(const [name, url] of got){
        fileCache.set(name, { verdict: LIVE, url });
        pending.delete(name);
      }
    }

    /*
     * DEAD requires that EVERY host answered and none of them had the file. If
     * Commons times out while en.wikipedia replies "missing", that is not evidence
     * of absence — it is one missing answer. The earlier version marked dead on any
     * single answer, which turns a rate limit into deleted data.
     */
    const conclusive = pending.size === 0 || answered === HOSTS.length;
    if(conclusive) for(const name of pending) fileCache.set(name, { verdict: DEAD, url: null });

    done += batch.length;
    if(!quiet) process.stdout.write(`\r          ${Math.min(done, todo.length)}/${todo.length} filenames`);
  });
  if(!quiet) process.stdout.write('\n');
  saveCache();
}

const verdictOf = (name) => (fileCache.get(name)?.verdict || UNKNOWN);

// ---------------------------------------------------------------------------
// Re-resolving a picture from scratch
// ---------------------------------------------------------------------------

const WP = 'https://en.wikipedia.org';
const WD = 'https://www.wikidata.org';

/** Wikidata P18 — a filename, which still has to be resolved to a URL. */
async function p18(qid){
  const d = await getJSON(`${WD}/wiki/Special:EntityData/${qid}.json`);
  const f = d?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return f ? decodeName(f) : null;
}

/**
 * The lead image of an article, plus its QID as a second avenue.
 *
 * `pageimages` gives what the article itself shows, which for a monarch is the
 * infobox portrait — exactly what these rows were reaching for.
 */
async function fromTitle(title){
  const u = `${WP}/w/api.php?format=json&formatversion=2&action=query&redirects=1`
          + `&prop=pageimages|pageprops&piprop=original&ppprop=wikibase_item`
          + `&titles=${encodeURIComponent(title)}`;
  const d = await getJSON(u);
  const page = d?.query?.pages?.[0];
  if(!page || page.missing) return { name: null, qid: null };
  return {
    name: page.original?.source ? wikimediaFilename(page.original.source) : null,
    qid: page.pageprops?.wikibase_item || null,
  };
}

/**
 * Find a live picture for one entry.
 *
 * Ordered by how much each source knows about *this* entry rather than about a string
 * that resembles it: a stored QID is unambiguous, the entry's own article title is
 * nearly so, and a search is a guess. Every candidate is resolved through the same
 * API as everything else, so a repair can only ever replace a dead URL with one that
 * is known to exist.
 */
async function findImage(entry){
  const tried = new Set();

  const accept = async (name, how) => {
    if(!name || tried.has(name)) return null;
    tried.add(name);
    await resolveFiles([name], { quiet: true });
    const rec = fileCache.get(name);
    return rec?.verdict === LIVE ? { url: rec.url, how } : null;
  };

  if(entry.origin?.qid){
    const hit = await accept(await p18(entry.origin.qid), 'wikidata P18 (stored qid)');
    if(hit) return hit;
  }

  for(const t of [entry.origin?.wiki, entry.title].filter(Boolean)){
    const { name, qid } = await fromTitle(t);
    const hit = await accept(name, `article lead image (${t})`);
    if(hit) return hit;
    if(qid){
      const h2 = await accept(await p18(qid), `wikidata P18 (${t})`);
      if(h2) return h2;
    }
  }

  /*
   * Last resort: a search disambiguated by the subtitle. "Henry VII" alone is six
   * different people; "Henry VII Holy Roman Empire" is one. Only the top hit is
   * considered — past that, a wrong picture is worse than none.
   */
  const hint = [entry.title, entry.subtitle].filter(Boolean).join(' ');
  const found = await getJSON(`${WP}/w/api.php?format=json&formatversion=2&action=query`
    + `&list=search&srlimit=1&srsearch=${encodeURIComponent(hint)}`);
  const best = found?.query?.search?.[0]?.title;
  if(best){
    const { name, qid } = await fromTitle(best);
    const hit = await accept(name, `search hit "${best}"`);
    if(hit) return hit;
    if(qid) return accept(await p18(qid), `wikidata P18 via search "${best}"`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Keeping the CSVs in step
// ---------------------------------------------------------------------------

/**
 * Apply `was -> image` to the CSVs, so a routine `migrate.mjs` does not reintroduce
 * every URL a run just fixed.
 *
 * Rows are matched on the FILENAME, not on the URL verbatim. The filename is the one
 * part of a Wikimedia URL that survives every rewrite this script performs — host,
 * hash directory and width token all change — and matching on the full URL silently
 * matched nothing whenever a previous pass had already reshaped it. Title will not do
 * either: three rows in `leaders.csv` are called "Henry IV".
 *
 * Where two rows share one filename and resolved to different pictures the mapping is
 * ambiguous, so the cell is left alone and counted rather than guessed at.
 */
const CONFLICT = Symbol('conflict');

function syncCsvs(changes){
  const byFile = new Map();
  for(const c of changes){
    if(c.origin?.wiki || c.origin?.qid) continue;      // ingested, carried over, no CSV row
    const file = c.origin?.dataset ? `${c.origin.dataset}.csv` : null;
    if(!file || (ONLY && file !== ONLY)) continue;
    const key = wikimediaFilename(c.was) || String(c.was || '').trim();
    if(!key) continue;
    const m = byFile.get(file) || byFile.set(file, new Map()).get(file);
    const prev = m.get(key);
    m.set(key, prev === undefined || prev === c.image ? c.image : CONFLICT);
  }

  let cells = 0, ambiguous = 0;
  for(const [file, byKey] of byFile){
    const p = path.join(DATASETS_DIR, file);
    if(!fs.existsSync(p)){ console.log(`  ${file} not found — skipped`); continue; }

    // readDataset -> parseCSV returns { headers, rows }, NOT an array. Treating it
    // as one is why the first version reported "0 CSV cells updated" while silently
    // skipping every file.
    const { headers, rows } = readDataset(p);
    if(!rows.length || !headers.includes('image')){ console.log(`  ${file} has no image column — skipped`); continue; }

    let changed = 0;
    for(const row of rows){
      const raw = String(row.image || '').trim();
      const next = byKey.get(wikimediaFilename(raw) || raw);
      if(next === undefined) continue;
      if(next === CONFLICT){ ambiguous++; continue; }
      if(next === raw) continue;
      row.image = next;
      changed++;
    }
    if(!changed) continue;

    writeDataset(p, rows, headers);
    cells += changed;
    console.log(`  wrote ${file}  (${changed} image cells; .bak kept)`);
  }
  return { cells, ambiguous };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/*
 * `--sync-csv <log.json>` replays a previous run's log into the CSVs and stops. It
 * exists because the JSONL and the CSVs can fall out of step: a run that repairs the
 * JSONL but fails to match any CSV row leaves the repair one `migrate.mjs` away from
 * being undone, and re-running the whole thing would compare the already-fixed URLs
 * against themselves and find nothing to do.
 */
const SYNC = val('--sync-csv');
if(SYNC){
  const log = JSON.parse(fs.readFileSync(SYNC, 'utf8'));
  const byId = new Map(readEntries().map((e) => [e.id, e]));
  const changes = log
    .map((r) => ({ ...byId.get(r.id), was: r.was, image: r.now }))
    .filter((c) => c.id);
  console.log(`\n  replaying ${changes.length} of ${log.length} logged changes into the CSVs`);
  const { cells, ambiguous } = syncCsvs(changes);
  console.log(`\n  ${cells} CSV cells updated${ambiguous ? `, ${ambiguous} ambiguous and left alone` : ''}\n`);
  process.exit(0);
}

const entries = readEntries();
const withImg = entries.filter((e) => e.image);
console.log(`\n  ${entries.length} entries, ${withImg.length} with an image`);

for(const e of withImg) e._was = e.image;

// ---- which files exist ---------------------------------------------------
const named = withImg.map((e) => ({ e, name: wikimediaFilename(e.image) }));
const foreign = named.filter((x) => !x.name);
const names = [...new Set(named.filter((x) => x.name).map((x) => x.name))];

console.log(`  ${names.length} distinct Wikimedia filenames, ${foreign.length} entries on other hosts (left alone)`);
console.log(`  checking existence via the API, ${BATCH} per request…`);
await resolveFiles(names);

const live = [], dead = [], unknown = [];
for(const x of named){
  if(!x.name) continue;
  const v = verdictOf(x.name);
  (v === LIVE ? live : v === DEAD ? dead : unknown).push(x);
}

const tally = (list) => {
  const by = {};
  for(const x of list) by[x.e.origin?.dataset || '?'] = (by[x.e.origin?.dataset || '?'] || 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
};

console.log(`\n  live     ${live.length}`);
console.log(`  dead     ${dead.length}   ${tally(dead)}`);
if(unknown.length) console.log(`  unknown  ${unknown.length}   ${tally(unknown)}  — LEFT ALONE, re-run to retry`);

/*
 * A live file whose stored URL has the wrong hash still needs rewriting: the API's
 * `url` is the real location, and storing it means the browser fetches a direct CDN
 * thumb with no redirect hop.
 */
let repathed = 0;
for(const x of live){
  const real = fileCache.get(x.name).url;
  if(real && x.e.image !== real){ x.e.image = real; repathed++; }
}
console.log(`\n  ${repathed} live images had a wrong path and now point at the real file`);

// ---- re-resolve the dead ones -------------------------------------------
const targets = dead.slice(0, LIMIT === Infinity ? dead.length : LIMIT);
if(targets.length < dead.length) console.log(`  --limit: only ${targets.length} of ${dead.length} dead entries will be re-resolved`);

let fixed = 0, cleared = 0, n = 0;
const log = [];
if(targets.length){
  console.log(`  re-resolving ${targets.length} dead images…`);
  await mapPool(targets, CONC, async ({ e }) => {
    const hit = await findImage(e);
    log.push({ id: e.id, title: e.title, was: e._was, now: hit?.url || '', how: hit?.how || 'no image found — cleared' });
    e.image = hit?.url || '';
    hit ? fixed++ : cleared++;
    if(++n % 25 === 0) process.stdout.write(`\r          ${n}/${targets.length}  ${fixed} fixed, ${cleared} cleared`);
  });
  process.stdout.write(`\r          ${targets.length}/${targets.length}  ${fixed} fixed, ${cleared} cleared\n`);
  saveCache();
}

for(const x of live) if(x.e.image !== x.e._was) log.push({ id: x.e.id, title: x.e.title, was: x.e._was, now: x.e.image, how: 'corrected path, same file' });

fs.writeFileSync('/tmp/imgfix.log.json', JSON.stringify(log, null, 1));

// ---- write back ---------------------------------------------------------
if(DRY){
  console.log('\n  --dry: nothing written. Sample:\n');
  for(const r of log.slice(0, 15)){
    console.log(`   ${r.title}\n     was ${r.was}\n     now ${r.now || '(cleared)'}   [${r.how}]`);
  }
  console.log(`\n  Full plan: /tmp/imgfix.log.json  (${log.length} rows)\n`);
  process.exit(0);
}

writeEntries(entries);
console.log(`\n  wrote datasets/atlas/entries.jsonl`);

const { cells: csvCells, ambiguous: csvAmbiguous } = syncCsvs(
  entries.filter((e) => e._was && e.image !== e._was).map((e) => ({ ...e, was: e._was })),
);
if(csvAmbiguous) console.log(`  ${csvAmbiguous} cells left alone: one dead URL shared by rows that resolved differently`);

console.log(`
  ${repathed} paths corrected, ${fixed} re-resolved, ${cleared} cleared, ${unknown.length} left unknown.
  ${csvCells} CSV cells updated. Log: /tmp/imgfix.log.json

  Next:  node datasets/migrate.mjs && node datasets/atlas.mjs && node datasets/verify.mjs
`);
