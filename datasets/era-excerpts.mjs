#!/usr/bin/env node
/**
 * Excerpts for rows that are WORKS rather than subjects — a painting, a film, a
 * treatise. Retrieval only; no model at any step.
 *
 *   node datasets/era-excerpts.mjs art.csv --dry --limit 12
 *   node datasets/era-excerpts.mjs art.csv
 *   node datasets/era-excerpts.mjs art.csv --no-own-page   # force the era path
 *
 * ## The problem this exists for
 *
 * `art.csv` has 527 rows with no excerpt, spread over 106 artists — Pissarro 48,
 * Renoir 27, Poussin 25, Vigée Le Brun 24. Most of those paintings have no
 * article of their own, so every search for one returns the *artist*, and the
 * naive fill writes one biography into 48 cells.
 *
 * That is worse than leaving them blank, and not for cosmetic reasons.
 * `entryText` embeds the excerpt, so 48 identical excerpts make 48 near-identical
 * vectors: the paintings collapse onto one point and cluster by the accident of
 * sharing a painter, not by anything about the work. `misses.mjs` caught this and
 * refused to write, which is why the cells are still empty.
 *
 * ## What it writes instead
 *
 * A row's excerpt is the artist's article **at that row's moment**, not the
 * artist's article. Pissarro in 1870 is the Franco-Prussian War and Norwood;
 * Pissarro in 1885 is meeting Seurat and Signac; Pissarro in 1897 is the London
 * and boulevard series. Those are three different paragraphs of the same page,
 * so three paintings twenty years apart get three different vectors — and two
 * paintings from the same season legitimately get similar ones, which is the
 * behaviour you actually want from a map.
 *
 * Two tiers, in order of trust:
 *
 *   1. THE WORK'S OWN PAGE. Many famous paintings have one, and it is always
 *      better than context. Gated hard — see `ownPage` below.
 *   2. ERA CONTEXT. Paragraphs of the creator's article scored by how near their
 *      years sit to the row's year, prefixed by a one-line statement of what the
 *      row itself is, so the work-specific part of the text is never zero.
 *
 * ## The three gates that keep this honest
 *
 * - **A candidate page must name the creator.** `Blue Dancers is an 1897 pastel
 *   by Edgar Degas` contains "Degas"; a wrong page of the same surface wording
 *   does not. This is the check that cosine could not do — the earlier attempt
 *   scored a generic concept page 0.542 against its row while the correct entity
 *   page scored 0.415, because the failure is ontological and an embedding cannot
 *   see ontology. A surname is a fact and it either appears or it does not.
 * - **A candidate page must not BE the creator's page.** Otherwise tier 1 quietly
 *   reintroduces exactly the bug tier 2 exists to avoid.
 * - **Paragraph reuse is penalised, not capped.** A hard cap forces a wrong era
 *   once the good paragraphs are spent, which is invisible afterwards. A penalty
 *   degrades: the fourth painting of a season takes the second-best paragraph
 *   rather than a paragraph from thirty years away.
 *
 * ## Resuming
 *
 * Safe to kill. The CSV is checkpointed, the fetched articles and leads are
 * cached, and — the part that is easy to get wrong — the paragraph *use counts*
 * are rebuilt from the log, so a resumed run does not start over at zero and
 * hand the popular paragraphs out a second time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDataset, writeDataset, cfgFor, getJSON, wpSearch, mapPool, titleSim,
} from './wikilib.mjs';
import { INDEX_TITLE, MIN_EXCERPT, stripApparatus } from './lib/wiki.mjs';
import { titleCase } from './lib/cluster.mjs';

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
const OWN_PAGE = !has('--no-own-page');
const REFETCH = has('--refetch');
const LIMIT = val('limit') ? parseInt(val('limit'), 10) : Infinity;
const CONC = parseInt(val('concurrency', '3'), 10);
// Only rows at or under this are targets. 1 means "blank only", which is the
// right default here: the 379 art rows that DO have prose got it from a search
// that enrich.mjs was confident in, and overwriting those is a separate decision.
const REWRITE_UNDER = parseInt(val('rewrite-under', '1'), 10);
const CKPT_EVERY = parseInt(val('checkpoint', '25'), 10);
/*
 * How much era prose to assemble.
 *
 * `entryText` truncates the excerpt at 700 characters before embedding, and the
 * opener costs ~80 of those, so ~620 is what actually reaches the embedder. Going
 * past it is not harmful, just invisible to the map — and HANDOFF's sweep found
 * the neighbour-agreement curve flat above 300 characters anyway, so the floor is
 * what matters and the ceiling is nearly free.
 */
