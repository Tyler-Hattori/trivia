/**
 * Read a website that is not Wikipedia: a course, a set of essays, any site
 * shaped as an index page linking to pages of prose. `topic.mjs --site <url>`
 * turns it into a topic; the site supplies the structure and the narrative,
 * Wikipedia supplies each entry's dates, image and lead (resolved here).
 *
 *   index page      -> the topic: its title, its opening prose, and its
 *                      same-directory links IN ORDER as the chapters
 *   chapter page    -> a chapter: its paragraphs, and the links inside them
 *   linked subpage  -> an entry candidate: "copernicus.html" titled
 *                      "Phyx 103-0, Copernicus" names Copernicus; its opening
 *                      becomes the entry's note from the site
 *   timeline page   -> lines that start with a year ("1814 - Joseph Fraunhofer…")
 *                      become dated events (mineEventsFrom), and a leading
 *                      "Name, a …" becomes a person candidate
 *   PDF             -> text via `pdftotext` when it is installed, else skipped
 *
 * Polite by default: one request at a time, SITE_GAP_MS apart (400 ms).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { USER_AGENT, getJSON, sleep, titleSim } from './wikilib.mjs';
import { mineEventsFrom } from './wiki.mjs';

const WP = 'https://en.wikipedia.org';
const GAP = Number(process.env.SITE_GAP_MS || 400);
let last = 0;

export const decode = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/gi, ' ').replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—')
  .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&rdquo;|&ldquo;/gi, '"').replace(/&eacute;/gi, 'é')
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

/** GET one page, politely. Returns { url, html } or { url, text } for a PDF, or null. */
export async function fetchPage(url){
  const wait = last + GAP - Date.now();
  if(wait > 0) await sleep(wait);
  last = Date.now();
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' }); }
  catch { return null; }
  if(!res.ok) return null;
  if(/\.pdf($|\?)/i.test(url) || /pdf/i.test(res.headers.get('content-type') || '')){
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    return text == null ? { url, pdf: true, text: null } : { url, pdf: true, text };
  }
  // Old sites are often Latin-1; decode as such when the page says so.
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.slice(0, 2000).toString('latin1');
  const latin = /charset=(iso-8859-1|windows-1252)/i.test(head + (res.headers.get('content-type') || ''));
  return { url: res.url || url, html: buf.toString(latin ? 'latin1' : 'utf8') };
}

