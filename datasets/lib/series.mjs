/**
 * Wikipedia's own organisation of a subject: SERIES.
 *
 * "Part of a series on the History of England" is a sidebar template that
 * editors curate: 131 articles under headings (Timeline, Topics, Polities…),
 * shown on 116 pages. A navbox (the box at the foot of an article) is the same
 * thing for subjects without a sidebar: *History of physics* (85 articles
 * under Classical physics, Modern physics…). Both are better membership than
 * guessing from links: they are bounded, curated, and say which page heads the
 * series.
 *
 *   seriesOf(article)   the sidebars and navboxes an article carries, judged
 *   seriesMembers(tpl)  { title, kind, groups: [{ heading, titles }] }
 *
 * Results are cached in datasets/series-cache.json (templates change rarely;
 * delete an entry to refetch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJSON } from './wikilib.mjs';
import { INDEX_TITLE } from './wiki.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(HERE, '..', 'series-cache.json');
const API = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2';

let cache = null;
const load = () => (cache ||= fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : { pages: {}, templates: {} });
const save = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0) + '\n');

/*
 * Boxes on every page of a kind, not a subject: "Region history sidebar title"
 * (on 5,375 pages), "Library resources box", sister-project links. Also the
 * campaign/military boxes, which list battles of one war, not a subject.
 */
const META = /^(region history sidebar title|library resources box|wiki(quote|books|versity|voyage|source\w*|species|data)|sister ?project|portal|authority control|taxonbar|subinfobox|campaignbox|military navigation|navboxes|country topics|.* topic$|topictoc-|events leading to)/i;
const GENERIC_ON = 2000;   // shown on more pages than this: a frame, not a series

async function all(params){
  const out = [];
  let cont = {};
  for(let guard = 0; guard < 30; guard++){
    const d = await getJSON(`${API}&${new URLSearchParams({ ...params, ...cont })}`);
    if(!d) break;
    out.push(d);
    if(!d.continue) break;
    cont = d.continue;
  }
  return out;
}

/** Templates (namespace 10) used on a page, after redirects. */
async function templatesOn(page){
  const c = load();
  if(c.pages[page]) return c.pages[page];
  const ts = [];
  let title = page;
  for(const d of await all({ action: 'query', prop: 'templates', titles: page, tlnamespace: 10, tllimit: 'max', redirects: 1 })){
    for(const p of d.query?.pages || []){ title = p.title; ts.push(...(p.templates || []).map((t) => t.title.replace(/^Template:/, ''))); }
  }
  c.pages[page] = { title, templates: [...new Set(ts)] };
  save();
  return c.pages[page];
}

/** Kind (sidebar | navbox | null), non-hidden categories and how many articles show it. */
async function templateInfo(names){
  const c = load();
  const need = names.filter((n) => !c.templates[n]?.info);
  for(let i = 0; i < need.length; i += 50){
    const chunk = need.slice(i, i + 50);
    for(const d of await all({ action: 'query', prop: 'categories', titles: chunk.map((n) => `Template:${n}`).join('|'), cllimit: 'max', clshow: '!hidden' })){
      for(const p of d.query?.pages || []){
        const n = p.title.replace(/^Template:/, '');
        const t = (c.templates[n] ||= {});
        t.cats = [...new Set([...(t.cats || []), ...(p.categories || []).map((x) => x.title.replace(/^Category:/, ''))])];
      }
    }
    for(const n of chunk){
      const t = (c.templates[n] ||= {});
      const cs = (t.cats || []).join(' ').toLowerCase();
      t.kind = /sidebar/.test(cs) ? 'sidebar' : /navigational box|navbox/.test(cs) ? 'navbox' : null;
      t.info = true;
    }
  }
  // Transclusions only for real candidates (one request each, capped at 500).
  for(const n of names){
    const t = c.templates[n];
    if(!t.kind || META.test(n) || t.on != null) continue;
    const d = await getJSON(`${API}&${new URLSearchParams({ action: 'query', list: 'embeddedin', eititle: `Template:${n}`, einamespace: 0, eilimit: 500 })}`);
    t.on = d?.query?.embeddedin?.length ?? 0;
    if(d?.continue) t.on = GENERIC_ON + 1;
  }
  save();
  return Object.fromEntries(names.map((n) => [n, c.templates[n]]));
}

/** The first sidebar or navbox element in the template's own rendering (not its documentation). */
function firstBox(html){
  const m = html.match(/<(table|div)\b[^>]*class="(?:[^"]*\s)?(sidebar|navbox)(?:\s[^"]*)?"[^>]*>/);
  if(!m) return '';
  const tag = m[1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = m.index + m[0].length;
  let depth = 1, x;
  while(depth && (x = re.exec(html))) depth += x[0][1] === '/' ? -1 : 1;
  return html.slice(m.index, x ? x.index : html.length);
}

const HEADING = /<(th|td|div)\b[^>]*class="[^"]*\b(sidebar-heading|sidebar-list-title|navbox-group|navbox-title|sidebar-title)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
const textOf = (s) => s.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();