const ERA_CHARS = parseInt(val('era-chars', '620'), 10);
// Two clipped paragraphs beat one whole one: same characters, but the pairing
// makes far more distinct bodies out of the same small pool of eras.
const MAX_PARAS = parseInt(val('max-paras', '2'), 10);
// How far from the FIRST chosen paragraph a follow-up may sit, in years. A
// working life turns over on roughly this scale, so it is the width of an "era".
const ERA_WINDOW = parseInt(val('era-window', '12'), 10);
// Score docked per prior use of a paragraph. Big enough to displace a paragraph
// after two or three uses, small enough that it never outweighs being decades
// nearer the right year.
const REUSE_PENALTY = parseFloat(val('reuse-penalty', '0.18'));
// The most reuse can ever cost. Deliberately less than the score gap between a
// paragraph about the right decade and one about the wrong century.
const REUSE_CAP = parseFloat(val('reuse-cap', '0.30'));
// Restrict to creators whose name contains this. Testing only — the reuse
// penalty is what needs stressing, and it only shows up on a prolific creator.
const ONLY = val('only', '');

const name = argv.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
if(!name){
  console.error('Usage: node era-excerpts.mjs <dataset.csv> [--dry] [--limit N] [--no-own-page]');
  process.exit(1);
}
const FILE = path.isAbsolute(name) ? name : path.join(HERE, name);
const BASE = FILE.replace(/\.csv$/, '');
const cfg = cfgFor(FILE);
if(!cfg.extra){
  console.error(`${path.basename(FILE)} has no creator column in wikilib's DATASETS map.`);
  process.exit(1);
}

const ARTICLES_FILE = `${BASE}.era-articles.json`;
const LEADS_FILE    = `${BASE}.era-leads.json`;
const LOG_FILE      = `${BASE}.era-log.json`;
const MISSES_FILE   = `${BASE}.era-misses.json`;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const { headers, rows } = readDataset(FILE);
for(const c of ['excerpt', cfg.name, cfg.extra, cfg.year]){
  if(!headers.includes(c)){
    console.error(`${path.basename(FILE)} has no "${c}" column.`);
    process.exit(1);
  }
}

const yearOf = (r) => {
  const m = String(r[cfg.year] || '').match(/-?\d{1,4}/);
  return m ? parseInt(m[0], 10) : null;
};

let targets = rows.filter((r) =>
  String(r.excerpt || '').trim().length < REWRITE_UNDER && String(r[cfg.extra] || '').trim() && yearOf(r) != null &&
  (!ONLY || String(r[cfg.extra]).toLowerCase().includes(ONLY.toLowerCase())));

/*
 * Sorted by creator then year, and that ordering is load-bearing.
 *
 * The reuse penalty makes each choice depend on what came before it, so a stable
 * order is what makes two runs of this script agree. Chronological within a
 * creator also means consecutive rows are consecutive in the artist's life, which
 * is when sharing a paragraph is least wrong.
 */
targets.sort((a, b) =>
  String(a[cfg.extra]).localeCompare(String(b[cfg.extra])) || (yearOf(a) - yearOf(b)));
if(targets.length > LIMIT) targets = targets.slice(0, LIMIT);

const byCreator = new Map();
for(const r of targets){
  const k = String(r[cfg.extra]).trim().toLowerCase();
  (byCreator.get(k) || byCreator.set(k, []).get(k)).push(r);
}

console.log(`${path.basename(FILE)}: ${rows.length} rows, ` +
            `${targets.length} to fill across ${byCreator.size} ${cfg.extra}s`);
