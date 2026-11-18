/**
 * The static word index for the search page (datasets/web/words/), shared by
 * the builder (build-web.mjs) and the browser (project/features/topic/search.js)
 * so both cut words the same way.
 *
 * Why static and sharded: the site is a static site (GitHub Pages). The old
 * search downloaded the whole store (store-lite.json, 18 MB) to search it in
 * the browser; a phone cannot do that at 70,000 entries, let alone 500,000.
 * Here a query fetches one small file per word (words/<first two letters>.json)
 * and then the rows of its best hits (rows/r-NNN.json, 100 rows each, numbered
 * most important first so the best hits share a few files).
 *
 *   words/<pp>.json   { <token>: [df, [rowNo, weight], …] }   best POSTINGS_MAX per token
 */

export const POSTINGS_MAX = 400;
export const ROWS_PER_BLOCK = 100;

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the to was were which with ' +
  'his her their he she they this these those not but also into than then there after before over under who whom whose ' +
  'de la le el di da von van der').split(' '));

/** Lowercase, accents off, a light plural fold ("wars" ~ "war", "empires" ~ "empire"). */
export function tokens(text){
  const out = [];
  for(let w of String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)){
    if(w.length < 2 || STOP.has(w)) continue;
    if(w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** The shard a token lives in: its first two characters. */
export const shardOf = (tok) => (/^[a-z0-9]{2}/.test(tok) ? tok.slice(0, 2) : '__');

/**
 * Rank row numbers for a query from the fetched postings. `lists` is one entry
 * per query token: [df, [row, w], …] or undefined. Rows matching every token
 * come first; within that, the sum of idf x weight.
 */
export function rank(lists, N, limit = 200){
  const score = new Map(), hits = new Map();
  const present = lists.filter(Boolean);
  for(const l of present){
    const [df, ...posts] = l;
    const idf = Math.log(1 + N / Math.max(1, df));
    for(const [row, w] of posts){
      score.set(row, (score.get(row) || 0) + idf * w);
      hits.set(row, (hits.get(row) || 0) + 1);
    }
  }
  const need = present.length;
  const all = [...score.keys()].filter((r) => hits.get(r) >= need);
  // Enough rows have every word ("printing press"): only those. A page listed in
  // time order shows everything returned, and "press westward" is not about presses.
  const pool = need > 1 && all.length >= 10 ? all : [...score.keys()];
  return pool
    .sort((a, b) => (hits.get(b) >= need) - (hits.get(a) >= need) || score.get(b) - score.get(a))
    .slice(0, limit);
}