/** Members of a series template, grouped by its own headings, in its order. */
export async function seriesMembers(name){
  const c = load();
  const t = (c.templates[name] ||= {});
  if(t.groups) return { name, title: t.title, kind: t.kind, on: t.on, groups: t.groups };
  const d = await getJSON(`${API}&${new URLSearchParams({ action: 'parse', page: `Template:${name}`, prop: 'text' })}`);
  const box = firstBox(d?.parse?.text || '');
  // Cut the box at each heading; links before the first heading are the title/intro.
  const marks = [...box.matchAll(HEADING)].map((m) => ({ at: m.index, end: m.index + m[0].length, cls: m[2], text: textOf(m[3]) }));
  const titleMark = marks.find((m) => m.cls === 'sidebar-title' && !/^part of a series/i.test(m.text) && m.text.length > 2);
  t.title = titleMark?.text || name.replace(/ (sidebar|navbox)$/i, '');
  const groups = [];
  const seen = new Set();
  const cuts = [{ at: 0, end: 0, text: '' }, ...marks.filter((m) => m.cls !== 'sidebar-title' && m.cls !== 'navbox-title'), { at: box.length, end: box.length }];
  for(let i = 0; i < cuts.length - 1; i++){
    const part = box.slice(cuts[i].end, cuts[i + 1].at);
    const titles = [];
    for(const m of part.matchAll(/<a\b[^>]*href="\/wiki\/([^"#?]+)(?:#[^"]*)?"[^>]*>/g)){
      let tt;
      try { tt = decodeURIComponent(m[1]).replace(/_/g, ' '); } catch { continue; }
      if(/^[A-Z][a-z]+( talk)?:/.test(tt) || INDEX_TITLE.test(tt) || seen.has(tt)) continue;
      seen.add(tt); titles.push(tt);
    }
    if(titles.length) groups.push({ heading: cuts[i].text || '', titles });
  }
  t.groups = groups;
  save();
  return { name, title: t.title, kind: t.kind, on: t.on, groups };
}

const STOP = new Set(['history', 'of', 'the', 'and', 'in', 'sidebar', 'navbox', 'topics', 'series', 'box', 'nav', 'a', 'on', 'ancient', 'civilization', 'civilisation', 'empire', 'kingdom']);
const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
/*
 * "England" ~ "English", "Rome" ~ "Roman", "Iran" ~ "Iranian", but not
 * "Iran" ~ "Iraq". ("France"/"French" do not match; their series names say
 * France anyway, and topic-structure.json can name a series by hand.)
 */
const sameWord = (a, b) => {
  if(a === b) return true;
  if(a.length >= 5 && b.length >= 5) return a.slice(0, 4) === b.slice(0, 4);
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.length > s.length && l.startsWith(s.slice(0, -1));
};
const overlapOf = (xs, ys) => xs.filter((x) => ys.some((y) => sameWord(x, y))).length;

/** Groups that break a subject down by place ("By county", "By city or town"): local histories, not the subject. */
export const LOCAL_GROUP = /^by\b|^(regional|local) histor/i;
/** A series' members, minus local-history groups. */
export const coreMembers = (s) => [...new Set(s.groups.filter((g) => !LOCAL_GROUP.test(g.heading)).flatMap((g) => g.titles))];

/**
 * The series an article carries, best first:
 *   own      the series is ABOUT this subject (its name shares the subject's words:
 *            History of England on History of England; Ancient Rome military sidebar
 *            on Ancient Rome)
 *   parent   a broader series that lists the article (History of Iraq on Mesopotamia)
 *   other    shown on the page but about something else (Traditional African
 *            religions on Mali Empire; Islam on Islamic Golden Age)
 */
export async function seriesOf(article, { name = '' } = {}){
  const { title, templates } = await templatesOn(article);
  const info = await templateInfo(templates);
  const subject = [...new Set([...words(title), ...words(name)])];
  const out = [];
  for(const n of templates){
    const t = info[n];
    if(!t?.kind || META.test(n) || (t.on ?? 0) > GENERIC_ON) continue;
    const s = await seriesMembers(n);
    const members = coreMembers(s);
    if(members.length < 8) continue;
    const overlap = overlapOf(subject, words(`${n} ${s.title}`));
    const lists = members.some((m) => m.toLowerCase() === title.toLowerCase());
    const role = overlap > 0 ? 'own' : lists ? 'parent' : 'other';
    out.push({ name: n, title: s.title, kind: t.kind, on: t.on, size: members.length, role, groups: s.groups });
  }
  // Within a role, the series editors invested most in: articles x pages showing it.
  const rank = { own: 0, parent: 1, other: 2 };
  out.sort((a, b) => rank[a.role] - rank[b.role] || b.size * Math.log1p(b.on) - a.size * Math.log1p(a.on));
  return { title, series: out };
}

/** Series templates in a category, biggest first: what to build next. */
export async function seriesInCategory(cat){
  const names = [];
  for(const d of await all({ action: 'query', list: 'categorymembers', cmtitle: cat.startsWith('Category:') ? cat : `Category:${cat}`, cmnamespace: 10, cmlimit: 'max' })){
    names.push(...(d.query?.categorymembers || []).map((x) => x.title.replace(/^Template:/, '')));
  }
  const info = await templateInfo(names);
  const out = [];
  for(const n of names){
    if(META.test(n) || /\/doc$/.test(n)) continue;
    const s = await seriesMembers(n);
    out.push({ name: n, title: s.title, kind: info[n]?.kind, on: info[n]?.on ?? 0, size: coreMembers(s).length });
  }
  return out.sort((a, b) => b.size * Math.log1p(b.on) - a.size * Math.log1p(a.on));
}