if(targets.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const articles = REFETCH ? {} : readJSON(ARTICLES_FILE, {});
const leads    = REFETCH ? {} : readJSON(LEADS_FILE, {});

/** Plain-text leads for up to 20 titles in one request. */
async function leadsFor(titles){
  const want = titles.filter((t) => !(t in leads));
  for(let i = 0; i < want.length; i += 20){
    const batch = want.slice(i, i + 20);
    const d = await getJSON(
      `${WP}/w/api.php?format=json&action=query&prop=extracts&explaintext=1&exintro=1` +
      `&exlimit=20&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`);
    const pages = Object.values(d?.query?.pages || {});
    // `titles` and `pages` do not correspond by position — redirects and
    // normalisation reorder them — so index by the page's own title and fill any
    // requested title that never came back, or it is re-fetched every run.
    for(const p of pages) if(p.title) leads[p.title] = String(p.extract || '').trim();
    for(const t of batch) if(!(t in leads)) leads[t] = leads[t] ?? '';
  }
  return titles.map((t) => leads[t] || '');
}

/** The creator's whole article as plain text, cached. */
async function articleFor(creator){
  if(creator in articles) return articles[creator];
  const hits = await wpSearch(creator, 5) || [];
  /*
   * Ranked by NAME MATCH, not by search rank.
   *
   * First-person-shaped-hit-wins cost two creators on the first full run, and
   * both failures are the kind nothing downstream can see:
   *
   *   casper david friedrich  ->  Joseph Koerner       (the art historian who
   *                                                     wrote the book about him)
   *   louis-michel van loo    ->  Jean-Baptiste van Loo (a different Van Loo)
   *
   * Both are real people, both are real painters or writers, both have long
   * articles full of dated paragraphs — so every other gate passed and the rows
   * got fluent, well-formed prose about the wrong life. A title-overlap floor
   * rules both out immediately: Koerner shares no word with the creator, and the
   * correct Van Loo shares all four against the wrong one's two.
   *
   * The floor survives the misspelling in the CSV — "casper" vs "caspar" still
   * matches two of three words.
   */
  const ranked = hits
    .map((t) => ({ t, hit: sharedNameWords(t, creator), sim: titleSim(t, creator) }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || b.sim - a.sim);

  let picked = null;
  for(const { t } of ranked){
    if(INDEX_TITLE.test(t)) continue;
    const d = await getJSON(
      `${WP}/w/api.php?format=json&action=query&prop=extracts&explaintext=1&redirects=1` +
      `&titles=${encodeURIComponent(t)}`);
    const page = Object.values(d?.query?.pages || {})[0];
    const text = String(page?.extract || '');
    if(text.length < 1200) continue;
    // A person, not a movement or a museum: the lead of a biography says so
    // within its first sentence or two, and every creator column in these
    // datasets is a person.
    if(!/\b(?:was|is)\b[^.]{0,80}\b(?:painter|artist|sculptor|engraver|printmaker|draughtsman|director|filmmaker|philosopher|writer|composer|architect|photographer)\b/i
        .test(text.slice(0, 700))) continue;
    picked = { title: page.title, text };
    break;
  }
  articles[creator] = picked;
  return picked;
}

// ---------------------------------------------------------------------------
// Sectioning and paragraph scoring
// ---------------------------------------------------------------------------

/*
 * Apparatus sections. Everything here is either a list, a citation dump, or
 * curatorial metadata; none of it says anything about a year in a life.
 */
const SKIP_SECTION =
  /^(see also|references|reference|notes|footnotes|citations|sources|bibliography|further reading|external links|gallery|list of|works|selected works|filmography|publications|awards|honou?rs|collections|museums|in popular culture)\b/i;

/*
 * Provenance, market and legacy sections are VETOED, not merely penalised.
 *
 * These are the one class of section that is systematically attractive to a
 * year-matching scorer and systematically wrong, because they discuss what
 * happened to the paintings *afterwards* and cite each painting's creation year
 * while doing it. Pissarro's restitution section names "A Square in La
 * Roche-Guyon" (1867), so it scored a perfect match against the 1867 canvas and
 * described a 2021 Berlin restitution case as that painting's era.
 *
 * A weight could not fix it: the section earns d=0 honestly, so any penalty small
 * enough to be safe elsewhere loses to a perfect year hit. The section simply has
 * no business here, so it is removed from the pool.
 */
const VETO_SECTION =
  /\b(legacy|provenance|restitution|looted|nazi|market|auction|sale|forger|attribution|posthumous|descendants|family of|influence on|reputation)\b/i;

/*
 * Headings weighted by how likely their paragraphs are to be about the WORK at a
 * moment rather than about the life in general.
 *
 * The one that made this necessary: Pissarro's "Marriage and children" paragraph
 * lists seven children's birth years, so it scores a perfect year match against
 * almost any target between 1863 and 1884 while saying nothing about painting.
 * It won the 1897 slot outright before this table existed.
 */
const HEAD_GOOD = /\b(period|years|phase|style|paint|work|career|exhibit|technique|impressionis|movement|london|paris|rome|italy|studio|series)\b/i;
const HEAD_BAD  = /\b(marriage|children|family|birth|death|died|burial|descend|ancestr|legacy|influence|reputation|estate|market|forger|looted|restitution|controvers|personal life|religio)\b/i;

/*
 * A year, and nothing that merely looks like one.
 *
 * The three-digit branch this started with (`[5-9]\d\d`) is what made the first
 * version wrong in a way the summary could not see: "sold few of his paintings…
 * $500" put a 500 in a Pissarro paragraph that also mentioned 2009, giving that
 * paragraph a 1,509-year span. A span that wide brackets EVERY target year, so
 * the paragraph scored a perfect era match against all 48 paintings and a section
 * about Nazi-era restitution was handed to a canvas from 1856.
 *
 * Nothing in these datasets predates Giotto, so the floor is 1000 and the
 * three-digit case is simply gone. The same lesson as `yearInLead` in lib/wiki.mjs,
 * which is where "about 560 kilometres" became the year 560.
 */
const YEAR_RE = /(?<![$£€\d.,])\b(1[0-9]{3}|20[0-2][0-9])\b(?![\d.,])/g;
// A paragraph is only *about* a period if its years sit close together. Anything
// wider is a summary sentence sweeping a whole century and is not era evidence.
const TIGHT_SPAN = 25;

function paragraphsOf(article){
  const out = [];
  let heading = '(lead)';
  let bodies = [];

  const flush = () => {
    if(SKIP_SECTION.test(heading) || VETO_SECTION.test(heading)){ bodies = []; return; }
    let weight = 0;
    if(heading === '(lead)') weight -= 0.30;          // the generic bio: the reuse trap
    if(HEAD_GOOD.test(heading)) weight += 0.22;
    if(HEAD_BAD.test(heading)) weight -= 0.45;
    if(/\d{4}/.test(heading)) weight += 0.15;         // an explicitly dated section
    /*
     * Consecutive short lines are joined before the length floor is applied.
     * A short article writes its life in one-sentence lines, and judging each of
     * those on its own throws the whole section away — which is how a creator
     * with a real but modest page came out as "no dated paragraphs".
     */
    const merged = [];
    for(const raw of bodies){
      const line = raw.trim();
      if(!line) continue;
      const prev = merged[merged.length - 1];
      if(prev && prev.length < 180) merged[merged.length - 1] = `${prev} ${line}`;
      else merged.push(line);
    }
    for(const raw of merged){
      // Apparatus goes before the length test, so a paragraph is judged on the
      // prose that will actually be embedded rather than on its IPA.
      const text = stripApparatus(raw);
      if(text.length < 140) continue;                 // a stub line, not a paragraph
      const years = [...text.matchAll(YEAR_RE)].map((m) => +m[1]);
      if(!years.length) continue;                     // nothing to place it in time
      out.push({ heading, text, years, weight, i: out.length });
    }
    bodies = [];
  };

  for(const line of String(article.text).split('\n')){
    const m = line.match(/^(={2,6})\s*(.+?)\s*\1$/);
    if(m){ flush(); heading = m[2]; } else if(line.trim()) bodies.push(line);
  }
  flush();
  return out;
}

/**
 * Years between `year` and the nearest edge of the paragraph's own span.
 *
 * Zero when the span brackets the target. This is the number that says whether a
 * row got its own era or somebody else's, so it is stored per row and reported —
 * a wrong era is invisible in the finished prose, which reads perfectly well
 * while describing the wrong decade.
 */
function distance(p, year){
  // Nearest INDIVIDUAL year, not the nearest edge of the min..max span. Using the
  // span let one paragraph mentioning 1830 and 2007 claim to be about 1856, and
  // that single choice is what put the restitution section on the early canvases.
  let best = Infinity;
  for(const y of p.years) best = Math.min(best, Math.abs(y - year));
  return best;
}

/**
 * How well a paragraph speaks to `year`.
 *
 * Containment beats proximity: a paragraph running 1870–1874 is *about* 1872 in a
 * way that a paragraph mentioning only 1871 is not, so a real span that brackets
 * the target earns a bonus over a bare match.
 */
function score(p, year, uses){
  const lo = Math.min(...p.years), hi = Math.max(...p.years);
  const d = distance(p, year);
  let s = 1 / (1 + d / 6);
  // The bonus is for a TIGHT span that brackets the year. Without the width test
  // it rewarded exactly the sprawling paragraphs it was meant to filter out.
  if(hi > lo && hi - lo <= TIGHT_SPAN && year >= lo && year <= hi) s += 0.25;
  s += Math.min(0.15, p.years.length * 0.03);
  s += p.weight;
  /*
   * Reuse is docked, but the total is CAPPED.
   *
   * Uncapped, the penalty grew without bound and eventually outranked being in
   * the right decade at all: Pissarro's 1850s paragraphs were spent by the third
   * painting, and the fourth took a paragraph about 1933 rather than reuse one
   * about 1855. Variety is the tie-breaker between comparable paragraphs; it is
   * not worth being wrong about when the work was made.
   */
  s -= Math.min(REUSE_CAP, REUSE_PENALTY * (uses.get(p.i) || 0));
  return s;
}

/** Trim to `n` chars at a sentence boundary rather than mid-word. */
function clip(text, n){
  if(text.length <= n) return text;
  const dot = text.lastIndexOf('. ', n);
  return (dot > n * 0.4 ? text.slice(0, dot + 1) : text.slice(0, n)).trim();
}

/*
 * Two works from the same season are ALLOWED to share their era paragraph.
 *
 * An earlier version handed each reuse a different sliding window of the same
 * paragraph, purely so the strings would differ. That was the wrong instinct:
 * it manufactured difference that corresponds to nothing about either painting,
 * and it opened excerpts mid-thought to do it. If two Pissarros were painted in
 * the same year, the true statement about their moment is the same statement,
 * and the honest thing is to say it twice.
 *
 * What legitimately separates them is the opener — each work's own title,
 * movement and date — which is real per-work information rather than an offset.
 * The remaining lever, if these ever need to be genuinely distinct, is Wikidata:
 * a painting with no article often still has an item carrying its collection,
 * medium and depicted subject. That is per-work fact, and it is not built here.
 */

/**
 * The one-line statement of what the row itself is.
 *
 * Its job is to guarantee that no two rows embed identical text even when they
 * share every era paragraph, and to put the title, creator and category into the
 * vector where the row's own identity belongs. Kept deliberately plain — an
 * invented adjective here is an invented fact about a painting.
 */
function opener(r){
  const title = titleCase(String(r[cfg.name] || '').trim());
  const who = titleCase(String(r[cfg.extra] || '').trim());
  const yr = String(r[cfg.year] || '').trim();
  const kind = String(r.movement || '').trim();
  const what = kind ? `a ${titleCase(kind)} work` : 'a work';
  return `${title} is ${what} by ${who}, dated ${yr}.`;
}

// ---------------------------------------------------------------------------
// Tier 1 — the work's own page
// ---------------------------------------------------------------------------

const surnameOf = (who) => String(who || '').trim().split(/\s+/).pop().toLowerCase();

/*
 * How many distinctive words a page title and a creator name share.
 *
 * `titleSim` divides by the LONGER name, which is right for comparing two
 * article titles and wrong for matching a person: it scored the correct
 * `rembrandt van rijn` -> *Rembrandt* at 0.33, below the same floor that was
 * meant to catch `casper david friedrich` -> *Joseph Koerner*. Five correct
 * resolutions were rejected before this replaced it — including *Masolino da
 * Panicale* and *Giambattista Pittoni*, where the article simply names the
 * painter more fully, or less fully, than the CSV does.
 *
 * Counting shared words instead is indifferent to how long either side is. The
 * four-character floor is what makes it discriminating: `louis-michel van loo`
 * and `jean-baptiste van loo` share only "van" and "loo", so the wrong Van Loo
 * scores zero while the right one scores two.
 */
function sharedNameWords(a, b){
  const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length >= 4));
  const A = words(a), B = words(b);
  let n = 0;
  for(const w of A) if(B.has(w)) n++;
  return n;
}

