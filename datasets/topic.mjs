#!/usr/bin/env node
/**
 * Build a TOPIC: one subject (e.g. "History of England") turned into a clean,
 * chaptered timeline and a quiz pool, from one Wikipedia article plus the store.
 *
 *     node datasets/topic.mjs "History of England"
 *     node datasets/topic.mjs "History of England" --events "Timeline of English history"
 *     node datasets/topic.mjs "History of England" --ingest          # fill gaps first
 *     node datasets/topic.mjs --all [--only slug,slug]               # rebuild every topic (or some)
 *     node datasets/topic.mjs --list [file] [--ingest] [--force]      # build many (topics.txt)
 *     node datasets/topic.mjs --discover <source> --group G [...]      # add many lines to topics.txt
 *     node datasets/topic.mjs --site <index url> --name N --hint "physics" --credit "…" [--ingest]
 *
 * ## Other websites: --site
 *
 * A site shaped as an index page linking to pages of prose (a course, a set of
 * essays) instead of a Wikipedia article. lib/site.mjs reads it: the index's
 * links in order are the chapters; links inside them to the site's own pages
 * name the entries ("copernicus.html" -> Nicolaus Copernicus on Wikipedia);
 * pages of year-led lines are timelines, mined as events; a timeline line's
 * leading "Name, a …" is a person. Wikipedia supplies each entry's dates, image
 * and lead; the site supplies the chapters, intros, the sentence each entry is
 * mentioned in, and a note from the entry's own page on the site (`note`).
 * --hint disambiguates names ("Mercury" + "astronomy" -> the planet).
 * In topics.txt: a line whose first field is a URL is a site.
 *
 * ## Finding topics: --discover
 *
 * Appends candidate articles to topics.txt (never duplicates a line). Sources:
 *
 *     category:Art movements            pages in a category
 *     links:List of sovereign states    pages a list page links to
 *     search:articletopic:military-and-warfare intitle:war     any Wikipedia search
 *
 * Options: --match <regex> keeps matching titles · --template "History of {}"
 * maps each title to the article to use (countries -> their history articles) ·
 * --min-kb N keeps articles at least N KB long (default 40: a topic needs
 * chapters) · --limit N · --dry prints instead of writing. Longest first.
 *
 *     node datasets/topic.mjs --discover "links:List of sovereign states" \
 *       --template "History of {}" --group Countries --limit 40
 *
 * Flags
 *     --name "England"        display name (default: the article title)
 *     --events <page>         also include events mined from this page. Repeatable
 *     --ingest                ingest linked pages / event pages missing from the
 *                             store before building (embeds new rows, throttled)
 *     --ingest-limit N        cap on linked pages ingested (default 250)
 *     --key N                 roughly how many entries "Key events" shows (default 90)
 *     --group "Countries"     shelf on the topic list (default: guessed from the article)
 *     --ideas                 fetch linked pages the store lacks as undated IDEAS
 *                             (lib/ideas.mjs); --ingest does this too
 *     --ingest-only           ingest what is missing, skip placing and building
 *                             (used by --list, which places once for the batch)
 *
 * ## Many topics: --list
 *
 * datasets/topics.txt holds one topic per line:
 *
 *     History of France | name=France | events=Timeline of French history | group=Countries
 *     Impressionism | group=Art
 *
 * `--list --ingest` runs three phases so a batch costs one atlas placement, not
 * one per topic: (1) ingest the missing pages of every pending topic, (2)
 * classify + place them once, (3) build each topic. A topic that is already
 * built is skipped unless --force; a topic that fails is reported and the batch
 * goes on. Re-running finishes whatever is left.
 *
 * Writes datasets/topics/<slug>.json and refreshes datasets/topics/index.json.
 *
 * ## Why a topic is built from the ARTICLE and not from embeddings
 *
 * Measured on this store: no similarity threshold returns "everything in English
 * history". For the query "English history", Richard II ranks #100 (0.41) and
 * Stonehenge #300, with French events between them; R-precision for "history of
 * Germany" stays near 35% whatever the text format or vector width. Similarity
 * RANKS well and cannot DEFINE A SET.
 *
 * The article already holds the structure the clustering was guessing at:
 *
 *   membership   the pages the article links to (plus a timeline page's events)
 *   chapters     its own section headings — Prehistory, Roman Britain, Anglo-Saxon,
 *                Norman, Plantagenet, Tudor… — in the author's order, with names a
 *                person would use. The atlas's clusters were "Byzantine" x5.
 *   importance   how often and where it links a page (a "Main article:" hatnote
 *                or a mention in the lead counts most), plus Wikidata fame
 *   date checks  a page linked in "Roman Britain" whose stored date is 2021
 *                (*Colchester*, city status) is not a Roman event; it stays in the
 *                topic as context but off the timeline
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readEntries, PATHS, slugify } from './lib/store.mjs';
import { entryType, TIMELINE_TYPES } from './lib/etype.mjs';
import { readAudit, auditType } from './lib/audit.mjs';
import { dupCandidates, pairKey, jaccard, readDupes } from './lib/dupes.mjs';
import { loadTaxonomy } from './lib/taxotree.mjs';
import { getJSON } from './lib/wikilib.mjs';
import { INDEX_TITLE, stripApparatus } from './lib/wiki.mjs';
import { readIdeas, ensureIdeas } from './lib/ideas.mjs';
import { writeLite, readTitles } from './lib/lite.mjs';
import { seriesOf, seriesMembers, LOCAL_GROUP } from './lib/series.mjs';

/** datasets/topic-structure.json: parent, series, rulers, role, absorb per slug. */
const STRUCTURE = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'topic-structure.json'), 'utf8')).topics || {}; } catch { return {}; } })();
const absorberOf = (s) => Object.entries(STRUCTURE).find(([, v]) => (v.absorb || []).includes(s))?.[0] || null;
const childrenOf = (s) => Object.entries(STRUCTURE).filter(([, v]) => v.parent === s).map(([k]) => k);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WP = 'https://en.wikipedia.org';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const args = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const flagValues = new Set(['--name', '--events', '--prose', '--ingest-limit', '--key', '--group', '--list', '--discover', '--match', '--template', '--min-kb', '--limit', '--site', '--hint', '--credit', '--max-subpages', '--only'].flatMap((f) => args(f)));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && flagValues.has(a)));

const OPT = {
  page: positional[0],
  name: arg('--name'),
  events: args('--events'),
  prose: args('--prose'),   // narrative pages to mine dated sentences from
  ingest: argv.includes('--ingest'),
  ingestLimit: Number(arg('--ingest-limit', 250)),
  key: Number(arg('--key', 90)),
  all: argv.includes('--all'),
  group: arg('--group'),
  ingestOnly: argv.includes('--ingest-only'),
  list: argv.includes('--list') ? (arg('--list') && !arg('--list').startsWith('--') ? arg('--list') : path.join(HERE, 'topics.txt')) : null,
  force: argv.includes('--force'),
  site: arg('--site'),               // a website index URL instead of a Wikipedia article
  hint: arg('--hint'),               // words that disambiguate its names on Wikipedia ("physics")
  credit: arg('--credit'),           // whose text it is, shown on every page of the topic
  maxSubpages: Number(arg('--max-subpages', 250)),
  ideas: argv.includes('--ideas'),   // fetch undated pages as ideas, without a full --ingest
};

fs.mkdirSync(PATHS.topics, { recursive: true });

if(OPT.all){
  const idx = readIndex();
  // --only a,b: just those slugs.
  const only = arg('--only') ? new Set(arg('--only').split(',').map((x) => x.trim())) : null;
  // Absorbed topics before the topic that folds them in; subtopics before the
  // collections that gather their essentials.
  const order = (t) => (absorberOf(t.slug) ? 0 : STRUCTURE[t.slug]?.role === 'collection' ? 2 : 1);
  for(const t of [...idx.topics].sort((a, b) => order(a) - order(b))){
    if(only && !only.has(t.slug)) continue;
    const a = t.source.kind === 'site'
      ? [path.join(HERE, 'topic.mjs'), '--site', t.source.url, '--name', t.title, '--key', String(t.keyTarget || 90),
         ...(t.source.hint ? ['--hint', t.source.hint] : []), ...(t.source.credit ? ['--credit', t.source.credit] : [])]
      : [path.join(HERE, 'topic.mjs'), t.source.page, '--name', t.title, '--key', String(t.keyTarget || 90)];
    for(const ev of t.events || []) a.push('--events', ev);
    if(t.group) a.push('--group', t.group);
    if(OPT.ideas) a.push('--ideas');
    spawnSync(process.execPath, a, { stdio: 'inherit', env: { ...process.env, TOPIC_BATCH: '1' } });
  }
  buildWeb();
  process.exit(0);
}
/*
 * --structure: apply topic-structure.json (parent, role, absorbedInto) to
 * index.json and every topic file without rebuilding. Series membership still
 * needs a rebuild (and --ingest for pages the store lacks).
 */
if(argv.includes('--structure')){
  const idx = readIndex();
  const set = (o, k, v) => { if(v) o[k] = v; else delete o[k]; };
  for(const row of idx.topics){
    const s = STRUCTURE[row.slug] || {};
    for(const o of [row, (() => { try { return JSON.parse(fs.readFileSync(path.join(PATHS.topics, `${row.slug}.json`), 'utf8')); } catch { return null; } })()]){
      if(!o) continue;
      set(o, 'parent', s.parent || null); set(o, 'role', s.role || null); set(o, 'absorbedInto', absorberOf(row.slug));
      if(o !== row) fs.writeFileSync(path.join(PATHS.topics, `${row.slug}.json`), JSON.stringify(o) + '\n');
    }
  }
  fs.writeFileSync(path.join(PATHS.topics, 'index.json'), JSON.stringify(idx, null, 1) + '\n');
  const unknown = Object.keys(STRUCTURE).filter((s) => !idx.topics.some((t) => t.slug === s));
  const orphans = idx.topics.filter((t) => t.parent && !idx.topics.some((x) => x.slug === t.parent)).map((t) => t.slug);
  console.log(`  structure applied to ${idx.topics.length} topics${unknown.length ? ` · not built yet: ${unknown.join(', ')}` : ''}${orphans.length ? ` · parent missing for: ${orphans.join(', ')}` : ''}`);
  process.exit(0);
}
if(OPT.list){ runList(OPT.list); process.exit(0); }
if(argv.includes('--discover')){ await discover(arg('--discover')); process.exit(0); }