let havePdftotext = null;
function pdfText(buf){
  if(havePdftotext === false) return null;
  const f = path.join(os.tmpdir(), `site-${process.pid}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(f, buf);
    const out = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    havePdftotext = true;
    return out;
  } catch { havePdftotext = false; return null; }
  finally { try { fs.unlinkSync(f); } catch {} }
}

export const titleOf = (html) => decode((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());

/** Strip what is never content. */
export function cleanHtml(html){
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, '');
}

/**
 * The page cut into paragraph-sized chunks of HTML. Old sites put prose in
 * table cells separated by <br><br> as often as in <p>, so every block-level
 * boundary counts.
 */
export function chunks(html){
  return cleanHtml(html)
    .replace(/<\/?(p|li|td|th|tr|div|blockquote|h[1-6]|ul|ol|table|dd|dt|center)\b[^>]*>/gi, '\u0000')
    .replace(/(<br\s*\/?>\s*){2,}/gi, '\u0000')
    .split('\u0000')
    .map((x) => x.trim())
    .filter((x) => x.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0);
}

/** Plain text, one line per block. What the event miner reads. */
export function textOf(html){
  const lines = chunks(html).map((c) => decode(c.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A year alone in its cell, the event in the next ("1645" / "Otto von
  // Guericke… invents"): one dated line, as a timeline reads.
  const out = [];
  for(let i = 0; i < lines.length; i++){
    if(/^(?:c\.\s*)?\d{1,4}(?:\s*(?:BC|BCE|AD|CE))?$/.test(lines[i]) && lines[i + 1] && !/^\d/.test(lines[i + 1])){
      out.push(`${lines[i]} - ${lines[i + 1]}`); i++;
    } else out.push(lines[i]);
  }
  // "1645 Otto von Guericke, Mayor of…": a line that opens with a bare year
  // and a capital is a dated line too; give it the separator the miner reads.
  return out.map((l) => l.replace(/^((?:c\.\s*)?\d{3,4}(?:\s*(?:BC|BCE|AD|CE))?)\s+(?=\p{Lu})/u, '$1 - ')).join('\n');
}

/** Every link on a page: { href (absolute), text }, in document order. */
export function linksOf(html, base){
  const out = [];
  for(const m of cleanHtml(html).matchAll(/<a\s[^>]*?href\s*=\s*["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/gi)){
    let href;
    try { href = new URL(decode(m[1]), base).href.replace(/#.*$/, ''); } catch { continue; }
    out.push({ href, text: decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const dirOf = (u) => u.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
const isPage = (u) => /\.(html?|php|aspx?|pdf)$/i.test(u.replace(/[#?].*$/, '')) || /\/$/.test(u);
const sameSite = (u, dir) => u.startsWith(dir);

/** Lines that open with a year: "1814 - …", "c. 450 BC: …", "1905 – …". */
const DATED_LINE = /^\s*(?:c\.\s*|ca\.\s*)?\d{1,4}(?:\s*(?:BC|BCE|AD|CE))?(?:\s*[-–—/]\s*\d{1,4})?\s*(?:[-–—:]|\s{2,})/;
export const isTimelineText = (text) => String(text).split('\n').filter((l) => DATED_LINE.test(l)).length >= 8;

/**
 * Titles across one site usually share a prefix ("Phyx 103-0, Copernicus",
 * "Phyx 103-0, Galileo"). Strip the longest one that most titles share.
 */
export function titleStripper(titles){
  const cands = new Map();
  for(const t of titles){
    const m = t.match(/^(.{3,40}?[,:|–—-])\s+/);
    if(m) cands.set(m[1], (cands.get(m[1]) || 0) + 1);
  }
  const prefixes = [...cands].filter(([, n]) => n >= Math.max(2, titles.length * 0.25)).map(([p]) => p);
  return (t) => {
    let s = t;
    for(const p of prefixes) if(s.startsWith(p)) s = s.slice(p.length).trim();
    // A family of prefixes ("Phyx 103-0," and "Phyx 103,"): strip the shared stem too.
    s = s.replace(/^[A-Za-z]{2,6}\s?\d{2,4}(-\d)?\s*[,:]\s*/, '');
    return s.trim();
  };
}

/**
 * Read the whole site. Returns
 *   { title, url, intro, chapters: [{ title, url, html, text, pdf, timeline, missing }],
 *     subpages: Map(url -> { title, html, text }), strip }
 */
export async function readSite(indexUrl, { maxSubpages = 250, log = console.log } = {}){
  const index = await fetchPage(indexUrl);
  if(!index?.html) throw new Error(`could not fetch ${indexUrl}`);
  const dir = dirOf(index.url);
  const seen = new Set([index.url.replace(/#.*$/, '')]);
  const chapters = [];
  for(const l of linksOf(index.html, index.url)){
    if(!sameSite(l.href, dir) || !isPage(l.href) || seen.has(l.href) || !l.text) continue;
    seen.add(l.href);
    chapters.push({ title: l.text, url: l.href });
  }
  log(`  ${titleOf(index.html) || indexUrl}: ${chapters.length} chapters linked from the index`);

  for(const c of chapters){
    const p = await fetchPage(c.url);
    if(!p){ c.missing = true; continue; }
    if(p.pdf){ c.pdf = true; c.text = p.text; c.html = p.text ? p.text.split(/\n\s*\n/).map((x) => `<p>${x.replace(/</g, '&lt;')}</p>`).join('\n') : ''; if(!p.text) c.missing = true; }
    else { c.html = p.html; c.text = textOf(p.html); }
    c.timeline = !!c.text && isTimelineText(c.text);
  }
  const skipped = chapters.filter((c) => c.missing);
  if(skipped.length) log(`  could not read ${skipped.length}: ${skipped.map((c) => c.title + (c.pdf ? ' (PDF; install poppler for pdftotext)' : '')).join(', ')}`);

  // Subpages: same-site pages linked from chapters that are not chapters themselves.
  const subUrls = [];
  for(const c of chapters) if(c.html) for(const l of linksOf(c.html, c.url)){
    if(sameSite(l.href, dir) && isPage(l.href) && !/\.pdf$/i.test(l.href) && !seen.has(l.href)){ seen.add(l.href); subUrls.push(l.href); }
  }
  const subpages = new Map();
  for(const u of subUrls.slice(0, maxSubpages)){
    const p = await fetchPage(u);
    if(p?.html) subpages.set(u, { title: titleOf(p.html), html: p.html, text: textOf(p.html) });
  }
  log(`  ${subpages.size} linked subpages read${subUrls.length > maxSubpages ? ` (of ${subUrls.length}; --max-subpages)` : ''}`);

  const strip = titleStripper([...chapters.map((c) => titleOf(c.html || '')), ...[...subpages.values()].map((s) => s.title)].filter(Boolean));
  const introText = textOf(index.html).split('\n').filter((l) => l.length > 120).slice(0, 2).join('\n\n');
  return { title: strip(titleOf(index.html)) || titleOf(index.html), url: index.url, intro: introText, chapters, subpages, strip, dir };
}

// ---------------------------------------------------------------------------
// Names -> Wikipedia
// ---------------------------------------------------------------------------

const resolved = new Map();

/** Exact title (after redirects), not a disambiguation page. */
async function exact(name){
  const d = await getJSON(`${WP}/w/api.php?format=json&formatversion=2&action=query&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(name)}`);
  const p = d?.query?.pages?.[0];
  if(!p || p.missing || p.invalid || p.pageprops?.disambiguation != null) return null;
  return p.title;
}

/**
 * The Wikipedia article for a name used on the site, or null. In order of
 * trust: the exact title; for a proper noun only (so "shape" never becomes
 * *Shape*); then a search with the topic's hint ("Kepler physics"), kept only
 * when the hit's title is close to the name.
 */
export async function toWikipedia(names, { hint = '', exactOnly = false } = {}){
  const list = [...new Set(names.map((n) => String(n || '').replace(/\s+/g, ' ').trim()).filter((n) => n.length > 2 && n.length < 80))];
  for(const n of list){
    const key = `${n}|${hint}`;
    if(resolved.has(key)) return resolved.get(key);
  }
  for(const n of list){
    if(!/^\p{Lu}/u.test(n)) continue;
    const t = await exact(n);
    if(t){ for(const m of list) resolved.set(`${m}|${hint}`, t); return t; }
  }
  if(exactOnly) return null;
  for(const n of list){
    if(!/^\p{Lu}/u.test(n)) continue;
    const d = await getJSON(`${WP}/w/api.php?format=json&formatversion=2&action=query&list=search&srlimit=3&srsearch=${encodeURIComponent(`${n} ${hint}`.trim())}`);
    for(const h of d?.query?.search || []){
      // "Copernicus" -> "Nicolaus Copernicus": the name is contained in the hit,
      // or the two are close by titleSim. Anything else is a guess.
      const close = h.title.toLowerCase().includes(n.toLowerCase()) || titleSim(n, h.title) >= 0.6;
      if(close && !/\(disambiguation\)$/.test(h.title)){ for(const m of list) resolved.set(`${m}|${hint}`, h.title); return h.title; }
    }
  }
  for(const m of list) resolved.set(`${m}|${hint}`, null);
  return null;
}

/**
 * A timeline line's subject: "1814 - Joseph Fraunhofer, a German lens-maker…"
 * names Joseph Fraunhofer. Two to four capitalised words before a comma.
 */
export function leadingName(line){
  const body = String(line).replace(DATED_LINE, '').trim();
  const m = body.match(/^((?:\p{Lu}[\p{L}.'’-]+)(?:\s+(?:de|da|di|van|von|der|den|la|le|du)?\s*\p{Lu}[\p{L}.'’-]+){1,3})\s*,/u);
  return m ? m[1] : null;
}

/** `ingest.mjs --events <url>` for a page that is not Wikipedia. */
export async function mineSitePage(url, opts = {}){
  const p = await fetchPage(url);
  if(!p?.html && !p?.text) return null;
  const body = p.html ? textOf(p.html) : p.text;
  return mineEventsFrom({ title: titleOf(p.html || '') || url, url, body, html: '' }, opts);
}

// ---------------------------------------------------------------------------
// Names in unlinked prose
// ---------------------------------------------------------------------------

const STOP_START = /^(The|A|An|In|On|At|By|For|From|Of|To|And|But|Or|If|When|While|After|Before|Since|This|That|These|Those|It|He|She|They|We|You|I|His|Her|Their|Our|However|Although|Because|So|Then|Thus|Here|There|What|Which|Who|Why|How|As|Now|Even|Also|One|Two|Three|Many|Most|Some|All|Each|Every|No|Not|Yes|Mr|Mrs|Dr|Professor|Sir|Saint|St|Chapter|Figure|Table|Note|See|Click|Return|Lecture|Phyx|Physics)$/;

/**
 * A gazetteer from the store, for sites that do not link their names (most
 * do not; Wikipedia is the exception). Full titles of Wikipedia-backed
 * entries, plus a person's surname when one person clearly owns it: "Newton"
 * is Isaac Newton (his sitelinks dwarf any other Newton), "Thomson" is nobody
 * (J. J. and William are too close to call).
 */
export function gazetteer(entries, typeOf){
  const full = new Map(), surname = new Map();
  for(const e of entries){
    const wiki = e.origin?.wiki;
    if(!wiki || e.origin?.manual || !/wikipedia\.org\/wiki\//.test(wiki)) continue;
    const t = decodeURIComponent(wiki.replace(/^.*\/wiki\//, '')).replace(/_/g, ' ');
    const plain = t.replace(/\s*\([^)]*\)$/, '');
    const fame = e.sitelinks || 0;
    if(plain.split(' ').length >= 2 || /^\p{Lu}[\p{Ll}]{3,}$/u.test(plain)){
      const k = plain.toLowerCase();
      if(!full.has(k) || full.get(k).fame < fame) full.set(k, { title: t, fame });
    }
    if(typeOf(e) === 'person'){
      const last = plain.split(' ').pop();
      if(last.length >= 4 && /^\p{Lu}/u.test(last)) (surname.get(last) || surname.set(last, []).get(last)).push({ title: t, fame });
    }
  }
  const sur = new Map();
  for(const [k, list] of surname){
    list.sort((a, b) => b.fame - a.fame);
    if(list.length === 1 || list[0].fame >= 2 * Math.max(1, list[1].fame)) sur.set(k, list[0].title);
  }
  return { full, sur };
}

/**
 * Names in a paragraph: [{ name, at, len, title? }]. Known names come back with
 * their Wikipedia title; unknown capitalised 2–3-word phrases come back without,
 * for the caller to try as exact titles.
 */
export function namesIn(text, gaz, common = null){
  const out = [];
  /*
   * A ONE-word match is the risky kind: "More recently…" became Thomas More,
   * "the Church" Alonzo Church, "Nature" the journal. So a single word is not a
   * name at the start of a sentence (where every word is capitalised), nor when
   * the same site also writes it in lower case (`common`: "more", "church",
   * "nature"), which says it is an ordinary word there.
   */
  const oneWordOk = (word, at) => {
    const before = text.slice(0, at).trimEnd();
    if(!before || /[.!?:;"“”(\-–—]$/.test(before)) return false;
    return !(common && common.has(word.toLowerCase()));
  };
  // A word is capitalised; a full stop belongs to it only as an initial ("J."),
  // so "…Galilei. Edmond Halley" is two names, not one.
  const W = String.raw`\p{Lu}(?:\.|[\p{L}'’-]*)`;
  const re = new RegExp(`${W}(?:\\s+(?:de|da|di|van|von|der|den|la|le|du|of)?\\s*${W}){0,3}`, 'gu');
  for(const m of text.matchAll(re)){
    let words = m[0].split(/\s+/);
    let at = m.index;
    while(words.length && STOP_START.test(words[0].replace(/[.'’]+$/, ''))){ at += words[0].length + 1; words = words.slice(1); }
    if(!words.length) continue;
    // Longest known run first: "James Clerk Maxwell" before "Maxwell".
    let hit = null;
    for(let n = words.length; n >= 1 && !hit; n--){
      for(let i = 0; i + n <= words.length && !hit; i++){
        const phrase = words.slice(i, i + n).join(' ').replace(/[.'’]+$/, '');
        const off = text.indexOf(phrase, at);
        if(n === 1 && !oneWordOk(phrase, off < 0 ? at : off)) continue;
        const f = gaz.full.get(phrase.toLowerCase());
        const t = f?.title || (n === 1 ? gaz.sur.get(phrase) : null);
        if(t){
          hit = { name: phrase, at: off < 0 ? at : off, len: phrase.length, title: t };
        }
      }
    }
    if(hit) out.push(hit);
    else if(words.length >= 2 && words.length <= 3) out.push({ name: words.join(' ').replace(/[.'’]+$/, ''), at, len: words.join(' ').length });
  }
  return out;
}
