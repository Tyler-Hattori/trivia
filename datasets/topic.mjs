#!/usr/bin/env node
/**
 * Build a TOPIC: one subject (e.g. "History of England") turned into a clean,
 * chaptered timeline and a quiz pool, from one Wikipedia article plus the store.
 *
 *     node datasets/topic.mjs "History of England"
 *     node datasets/topic.mjs "History of England" --events "Timeline of English history"
 *     node datasets/topic.mjs "History of England" --ingest          # fill gaps first
 *     node datasets/topic.mjs --all                                  # rebuild every topic
 *
 * Flags
 *     --name "England"        display name (default: the article title)
 *     --events <page>         also include events mined from this page. Repeatable
 *     --ingest                ingest linked pages / event pages missing from the
 *                             store before building (embeds new rows, throttled)
 *     --ingest-limit N        cap on linked pages ingested (default 250)
 *     --key N                 roughly how many entries "Key events" shows (default 90)
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
import { loadTaxonomy } from './lib/taxotree.mjs';
import { getJSON } from './lib/wikilib.mjs';
import { INDEX_TITLE } from './lib/wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WP = 'https://en.wikipedia.org';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const args = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const flagValues = new Set(['--name', '--events', '--ingest-limit', '--key'].flatMap((f) => args(f)));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && flagValues.has(a)));

const OPT = {
  page: positional[0],
  name: arg('--name'),
  events: args('--events'),
  ingest: argv.includes('--ingest'),
  ingestLimit: Number(arg('--ingest-limit', 250)),
  key: Number(arg('--key', 90)),
  all: argv.includes('--all'),
};

fs.mkdirSync(PATHS.topics, { recursive: true });

if(OPT.all){
  const idx = readIndex();
  for(const t of idx.topics){
    const a = [path.join(HERE, 'topic.mjs'), t.source.page, '--name', t.title, '--key', String(t.keyTarget || 90)];
    for(const ev of t.events || []) a.push('--events', ev);
    spawnSync(process.execPath, a, { stdio: 'inherit' });
  }
  process.exit(0);
}
if(!OPT.page){
  console.error('usage: node datasets/topic.mjs "History of England" [--events "Timeline of English history"] [--ingest]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. The article: sections and the links inside each
// ---------------------------------------------------------------------------

/** Sections that are apparatus, not history. Everything from the first of these on is dropped. */
const STOP_SECTIONS = /^(see also|references|notes|citations|sources|further reading|external links|bibliography|footnotes|historiography|primary sources|works cited|explanatory notes|general and cited references)$/i;

async function fetchArticle(page){
  const u = `${WP}/w/api.php?action=parse&format=json&formatversion=2&redirects=1&prop=text&page=${encodeURIComponent(page)}`;
  const d = await getJSON(u);
  if(!d?.parse) throw new Error(`could not fetch "${page}" from Wikipedia`);
  return { title: d.parse.title, html: d.parse.text };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\[\d+\]/g, '').trim();

/**
 * Split the article into sections and harvest links per section.
 *
 * Links are taken only from prose (`<p>`, `<li>`) and from "Main article:"
 * hatnotes. Tables, infoboxes, navboxes and reference lists are skipped: they
 * link to everything (every monarch, every county) and would make membership
 * mean "appears anywhere on the page".
 */
function parseSections(html){
  // References inside prose link to sources, not subjects.
  html = html.replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/g, '');
  const parts = html.split(/(<div class="mw-heading mw-heading[234]"[^>]*>[\s\S]*?<\/h[234]>)/);
  const sections = [{ level: 1, title: '(lead)', body: parts[0] }];
  for(let i = 1; i < parts.length; i += 2){
    const m = parts[i].match(/mw-heading([234])[\s\S]*?<h[234][^>]*>([\s\S]*?)<\/h[234]>/);
    sections.push({ level: Number(m[1]), title: stripTags(m[2]), body: parts[i + 1] || '' });
  }
  const stop = sections.findIndex((s) => s.level === 2 && STOP_SECTIONS.test(s.title));
  const kept = stop > 0 ? sections.slice(0, stop) : sections;

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
    s.links = s.links.filter((l) => !/^[A-Z][a-z]+( talk)?:/.test(l.target) || /^[A-Z][a-z]+:[^ ]/.test(l.target) === false);
    s.links = s.links.filter((l) => !/^(File|Category|Help|Wikipedia|Template|Portal|Special|Talk):/i.test(l.target));
  }
  return kept;
}