/**
 * A page about the work, or null.
 *
 * Three things must all hold, and each one rules out a failure that has actually
 * happened in this repo:
 *
 *   - the lead names the creator      -> it is about this work, not a namesake
 *   - the page is not the creator      -> tier 1 cannot reintroduce the reuse bug
 *   - the titles genuinely overlap     -> `destruction of tyre` does not become
 *                                         *Tyrion Lannister*
 */
async function ownPage(r, creatorTitle){
  const rowTitle = String(r[cfg.name] || '').trim();
  if(rowTitle.length < 4) return null;
  const who = String(r[cfg.extra] || '').trim();
  const surname = surnameOf(who);
  if(surname.length < 4) return null;

  const hits = (await wpSearch(`${rowTitle} ${who}`, 5)) || [];
  const usable = hits.filter((t) =>
    !INDEX_TITLE.test(t) &&
    t.toLowerCase() !== who.toLowerCase() &&
    t.toLowerCase() !== String(creatorTitle || '').toLowerCase() &&
    titleSim(t, rowTitle) >= 0.5);
  if(!usable.length) return null;

  const texts = await leadsFor(usable);
  for(let i = 0; i < usable.length; i++){
    const lead = texts[i];
    if(!lead || lead.length < MIN_EXCERPT) continue;
    if(!lead.toLowerCase().includes(surname)) continue;
    // A biography, not a work: the creator's page under an alias would pass every
    // check above, since it certainly contains its own surname.
    if(/^\s*\S[^.]{0,120}\b(?:was|is) an? [^.]{0,60}\b(?:painter|artist|sculptor|director|filmmaker)\b/i.test(lead)) continue;
    return { title: usable[i], text: clip(lead, ERA_CHARS + 120) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const log = readJSON(LOG_FILE, {});
const misses = [];
const stats = { own: 0, era: 0, thin: 0, noCreatorPage: 0, noParas: 0 };

/*
 * Use counts rebuilt from the log BEFORE anything is chosen.
 *
 * Without this a resumed run starts every creator at zero uses and re-issues the
 * same top paragraph it already issued, which is the precise failure the penalty
 * exists to prevent — and it would only show up as clustering, weeks later.
 */
const usesByCreator = new Map();
for(const rec of Object.values(log)){
  if(!rec.creatorPage || !rec.paras) continue;
  const m = usesByCreator.get(rec.creatorPage) || usesByCreator.set(rec.creatorPage, new Map()).get(rec.creatorPage);
  for(const i of rec.paras) m.set(i, (m.get(i) || 0) + 1);
}

let committed = 0, sinceCkpt = 0;

/** Paragraph breaks are the two literal characters \n\n; the record stays on one line. */
const encode = (s) => String(s).replace(/\r/g, '').replace(/\n{2,}/g, '\n\n')
  .split('\n').map((x) => x.trim()).join('\\n').replace(/(?:\\n)+/g, '\\n\\n').trim();

function checkpoint(){
  if(DRY) return;
  writeDataset(FILE, rows, headers);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(articles));
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads));
  sinceCkpt = 0;
}