/** `--discover`: find candidate topic articles and append them to topics.txt. */
async function discover(source){
  const API = `${WP}/w/api.php?format=json&formatversion=2`;
  const m = String(source || '').match(/^(category|links|search):\s*(.+)$/i);
  if(!m){ console.error('  --discover needs category:<name>, links:<page> or search:<query>'); process.exit(1); }
  const [, kind, what] = m;
  const limit = Number(arg('--limit', 50));
  const titles = [];
  let cont = {};
  for(let guard = 0; guard < 40; guard++){
    const q = new URLSearchParams(cont);
    let u;
    if(/^category$/i.test(kind)) u = `${API}&action=query&list=categorymembers&cmnamespace=0&cmlimit=500&cmtitle=${encodeURIComponent(what.startsWith('Category:') ? what : 'Category:' + what)}&${q}`;
    else if(/^links$/i.test(kind)) u = `${API}&action=query&prop=links&plnamespace=0&pllimit=500&redirects=1&titles=${encodeURIComponent(what)}&${q}`;
    else u = `${API}&action=query&list=search&srnamespace=0&srlimit=500&srsearch=${encodeURIComponent(what)}&${q}`;
    const d = await getJSON(u);
    if(!d) break;
    if(d.query?.categorymembers) titles.push(...d.query.categorymembers.map((x) => x.title));
    if(d.query?.search) titles.push(...d.query.search.map((x) => x.title));
    if(d.query?.pages) for(const p of d.query.pages) titles.push(...(p.links || []).map((x) => x.title));
    if(!d.continue || titles.length > 5000) break;
    cont = d.continue;
  }
  const match = arg('--match') ? new RegExp(arg('--match'), 'i') : null;
  const tpl = arg('--template');
  let cands = [...new Set(titles.filter((t) => !match || match.test(t)).map((t) => (tpl ? tpl.replace('{}', t) : t)))];
  console.log(`\n  ${titles.length} titles from ${kind}:${what} -> ${cands.length} candidates`);

  // Exists (after redirects) and long enough to have chapters.
  const minBytes = Number(arg('--min-kb', 40)) * 1000;
  const ok = new Map();   // canonical title -> length
  for(let i = 0; i < cands.length; i += 50){
    const chunk = cands.slice(i, i + 50);
    const d = await getJSON(`${API}&action=query&prop=info&redirects=1&titles=${encodeURIComponent(chunk.join('|'))}`);
    // With a template, a redirect away from its shape is not a hit: "History
    // of The New York Times" redirects to "The New York Times".
    const shape = tpl ? new RegExp('^' + tpl.split('{}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$', 'i') : null;
    for(const p of d?.query?.pages || []){
      if(p.missing || p.length < minBytes || INDEX_TITLE.test(p.title) || (shape && !shape.test(p.title))) continue;
      ok.set(p.title, p.length);
    }
  }
  const file = OPT.list || path.join(HERE, 'topics.txt');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split('\n').map((l) => l.replace(/#.*$/, '').split('|')[0].trim().toLowerCase()).filter(Boolean));
  const fresh = [...ok].filter(([t]) => !have.has(t.toLowerCase())).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const group = arg('--group');
  // Display name: the subject, not the article ("History of Peru" -> Peru).
  const lines = fresh.map(([t]) => {
    const name = t.replace(/^History of (the )?/i, '').replace(/^\w/, (c) => c.toUpperCase());
    return [t, name !== t ? `name=${name}` : '', group ? `group=${group}` : ''].filter(Boolean).join(' | ');
  });
  console.log(`  ${ok.size} exist and are ≥ ${minBytes / 1000} KB · ${ok.size - fresh.length > 0 ? `${[...ok].length - fresh.length} already listed or over --limit · ` : ''}adding ${lines.length}:`);
  for(const l of lines) console.log(`    ${l}`);
  if(argv.includes('--dry') || !lines.length) return;
  fs.appendFileSync(file, `${existing.endsWith('\n') ? '' : '\n'}\n# --discover ${source}${group ? ` (${group})` : ''}\n${lines.join('\n')}\n`);
  console.log(`\n  appended to ${path.relative(process.cwd(), file)}. Build them: node datasets/topic.mjs --list --ingest`);
}

/** `--list`: build every topic in a list file, in three phases. */
function runList(file){
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const jobs = lines.map((l) => {
    const [page, ...kv] = l.split('|').map((x) => x.trim());
    const o = { page, events: [] };
    for(const p of kv){
      const m = p.match(/^(\w+)\s*=\s*(.+)$/);
      if(!m) continue;
      if(m[1] === 'events') o.events.push(...m[2].split(';').map((x) => x.trim()).filter(Boolean));
      else if(m[1] === 'prose') (o.prose ||= []).push(...m[2].split(';').map((x) => x.trim()).filter(Boolean));
      else o[m[1]] = m[2].trim();
    }
    o.slug = slugify(o.name || o.page);
    return o;
  });
  const built = new Set(readIndex().topics.map((t) => t.slug));
  const pending = jobs.filter((j) => OPT.force || !built.has(j.slug));
  console.log(`\n  ${jobs.length} topics in ${path.basename(file)} · ${jobs.length - pending.length} already built · ${pending.length} to do`);
  if(!pending.length) return;
  const argsOf = (j) => {
    const a = /^https?:\/\//.test(j.page) ? [path.join(HERE, 'topic.mjs'), '--site', j.page] : [path.join(HERE, 'topic.mjs'), j.page];
    if(j.hint) a.push('--hint', j.hint);
    if(j.credit) a.push('--credit', j.credit);
    if(j.name) a.push('--name', j.name);
    for(const e of j.events) a.push('--events', e);
    for(const e of j.prose || []) a.push('--prose', e);
    if(j.group) a.push('--group', j.group);
    if(j.key) a.push('--key', j.key);
    return a;
  };
  const run = (a) => spawnSync(process.execPath, a, { stdio: 'inherit', env: { ...process.env, TOPIC_BATCH: '1' } }).status;
  if(OPT.ingest){
    for(const [i, j] of pending.entries()){
      console.log(`\n  ── ingest ${i + 1}/${pending.length}: ${j.name || j.page}`);
      // A failure here is almost always Wikipedia throttling, which clears in
      // seconds to a minute: wait and try once more before moving on.
      if(run([...argsOf(j), '--ingest', '--ingest-only', '--ingest-limit', String(OPT.ingestLimit)])){
        console.log('  !! ingest failed; waiting 90 s and retrying once');
        spawnSync('sleep', ['90']);
        if(run([...argsOf(j), '--ingest', '--ingest-only', '--ingest-limit', String(OPT.ingestLimit)])) console.log(`  !! ingest failed again for ${j.page}; building from what the store has`);
      }
    }
    console.log('\n  ── classify + place the new entries (once for the batch)');
    run([path.join(HERE, 'classify.mjs')]);
    run([path.join(HERE, 'atlas.mjs')]);
  }
  const failed = [];
  for(const [i, j] of pending.entries()){
    console.log(`\n  ── build ${i + 1}/${pending.length}: ${j.name || j.page}`);
    if(run(argsOf(j))) failed.push(j.page);
  }
  console.log(`\n  done: ${pending.length - failed.length} built${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`);
  buildWeb();
}

/** datasets/web/ (build-web.mjs): the browser's whole-store files, cut small. Seconds. */
function buildWeb(){
  spawnSync(process.execPath, [path.join(HERE, 'build-web.mjs')], { stdio: 'inherit' });
}
if(!OPT.page && !OPT.site){
  console.error('usage: node datasets/topic.mjs "History of England" [--events "Timeline of English history"] [--ingest]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. The article: sections and the links inside each
// ---------------------------------------------------------------------------

/** Sections that are apparatus, not history. Everything from the first of these on is dropped. */
const STOP_SECTIONS = /^(see also|references|notes|citations|sources|cited sources|notes and quotes|notes and references|sources and further reading|further reading|external links|bibliography|footnotes|historiography|primary sources|works cited|explanatory notes|general and cited references|articles on .+|lists? of .+|related (articles|topics))$/i;

async function fetchArticle(page){
  const u = `${WP}/w/api.php?action=parse&format=json&formatversion=2&redirects=1&prop=text&page=${encodeURIComponent(page)}`;
  const d = await getJSON(u);
  if(!d?.parse) throw new Error(`could not fetch "${page}" from Wikipedia`);
  return { title: d.parse.title, html: d.parse.text };
}

// Named entities: hand-written sites use them freely (&mdash;, &times;, &deg;);
// Wikipedia's markup only ever has the five below plus numeric ones.
const NAMED = { nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', deg: '°', times: '×',
  divide: '÷', middot: '·', plusmn: '±', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', eacute: 'é', egrave: 'è',
  aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', szlig: 'ß',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω', theta: 'θ',
  rarr: '→', larr: '←', harr: '↔', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', minus: '−', prime: '′', Prime: '″', bull: '•', copy: '©' };
const decode = (s) => s.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, n) => NAMED[n] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\[\d+\]/g, '').trim();

/**
 * Split the article into sections and harvest links per section.
 *
 * Links are taken only from prose (`<p>`, `<li>`) and from "Main article:"
 * hatnotes. Tables, infoboxes, navboxes and reference lists are skipped: they
 * link to everything (every monarch, every county) and would make membership
 * mean "appears anywhere on the page".
 */
/**
 * Cut out boxes that are not the article's prose: a "History of Algeria"
 * sidebar beside *Ancient Carthage*'s first section put the Algerian War, the
 * Évian Accords and COVID-19 in Algeria into its "Etymology" chapter, because
 * the sidebar's <li>s read as prose. Nested tags are matched by counting.
 */
const BOX = /class="[^"]*\b(sidebar|navbox|vertical-navbox|infobox|metadata|ambox|side-box|thumb|toc)\b[^"]*"/;
function stripBoxes(html){
  const open = /<(table|div|ul)\b[^>]*>/g;
  let out = '', i = 0, m;
  while((m = open.exec(html))){
    if(!BOX.test(m[0])) continue;
    const tag = m[1];
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, t;
    while(depth && (t = re.exec(html))) depth += t[0][1] === '/' ? -1 : 1;
    const end = depth ? html.length : re.lastIndex;
    out += html.slice(i, m.index);
    i = end;
    open.lastIndex = end;
  }
  return out + html.slice(i);
}

function parseSections(html){
  html = stripBoxes(html);
  // References inside prose link to sources, not subjects.
  html = html.replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/g, '');
  const parts = html.split(/(<div class="mw-heading mw-heading[234]"[^>]*>[\s\S]*?<\/h[234]>)/);
  const sections = [{ level: 1, title: '(lead)', body: parts[0] }];
  for(let i = 1; i < parts.length; i += 2){
    const m = parts[i].match(/mw-heading([234])[\s\S]*?<h[234][^>]*>([\s\S]*?)<\/h[234]>/);
    sections.push({ level: Number(m[1]), title: stripTags(m[2]), body: parts[i + 1] || '' });
  }
  // The tail (See also, Notes, References…) is where every remaining top-level
  // section is one of these. A "Historiography" or "Sources" section EARLIER on
  // is skipped on its own: stopping at it cut *Ancient Greece* to its first
  // section, and *Mali Empire*, which opens with one, to nothing.
  const top = sections.map((s, i) => [s, i]).filter(([s]) => s.level === 2);
  let tail = sections.length;
  for(let k = top.length - 1; k >= 0 && STOP_SECTIONS.test(top[k][0].title); k--) tail = top[k][1];
  let skipping = false;
  const kept = sections.slice(0, tail).filter((s) => {
    if(s.level === 2) skipping = STOP_SECTIONS.test(s.title);
    return !skipping;
  });

  for(const s of kept){
    s.links = [];
    const hat = [...s.body.matchAll(/<div[^>]*class="[^"]*hatnote[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    for(const h of hat){
      if(!/main article|main articles|further information/i.test(h[1])) continue;
      for(const a of h[1].matchAll(/<a href="\/wiki\/([^"#?]+)"/g)) s.links.push({ target: a[1], weight: 4, hat: true });
    }
    const prose = [...s.body.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]).join('\n');
    for(const a of prose.matchAll(/<a href="\/wiki\/([^"#?]+)"/g)) s.links.push({ target: a[1], weight: 1, hat: false });
    for(const l of s.links) l.target = decodeURIComponent(l.target).replace(/_/g, ' ');
    s.paras = [...s.body.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)]
      .map((m) => ({ tag: m[1], ...proseText(m[2]) }))
      .filter((p) => p.text.length > 30);
    // Namespaces are not entries. "Template talk:History of Japan" got through
    // when only the bare namespaces were listed.
    s.links = s.links.filter((l) => !/^(File|Image|Category|Help|Wikipedia|WP|Template|Portal|Special|Talk|Module|Draft|User|MediaWiki|TimedText|Book|Wiktionary|Wikt)( talk)?:/i.test(l.target));
  }
  return kept;
}

/**
 * A paragraph's plain text, with the position of every /wiki/ link in it, so a
 * link can be traced back to the sentence that mentions it.
 */
const wikiHref = (href) => {
  const m = String(href).match(/^\/wiki\/([^#?]+)/);
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};

function proseText(html, resolve = wikiHref){
  html = html.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/g, '')          // footnote markers, [citation needed]
    .replace(/<span[^>]*class="[^"]*(?:IPA|nowrap)[^"]*"[^>]*>[\s\S]*?<\/span>/g, (m) => (/IPA/.test(m) ? '' : m))
    .replace(/<(style|ul|ol|table)\b[\s\S]*?<\/\1>/g, '');            // nested lists are their own paragraphs
  let text = '';
  const links = [];
  for(const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>|<br\s*\/?>|<[^>]+>|[^<]+/gi)){
    if(m[1] != null){
      const t = stripTags(m[2]);
      const target = resolve(decode(m[1]), t);
      if(target) links.push({ target, at: text.length + 1, len: t.length });
      text += t;
    } else if(m[0].startsWith('<')){
      if(/^<br/.test(m[0])) text += ' ';
    } else text += decode(m[0]);
  }
  // Collapse whitespace while keeping link offsets aligned.
  let out = '', map = [];
  for(let i = 0; i < text.length; i++){
    const ws = /\s/.test(text[i]);
    if(ws && (out === '' || out.endsWith(' '))){ map.push(out.length); continue; }
    map.push(out.length); out += ws ? ' ' : text[i];
  }
  map.push(out.length);
  for(const l of links) l.at = map[Math.min(map.length - 1, Math.max(0, l.at - 1))];
  return { text: out.trim(), links };
}

/** Abbreviations whose full stop does not end a sentence. */
// A lone capital is an initial ("J. R. R. Tolkien"), except I, V and X, which
// end a regnal name as often as not ("…Edward VI and Mary I. The religious…").
const ABBR = /(?:\b(?:c|ca|fl|r|d|b|St|Mr|Mrs|Dr|Jr|Sr|vs|viz|i\.e|e\.g|Gen|Col|Capt|Lt|Rev|No|Vol|pp?|ed|cf|al)|\b[A-HJ-UWYZ])$/;

/** Split a paragraph into sentences: [{ text, from, to }], offsets into `text`. */
function sentences(text){
  const out = [];
  let from = 0;
  for(const m of text.matchAll(/[.!?]["”’')\]]*(?=\s+["“‘(]?[A-Z0-9])/g)){
    if(m[0][0] === '.' && ABBR.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    const to = m.index + m[0].length;
    out.push({ from, to });
    from = to;
    while(from < text.length && /\s/.test(text[from])) from++;
  }
  if(from < text.length) out.push({ from, to: text.length });
  return out.map((x) => ({ ...x, text: text.slice(x.from, x.to).trim() })).filter((x) => x.text);
}

/** The first sentences of some paragraphs, up to about `max` characters. */
function opening(paras, max){
  let out = '';
  for(const p of paras){
    for(const s of sentences(p.text)){
      if(out && out.length + s.text.length > max) return out;
      out += (out ? ' ' : '') + s.text;
      if(out.length > max * 0.6) return out;
    }
    if(out.length > max * 0.4) return out;
    if(out) out += '\n\n';
  }
  return out.trim();
}

/**
 * An intro as a reader should get it: no pronunciation guide, and no sentence
 * about the website itself ("Welcome to the general public version of the
 * homepage…", "try saving them to your desktop and using QuickTime"). Course
 * sites open their index page that way.
 */
const BOILERPLATE = /\b(welcome to|this (web ?site|web ?page|site)|homepage|home page|web browser|click (here|on)|quicktime|download|bookmark|copyright|all rights reserved|lecture topics are listed)\b/i;
function cleanIntro(text){
  if(!text) return '';
  return String(text).split(/\n{2,}/).map((p) => sentences(stripApparatus(p)).map((s) => s.text).filter((s) => !BOILERPLATE.test(s)).join(' '))
    .filter((p) => p.trim().length > 20).join('\n\n').trim();
}

/** Does one passage repeat the other? Compared on their openings, so a trimmed copy still counts. */
const repeats = (a, b) => !!a && !!b && (b.includes(a.slice(0, 90)) || a.includes(b.slice(0, 90)));

/**
 * Hand corrections, per topic: datasets/topic-overrides.json. For what no rule
 * should have to know ("Ottoman Greeks" is a bad match for "the Greeks" in a
 * physics lecture). Titles match case-insensitively.
 *
 *   drop          [titles]   not in the topic at all
 *   unkey         [titles]   never an essential (the next best takes the slot)
 *   key           [titles]   always an essential (if it has a date)
 *   intro         text       replaces the topic's intro
 *   blurb         text       replaces the topic list's one-liner
 *   chapterYears  { chapter title: [from, to] }
 *   chapterIntro  { chapter title: text }
 *   noKeyChapters [chapter titles]  no essentials from these (historiography,
 *                 "Approaches to…": a list of historians, not the subject)
 */
function loadOverrides(slug){
  try {
    const all = JSON.parse(fs.readFileSync(path.join(HERE, 'topic-overrides.json'), 'utf8'));
    const o = all[slug] || {};
    const low = (a) => new Set((a || []).map((s) => String(s).toLowerCase()));
    return { ...o, drop: low(o.drop), unkey: low(o.unkey), key: low(o.key), noKeyChapters: low(o.noKeyChapters), chapterYears: o.chapterYears || {}, chapterIntro: o.chapterIntro || {} };
  } catch(e){
    if(e.code !== 'ENOENT') console.log(`  !! topic-overrides.json: ${e.message}`);
    return { drop: new Set(), unkey: new Set(), key: new Set(), noKeyChapters: new Set(), chapterYears: {}, chapterIntro: {} };
  }
}

/**
 * Group sections into chapters: each level-2 heading is a chapter, its level-3
 * and -4 headings are its subsections. The lead is not a chapter; its links are
 * credited as "mentioned in the lead".
 */
/** A picture gallery is not a chapter: its works count, its museums do not. */
const GALLERY = /^(gallery|galleries|image gallery|gallery of works|selected works|images|paintings|works gallery)$/i;

function chaptersFrom(sections, isDated = () => true){
  let chapters = [];
  let cur = null;
  for(const s of sections){
    if(s.title === '(lead)' || GALLERY.test(s.title)) continue;
    if(s.level === 2){ cur = { title: s.title, subsections: [], sections: [s] }; chapters.push(cur); }
    else if(cur){ cur.subsections.push(s.title); cur.sections.push(s); }
  }
  /*
   * A chapter that holds most of the article is the article's real structure
   * one level down (measured in links to DATED store entries: Egypt's
   * "History" has a third of the links but nearly all the dates). "History" in *Ancient Egypt* (Predynastic, Old Kingdom,
   * Middle Kingdom…) and *Ancient Rome* (Kingdom, Republic, Empire…), "Course of
   * the war" in *World War II*. Left whole, one chapter held 215 of 228 entries.
   * Its subsections become chapters; its own opening goes with the first.
   */
  const links = (c) => new Set(c.sections.flatMap((x) => x.links.filter((l) => isDated(l.target)).map((l) => l.target))).size;
  const total = chapters.reduce((n, c) => n + links(c), 0);
  chapters = chapters.flatMap((c) => {
    const subs = c.sections.filter((x) => x.level === 3);
    // The biggest chapter, holding over 38% of the dated links.
    // Or a chapter called "History": in an article about a civilisation that IS
    // the narrative, even when Culture is as big (*Ancient Greece*).
    const narrative = /^history$/i.test(c.title) && subs.length >= 3;
    if(!narrative && (subs.length < 3 || links(c) < total * 0.38 || chapters.some((o) => links(o) > links(c)))) return [c];
    const out = [];
    for(const x of c.sections.slice(1)){
      if(x.level === 3){ out.push({ title: x.title, subsections: [], sections: [x], parent: c.title }); }
      else if(out.length){ out[out.length - 1].subsections.push(x.title); out[out.length - 1].sections.push(x); }
    }
    if(out.length) out[0].sections.unshift({ ...c.sections[0], level: 3, title: out[0].title });
    return out.length ? out : [c];
  });
  return chapters;
}

/** Resolve link targets through redirects, 50 at a time. */
async function resolveRedirects(titles){
  const map = new Map();
  const list = [...new Set(titles)];
  for(let i = 0; i < list.length; i += 50){
    const chunk = list.slice(i, i + 50);
    const d = await getJSON(`${WP}/w/api.php?action=query&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(chunk.join('|'))}`);
    const norm = new Map((d?.query?.normalized || []).map((n) => [n.from, n.to]));
    const redir = new Map((d?.query?.redirects || []).map((r) => [r.from, r.to]));
    for(const t of chunk){
      let x = norm.get(t) || t;
      x = redir.get(x) || x;
      map.set(t, x);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1b. A website instead of an article (--site)
// ---------------------------------------------------------------------------

/**
 * The same shape `parseSections` makes from a Wikipedia article, from a site:
 * a lead plus one level-2 section per chapter page, each with `paras` whose
 * links already point at Wikipedia titles. Everything after this is shared.
 */
async function siteArticle(url){
  const { readSite, chunks, linksOf, toWikipedia, leadingName, textOf, titleOf, gazetteer, namesIn } = await import('./lib/site.mjs');
  const gaz = gazetteer(readEntries(), entryType);
  let common = null;     // words the site writes in lower case: not names when capitalised alone
  const unknownTried = new Map();     // capitalised phrase -> exact Wikipedia title or null
  console.log(`\n  reading ${url}…`);
  const S = await readSite(url, { maxSubpages: OPT.maxSubpages });
  const title = OPT.name || S.title;
  const topicHint = OPT.hint || '';

  // What each same-site page is called, from its own title and the link texts
  // that point at it, then resolved to Wikipedia once.
  const anchors = new Map();
  for(const c of S.chapters) if(c.html) for(const l of linksOf(c.html, c.url)){
    (anchors.get(l.href) || anchors.set(l.href, new Set()).get(l.href)).add(l.text);
  }
  const hrefTitle = new Map();     // href -> Wikipedia title (or null)
  const notes = new Map();         // Wikipedia title -> { text, url } from the site's own page
  const chapterUrls = new Set(S.chapters.map((c) => c.url));
  let n = 0;
  const resolveHref = async (href, text, hint) => {
    if(hrefTitle.has(href)) return hrefTitle.get(href);
    const sub = S.subpages.get(href);
    if(chapterUrls.has(href) || /\.(jpe?g|png|gif|pdf|mov|mp4|avi)$/i.test(href)){ hrefTitle.set(href, null); return null; }
    const names = [sub && S.strip(sub.title), ...(anchors.get(href) || []), text].filter(Boolean);
    const t = await toWikipedia(names, { hint: `${hint} ${topicHint}`.trim() });
    hrefTitle.set(href, t);
    if(t && sub && !notes.has(t)) notes.set(t, { text: sub.text.split('\n').filter((l) => l.length > 60).slice(0, 2).join(' ').slice(0, 600), url: href });
    if(++n % 20 === 0) process.stdout.write(`\r  resolved ${n} names…`);
    return t;
  };

  common = new Set();
  for(const c of S.chapters) if(c.html) for(const w of textOf(c.html).match(/(?<![.!?]\s)\b[a-z][a-z'’-]{2,}\b/g) || []) common.add(w);
  const sections = [{ level: 1, title: '(lead)', body: '', links: [], paras: S.intro ? [{ tag: 'p', text: S.intro, links: [] }] : [] }];
  const events = [];
  for(const c of S.chapters){
    if(!c.html){ continue; }
    const sec = { level: 2, title: c.title, body: c.html, links: [], paras: [], url: c.url };
    // The chapter's own subject ("Galileo", "Newton"), exact titles only: a
    // lecture called "Energy" is about the concept, and that is fine too.
    const own = await toWikipedia([c.title], { hint: topicHint, exactOnly: true });
    if(own) sec.links.push({ target: own, weight: 4, hat: true });

    // Resolve this page's links first (async), then parse paragraphs with them.
    const map = new Map();
    for(const l of linksOf(c.html, c.url)) if(!map.has(l.href)) map.set(l.href, await resolveHref(l.href, l.text, c.title));
    const base = c.url;
    const resolve = (href) => { try { return map.get(new URL(href, base).href.replace(/#.*$/, '')) || null; } catch { return null; } };
    for(const ch of chunks(c.html)){
      const p = proseText(`<p>${ch}</p>`, resolve);
      if(p.text.length <= 30) continue;
      /*
       * Names the page mentions without linking. Known ones come from the
       * store's gazetteer; an unknown "Edmond Halley" is tried as an exact
       * Wikipedia title (proper names only, so no search guessing). A name
       * already covered by a link is not added twice.
       */
      for(const nm of namesIn(p.text, gaz, common)){
        if(p.links.some((l) => nm.at < l.at + l.len && l.at < nm.at + nm.len)) continue;
        let tt = nm.title;
        if(!tt){
          if(!unknownTried.has(nm.name)) unknownTried.set(nm.name, await toWikipedia([nm.name], { exactOnly: true }));
          tt = unknownTried.get(nm.name);
        }
        if(tt) p.links.push({ target: tt, at: nm.at, len: nm.len });
      }
      p.links.sort((a, b) => a.at - b.at);
      sec.paras.push({ tag: 'p', ...p });
    }
    if(c.timeline){
      events.push(c.url);
      // "1814 - Joseph Fraunhofer, a German lens-maker…": the line is an EVENT
      // (mined from this page). The person it names is resolved so the event
      // can borrow his picture and link to him, but a person named only on a
      // timeline line is not a card of his own (`tl`): the Dateline of
      // Thermodynamics was 21 people cards carrying the events as captions.
      for(const line of textOf(c.html).split('\n')){
        const name = leadingName(line);
        if(!name) continue;
        const t = await toWikipedia([name], { hint: topicHint });
        if(t) sec.paras.push({ tag: 'p', text: line, links: [{ target: t, at: line.indexOf(name), len: name.length, tl: true }] });
      }
    }
    for(const p of sec.paras) for(const l of p.links) sec.links.push({ target: l.target, weight: l.tl ? 0.3 : 1, hat: false, tl: !!l.tl });
    sections.push(sec);
  }
  console.log(`\r  resolved ${[...hrefTitle.values()].filter(Boolean).length} of ${hrefTitle.size} linked pages to Wikipedia; ${events.length} timeline pages`);
  return { title, html: '', sections, kind: 'site', url: S.url, events, notes, credit: OPT.credit || null };
}

// ---------------------------------------------------------------------------
// 2. Chapter dates
// ---------------------------------------------------------------------------

const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21 };

/**
 * A date range stated by the heading itself, when there is one: "14th century",
 * "Modern England, 18th–19th centuries", "Tudor England (1485–1603)". These
 * override the range inferred from members, because the author said so.
 */
function headingRange(title){
  const t = title.toLowerCase();
  let m = t.match(/(\d{3,4})\s*[–-]\s*(\d{2,4})/);
  if(m){ let a = +m[1], b = +m[2]; if(b < 100) b = Math.floor(a / 100) * 100 + b; if(b > a) return [a, b]; }
  const cent = [...t.matchAll(/(\d{1,2})(?:st|nd|rd|th)|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first)\b/g)]
    .map((x) => (x[1] ? +x[1] : ORD[x[2]]));
  if(cent.length && /centur/.test(t)){
    const bc = /\bbc\b|bce/.test(t);
    const lo = Math.min(...cent), hi = Math.max(...cent);
    return bc ? [-hi * 100, -(lo - 1) * 100 - 1] : [(lo - 1) * 100, hi * 100 - 1];
  }
  return null;
}

/** The year an entry "happens" at, for placing it in a chapter. */
function anchorYear(it){
  if(it.type === 'person' && it.kind === 'span' && it.end != null){
    // A life is best placed at its prime, not its birth: Shakespeare is
    // Elizabethan, not "born under Mary I". Two-thirds through a lifespan, or
    // the reign itself for leaders (whose span already IS the reign).
    if(it.dataset === 'leaders') return it.start;
    return Math.round(it.start + (it.end - it.start) * 0.6);
  }
  return it.start;
}

/**
 * Infer each chapter's range from the members it mentions, when the heading
 * does not state one. Consecutive chapters are split at the year that
 * misclassifies the fewest of their two member sets, and boundaries are forced
 * to be monotone — a chronological article's chapters do not overlap.
 */
function inferRanges(chapters){
  const anchors = chapters.map((c) => c.members.filter((it) => TIMELINE_TYPES.has(it.type)).map(anchorYear).sort((a, b) => a - b));
  const med = anchors.map((a) => (a.length ? a[Math.floor(a.length / 2)] : null));

  // Is the article chronological at all? Spearman-ish: fraction of consecutive
  // pairs (with data) whose medians ascend.
  const pairs = [];
  for(let i = 0; i + 1 < med.length; i++) if(med[i] != null && med[i + 1] != null) pairs.push(med[i + 1] >= med[i]);
  const chronological = pairs.length >= 2 && pairs.filter(Boolean).length / pairs.length >= 0.75;
  if(!chronological) return false;

  const stated = chapters.map((c) => headingRange(c.title));
  const bounds = [];
  for(let i = 0; i + 1 < chapters.length; i++){
    const left = anchors[i], right = anchors[i + 1];
    if(stated[i]){ bounds.push(stated[i][1] + 1); continue; }
    if(stated[i + 1]){ bounds.push(stated[i + 1][0]); continue; }
    // Candidate split points: every anchor year of the two chapters.
    const cands = [...new Set([...left, ...right])].sort((a, b) => a - b);
    let best = med[i] != null && med[i + 1] != null ? (med[i] + med[i + 1]) / 2 : null, bestErr = Infinity;
    for(const b of cands){
      const err = left.filter((y) => y >= b).length + right.filter((y) => y < b).length;
      if(err < bestErr){ bestErr = err; best = b; }
    }
    bounds.push(best);
  }
  // Monotone: a boundary may not precede the one before it.
  for(let i = 1; i < bounds.length; i++) if(bounds[i] != null && bounds[i - 1] != null && bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];

  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  chapters.forEach((c, i) => {
    // The first chapter starts where its members mostly start, not at its single
    // oldest member — one -4,000,000 entry would otherwise set the left edge.
    const lo = i === 0 ? (stated[0]?.[0] ?? pct(anchors[0], 0.1)) : bounds[i - 1];
    const hi = i === chapters.length - 1 ? (stated[i]?.[1] ?? new Date().getFullYear()) : bounds[i] - 1;
    c.from = lo; c.to = hi;
    // A thematic chapter wedged between two dated ones ("Formation of Great
    // Britain", between "17th century" and "18th–19th centuries") gets squeezed
    // to nothing by the stated neighbours. It really overlaps them, so give it
    // its own members' range instead and let it overlap.
    if(hi < lo || (anchors[i].length >= 3 && hi - lo < 10)){
      c.from = stated[i]?.[0] ?? pct(anchors[i], 0.1);
      c.to = stated[i]?.[1] ?? pct(anchors[i], 0.9);
      c.overlaps = true;
    }
  });
  return true;
}

// ---------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------

const art = OPT.site ? await siteArticle(OPT.site) : (console.log(`\n  fetching "${OPT.page}"…`), await fetchArticle(OPT.page));
const sections = art.sections || parseSections(art.html);
const lead = sections[0];

const allTargets = sections.flatMap((s) => s.links.map((l) => l.target));
const redirects = await resolveRedirects(allTargets);
const canon = (t) => redirects.get(t) || t;

// The store, early: splitting a dominant chapter is decided by where the
// article's DATED entries are, not where its links are.
const slug = slugify(OPT.name || art.title);
const domain = slug;
const OVR = loadOverrides(slug);
const titleIn = (set, it) => set.has(String(it.title).toLowerCase()) || (it.canon && set.has(String(it.canon).toLowerCase())) || (it.origTitle && set.has(String(it.origTitle).toLowerCase()));
// Short titles for mined timeline events, whose own title is a sentence fragment
// ("Harry Brearley invents stainless steel in Sheffield, Yorkshire"): datasets/titles.json.
const TITLES = readTitles();
const wikiKey = (u) => decodeURIComponent(String(u || '').replace(/^https?:\/\/en\.wikipedia\.org\/wiki\//, '')).replace(/_/g, ' ');

let entries = readEntries();
const indexStore = () => {
  const byWiki = new Map(), byTitle = new Map();
  for(const e of entries){
    if(e.origin?.wiki && !e.origin?.manual) byWiki.set(wikiKey(e.origin.wiki).toLowerCase(), e);
    if(!e.origin?.manual) byTitle.set(String(e.title).toLowerCase(), byTitle.get(String(e.title).toLowerCase()) || e);
  }
  return { byWiki, byTitle };
};
let { byWiki, byTitle } = indexStore();
const findEntry = (t) => byWiki.get(t.toLowerCase()) || byTitle.get(t.toLowerCase()) || null;

const chapters = chaptersFrom(sections, (target) => findEntry(canon(target))?.start != null);
console.log(`  ${art.title}: ${chapters.length} chapters, ${sections.reduce((s, x) => s + x.links.length, 0)} prose links`);

// Per canonical title: weighted mentions, which chapters/subsections, lead mention.
const mention = new Map();
const credit = (t, w, ch, sub, hat, tl = false) => {
  let m = mention.get(t);
  if(!m) mention.set(t, (m = { weight: 0, count: 0, lead: false, hat: false, chapters: new Map(), firstChapter: ch, firstSub: sub, prose: 0 }));
  m.galleryOnly = false;
  if(!tl) m.prose++;
  m.weight += w; m.count++;
  if(hat) m.hat = true;
  if(ch == null) m.lead = true;
  else m.chapters.set(ch, (m.chapters.get(ch) || 0) + w);
  if(m.firstChapter == null && ch != null){ m.firstChapter = ch; m.firstSub = sub; }
};
for(const l of lead.links) credit(canon(l.target), 2, null, null, false);
// Gallery sections: credit the works they show, flagged, with no chapter. A
// museum there ("Metropolitan Museum of Art") is a caption, dropped below.
for(const sec of sections.filter((x) => GALLERY.test(x.title))){
  for(const l of sec.links){
    const t = canon(l.target);
    let m = mention.get(t);
    if(!m) mention.set(t, (m = { weight: 0, count: 0, lead: false, hat: false, chapters: new Map(), firstChapter: null, firstSub: null, galleryOnly: true }));
    m.weight += 1; m.count++;
  }
}
chapters.forEach((c, ci) => {
  c.sections.forEach((s, k) => { for(const l of s.links) credit(canon(l.target), l.weight, ci, k === 0 ? null : s.title, l.hat, l.tl); });
});
mention.delete(art.title);   // the article linking to itself

/*
 * Members beyond the article's own links (docs/TOPICS.md, "Series and the topic
 * tree"):
 *  - the topic's Wikipedia SERIES (sidebar/navbox, topic-structure.json or the
 *    biggest own series): what editors filed under this subject. Weighted below
 *    an article link (0.6, or +0.5 for a page the article links too), so they
 *    fill in rather than take the essentials.
 *  - a COLLECTION's subtopics: their essentials, weight 0.8.
 *  - ABSORBED topics (Ideas of Physics into Physics): their members as links,
 *    with the course's own note on each.
 */
const STRUCT = STRUCTURE[slug] || {};
const SERIES = [];
if(!OPT.site){
  let names = STRUCT.series;
  if(!names){
    try {
      names = (await seriesOf(art.title, { name: OPT.name || '' })).series
        .filter((s) => s.role === 'own' && !/^years in |\btopics$/i.test(s.name)).slice(0, 1).map((s) => s.name);
    } catch(e){ names = []; console.log(`  series lookup failed: ${e.message}`); }
  }
  for(const n of names){
    try { SERIES.push(await seriesMembers(n)); } catch(e){ console.log(`  series "${n}" failed: ${e.message}`); }
  }
}
const seriesHeading = new Map();   // canonical title -> the series heading it is filed under
{
  const raw = SERIES.flatMap((s) => s.groups.filter((g) => !LOCAL_GROUP.test(g.heading)).flatMap((g) => g.titles.map((t) => [t, g.heading || s.title])));
  const rd = raw.length ? await resolveRedirects(raw.map(([t]) => t)) : new Map();
  for(const [t, h] of raw){ const c = rd.get(t) || t; if(!seriesHeading.has(c) && !INDEX_TITLE.test(c)) seriesHeading.set(c, h); }
}
const addMember = (t, w, extra) => {
  if(!t || t === art.title) return;
  const m = mention.get(t);
  if(m){ m.weight += w * 0.8; Object.assign(m, extra); return; }
  mention.set(t, { weight: w, count: 1, lead: false, hat: false, chapters: new Map(), firstChapter: null, firstSub: null, prose: 1, ...extra });
};
for(const [t, h] of seriesHeading) addMember(t, 0.6, { series: h });
if(SERIES.length) console.log(`  series: ${SERIES.map((s) => `${s.name} (${s.groups.filter((g) => !LOCAL_GROUP.test(g.heading)).flatMap((g) => g.titles).length})`).join(', ')}`);

const readTopic = (s) => { try { return JSON.parse(fs.readFileSync(path.join(PATHS.topics, `${s}.json`), 'utf8')); } catch { return null; } };
const childContext = new Map();   // canonical title -> { text, slug } from a subtopic
if(STRUCT.role === 'collection'){
  let n = 0;
  for(const c of childrenOf(slug)){
    const t = readTopic(c);
    for(const it of t?.items || []) if(it.key && it.canon && it.via === 'link'){
      addMember(it.canon, 0.8, { fromChild: c });
      // The subtopic's own sentence about it, for when the collection's article has none.
      if(it.context && !childContext.has(it.canon)) childContext.set(it.canon, { text: it.context, slug: c });
      n++;
    }
  }
  console.log(`  collection: ${n} essentials from ${childrenOf(slug).length} subtopics`);
}
const ABSORBED = (STRUCT.absorb || []).map(readTopic).filter(Boolean);
if(ABSORBED.length){
  if(!art.notes) art.notes = new Map();
  for(const a of ABSORBED){
    for(const it of a.items) if(it.canon && it.via === 'link'){
      addMember(it.canon, it.key ? 0.8 : 0.4, { course: a.slug });
      if(it.note && !art.notes.has(it.canon)) art.notes.set(it.canon, { text: it.note, url: it.noteUrl || '' });
    }
  }
  console.log(`  absorbed: ${ABSORBED.map((a) => `${a.title} (${a.items.length})`).join(', ')}`);
}

/*
 * Where the article says it. For every link: the sentence it sits in, by
 * chapter, so an entry can be shown the way THIS article talks about it
 * ("Julius Caesar invaded in 55 and 54 BC…") rather than through its own
 * Wikipedia lead, which is about Caesar, not about England.
 *
 * Co-mentions — two links in the same sentence or paragraph — become each
 * entry's "related" list: Hastings, Harold Godwinson and William the Conqueror
 * are linked from the same lines.
 */
const contexts = new Map();   // canonical title -> [{ ch, sub, text }]
const cooc = new Map();       // canonical title -> Map(canonical title -> weight)
const bump = (a, b, w) => {
  if(a === b) return;
  let m = cooc.get(a); if(!m) cooc.set(a, (m = new Map()));
  m.set(b, (m.get(b) || 0) + w);
};
function harvest(sec, ch, first = false){
  // A chapter's first section is its opening, whatever its heading level (a
  // promoted subsection is level 3).
  const sub = first || sec.level <= 2 ? null : sec.title;
  // A "Main article: Elizabethan era" hatnote means the section IS about it, so
  // the section's opening is its context.
  const hatOpen = opening((sec.paras || []).filter((p) => p.tag === 'p'), 320);
  if(hatOpen) for(const l of sec.links.filter((x) => x.hat)){
    const t = canon(l.target);
    const list = contexts.get(t) || contexts.set(t, []).get(t);
    // Low score: a fallback for entries the prose never names, since the same
    // opening is also the context of whatever its first sentence links.
    if(!list.some((c) => c.text === hatOpen)) list.push({ ch, sub, text: hatOpen, score: -1 });
  }
  for(const p of sec.paras || []){
    const sents = sentences(p.text);
    const at = p.links.map((l) => ({ t: canon(l.target), at: l.at, k: sents.findIndex((x) => l.at >= x.from && l.at < x.to) }));
    for(const { t, k, at: pos } of at){
      if(k < 0) continue;
      let text = sents[k].text;
      const sn = sents[k];
      // How much the sentence is ABOUT this link: near the start (the subject),
      // few other links competing, a date in it. Used to pick the best of
      // several mentions; the first is often a passing one ("his brother Henry").
      const lead = 1 - Math.min(1, (pos - sn.from) / Math.max(40, sn.to - sn.from));
      const others = at.filter((x) => x.k === k).length - 1;
      const score = 2 * lead - 0.25 * Math.min(4, others) + (/\b\d{3,4}\b/.test(sn.text) ? 0.6 : 0) + (sub && t.toLowerCase().includes(sub.toLowerCase().split(' ')[0]) ? 0.5 : 0);
      // A short sentence leans on its neighbour ("He was crowned in 1066.").
      if(text.length < 80 && sents[k + 1]) text += ' ' + sents[k + 1].text;
      if(text.length > 420) text = text.slice(0, 420).replace(/\s+\S*$/, '') + '…';
      const list = contexts.get(t) || contexts.set(t, []).get(t);
      if(list.length < 12 && !list.some((c) => c.text === text)) list.push({ ch, sub, text, score });
    }
    const seen = [...new Set(at.map((x) => x.t))];
    // Same paragraph is weak evidence (a long paragraph links everything);
    // same sentence is strong.
    if(seen.length <= 12) for(const a of seen) for(const b of seen) bump(a, b, 1);
    for(let i = 0; i < at.length; i++) for(let j = 0; j < at.length; j++) if(at[i].k === at[j].k && at[i].t !== at[j].t) bump(at[i].t, at[j].t, 3);
  }
}
harvest(lead, null);
chapters.forEach((c, ci) => c.sections.forEach((sec, k) => harvest(sec, ci, k === 0)));

// --- optional: fill gaps in the store first -------------------------------

/*
 * What to ingest: not what the store already refused (ingest-refused.json) or
 * holds as an undated idea; series members ahead of light article links
 * (editors filed them under this subject; a passing link to *Coin* did not).
 */
const REFUSED = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'ingest-refused.json'), 'utf8')); } catch { return {}; } })();
const KNOWN_IDEAS = readIdeas();
const refusedLower = new Set(Object.keys(REFUSED).map((t) => t.toLowerCase()));
const missing = [...mention.entries()]
  .filter(([t]) => !findEntry(t) && !INDEX_TITLE.test(t) && !refusedLower.has(t.toLowerCase()) && !KNOWN_IDEAS.has(t.toLowerCase()))
  .sort((a, b) => (b[1].weight + (b[1].series ? 1.5 : 0)) - (a[1].weight + (a[1].series ? 1.5 : 0)));

/*
 * Where dated events come from.
 *
 * 1. Timeline pages: `events=` in topics.txt, and any "Timeline of …" page a
 *    "Main article:" note points to.
 * 2. Narrative pages, for a topic with no timeline page: the article itself and
 *    the pages its "Main article:" notes point to (*Inca Empire* → *Spanish
 *    conquest of the Inca Empire*, *Inca civil war*…), plus `prose=` pages.
 *    Their dated SENTENCES are mined (ingest --events-prose). They are noisier,
 *    so below they must fall within the topic's era, and they stay off the
 *    timeline until they have a short title in titles.json.
 * Without (2), Kush had 2 events among 70 essentials and the Islamic Golden
 * Age 7 against 56 people.
 */
// In the article's own order: ranked by link count, *Quechua languages* and
// *Inca education* pushed *Spanish conquest of the Inca Empire* out of the top 10.
const hatTargets = OPT.site ? [] : [...mention.entries()].filter(([, m]) => m.hat)
  .sort((a, b) => (a[1].firstChapter ?? 1e9) - (b[1].firstChapter ?? 1e9)).map(([t]) => { try { return decodeURIComponent(String(t)).replace(/_/g, ' '); } catch { return String(t).replace(/_/g, ' '); } });
// Resolved through redirects: the store records the page a timeline really is.
// "Timeline of natural history" is *Timeline of Earth*, and History of Earth
// matched none of its own 253 events.
const rawEventPages = [...new Set([...OPT.events, ...(art.events || []), ...hatTargets.filter((t) => /^timeline of /i.test(t))])];
const evRedir = OPT.site ? new Map() : await resolveRedirects(rawEventPages.filter((p) => !/^https?:\/\//.test(p)));
const eventPages = [...new Set(rawEventPages.map((p) => evRedir.get(p) || p))];
// A Wikipedia timeline is matched by title, another site's by its URL.
const pageKey = (u) => (/^https?:\/\//.test(u) && !/wikipedia\.org/.test(u) ? String(u) : wikiKey(u)).toLowerCase();
const minedFrom = (p) => entries.some((e) => e.origin?.manual && pageKey(e.origin?.wiki) === pageKey(p));
/*
 * Narrative pages are mined when the timeline pages are missing OR thin: Ice
 * ages' *Timeline of glaciation* gives 6 events, Plate tectonics' 12. Decided
 * from what the timeline pages actually yielded, so after they are mined.
 */
const PROSE_BELOW = 40;
/*
 * Series members that are narrative (an era or a happening in the store:
 * "Norman Conquest", "Tudor period") come first: editors filed them under this
 * subject, which a passing hatnote does not say.
 */
const seriesNarrative = [...seriesHeading.keys()].filter((t) => { const e = findEntry(t); return e && ['period', 'event'].includes(auditType(e.id) || entryType(e)); });
const proseCandidates = [...new Set([art.title, ...seriesNarrative.slice(0, 20),
  ...hatTargets.filter((t) => !/^(timeline|list|lists|outline|index|glossary|bibliography) of /i.test(t))])].slice(0, 30);
const eventYield = () => { const keys = new Set(eventPages.map(pageKey)); return entries.filter((e) => e.origin?.manual && keys.has(pageKey(e.origin?.wiki))).length; };
const prosePagesNow = () => OPT.site ? [] : [...new Set([...OPT.prose, ...(eventYield() >= PROSE_BELOW ? [] : proseCandidates)])]
  .filter((p) => !eventPages.some((q) => pageKey(q) === pageKey(p)));
let prosePages = prosePagesNow();
const missingEvents = eventPages.filter((p) => !minedFrom(p));
const missingProse = prosePages.filter((p) => !minedFrom(p));

/*
 * Ideas: what is still missing after ingest is mostly undated (Energy, Wave,
 * Natural selection), which the store refuses. Fetch those as ideas
 * (lib/ideas.mjs): one summary each, no model. Only pages the article leans
 * on: a hatnote, the lead, or more than one mention (any mention, for a site).
 */
async function fetchIdeasFor(){
  entries = readEntries();
  ({ byWiki, byTitle } = indexStore());
  const want = [...mention.entries()]
    .filter(([t, m]) => !findEntry(t) && !INDEX_TITLE.test(t) && (m.hat || m.lead || m.weight >= 1.5 || art.kind === 'site'))
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, 250).map(([t]) => t);
  await ensureIdeas(want);
}

if(OPT.ingest && (missing.length || missingEvents.length || missingProse.length)){
  const list = missing.slice(0, OPT.ingestLimit).map(([t]) => t);
  const run = (a) => spawnSync(process.execPath, [path.join(HERE, 'ingest.mjs'), ...a], { stdio: 'inherit' });
  if(list.length){
    const f = path.join(PATHS.topics, `.${slug}.ingest.txt`);
    fs.writeFileSync(f, list.join('\n') + '\n');
    console.log(`\n  ingesting ${list.length} linked pages missing from the store…`);
    run([`@${f}`, '--domain', domain, '--limit', String(list.length), '--no-build']);
    fs.unlinkSync(f);
  }
  for(const p of missingEvents){
    console.log(`\n  mining events from "${p}"…`);
    run(['--events', p, '--domain', domain, '--no-build']);
  }
  if(missingEvents.length){ entries = readEntries(); prosePages = prosePagesNow(); }
  for(const p of prosePages.filter((x) => !minedFrom(x))){
    console.log(`\n  mining dated sentences from "${p}"…`);
    run(['--events', p, '--events-prose', '--domain', domain, '--no-build']);
  }
  await fetchIdeasFor();
  if(OPT.ingestOnly){ console.log('  ingest only: not placing or building'); process.exit(0); }
  console.log('\n  placing new entries on the atlas…');
  spawnSync(process.execPath, [path.join(HERE, 'classify.mjs')], { stdio: 'inherit' });
  spawnSync(process.execPath, [path.join(HERE, 'atlas.mjs')], { stdio: 'inherit' });
  entries = readEntries();
  ({ byWiki, byTitle } = indexStore());
}

if(OPT.ideas || (OPT.ingest && !missing.length && !missingEvents.length && !missingProse.length)) await fetchIdeasFor();
if(OPT.ingestOnly){ console.log('  ingest only: nothing else to do'); process.exit(0); }

// --- membership ------------------------------------------------------------
const items = new Map();
const fameMax = Math.log1p(Math.max(1, ...entries.map((e) => e.sitelinks || 0)));

const IDEAS = readIdeas();
const NOT_IDEA_PAGE = /\d{3,4}|\bhistory\b|historiography|\b(presidency|administration) of\b|\bby (country|region)\b|\b(in|during) (world war|the (first|second) world war)\b|^(list|timeline|outline|index|glossary) of\b/i;
const ideaEntry = (x) => ({ id: x.id, title: x.title, subtitle: x.subtitle || '', excerpt: x.excerpt || '', image: x.image || '',
  origin: { wiki: x.wiki, dataset: 'ideas' }, start: null, end: null, kind: 'point', idea: true });
for(const [t, m] of mention){
  const e = findEntry(t);
  if(e){ items.set(e.id, { e, m, via: 'link', t }); continue; }
  const x = IDEAS.get(t.toLowerCase());
  if(x && !x.missing && !items.has(x.id)) items.set(x.id, { e: ideaEntry(x), m, via: 'link', t });
}
for(const p of eventPages){
  for(const e of entries){
    if(e.origin?.manual && pageKey(e.origin?.wiki) === pageKey(p) && !items.has(e.id)) items.set(e.id, { e, m: null, via: 'events' });
  }
}
// An absorbed course's mined timeline lines (its "Dateline" pages).
{
  const ids = new Set(ABSORBED.flatMap((a) => a.items.filter((it) => it.via === 'events').map((it) => it.id)));
  if(ids.size) for(const e of entries) if(ids.has(e.id) && !items.has(e.id)) items.set(e.id, { e, m: null, via: 'events', course: true });
}
/*
 * A number in the middle of a sentence is a year when the sentence says so:
 * "in 785", "by 1572", "(c. 530 BC)", "1438–1471". "Around 750 verses" and "a
 * catalogue of 1022 stars" are counts.
 */
function readsAsDate(e){
  const yt = String(e.yearText || '').trim();
  if(/\b(BC|BCE|AD|CE|century|millennium|Ma|ka|ago)\b|^c\.|^\d{1,4}\s*[–-]\s*\d{1,4}$/i.test(yt)) return true;
  const x = String(e.excerpt || '');
  const num = (yt.match(/\d{3,4}/) || [])[0];
  if(!num) return false;
  if(x.startsWith(num) || x.startsWith(yt)) return true;               // a line that opens with its date
  if(!x.includes(num)) return true;                                     // a table row: the date is its own column
  for(const m of x.matchAll(new RegExp(`(^|[^\\d])${num}(?!\\d)`, 'g'))){
    const before = x.slice(Math.max(0, m.index - 14), m.index + m[1].length);
    const after = x.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if(/\b(in|by|from|until|till|since|after|before|during|between|circa|year)\s*$/i.test(before)) return true;
    if(/\b(summer|winter|spring|autumn|end|beginning|start|middle|January|February|March|April|May|June|July|August|September|October|November|December)\s+of\s*$/i.test(before)) return true;
    if(/\(\s*$/.test(before) && /^\s*[)–-]/.test(after)) return true;   // "(1070)", "(994–1064)"
    if(/\b(around|about)\s*$/i.test(before) && !/^\s+[a-z]/.test(after.replace(/^\s+(and|to|or|when|the)\b/, ','))) return true;
  }
  return false;
}

/*
 * Prose events: only inside the topic's era. The era is the topic's own span
 * when the store has one (*Inca Empire* 1438–1572; generous before, for the
 * rise), else the bulk of the article's dated links (Tukey fences). This drops
 * "a Handbook for Travelers in 1868" and "physicists argued in 2007" from the
 * Islamic Golden Age. Small number ranges ("3–7", "170–180") are ages and
 * head-counts, not years.
 */
prosePages = prosePagesNow();
{
  const self = findEntry(art.title);
  let lo, hi;
  if(self?.start != null && self.end != null && self.end > self.start){
    const len = self.end - self.start;
    lo = self.start - Math.min(len, 1000) - 200; hi = self.end + Math.min(0.25 * len, 200) + 50;
  } else {
    const ys = [...items.values()].filter((x) => x.via === 'link' && x.e.start != null).map((x) => x.e.start).sort((a, b) => a - b);
    if(ys.length >= 8){
      const q = (f) => ys[Math.floor(f * (ys.length - 1))];
      const iqr = q(0.75) - q(0.25);
      lo = q(0.25) - 1.5 * iqr; hi = q(0.75) + 1.5 * iqr;
    }
  }
  let kept = 0, dropped = 0;
  for(const p of prosePages){
    for(const e of entries){
      if(!e.origin?.manual || pageKey(e.origin?.wiki) !== pageKey(p) || items.has(e.id)) continue;
      const small = /^\(?\s*\d{1,3}\s*[–-]\s*\d{1,3}\s*\)?$/.test(String(e.yearText).trim()) || !readsAsDate(e);
      const end = e.end ?? e.start;
      if(small || (lo != null && (end < lo || e.start > hi))){ dropped++; continue; }
      items.set(e.id, { e, m: null, via: 'events', prose: true });
      kept++;
    }
  }
  if(prosePages.length) console.log(`  prose events from ${prosePages.length} page${prosePages.length === 1 ? '' : 's'}: ${kept} kept, ${dropped} outside ${lo != null ? `${Math.round(lo)}–${Math.round(hi)}` : 'the era'} or not years`);
}

const taxo = loadTaxonomy();
const out = [...items.values()].map(({ e, m, via, t, prose }) => ({
  id: e.id,
  canon: t || null,
  title: TITLES[e.id] || e.title,
  ...(TITLES[e.id] ? { origTitle: e.title } : {}),
  subtitle: e.subtitle || '',
  yearText: e.yearText || '',
  start: e.start, end: e.end,
  kind: e.kind, circa: !!e.circa, openEnded: !!e.openEnded,
  image: e.image || '',
  excerpt: e.excerpt || '',
  facets: e.facets || {},
  dataset: e.origin?.dataset || '',
  wiki: e.origin?.wiki || '',
  dateSource: e.origin?.dateSource || (e.origin?.manual ? 'mined' : ''),
  // An idea is a concept unless its description says person/place/group.
  // An idea is a concept only if nothing says otherwise: a missing page that
  // is really an event ("Civil Rights Act of 1964", "Battle of Appomattox
  // Court House"; the store just never ingested it) keeps its own type and
  // stays out of Key ideas. It belongs in the store, via --ingest.
  type: e.idea ? (NOT_IDEA_PAGE.test(e.title) ? 'other' : entryType(e)) : (auditType(e.id) || entryType(e)),
  idea: !!e.idea,
  // Known subject + region (classify.mjs) — the topic page's second filter row.
  subject: taxo?.entries?.[e.id]?.mid || '',
  region: taxo?.entries?.[e.id]?.region || '',
  fame: e.sitelinks ? Math.log1p(e.sitelinks) / fameMax : 0,
  via,
  ...(prose ? { prose: true } : {}),
  mentions: m ? m.count : 0,
  weight: m ? m.weight : 0,
  lead: !!m?.lead, hat: !!m?.hat,
  tlOnly: !!m && !m.prose,       // named only at the head of timeline lines
  mentionedIn: m ? [...m.chapters.keys()] : [],
  chapterOfMention: m ? ([...m.chapters].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null,
  sub: m?.firstSub || null,
  ...(m?.series ? { series: m.series } : {}),
  ...(m?.fromChild ? { fromChild: m.fromChild } : {}),
  ...(m?.course ? { course: m.course } : {}),
  // A site topic: what the site's own page about this entry says.
  note: (t && art.notes?.get(t)?.text) || '',
  noteUrl: (t && art.notes?.get(t)?.url) || '',
})).filter((it) => it.start != null || it.idea);

/*
 * A state or period stored as a single year usually states its span in its
 * description: *Soviet Union* "former country in Eurasia (1922–1991)", *Empire
 * of Japan* "empire … from 1868 to 1947". Use it, so it is drawn as the span it
 * was and is judged as an umbrella rather than an event of 1922.
 */
for(const it of out){
  if(it.type !== 'period' || (it.end != null && it.end !== it.start)) continue;
  const m = String(it.subtitle || '').match(/\b(\d{3,4})\s*(?:[–-]|to)\s*(\d{3,4})\b/);
  if(m && +m[1] === it.start && +m[2] > it.start && +m[2] <= new Date().getFullYear()){ it.end = +m[2]; it.kind = 'span'; it.yearText = `${m[1]}-${m[2]}`; }
}

/*
 * A description that is only a name says nothing about a place, group or
 * period: Wikidata's description slot for *Spain* held "Pedro Sánchez" and
 * for *Ontario* "Kathleen Wynne" (the head of government). For a work or a
 * discovery a name is its maker (*SN 1572* — Tycho Brahe) and stays.
 */
{
  const BARE = /^[A-Z][\p{L}'’.-]*( (de|da|von|van|al|bin|ibn|[A-Z][\p{L}'’.-]*)){0,4}$/u;
  for(const it of out) if(['place', 'group', 'period'].includes(it.type) && BARE.test(it.subtitle || '')) it.subtitle = '';
}

// The subject itself is the whole topic, not one of its entries: Cold War had
// four "Cold War" essentials (the store holds it more than once).
{
  const self = new Set([art.title, OPT.name, slug.replace(/-/g, ' ')].filter(Boolean).map((x) => String(x).toLowerCase()));
  for(let i = out.length - 1; i >= 0; i--) if(self.has(String(out[i].title).toLowerCase()) && out[i].via !== 'works') out.splice(i, 1);
}

// Hand corrections: dropped entries are not members at all.
if(OVR.drop.size){
  const before = out.length;
  for(let i = out.length - 1; i >= 0; i--) if(titleIn(OVR.drop, out[i])) out.splice(i, 1);
  console.log(`  overrides: dropped ${before - out.length}`);
}

// A site's timeline page is a chapter: its mined events belong to it.
if(art.kind === 'site'){
  const chOfUrl = new Map(chapters.map((c, i) => [c.sections[0].url, i]));
  for(const it of out) if(it.via === 'events' && chOfUrl.has(it.wiki)) it.chapterOfMention = chOfUrl.get(it.wiki);
}

// Gallery-only places and groups are captions (museums), not members.
for(let i = out.length - 1; i >= 0; i--){
  const m = mention.get(out[i].canon);
  if(m?.galleryOnly && ['place', 'group', 'concept'].includes(out[i].type)) out.splice(i, 1);
}

/*
 * Works by the topic's people. The article links Monet but not the 26 Monets
 * the store holds; an art topic without its paintings cannot show how the art
 * developed, which was the whole point of the old art timeline. Any store entry
 * whose creator facet (artist, director, author, scientist…) names a member
 * person joins, under that person, up to WORKS_PER_PERSON each.
 */
// Artistic creators only. With 'scientist' and 'philosopher' too, Darwin's *The
// Structure and Distribution of Coral Reefs* turned up in Dinosaurs and
// Aristotle's *Nicomachean Ethics* in Geologic time: a scientist's works are
// not what a topic that mentions him is about, a painter's are.
const CREATOR_FACETS = ['artist', 'director', 'author', 'composer', 'creator', 'architect'];
const WORKS_PER_PERSON = 14;
const nameKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\([^)]*\)/g, '').replace(/[^a-z]/g, '');
const people = new Map();
for(const it of out) if(it.type === 'person') people.set(nameKey(it.title), it);
const have = new Set(out.map((it) => it.id));
const worksOf = new Map();
for(const e of entries){
  if(have.has(e.id) || e.start == null) continue;
  for(const f of CREATOR_FACETS){
    const p = e.facets?.[f] && people.get(nameKey(e.facets[f]));
    if(!p) continue;
    (worksOf.get(p.id) || worksOf.set(p.id, []).get(p.id)).push(e);
    break;
  }
}
/*
 * Only works on the topic's own subjects. Aristotle is mentioned in the Galileo
 * lecture; his *Metaphysics* and *Nicomachean Ethics* are not physics. The
 * topic's subjects are the commonest among the article's own links.
 */
const subjCount = new Map();
for(const it of out) if(it.subject) subjCount.set(it.subject, (subjCount.get(it.subject) || 0) + 1);
const topSubjects = new Set([...subjCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s]) => s));
for(const [pid, list] of worksOf){
  const keep = list.filter((e) => { const s = taxo?.entries?.[e.id]?.mid; return !s || topSubjects.has(s); });
  if(keep.length) worksOf.set(pid, keep); else worksOf.delete(pid);
}
let nWorks = 0;
for(const [pid, list] of worksOf){
  const p = out.find((it) => it.id === pid);
  // Spread across the career rather than the first N in file order.
  list.sort((a, b) => a.start - b.start);
  const step = Math.max(1, list.length / WORKS_PER_PERSON);
  const pick = [];
  for(let k = 0; k < list.length && pick.length < WORKS_PER_PERSON; k += step) pick.push(list[Math.floor(k)]);
  for(const e of pick){
    have.add(e.id); nWorks++;
    out.push({
      id: e.id, canon: null, title: e.title, subtitle: e.subtitle || p.title, yearText: e.yearText || '',
      start: e.start, end: e.end, kind: e.kind, circa: !!e.circa, openEnded: !!e.openEnded,
      image: e.image || '', excerpt: e.excerpt || '', facets: e.facets || {}, dataset: e.origin?.dataset || '',
      wiki: e.origin?.wiki || '', dateSource: e.origin?.dateSource || '', type: auditType(e.id) || entryType(e),
      subject: taxo?.entries?.[e.id]?.mid || '', region: taxo?.entries?.[e.id]?.region || '',
      fame: e.sitelinks ? Math.log1p(e.sitelinks) / fameMax : 0,
      via: 'works', by: pid, mentions: 0, weight: 0, lead: false, hat: false,
      mentionedIn: [], chapterOfMention: p.chapterOfMention, sub: p.sub,
    });
  }
}
if(nWorks) console.log(`  + ${nWorks} works by ${worksOf.size} of the topic's people (from the store)`);

/*
 * The content audit (audit-entries.mjs, Claude Haiku; audit.json by hand wins).
 * Types were applied above. Here:
 *   - a date judged wrong is replaced by the audit's year when it gives one far
 *     from the stored one (*On Floating Bodies* stored at 1891, its edition, is
 *     c. 250 BC; the Mesoproterozoic ends 1.0 billion years ago, not in 1 BC);
 *     with no year it is suspect and off the timeline (*Halley's Comet* at 1986);
 *     a year or two out (Newton's Julian birth year) is not wrong;
 *   - relevance to this topic: 'off' is never an essential (the First Punic
 *     War in Physics), 'context' ranks lower.
 */
const AUDIT = readAudit();
const RELEVANCE = AUDIT.topics[slug] || {};
/*
 * What kind of span a period is (audit-entries.mjs --kinds): a state (the
 * States & dynasties track), an era or movement (Eras & movements), or really
 * an event that lasted (Reign of Terror, Reconquista: the Events lane, as a
 * duration). The timeline keeps the three apart.
 */
for(const it of out){
  if(it.type !== 'period') continue;
  const pk = AUDIT.entries[it.id]?.pk;
  if(pk === 'event') it.type = 'event';
  else if(pk) it.periodKind = pk === 'state' ? 'states' : pk === 'era' ? 'eras' : 'other';
}
{
  let fixed = 0, suspect = 0;
  const tolAt = (y) => Math.max(3, 0.05 * (new Date().getFullYear() - y));
  let spans = 0;
  for(const it of out){
    if(it.via === 'events' || it.start == null) continue;
    const a = AUDIT.entries[it.id];
    // A period with no end: the span the audit gave (--spans), when its start
    // agrees with ours. The Akkadian Empire was "2334 BC"; it is 2334–2154 BC.
    if(it.type === 'period' && (it.end == null || it.end === it.start) && Array.isArray(a?.span) && Number.isInteger(a.span[1])){
      let [sy, ey] = a.span;
      if(it.start < 0 && sy > 0 && ey <= sy){ sy = -sy; ey = -ey; }
      if(ey > sy && Math.abs(sy - it.start) <= tolAt(Math.min(sy, it.start))){
        it.end = ey; it.kind = 'span'; it.yearText = ''; it.openEnded = false; it.spanAdded = true; spans++;
        continue;
      }
    }
    if(a?.d !== 'wrong') continue;
    // A ruler's stored span is the reign, on purpose; the model "corrects" it
    // to the life (Puyi 1908–1912 → 1906–1967).
    if(it.dataset === 'leaders') continue;
    if(!Number.isInteger(a.y)){ it.auditWrong = true; suspect++; continue; }
    // The model often drops the minus of a BC year (Demosthenes "384..322"):
    // a stored BC date with a positive, descending or single answer means BC.
    let y = a.y, e = Number.isInteger(a.e) ? a.e : null;
    if(it.start < 0 && y > 0 && (e == null || e <= y)){ y = -y; e = e == null ? null : -e; }
    const startOk = Math.abs(y - it.start) <= tolAt(Math.min(y, it.start));
    const endOk = e == null || it.end == null || Math.abs(e - it.end) <= tolAt(Math.min(e, it.end));
    // Right start, no end stored: the span it gives (Russian Empire 1721 → 1721–1917).
    if(startOk && (it.end == null || it.end === it.start) && e != null && e > it.start && it.type !== 'person' && it.type !== 'place'){
      it.end = e; it.kind = 'span'; it.yearText = ''; it.spanAdded = true; spans++;
      continue;
    }
    if(startOk && endOk) continue;
    a.y = y; a.e = e;
    it.storedYears = it.end != null && it.end !== it.start ? [it.start, it.end] : [it.start];
    it.start = a.y;
    it.end = Number.isInteger(a.e) && a.e > a.y ? a.e : null;
    it.kind = it.end != null ? 'span' : 'point';
    it.openEnded = false;
    it.yearText = '';
    it.dateFixed = true;
    fixed++;
  }
  const rel = Object.values(RELEVANCE);
  if(fixed || suspect || spans || rel.length) console.log(`  audit: ${fixed} dates corrected, ${spans} spans completed, ${suspect} suspect; relevance ${rel.filter((r) => r === 'off').length} off, ${rel.filter((r) => r === 'context').length} context`);
}

// --- chapters & date checks -----------------------------------------------
chapters.forEach((c, ci) => { c.members = out.filter((it) => it.chapterOfMention === ci && it.start != null); });
let chronological = inferRanges(chapters);
for(const c of chapters){
  const y = OVR.chapterYears[c.title];
  if(y){ c.from = y[0]; c.to = y[1]; c.overlaps = false; }
}
/*
 * Dated chapters only make sense if they mostly do not overlap. *History of
 * science* passed the "medians ascend" test but 11 of its 13 chapters ended up
 * overlapping, and *Ancient Egypt*'s "Government and economy" was dated to
 * 665 million BC. Then the article is thematic: chapters stay, dates go.
 */
if(chronological){
  const dated = chapters.filter((c) => c.members.length);
  // Nor if the eras do not run in order: *Aztec Empire* has eight chapters of
  // history, then administration, rulers and law, whose inferred years
  // ("List of rulers" 1299–1524 after "Spanish conquest") go back in time.
  const main = chapters.filter((c) => !c.overlaps && c.from != null);
  const backwards = main.some((c, i) => i > 0 && c.from < main[i - 1].from);
  if(backwards || dated.filter((c) => c.overlaps).length > dated.length * 0.4){
    chronological = false;
    for(const c of chapters){ c.from = c.to = null; c.overlaps = false; }
    console.log(`  chapters ${backwards ? 'go back in time' : 'overlap too much'} to be eras: treating the article as thematic`);
  }
}

const chapterOfYear = (y) => {
  for(let i = chapters.length - 1; i >= 0; i--) if(!chapters[i].overlaps && chapters[i].from != null && y >= chapters[i].from) return i;
  return 0;
};

for(const it of out){
  if(it.start == null){
    // An idea: in the chapter that mentions it most, never on the timeline.
    it.dateSuspect = false; it.chapter = it.chapterOfMention ?? 0; it.onTimeline = false;
    continue;
  }
  if(chronological){
    // Does the stored date fall in (or near) a chapter the article mentions it in?
    // Tolerance scales with the chapter: a 50-year slack is nothing for
    // Prehistory and a lot for "Henry VIII".
    const ok = it.via === 'events' || it.mentionedIn.length === 0 || it.mentionedIn.some((ci) => {
      const c = chapters[ci];
      if(c.from == null) return true;
      // Capped: a quarter of Prehistory is ~20,000 years, which let *Prehistoric
      // Britain* stored at AD 900 pass as prehistoric.
      const tol = Math.min(300, Math.max(30, 0.25 * (c.to - c.from)));
      const lo = Math.min(it.start, it.end ?? it.start), hi = Math.max(it.start, it.end ?? it.start);
      return hi >= c.from - tol && lo <= c.to + tol;
    });
    it.dateSuspect = !ok;
    // The chapter that MENTIONS it, when its date sits in that chapter's range;
    // otherwise the chapter its date falls in. Mention first, because an
    // overlapping chapter ("Formation of Great Britain") owns its members only
    // by mention — by date they all also fall in a neighbour.
    const cm = it.chapterOfMention != null ? chapters[it.chapterOfMention] : null;
    const y = anchorYear(it);
    it.chapter = cm && cm.from != null && y >= cm.from - 5 && y <= cm.to + 5 ? it.chapterOfMention : chapterOfYear(y);
  } else {
    it.dateSuspect = false;
    it.chapter = it.chapterOfMention ?? 0;
  }

  if(it.auditWrong) it.dateSuspect = true;

  // On the timeline: things that happened, dated plausibly. A place or group
  // dated only by prose ("lead-text") is the classic false date. Concepts —
  // languages, overview articles, legal ideas — never.
  it.onTimeline = !it.dateSuspect && it.type !== 'concept' &&
    // A sentence mined from prose shows once it has a short title of its own.
    !(it.prose && !it.origTitle) &&
    !((it.type === 'place' || it.type === 'group') && it.dateSource === 'lead-text') &&
    // An open span stretching to today is not a date (*Catholic Church*).
    !(it.openEnded && it.type !== 'person') &&
    // A person named only by timeline lines: the events are the cards.
    !(it.tlOnly && it.type === 'person');
}

/*
 * A place or group is dated by its founding: Wikidata gives *Iraq* 1932, its
 * independence. Mentioned in "Babylonian" mathematics ("Mesopotamia (modern
 * Iraq)") it put a flag on the timeline and topped the search page for 1932.
 * Chapters with years catch this above; a chapter WITHOUT years (most
 * history-of-a-science articles) is measured by its other dated members.
 * A present-day country far from their middle is not on the timeline.
 */
const PRESENT_STATE = /(^|\|)(sovereign state|country|constituent country of the United Kingdom|transcontinental country|landlocked country)(\||$)/;
{
  const THING = new Set(['place', 'group', 'concept']);
  const era = new Map();
  chapters.forEach((c, ci) => {
    if(c.from != null) return;
    const ys = out.filter((x) => x.chapter === ci && x.onTimeline && !THING.has(x.type)).map(anchorYear).sort((a, b) => a - b);
    if(ys.length < 2) return;
    const q = (f) => ys[Math.min(ys.length - 1, Math.floor(f * ys.length))];
    const mid = ys.length % 2 ? ys[(ys.length - 1) / 2] : (ys[ys.length / 2 - 1] + ys[ys.length / 2]) / 2;
    era.set(ci, { mid, tol: Math.max(150, 0.5 * (q(0.75) - q(0.25))), q1: q(0.25), q3: q(0.75) });
  });
  /*
   * A mined event no chapter mentions went to chapter 0: all 246 events of
   * *Timeline of scientific discoveries* landed in "Approaches to history of
   * science" and none became essential. Without chapter years, it goes to the
   * chapter whose dated members' middle half is nearest its year, narrow
   * chapters preferred.
   */
  if(era.size >= 2){
    let moved = 0;
    for(const it of out){
      if(it.via !== 'events' || it.start == null || (it.chapterOfMention != null && chapters[it.chapterOfMention]?.from != null)) continue;
      if(it.chapterOfMention != null && era.has(it.chapterOfMention)){
        const e = era.get(it.chapterOfMention);
        if(Math.abs(anchorYear(it) - e.mid) <= e.tol) continue;
      }
      const y = anchorYear(it);
      // Distance outside the chapter's middle half, plus a tenth of its width:
      // a broad chapter ("Approaches to history of science") spans every year
      // and would otherwise take everything near a narrow one's edge.
      let best = null, bestS = Infinity;
      for(const [ci, e] of era){
        const sc = (y < e.q1 ? e.q1 - y : y > e.q3 ? y - e.q3 : 0) + 0.1 * (e.q3 - e.q1);
        if(sc < bestS){ bestS = sc; best = ci; }
      }
      if(best != null && best !== it.chapter){ it.chapter = best; moved++; }
    }
    if(moved) console.log(`  ${moved} mined events placed in the chapter of their era`);
  }
  let off = 0;
  for(const it of out){
    if(!it.onTimeline || (it.type !== 'place' && it.type !== 'group') || it.via === 'events') continue;
    // Only a present-day country: its date is the modern state's founding.
    // A university, an ancient city or a historical country is dated by what
    // made it matter, and a thin chapter's median is too rough to overrule it
    // (it took Babylonia off the Babylonian chapter).
    if(!PRESENT_STATE.test([].concat(it.facets?.instanceOf || []).join('|'))) continue;
    const e = era.get(it.chapter);
    if(e && Math.abs(anchorYear(it) - e.mid) > e.tol){ it.onTimeline = false; it.dateSuspect = true; off++; }
  }
  if(off) console.log(`  ${off} present-day countr${off === 1 ? 'y' : 'ies'} off the timeline: dated far from their chapter's era`);
}

/*
 * Mined events, made readable at a glance.
 *
 * 1. One card per happening. "Battle of Bosworth Field" mined from the timeline
 *    page and the article's own link to *Battle of Bosworth Field* are the same
 *    thing a year apart at most: the linked entry stays (it has a picture and a
 *    lead) and takes the mined line as its sentence if it had none.
 * 2. A picture. A mined line has none; it borrows the picture of the member it
 *    is about, the longest title it names ("Birth of Henry VIII" → Henry VIII,
 *    "Blaise Pascal, a French mathematician…" → Pascal), and links to it.
 */
{
  const words = (t) => new Set(String(t).toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|of|in|at|on|for|with|first|second)$/.test(w)));
  const sim = (a, b) => { const A = words(a), B = words(b); if(!A.size || !B.size) return 0; let n = 0; for(const w of A) if(B.has(w)) n++; return n / Math.min(A.size, B.size); };
  const linkedEvents = out.filter((it) => it.via === 'link' && it.onTimeline && (it.type === 'event' || it.type === 'work'));
  // Pairs judged the same happening by dedupe-events.mjs (lib/dupes.mjs).
  const DUP_PAIRS = readDupes();
  const firstLine = (it) => String(it.excerpt || '').split(/(?<=[.!?])\s+(?=[A-Z0-9])/)[0] || '';
  let merged = 0;
  for(let i = out.length - 1; i >= 0; i--){
    const ev = out[i];
    if(ev.via !== 'events') continue;
    const twin = linkedEvents.find((L) => Math.abs(L.start - ev.start) <= 1 && (sim(L.title, ev.title) >= 0.75 || DUP_PAIRS[pairKey(L, ev)] === true));
    if(twin){
      if(!twin.context) twin.context = firstLine(ev);
      out.splice(i, 1); merged++;
    }
  }
  const named = out.filter((it) => it.via !== 'events' && it.title.replace(/\s*\(.*\)$/, '').length >= 5)
    // Case-sensitive: names are capitalised, and "the mercury falls" in a
    // barometer experiment is not the planet Mercury.
    .map((it) => ({ it, re: new RegExp(`\\b${it.title.replace(/\s*\(.*\)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u') }))
    .sort((a, b) => b.it.title.length - a.it.title.length);
  let lent = 0;
  for(const ev of out){
    if(ev.via !== 'events') continue;
    const text = `${ev.title} ${firstLine(ev)}`;
    const hit = named.find(({ it, re }) => it.image && re.test(text));
    if(hit){
      ev.about = hit.it.id;
      if(!ev.image){ ev.image = hit.it.image; ev.imageFrom = hit.it.id; lent++; }
    }
  }
  if(merged || lent) console.log(`  mined events: ${merged} merged into the article's own entries, ${lent} given the picture of what they are about`);
}

// --- in-context sentence & related entries ------------------------------------
const idOfCanon = new Map(out.filter((it) => it.canon).map((it) => [it.canon, it.id]));
const relatable = new Set(out.filter((it) => it.onTimeline && it.type !== 'concept').map((it) => it.id));
for(const it of out){
  const co = it.canon ? cooc.get(it.canon) : null;
  // Only things worth stepping to: on the timeline, not a concept ("Latin").
  it.related = co ? [...co].map(([t, w]) => [idOfCanon.get(t), w]).filter(([id]) => id && id !== it.id && relatable.has(id))
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id) : [];
}

// --- importance & key selection --------------------------------------------
// Periods are already drawn as the chapter bands, so in the KEY set they yield to
// what happened and who did it.
const POLITY = /\b(country|state|empire|kingdom|republic|monarchy|federation|union|confederation|principality|caliphate|sultanate)\b/i;
const TYPE_W = { event: 1, person: 0.9, period: 0.6, work: 0.75, place: 0.5, group: 0.5, concept: 0.3 };

/*
 * Corroboration: a page the article links once but the timeline page ALSO names
 * is more central than its link count says. *Battle of Hastings* is linked once
 * in "History of England" prose (the article says "Norman Conquest") and ranked
 * 34th in its chapter; *Timeline of English history* names it outright.
 */
const mined = out.filter((it) => it.via === 'events').map((it) => `${it.title} ${it.excerpt}`.toLowerCase());
if(mined.length){
  for(const it of out){
    if(it.via !== 'link') continue;
    const t = it.title.toLowerCase().replace(/\s*\(.*\)$/, '');
    if(t.length < 6) continue;
    const hits = mined.filter((m) => m.includes(t)).length;
    // A title that appears in a large share of the events is a word, not a
    // corroboration: "England" is in 115 of 154 rows of Timeline of English history.
    if(hits > mined.length * 0.08) continue;
    it.corroborated = hits;
    it.weight += Math.min(3, hits) * 1.5;
  }
}

/*
 * Unknown fame is not zero fame. Entries from the old CSVs (Elizabeth I, Edward
 * I, Vespasian) have no Wikidata id, so no sitelink count; scoring them 0 left
 * Elizabeth I out of Key while Francis Drake was in. Give them the median.
 */
const knownFame = out.filter((it) => it.via === 'link' && it.fame > 0).map((it) => it.fame).sort((a, b) => a - b);
const medFame = knownFame[Math.floor(knownFame.length / 2)] || 0.5;
for(const it of out) if(it.via === 'link' && !it.fame){ it.fame = medFame; it.fameGuessed = true; }

const maxW = Math.max(1, ...out.map((it) => it.weight));
/*
 * A mined event's worth: what kind of happening it is, and how much the
 * article cares about what it is about. A battle, a treaty, an invention or a
 * founding is history; "Birth of Henry VI" is a line in a genealogy (his own
 * card covers it). Was a flat 0.32, so England's 154 mined events gave 4 of its
 * 92 essentials, against 44 people.
 */
const NOTABLE = /\b(battle|war|treaty|peace|revolution|revolt|rebellion|uprising|invasion|invades|conquest|conquers|siege|massacre|founded|founds|founding|established|invent\w*|discover\w*|experiment|theory|law|act|charter|constitution|crowned|coronation|becomes (king|queen|emperor|president|prime minister|shogun)|assassinat\w*|executed|execution|independence|union|abolish\w*|annex\w*|surrender\w*|armistice|earthquake|eruption|plague|famine|epidemic|pandemic|first|publishes?|opens?|reform\w*|restoration|unification|reunif\w*)\b/i;
function minedBase(it){
  const text = `${it.title} ${String(it.excerpt || '').slice(0, 200)}`;
  let b = 0.3;
  if(NOTABLE.test(it.title) || NOTABLE.test(text.slice(0, 160))) b += 0.16;
  if(/^(birth of|death of)\b|\bis born\b/i.test(it.title)) b *= 0.4;
  const about = it.about && out.find((x) => x.id === it.about);
  if(about) b += 0.25 * Math.min(1, (about.weight || 0) / Math.max(1, maxW) * 3 + (about.fame || 0) * 0.5);
  return Math.min(0.75, b);
}
for(const it of out){
  const mention = Math.log1p(it.weight) / Math.log1p(maxW) + (it.hat ? 0.25 : 0) + (it.lead ? 0.15 : 0);
  // A mined event has no links and no QID; its signal is that an editor put it
  // in a curated timeline. A flat middling score, so it fills a chapter the
  // article is thin on without displacing the article's own headline links.
  const base = it.via === 'events' ? minedBase(it) : 0.5 * mention + 0.35 * it.fame;
  let imp = base * (0.55 + 0.45 * (TYPE_W[it.type] ?? 0.5));
  /*
   * Umbrella penalty: an entry whose span dwarfs its chapter is context for the
   * chapter, not an event in it — *Prehistoric Britain* or *England in the High
   * Middle Ages* inside "Anglo-Saxon period". They are famous and heavily
   * linked, so without this they take the key slots that should go to what
   * happened. People are exempt: a long life is not an umbrella.
   */
  const ch = chapters[it.chapter];
  if(ch?.from != null && it.type !== 'person' && it.end != null){
    const len = Math.abs(it.end - it.start), chLen = Math.max(20, ch.to - ch.from);
    if(len > 1.5 * chLen) imp *= 0.55;
  }
  // A state stored with only its founding year is an umbrella too, just one
  // whose length we do not know: *British Empire* (1583) and *Soviet Union*
  // (1922) were essentials of World War II's "Start and end dates".
  if(it.type === 'period' && it.end == null && !it.hat && POLITY.test(it.subtitle)) imp *= 0.55;
  const rel = it.via === 'events' ? 'core' : RELEVANCE[it.id];
  if(rel === 'context') imp *= 0.8;
  else if(rel === 'off'){ imp *= 0.5; it.offTopic = true; }
  it.importance = +imp.toFixed(4);
}
// A creator's works rank just under the creator: the best known two can be
// essentials (so the default timeline of an art topic shows paintings), the
// rest sit in Everything.
const byWorks = new Map();
for(const it of out) if(it.via === 'works') (byWorks.get(it.by) || byWorks.set(it.by, []).get(it.by)).push(it);
for(const [pid, list] of byWorks){
  const p = out.find((x) => x.id === pid);
  list.sort((a, b) => (b.fame - a.fame) || (String(b.excerpt).length - String(a.excerpt).length));
  list.forEach((it, k) => { it.importance = +((p?.importance || 0.3) * (k < 2 ? 0.92 : 0.45)).toFixed(4); });
}

/*
 * One card per happening, among mined events too. Related-article mining finds
 * the same event on several pages: Pizarro reaching Peru three times, "Spain
 * licenses Pizarro to conquer Peru" next to "Pizarro receives royal approval".
 * Pairs judged the same by dedupe-events.mjs (lib/dupes.mjs) merge; a pair not
 * yet judged only when its titles are nearly identical. The survivor is the
 * timeline-page line over a prose sentence, then the more important; it keeps
 * the other's sentence and picture if it has none.
 */
{
  const DUP = readDupes();
  const ev = out.filter((it) => it.via === 'events' && it.onTimeline);
  const parent = new Map(ev.map((it) => [it.id, it.id]));
  const find = (x) => { while(parent.get(x) !== x){ parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for(const [a, b] of dupCandidates(ev)){
    const v = DUP[pairKey(a, b)];
    if(v === true || (v === undefined && jaccard(a.title, b.title) >= 0.6)) parent.set(find(a.id), find(b.id));
  }
  const groups = new Map();
  for(const it of ev) (groups.get(find(it.id)) || groups.set(find(it.id), []).get(find(it.id))).push(it);
  const gone = new Set();
  for(const g of groups.values()){
    if(g.length < 2) continue;
    g.sort((a, b) => (!!a.prose - !!b.prose) || (b.importance - a.importance) || (!!b.image - !!a.image));
    const [keep, ...rest] = g;
    for(const r of rest){
      if(!keep.excerpt && r.excerpt) keep.excerpt = r.excerpt;
      if(!keep.image && r.image){ keep.image = r.image; if(r.imageFrom) keep.imageFrom = r.imageFrom; }
      if(!keep.about && r.about) keep.about = r.about;
      keep.importance = Math.max(keep.importance, r.importance);
      gone.add(r.id);
    }
    // Told on several pages: a little more central.
    keep.importance = +Math.min(1, keep.importance * (1 + 0.1 * rest.length)).toFixed(4);
    keep.alsoTold = rest.length;
  }
  if(gone.size){
    for(let i = out.length - 1; i >= 0; i--) if(gone.has(out[i].id)) out.splice(i, 1);
    console.log(`  mined events: ${gone.size} duplicates merged`);
  }
}

/*
 * Context: the best-scoring sentence in the entry's own chapter; else in the
 * chapter that mentions it most; else anywhere in the body; else the lead.
 * Most important first, and no two entries of a chapter share a sentence:
 * "There were renewed Scandinavian attacks…" links both Cnut and the Norman
 * Conquest, and read twice in a row it says nothing about the second.
 */
const proseParas = (sec) => (sec?.paras || []).filter((p) => p.tag === 'p');
const topicIntro = OVR.intro || cleanIntro(opening(proseParas(lead), 700));
const chIntro = chapters.map((c) => OVR.chapterIntro[c.title] || cleanIntro(c.sections.map((x) => opening(proseParas(x), 650)).find(Boolean) || ''));
const usedCtx = new Map();   // chapter -> Set of texts
for(const it of [...out].sort((a, b) => b.importance - a.importance)){
  const used = usedCtx.get(it.chapter) || usedCtx.set(it.chapter, new Set()).get(it.chapter);
  // Not a sentence the reader has just read as the chapter's (or the topic's)
  // intro: "Anglo-Saxon settlement" repeated the Anglo-Saxon intro word for word.
  const raw = it.canon ? contexts.get(it.canon) || [] : [];
  const list = raw.filter((c) => !used.has(c.text) && !repeats(c.text, chIntro[it.chapter]) && !repeats(c.text, topicIntro));
  // Told only in the intro: Learn shows its own Wikipedia first line instead,
  // which adds to the intro rather than repeating it.
  if(!list.length && raw.length) it.inIntro = true;
  const best = (f) => list.filter(f).sort((a, b) => b.score - a.score)[0];
  const pick = best((c) => c.ch === it.chapter) || best((c) => c.ch === it.chapterOfMention) || best((c) => c.ch != null) || best(() => true);
  it.context = pick?.text || '';
  if(pick){ it.sub = pick.sub || null; used.add(pick.text); }
  // A collection's entry that its article never tells (Africa's essentials from
  // Nigeria or Ethiopia): the subtopic's sentence, marked as from there.
  else if(it.canon && childContext.has(it.canon) && !used.has(childContext.get(it.canon).text)){
    const cc = childContext.get(it.canon);
    it.context = cc.text; it.contextFrom = cc.slug; it.inIntro = false; used.add(cc.text);
  }
  /*
   * An entry the article never puts in a sentence of its own makes a poor
   * essential: Learn can only show its generic Wikipedia lead ("A world war is
   * an international conflict…"). It yields its slot to one the article tells.
   */
  if(!it.context && !it.inIntro && it.via === 'link') it.importance = +(it.importance * 0.7).toFixed(4);
}

// Key events: proportional to each chapter's share, at least 4 per chapter, so
// a thin chapter still reads and the Tudors do not crowd out the Anglo-Saxons.
const onTl = out.filter((it) => it.onTimeline);
const byCh = new Map();
for(const it of onTl) (byCh.get(it.chapter) || byCh.set(it.chapter, []).get(it.chapter)).push(it);
for(const [, arr] of byCh){
  arr.sort((a, b) => b.importance - a.importance);
  const quota = Math.max(4, Math.round(OPT.key * arr.length / Math.max(1, onTl.length)));
  /*
   * Places, groups and concepts are context, not things that happened. They
   * took Key slots on fame alone: *Greater Manchester*, *Merseyside* and the
   * *European Union* were all Key in England because the lead mentions them.
   * They stay Key only when a section is ABOUT them (a "Main article" hatnote).
   */
  if(OVR.noKeyChapters.has(String(chapters[arr[0].chapter]?.title).toLowerCase())){ arr.forEach((it) => { it.key = false; }); continue; }
  const eligible = arr.filter((it) => (!['place', 'group', 'concept'].includes(it.type) || it.hat) && !it.offTopic && !titleIn(OVR.unkey, it));
  // A chapter of nothing but places ("Legacy") still gets its best two.
  if(!eligible.length) eligible.push(...arr.filter((it) => !it.offTopic && !titleIn(OVR.unkey, it)).slice(0, 2));
  /*
   * What happened comes first: at least half of a chapter's essentials are
   * events when it has them, and people at most 40%. Reading down a timeline
   * should be a sequence of things that happened, with the people among them.
   */
  const isEv = (it) => it.type === 'event' && !/^(birth|death) of\b/i.test(it.title);
  const picked = eligible.filter(isEv).slice(0, Math.ceil(quota * 0.5));
  const personCap = Math.ceil(quota * 0.4);
  let persons = 0;
  for(const it of eligible){
    if(picked.length >= quota) break;
    if(picked.includes(it)) continue;
    if(it.type === 'person'){ if(persons >= personCap) continue; persons++; }
    picked.push(it);
  }
  // Not enough of anything else: fill with the people after all.
  for(const it of eligible){ if(picked.length >= quota) break; if(!picked.includes(it)) picked.push(it); }
  const keyIds = new Set(picked.map((it) => it.id));
  arr.forEach((it) => { it.key = keyIds.has(it.id); });
}
for(const it of out) if(!it.onTimeline) it.key = false;
for(const it of out){
  if(titleIn(OVR.unkey, it)) it.key = false;
  if(titleIn(OVR.key, it) && it.start != null){ it.key = true; it.onTimeline = true; }
}

/*
 * Key ideas: the concepts a chapter is about (Conservation of energy, Boyle's
 * law, Natural selection), dated or not. Shown in Learn above the chapter's
 * entries and asked in the quiz's Ideas mode. Not languages, offices,
 * countries, foods, institutions or publications, which the prose links in
 * passing ("the Pope", "Latin", "a Twinkie"). It needs a sentence in the
 * article and more than a passing mention: a hatnote, two or more mentions, or
 * a title that shares a word with its chapter's.
 */
const NOT_IDEA = /\b(language|dialect|country|city|town|village|capital|snack|food|dish|cuisine|beverage|drink|brand|company|corporation|manufacturer|university|college|school|academy|institute|museum|library|title|office|position|rank|religio\w*|church|denomination|nationality|ethnic|ethnonym|demonym|sport|award|prize|newspaper|journal|magazine|periodical|television|film|song|album|band|dam|bridge|river|mountain|island|lake|sea|ocean|continent|region|province|county|district|surname|given name|family name|website|encyclopedia|dictionary|novel|painting|holiday|festival|calendar|month|day of|currency|awards?|prizes?|society|organi[sz]ation|association|agency|party|army|navy|air force|government|dynasty|empire|kingdom|nation|sovereign state|people|tribe|family|house|missile|weapon|aircraft|tank|rifle|gun|ship|vessel|submarine|bomber|fighter|warship)\b/i;
const wordsOf = (x) => new Set(String(x).toLowerCase().match(/[a-z]{4,}/g) || []);
// Shared title words, ignoring generic ones ("law", "theory"): how strongly a
// chapter is ABOUT an idea. "Newton's laws of motion" shares 2 with "Newton's
// Laws" and 1 with "Newton".
const GENERIC_W = new Set(['law', 'laws', 'theory', 'principle', 'effect', 'history', 'with', 'from', 'that', 'this', 'their', 'into', 'about']);
const shares = (it, ci) => {
  const cw = [...wordsOf(chapters[ci]?.title || '')].map((w) => w.replace(/s$/, ''));
  const iw = [...wordsOf(it.title)].map((w) => w.replace(/s$/, ''));
  const n = iw.filter((w) => cw.includes(w)).length;
  return iw.some((w) => cw.includes(w) && !GENERIC_W.has(w) && !GENERIC_W.has(w + 's')) ? n : 0;
};
const NOT_IDEA_TITLE = /\b(society|university|college|institute|academy|museum|company|party|church|school|journal|prize|award)\b/i;
const ideaCands = out.filter((it) => it.type === 'concept' && !it.onTimeline && it.via === 'link' &&
  !/^(history|list|timeline|outline|index|glossary) of\b/i.test(it.title) && !NOT_IDEA.test(it.subtitle || '') &&
  !NOT_IDEA_TITLE.test(it.title) && !titleIn(OVR.unkey, it) && (it.context || it.inIntro || it.idea));
for(const it of ideaCands){
  // The lecture an idea is named after is its chapter, even if another one
  // mentions it more ("Newton's laws of motion" belongs to "Newton's Laws").
  const own = (it.mentionedIn || []).map((ci) => [ci, shares(it, ci)]).filter(([, n]) => n).sort((a, b) => b[1] - a[1])[0];
  if(own) it.chapter = own[0];
  else if(it.mentionedIn?.length && !it.mentionedIn.includes(it.chapter)) it.chapter = it.chapterOfMention ?? it.mentionedIn[0];
  const share = shares(it, it.chapter) > 0;
  it.isIdea = true;
  it.ideaScore = (it.hat ? 3 : 0) + Math.min(4, it.weight) + (share ? 2 : 0) + (it.context ? 1 : 0);
  // A dated store entry typed "concept" is often a mistyped person, country or
  // award with no description: it must be named by its chapter or a hatnote.
  // A description that is just a name ("Robert Boyle") is a creator, not a
  // description, and says nothing either way.
  const described = it.subtitle && !/^[A-Z][\w'’.-]*( [A-Z][\w'’.-]*){0,3}$/.test(it.subtitle);
  if(!it.idea && !(it.hat || share || (described && it.weight >= 2))) it.ideaScore = 0;
  // In a chronological history the timeline carries what happened; a dated
  // "concept" there is usually a mistyped event or institution. Only genuine
  // ideas (undated) and what a section is about (a hatnote) count.
  if(chronological && !it.idea) it.ideaScore = 0;
}
const byChIdea = new Map();
for(const it of ideaCands) if(it.ideaScore >= 3) (byChIdea.get(it.chapter) || byChIdea.set(it.chapter, []).get(it.chapter)).push(it);
for(const [, arr] of byChIdea){
  arr.sort((a, b) => b.ideaScore - a.ideaScore || b.importance - a.importance);
  arr.slice(0, 6).forEach((it) => { it.keyIdea = true; });
}
for(const it of out) if(titleIn(OVR.key, it) && it.start == null){ it.isIdea = true; it.keyIdea = true; }
// An idea moved to the chapter named after it may now share its sentence
// with an entry there: the entry keeps it, the idea shows its definition.
{
  const used = new Map();
  for(const it of out) if(!it.isIdea && it.context) (used.get(it.chapter) || used.set(it.chapter, new Set()).get(it.chapter)).add(it.context);
  for(const it of out){
    if(!it.isIdea || !it.context) continue;
    const u = used.get(it.chapter) || used.set(it.chapter, new Set()).get(it.chapter);
    if(u.has(it.context)) it.context = ''; else u.add(it.context);
  }
}
const nIdeas = out.filter((it) => it.keyIdea).length;
if(nIdeas) console.log(`  ${nIdeas} key ideas (${out.filter((it) => it.idea).length} undated ideas in the topic)`);

// --- chapter output -----------------------------------------------------------
const PALETTE = ['#8a6d3b', '#a0522d', '#6b8e23', '#2f6f73', '#4a6fa5', '#7b5ea7', '#a3477a', '#b5543c', '#5b7c3a', '#3d6e8f', '#8c6239', '#566573'];
/*
 * Key points: a short summary per chapter (and one for the topic), written for
 * this site and kept in datasets/topic-notes/<slug>.json so a rebuild never
 * loses them: { "topic": [..], "chapters": { "<chapter title>": [..] } }.
 * A chapter whose title changed simply has none until the notes are updated;
 * topic-report.mjs lists those.
 */
let NOTES = { topic: [], chapters: {} };
try { NOTES = { topic: [], chapters: {}, ...JSON.parse(fs.readFileSync(path.join(HERE, 'topic-notes', `${slug}.json`), 'utf8')) }; } catch {}
// Titles compared with whitespace normalised: the article's "c. 3150" has a thin space.
const normT = (t) => String(t).replace(/\s+/gu, ' ').trim().toLowerCase();
const notesByTitle = new Map(Object.entries(NOTES.chapters || {}).map(([k, v]) => [normT(k), v]));
const notesFor = (t) => notesByTitle.get(normT(t)) || [];
const chOut = chapters.map((c, i) => ({
  id: i,
  title: c.title,
  // The chapter's own opening, from the article: the narrative that the
  // entries hang off. If the heading goes straight into a subsection, that
  // subsection's opening stands in.
  intro: chIntro[i],
  subsections: c.sections.slice(1).map((sec) => ({ title: sec.title, intro: cleanIntro(opening(proseParas(sec), 280)) })),
  parent: c.parent || null,
  points: notesFor(c.title),
  from: c.from ?? null,
  to: c.to ?? null,
  overlaps: !!c.overlaps,
  color: PALETTE[i % PALETTE.length],
  count: out.filter((it) => it.chapter === i && it.onTimeline).length,
  key: out.filter((it) => it.chapter === i && it.key).length,
}));

out.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.importance - a.importance);

/*
 * The shelf on the topic list. From --group when the list gives one, else the
 * commonest known subject among the key entries ("Visual arts", "Military and
 * warfare"), with chronological "History of X" articles shelved as History.
 */
const guessGroup = () => {
  if(chronological && /^history of /i.test(art.title)) return 'History';
  const c = new Map();
  for(const it of out) if(it.key && it.subject) c.set(it.subject, (c.get(it.subject) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other';
};

const topic = {
  slug,
  group: OPT.group || guessGroup(),
  title: OPT.name || art.title,
  source: art.kind === 'site'
    ? { kind: 'site', page: art.title, url: art.url, credit: art.credit, hint: OPT.hint || null }
    : { page: art.title, url: `${WP}/wiki/${encodeURIComponent(art.title.replace(/ /g, '_'))}` },
  events: OPT.events,
  keyTarget: OPT.key,
  built: new Date().toISOString().slice(0, 10),
  chronological,
  // A site's index page is often all housekeeping: then the first chapter's
  // opening is the better start.
  intro: topicIntro || chIntro.find(Boolean) || '',
  blurb: OVR.blurb || null,
  points: NOTES.topic || [],
  // The topic tree (topic-structure.json) and where members came from.
  parent: STRUCT.parent || null,
  role: STRUCT.role || null,
  absorbedInto: absorberOf(slug),
  series: SERIES.map((s) => ({ name: s.name, title: s.title, kind: s.kind,
    groups: s.groups.filter((g) => !LOCAL_GROUP.test(g.heading)).map((g) => ({ heading: g.heading, n: g.titles.length })) })),
  // An absorbed course (Ideas of Physics): its own chapters and what each one
  // covers, read as a second path through the topic on Learn.
  courses: ABSORBED.map((a) => {
    const have = new Set(out.map((it) => it.id));
    return { slug: a.slug, title: a.title, credit: a.source?.credit || '', url: a.source?.url || '', intro: a.intro || '',
      chapters: a.chapters.map((c) => ({ title: c.title, intro: c.intro || '', points: c.points || [],
        ids: a.items.filter((it) => it.chapter === c.id && (it.key || it.keyIdea) && have.has(it.id)).map((it) => it.id) })) };
  }),
  chapters: chOut,
  items: out,
};

fs.writeFileSync(path.join(PATHS.topics, `${slug}.json`), JSON.stringify(topic) + '\n');
updateIndex(topic);
updateMembers(topic);
updateAll(topic);
writeLite({ entries, taxo });
// One topic on its own: refresh web/ now. In a batch (--all, --list) the parent does it once at the end.
if(!process.env.TOPIC_BATCH) buildWeb();

// --- report ---------------------------------------------------------------------
const n = (f) => out.filter(f).length;
console.log(`\n  ${topic.title}  ->  datasets/topics/${slug}.json`);
console.log(`  ${out.length} members (${n((it) => it.via === 'link')} linked, ${n((it) => it.via === 'events')} mined events)` +
            ` · ${n((it) => it.onTimeline)} on the timeline · ${n((it) => it.key)} key`);
console.log(`  off the timeline: ${n((it) => it.dateSuspect)} date doesn't fit where the article mentions it, ` +
            `${n((it) => !it.dateSuspect && !it.onTimeline)} not datable things (places, concepts…)`);
console.log(`  ${chronological ? 'chronological' : 'thematic'} chapters:`);
for(const c of chOut) console.log(`    ${String(c.from ?? '').padStart(7)} – ${String(c.to ?? '').padEnd(6)} ${c.title.padEnd(48)} ${String(c.count).padStart(4)} (${c.key} key)`);
if(missing.length && !OPT.ingest){
  console.log(`\n  ${missing.length} linked pages are not in the store, e.g.: ${missing.slice(0, 10).map(([t]) => t).join(', ')}`);
  console.log(`  add them with --ingest (embeds only the new rows, throttled)`);
}
const sus = out.filter((it) => it.dateSuspect).slice(0, 8);
if(sus.length) console.log(`\n  sample date mismatches: ${sus.map((it) => `${it.title} [${it.yearText}]`).join(', ')}`);

// ---------------------------------------------------------------------------

function readIndex(){
  try { return JSON.parse(fs.readFileSync(path.join(PATHS.topics, 'index.json'), 'utf8')); }
  catch { return { topics: [] }; }
}

function updateIndex(t){
  const idx = readIndex();
  const cover = t.items.filter((it) => it.key && it.image).sort((a, b) => b.importance - a.importance)[0]?.image || '';
  const row = {
    slug: t.slug, title: t.title, group: t.group, source: t.source, events: t.events, keyTarget: t.keyTarget,
    blurb: t.blurb || (t.intro || '').split(/(?<=[.!?])\s/)[0].slice(0, 220),
    built: t.built, count: t.items.filter((it) => it.onTimeline).length, key: t.items.filter((it) => it.key).length,
    chapters: t.chapters.length,
    ...spanOf(t), cover,
    ...(t.parent ? { parent: t.parent } : {}),
    ...(t.role ? { role: t.role } : {}),
    ...(t.absorbedInto ? { absorbedInto: t.absorbedInto } : {}),
    ...(t.series?.length ? { series: t.series.map((s) => s.title || s.name) } : {}),
  };
  idx.topics = [...idx.topics.filter((x) => x.slug !== t.slug), row].sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(PATHS.topics, 'index.json'), JSON.stringify(idx, null, 1) + '\n');
}

/**
 * The years a topic is about, for the topic list. From its ESSENTIALS, minus
 * the oldest and newest few: one Palaeolithic link made England read
 * "4,000,000 BC – 2026", and Ancient Egypt's geology chapter made it
 * "71,000,000 BC". Rounded the way a person would say it.
 */
function spanOf(t){
  const key = t.items.filter((it) => it.key && it.onTimeline);
  const pool = key.length >= 10 ? key : t.items.filter((it) => it.onTimeline);
  // A person counts from their working life, not their birth (Roosevelt, born
  // 1882, made the Cold War start in 1882).
  const lo = pool.map((it) => (it.type === 'person' && it.end != null ? Math.round(it.start + 0.6 * (it.end - it.start)) : it.start)).sort((a, b) => a - b);
  const hi = pool.map((it) => Math.min(new Date().getFullYear(), it.end ?? it.start)).sort((a, b) => a - b);
  const cut = Math.floor(pool.length * 0.04);
  const round = (y, dir) => {
    const a = Math.abs(y);
    if(a < 3000) return y;
    const unit = 10 ** (Math.floor(Math.log10(a)) - 1);     // two significant figures
    return Math.sign(y) * (dir < 0 === y < 0 ? Math.ceil(a / unit) : Math.floor(a / unit)) * unit;
  };
  // A chronological article says where it starts: its first chapter (England's
  // Prehistory). A thematic one starts where most of its essentials do.
  const first = t.chronological ? t.chapters.find((c) => c.from != null)?.from : null;
  return { from: first != null ? round(first, -1) : lo.length ? round(lo[cut], -1) : null, to: hi.length ? round(hi[hi.length - 1 - cut], 1) : null };
}

/**
 * topics/all.json: every timeline entry of every topic, small enough for a
 * phone. The detail panel's "Meanwhile" (what the OTHER topics were doing in
 * the same years) and the cross-topic quiz and review read it; neither needs
 * the full topic files.
 */
function updateAll(t){
  const f = path.join(PATHS.topics, 'all.json');
  let all = { topics: {}, items: [] };
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  all.items = all.items.filter((r) => r.x !== t.slug);
  delete all.topics[t.slug];
  // An absorbed topic lives on inside its absorber: not a topic of its own here.
  if(t.absorbedInto){ fs.writeFileSync(f, JSON.stringify(all) + '\n'); return; }
  all.topics[t.slug] = { title: t.title, group: t.group, chapters: t.chapters.map((c) => [c.title, c.color]) };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s; };
  for(const it of t.items){
    if(it.keyIdea){
      // An idea: no date; its definition (the lead's first sentence) is the quiz prompt.
      const r = { x: t.slug, id: it.id, t: it.title, ch: it.chapter, ty: it.type, i: 1, key: 1 };
      if(it.image) r.im = it.image;
      r.c = clip(it.context || it.note || it.excerpt, 260);
      r.def = clip(String(it.excerpt || '').split(/(?<=[.!?])\s/)[0], 300);
      all.items.push(r);
      continue;
    }
    if(!it.onTimeline) continue;
    const r = { x: t.slug, id: it.id, t: it.title, s: it.start, ch: it.chapter, ty: it.type };
    if(it.end != null && it.end !== it.start) r.e = it.end;
    if(it.yearText) r.y = it.yearText;
    if(it.kind === 'span') r.k = 1;
    if(it.dataset === 'leaders') r.d = 'leaders';
    if(it.key) r.key = 1;
    if(it.image) r.im = it.image;
    const c = it.context || it.note || '';
    r.c = clip(c || it.excerpt, 260);
    all.items.push(r);
  }
  // Drop topics that no longer exist (renamed or deleted).
  const live = new Set(readIndex().topics.map((x) => x.slug));
  for(const s of Object.keys(all.topics)) if(!live.has(s)){ delete all.topics[s]; all.items = all.items.filter((r) => r.x !== s); }
  fs.writeFileSync(f, JSON.stringify(all) + '\n');
}

/**
 * topics/members.json: entry id -> the topics it is on the timeline of, for
 * entries in two or more. members-all.json is the same for every entry; the
 * atlas loads it for its Topic filter. The detail panel's "Also in" line: Napoleon in France
 * links to the same card in the other topics that cover him.
 */
function updateMembers(t){
  const f = path.join(PATHS.topics, 'members-all.json');     // every entry: merging, and the atlas's topic filter
  let all = {};
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for(const id of Object.keys(all)){
    all[id] = all[id].filter((s) => s !== t.slug);
    if(!all[id].length) delete all[id];
  }
  if(!t.absorbedInto) for(const it of t.items) if(it.onTimeline) (all[it.id] ||= []).push(t.slug);
  const multi = Object.fromEntries(Object.entries(all).filter(([, v]) => v.length > 1));
  fs.writeFileSync(f, JSON.stringify(all) + '\n');
  fs.writeFileSync(path.join(PATHS.topics, 'members.json'), JSON.stringify(multi) + '\n');
}
