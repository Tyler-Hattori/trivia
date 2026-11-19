/**
 * IDEAS: undated entries. Energy, Wave, Uncertainty principle, Natural
 * selection, Plate tectonics — the things a science or mathematics topic is
 * mostly about, and which the main store (entries.jsonl) refuses because it is
 * a store of DATED entries: everything there has an x on the atlas, and
 * verify.mjs, the atlas, the cluster quiz and search all assume it.
 *
 * So ideas live beside it, in datasets/store/ideas.jsonl, one per line:
 *   { id, title, subtitle, excerpt, image, wiki, qid, fetched }
 * plus a list of pages that have no usable summary (so they are not refetched):
 *   { title, missing: true, fetched }
 *
 * topic.mjs reads them as members with no date: never on a timeline, shown in
 * Learn as a chapter's "Key ideas", asked in the quiz as "which idea is this?".
 * Fetching is one REST summary per page through wikilib's shared politeness
 * budget — about a second per idea, no model, no embedding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, slugify } from './store.mjs';
import { getJSON } from './wikilib.mjs';
import { stripApparatus } from './wiki.mjs';

const FILE = PATHS.ideas;

export function readIdeas(){
  const byTitle = new Map();
  if(!fs.existsSync(FILE)) return byTitle;
  for(const line of fs.readFileSync(FILE, 'utf8').split('\n')){
    if(!line.trim()) continue;
    try { const r = JSON.parse(line); byTitle.set(r.title.toLowerCase(), r); if(r.asked) byTitle.set(r.asked.toLowerCase(), r); } catch {}
  }
  return byTitle;
}

function append(rows){
  if(rows.length) fs.appendFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** One page's summary as an idea, or a `missing` marker. */
async function fetchIdea(title){
  const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const d = await getJSON(u);
  const now = new Date().toISOString().slice(0, 10);
  if(!d || !d.title || d.type === 'disambiguation' || /not_found/.test(d.type || '')) return { title, missing: true, fetched: now };
  const excerpt = stripApparatus(String(d.extract || '').replace(/\s+/g, ' ').trim());
  if(excerpt.length < 60) return { title, missing: true, fetched: now };
  return {
    id: `idea:${slugify(d.title)}`,
    title: d.title,
    asked: d.title !== title ? title : undefined,
    subtitle: d.description || '',
    excerpt,
    image: d.originalimage?.source || d.thumbnail?.source || '',
    wiki: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(d.title.replace(/ /g, '_'))}`,
    qid: d.wikibase_item || null,
    fetched: now,
  };
}

/**
 * Make sure every title in `titles` is in the ideas file (fetching what is
 * not), and return the up-to-date map. `log` gets one progress line.
 */
export async function ensureIdeas(titles, { log = console.log } = {}){
  const have = readIdeas();
  const want = [...new Set(titles)].filter((t) => !have.has(t.toLowerCase()));
  if(!want.length) return have;
  log(`  fetching ${want.length} ideas (undated pages) from Wikipedia…`);
  const out = [];
  for(const [i, t] of want.entries()){
    out.push(await fetchIdea(t));
    if((i + 1) % 25 === 0){ append(out.splice(0)); log(`    ${i + 1}/${want.length}`); }
  }
  append(out);
  return readIdeas();
}

export const IDEAS_FILE = FILE;