const samples = [];

for(const [key, group] of byCreator){
  const who = String(group[0][cfg.extra]).trim();
  const article = await articleFor(who);
  const creatorTitle = article?.title || null;
  const paras = article ? paragraphsOf(article) : [];

  if(!article) stats.noCreatorPage += group.length;
  else if(!paras.length) stats.noParas += group.length;

  const uses = usesByCreator.get(creatorTitle) ||
               usesByCreator.set(creatorTitle, new Map()).get(creatorTitle);

  // Tier 1 is per row and independent, so it can run in parallel across the
  // creator's rows. Tier 2 cannot: each choice changes the next row's scores.
  const own = OWN_PAGE
    ? await mapPool(group, CONC, (r) => ownPage(r, creatorTitle).catch(() => null))
    : group.map(() => null);

  for(let gi = 0; gi < group.length; gi++){
    const r = group[gi];
    const year = yearOf(r);
    const id = `${r[cfg.name]}|${r[cfg.extra]}|${r[cfg.year]}`;
    let out = null, rec = null;

    if(own[gi]){
      out = own[gi].text;
      rec = { via: 'own-page', page: own[gi].title, chars: out.length };
      stats.own++;
    } else if(paras.length){
      /*
       * Era validity is a FILTER; variety is the objective inside it.
       *
       * Ranking everything by one blended score could not do both at once. With
       * the reuse penalty capped, era-correctness won and 48 paintings shared 7
       * bodies — one of them 31 times. Uncapped, variety won and a canvas from
       * 1853 was handed a paragraph about 1933. Splitting the two settles it:
       * nothing outside the window is ever eligible, so the penalty inside the
       * window cannot buy diversity at the cost of being wrong, and is therefore
       * left uncapped.
       */
      let pool = paras.filter((p) => distance(p, year) <= ERA_WINDOW);
      if(!pool.length){
        // No paragraph within a working generation. Fall back to the nearest few
        // so a row is not dropped, but it is genuinely the artist's other era and
        // the `off` figure in the log will say so.
        pool = [...paras].sort((a, b) => distance(a, year) - distance(b, year)).slice(0, 3);
      }
      const chosen = pool
        .sort((a, b) => score(b, year, uses) - score(a, year, uses))
        .slice(0, MAX_PARAS);
      // Chronological, so the prose reads forwards even though it was picked by
      // proximity. A paragraph from 1885 followed by one from 1870 reads as an
      // error even when both are right.
      chosen.sort((a, b) => Math.min(...a.years) - Math.min(...b.years));

      /*
       * The budget is SHARED between the chosen paragraphs rather than spent on
       * the first one.
       *
       * A Wikipedia paragraph runs 400–900 characters, so a first-come budget was
       * always exhausted by paragraph one and every excerpt was a single
       * paragraph — which is why so few distinct bodies existed to go round. Two
       * clipped halves of ~310 characters each still clear MIN_EXCERPT together,
       * and they combine: n paragraphs in a pool give far more than n bodies.
       */
      let body = '';
      const share = Math.floor(ERA_CHARS / Math.max(1, chosen.length));
      for(const p of chosen){
        body += (body ? '\n\n' : '') + clip(p.text, share);
        uses.set(p.i, (uses.get(p.i) || 0) + 1);
      }
      if(body.length >= 200){
        out = `${opener(r)}\n\n${body}`;
        rec = {
          via: 'era', page: creatorTitle, chars: out.length,
          creatorPage: creatorTitle,
          paras: chosen.map((p) => p.i),
          sections: [...new Set(chosen.map((p) => p.heading))],
          // Years from the row's date to the nearest edge of the nearest chosen
          // paragraph's span. 0 means the paragraph brackets the row's year.
          off: Math.min(...chosen.map((p) => distance(p, year))),
        };
        stats.era++;
      }
    }

    if(!out){
      stats.thin++;
      misses.push({ id, title: r[cfg.name], creator: who, year, creatorPage: creatorTitle,
                    why: !article ? 'no-creator-page' : !paras.length ? 'no-dated-paragraphs' : 'too-thin' });
      continue;
    }

    r.excerpt = encode(out);
    log[id] = { ...rec, year, url: rec.page ? `${WP}/wiki/${encodeURIComponent(String(rec.page).replace(/ /g, '_'))}` : null };
    committed++;
    if(samples.length < 6) samples.push({ r, out, rec });
    if(++sinceCkpt >= CKPT_EVERY) checkpoint();
  }

  if(committed && committed % 100 < group.length){
    console.log(`  ${committed}/${targets.length} filled  (own-page ${stats.own}, era ${stats.era})`);
  }
}