/**
 * Group sections into chapters: each level-2 heading is a chapter, its level-3
 * and -4 headings are its subsections. The lead is not a chapter; its links are
 * credited as "mentioned in the lead".
 */
function chaptersFrom(sections){
  const chapters = [];
  let cur = null;
  for(const s of sections){
    if(s.title === '(lead)') continue;
    if(s.level === 2){ cur = { title: s.title, subsections: [], sections: [s] }; chapters.push(cur); }
    else if(cur){ cur.subsections.push(s.title); cur.sections.push(s); }
  }
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

console.log(`\n  fetching "${OPT.page}"…`);
const art = await fetchArticle(OPT.page);
const sections = parseSections(art.html);
const chapters = chaptersFrom(sections);
const lead = sections[0];
console.log(`  ${art.title}: ${chapters.length} chapters, ${sections.reduce((s, x) => s + x.links.length, 0)} prose links`);

const allTargets = sections.flatMap((s) => s.links.map((l) => l.target));
const redirects = await resolveRedirects(allTargets);
const canon = (t) => redirects.get(t) || t;

// Per canonical title: weighted mentions, which chapters/subsections, lead mention.
const mention = new Map();
const credit = (t, w, ch, sub, hat) => {
  let m = mention.get(t);
  if(!m) mention.set(t, (m = { weight: 0, count: 0, lead: false, hat: false, chapters: new Map(), firstChapter: ch, firstSub: sub }));
  m.weight += w; m.count++;
  if(hat) m.hat = true;
  if(ch == null) m.lead = true;
  else m.chapters.set(ch, (m.chapters.get(ch) || 0) + w);
  if(m.firstChapter == null && ch != null){ m.firstChapter = ch; m.firstSub = sub; }
};
for(const l of lead.links) credit(canon(l.target), 2, null, null, false);
chapters.forEach((c, ci) => {
  for(const s of c.sections) for(const l of s.links) credit(canon(l.target), l.weight, ci, s.level === 2 ? null : s.title, l.hat);
});
mention.delete(art.title);   // the article linking to itself

// --- optional: fill gaps in the store first -------------------------------
const slug = slugify(OPT.name || art.title);
const domain = slug;
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

const missing = [...mention.entries()]
  .filter(([t]) => !findEntry(t) && !INDEX_TITLE.test(t))
  .sort((a, b) => b[1].weight - a[1].weight);

const eventPages = OPT.events;
const missingEvents = eventPages.filter((p) => !entries.some((e) => wikiKey(e.origin?.wiki).toLowerCase() === p.toLowerCase() && e.origin?.manual));

if(OPT.ingest && (missing.length || missingEvents.length)){
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
  console.log('\n  placing new entries on the atlas…');
  spawnSync(process.execPath, [path.join(HERE, 'atlas.mjs')], { stdio: 'inherit' });
  entries = readEntries();
  ({ byWiki, byTitle } = indexStore());
}

// --- membership ------------------------------------------------------------
const items = new Map();
const fameMax = Math.log1p(Math.max(1, ...entries.map((e) => e.sitelinks || 0)));

for(const [t, m] of mention){
  const e = findEntry(t);
  if(!e) continue;
  items.set(e.id, { e, m, via: 'link' });
}
for(const p of eventPages){
  for(const e of entries){
    if(e.origin?.manual && wikiKey(e.origin?.wiki).toLowerCase() === p.toLowerCase() && !items.has(e.id)) items.set(e.id, { e, m: null, via: 'events' });
  }
}

const taxo = loadTaxonomy();
const out = [...items.values()].map(({ e, m, via }) => ({
  id: e.id,
  title: e.title,
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
  type: entryType(e),
  // Known subject + region (classify.mjs) — the topic page's second filter row.
  subject: taxo?.entries?.[e.id]?.mid || '',
  region: taxo?.entries?.[e.id]?.region || '',
  fame: e.sitelinks ? Math.log1p(e.sitelinks) / fameMax : 0,
  via,
  mentions: m ? m.count : 0,
  weight: m ? m.weight : 0,
  lead: !!m?.lead, hat: !!m?.hat,
  mentionedIn: m ? [...m.chapters.keys()] : [],
  chapterOfMention: m ? ([...m.chapters].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null,
  sub: m?.firstSub || null,
})).filter((it) => it.start != null);

// --- chapters & date checks -----------------------------------------------
chapters.forEach((c, ci) => { c.members = out.filter((it) => it.chapterOfMention === ci); });
const chronological = inferRanges(chapters);

const chapterOfYear = (y) => {
  for(let i = chapters.length - 1; i >= 0; i--) if(!chapters[i].overlaps && chapters[i].from != null && y >= chapters[i].from) return i;
  return 0;
};

for(const it of out){
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

  // On the timeline: things that happened, dated plausibly. A place or group
  // dated only by prose ("lead-text") is the classic false date. Concepts —
  // languages, overview articles, legal ideas — never.
  it.onTimeline = !it.dateSuspect && it.type !== 'concept' &&
    !((it.type === 'place' || it.type === 'group') && it.dateSource === 'lead-text') &&
    // An open span stretching to today is not a date (*Catholic Church*).
    !(it.openEnded && it.type !== 'person');
}

// --- importance & key selection --------------------------------------------
// Periods are already drawn as the chapter bands, so in the KEY set they yield to
// what happened and who did it.
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

const maxW = Math.max(1, ...out.map((it) => it.weight));
for(const it of out){
  const mention = Math.log1p(it.weight) / Math.log1p(maxW) + (it.hat ? 0.25 : 0) + (it.lead ? 0.15 : 0);
  // A mined event has no links and no QID; its signal is that an editor put it
  // in a curated timeline. A flat middling score, so it fills a chapter the
  // article is thin on without displacing the article's own headline links.
  const base = it.via === 'events' ? 0.32 : 0.5 * mention + 0.35 * it.fame;
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
  it.importance = +imp.toFixed(4);
}

// Key events: proportional to each chapter's share, at least 4 per chapter, so
// a thin chapter still reads and the Tudors do not crowd out the Anglo-Saxons.
const onTl = out.filter((it) => it.onTimeline);
const byCh = new Map();
for(const it of onTl) (byCh.get(it.chapter) || byCh.set(it.chapter, []).get(it.chapter)).push(it);
for(const [, arr] of byCh){
  arr.sort((a, b) => b.importance - a.importance);
  const quota = Math.max(4, Math.round(OPT.key * arr.length / Math.max(1, onTl.length)));
  arr.forEach((it, k) => { it.key = k < quota; });
}
for(const it of out) if(!it.onTimeline) it.key = false;

// --- chapter output -----------------------------------------------------------
const PALETTE = ['#8a6d3b', '#a0522d', '#6b8e23', '#2f6f73', '#4a6fa5', '#7b5ea7', '#a3477a', '#b5543c', '#5b7c3a', '#3d6e8f', '#8c6239', '#566573'];
const chOut = chapters.map((c, i) => ({
  id: i,
  title: c.title,
  subsections: c.subsections,
  from: c.from ?? null,
  to: c.to ?? null,
  overlaps: !!c.overlaps,
  color: PALETTE[i % PALETTE.length],
  count: out.filter((it) => it.chapter === i && it.onTimeline).length,
  key: out.filter((it) => it.chapter === i && it.key).length,
}));

out.sort((a, b) => a.start - b.start || b.importance - a.importance);

const topic = {
  slug,
  title: OPT.name || art.title,
  source: { page: art.title, url: `${WP}/wiki/${encodeURIComponent(art.title.replace(/ /g, '_'))}` },
  events: eventPages,
  keyTarget: OPT.key,
  built: new Date().toISOString().slice(0, 10),
  chronological,
  chapters: chOut,
  items: out,
};

fs.writeFileSync(path.join(PATHS.topics, `${slug}.json`), JSON.stringify(topic) + '\n');
updateIndex(topic);

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
    slug: t.slug, title: t.title, source: t.source, events: t.events, keyTarget: t.keyTarget,
    built: t.built, count: t.items.filter((it) => it.onTimeline).length, key: t.items.filter((it) => it.key).length,
    chapters: t.chapters.length, from: Math.min(...t.items.filter((it) => it.onTimeline).map((it) => it.start)),
    to: Math.max(...t.items.filter((it) => it.onTimeline).map((it) => it.end ?? it.start)), cover,
  };
  idx.topics = [...idx.topics.filter((x) => x.slug !== t.slug), row].sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(PATHS.topics, 'index.json'), JSON.stringify(idx, null, 1) + '\n');
}