checkpoint();
if(!DRY) fs.writeFileSync(MISSES_FILE, JSON.stringify(misses, null, 2));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const written = targets.filter((r) => String(r.excerpt || '').trim().length >= REWRITE_UNDER);
const lens = written.map((r) => r.excerpt.length).sort((a, b) => a - b);

/*
 * The number this whole script is judged on.
 *
 * Not "did every cell get prose" — the naive fill managed that. Whether the prose
 * is DIFFERENT is the thing that decides whether these rows land as a cloud or as
 * a point, so it is measured and printed every run rather than assumed.
 */
/*
 * Measured on the era BODY, with the opener removed.
 *
 * Counting whole excerpts would report 100% distinct every time and mean nothing:
 * the opener carries the row's own title, so it is unique by construction.
 *
 * This is reported as a FACT, not chased as a target. Works from the same season
 * by the same hand share an era and may share the sentence describing it; that is
 * the excerpt being correct, not the excerpt being lazy. The number that would
 * signal the original bug is a body shared across DECADES, which is what the era
 * fit line below measures.
 */
const seen = new Map();
for(const r of written){
  // The WHOLE body. A prefix would report two excerpts as identical whenever they
  // merely opened with the same paragraph, which is the common case and not the
  // thing being measured.
  const body = r.excerpt.split('\\n\\n').slice(1).join(' ') || r.excerpt;
  seen.set(body, (seen.get(body) || 0) + 1);
}
const worst = [...seen.values()].sort((a, b) => b - a)[0] || 0;

console.log('\n=== summary ===');
console.log(`  ${committed} excerpts written  (${stats.own} from the work's own page, ${stats.era} era context)`);
if(lens.length){
  console.log(`  length: min ${lens[0]} · median ${lens[lens.length >> 1]} · max ${lens[lens.length - 1]}`);
}
console.log(`  distinct era bodies: ${seen.size}/${written.length}, most-shared body used ${worst}x` +
            `   (sharing within an era is expected; see era fit)`);

/*
 * Whether the era prose is actually of the row's era.
 *
 * Everything else this script prints would look identical if the scoring were
 * broken and every painting got the same well-written paragraph about 1873, so
 * this is the check that has teeth. A run where the 90th percentile runs to
 * decades means the creator articles are too thin for this approach and those
 * rows want leaving blank.
 */
const offs = Object.values(log).filter((x) => x.via === 'era' && x.off != null)
  .map((x) => x.off).sort((a, b) => a - b);
if(offs.length){
  const q = (p) => offs[Math.min(offs.length - 1, Math.floor(offs.length * p))];
  const exact = offs.filter((d) => d === 0).length;
  console.log(`  era fit: ${exact}/${offs.length} land inside the paragraph's own span` +
              `  ·  median ${q(0.5)}y off · p90 ${q(0.9)}y · worst ${offs[offs.length - 1]}y`);
}
/*
 * Counted from `misses`, not from the running tallies.
 *
 * The tallies count every row of a creator with no article, but some of those
 * rows are filled anyway by tier 1 — so the first version of this line reported
 * "26 left blank: 30 no creator page", more causes than effects.
 */
if(misses.length){
  const why = {};
  for(const m of misses) why[m.why] = (why[m.why] || 0) + 1;
  console.log(`  ${misses.length} left blank: ` +
              Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', '));
}

// Rows whose nearest era paragraph is more than a working generation away. The
// prose is accurate about the artist and wrong about the moment, which is the
// one failure here that reads perfectly well, so it is named rather than summarised.
const far = Object.entries(log).filter(([, x]) => x.via === 'era' && x.off > 25);
if(far.length){
  console.log(`  ${far.length} rows found no paragraph within 25 years of their date:`);
  for(const [id, x] of far.slice(0, 8)) console.log(`    ${x.off}y off  ${id.split('|')[0]} <- ${x.page}`);
  if(far.length > 8) console.log(`    …and ${far.length - 8} more (see ${path.basename(LOG_FILE)})`);
}

if(DRY){
  console.log('\nDRY RUN — nothing written. Sample:\n');
  for(const s of samples){
    console.log(`  ${s.r[cfg.name]} (${s.r[cfg.year]}) — ${s.rec.via} <- ${s.rec.page}` +
                (s.rec.sections ? `  [${s.rec.sections.join(' | ')}]` : ''));
    console.log(`    ${s.out.replace(/\n+/g, ' ').slice(0, 300)}\n`);
  }
} else {
  console.log(`\nwrote ${path.basename(FILE)} (backup at ${path.basename(FILE)}.bak)`);
  console.log(`     ${path.basename(LOG_FILE)} · ${path.basename(MISSES_FILE)} (${misses.length})`);
  console.log(`\nNext: node datasets/migrate.mjs && node datasets/embed-all.mjs` +
              ` && node datasets/atlas.mjs --rebuild && node datasets/verify.mjs`);
}
