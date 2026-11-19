/*
 * The whole-store data, fetched in small static pieces (datasets/web/, built by
 * datasets/build-web.mjs). Nothing here downloads the whole store: a request
 * fetches the time buckets, word shards or row blocks it needs, and each is
 * cached for the session. See docs/TOPICS.md, "What the browser loads".
 */
import { anchorYear } from './layout.js';
import { tokens, shardOf, rank } from '../../../datasets/lib/webindex.mjs';

const BASE = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '') + 'datasets/web/';
const cache = new Map();
/** Fetch one file of datasets/web/, once per session. */
export function web(rel){
  if(!cache.has(rel)){
    cache.set(rel, fetch(BASE + rel).then((r) => { if(!r.ok) throw new Error(`${rel}: HTTP ${r.status}`); return r.json(); })
      .catch((e) => { cache.delete(rel); throw e; }));
  }
  return cache.get(rel);
}
const IMG = 'https://upload.wikimedia.org/wikipedia/';
const fixImg = (r) => { if(r.im && r.im[0] === '~') r.im = IMG + r.im.slice(1); return r; };

// ---------------------------------------------------------------------------
// Topic rows (what each topic puts on its timeline)
// ---------------------------------------------------------------------------

/** { topics: {slug: {title, group, chapters}}, buckets } */
export const topicsMeta = () => web('trows/manifest.json');

const prepT = (rows) => rows.map((r) => { if(!r._p){ fixImg(r); r.anchor = r.i ? null : r.a; r._p = 1; } return r; });

/** Topic rows whose anchor year is in [lo, hi], from the buckets that cover it. */
export async function topicRowsIn(lo, hi){
  const M = await topicsMeta();
  const files = M.buckets.filter((b) => b.hi >= lo && b.lo <= hi).map((b) => b.f);
  const parts = await Promise.all(files.map((f) => web(`trows/${f}`)));
  return prepT(parts.flat()).filter((r) => r.anchor >= lo && r.anchor <= hi);
}

/** One topic's rows (keyOnly: its essentials and key ideas). */
export async function topicRows(slug, keyOnly){
  try { return prepT(await web(`trows/t/${slug}${keyOnly ? '.key' : ''}.json`)); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// The whole store, for the search page
// ---------------------------------------------------------------------------

const prepL = (rows) => rows.map((r) => {
  if(!r._p){ fixImg(r); r.anchor = r.i ? null : anchorYear({ type: r.ty, kind: r.k ? 'span' : 'point', start: r.s, end: r.e }); r._p = 1; }
  return r;
});
const MAX_TIME_BUCKETS = 40;

/**
 * Every entry whose years overlap [lo, hi]: the time buckets that cover it
 * plus the long spans. `partial` when the span covers more buckets than one
 * page should fetch (a whole millennium): then the first and last buckets'
 * worth around its ends, and what is under way throughout.
 */
export async function storeRowsIn(lo, hi){
  const M = await web('lite/time/manifest.json');
  let bs = M.buckets.filter((b) => (b.hi == null || b.hi >= lo) && b.lo <= hi);
  const partial = bs.length > MAX_TIME_BUCKETS;
  if(partial) bs = [...bs.slice(0, MAX_TIME_BUCKETS / 2), ...bs.slice(-MAX_TIME_BUCKETS / 2)];
  const parts = await Promise.all([...bs.map((b) => web(`lite/time/${b.f}`)), web('lite/time/long.json')]);
  const seen = new Set(), out = [];
  for(const r of parts.flat()) if(!seen.has(r.id)){ seen.add(r.id); out.push(r); }
  return { rows: prepL(out), partial };
}

/** Rows for row numbers, from blocks of rowsPerBlock. */
async function rowsByNumber(nums){
  const man = await web('manifest.json');
  const per = man.rowsPerBlock;
  const blocks = [...new Set(nums.map((n) => Math.floor(n / per)))];
  const got = new Map(await Promise.all(blocks.map(async (b) => [b, await web(`lite/rows/r-${String(b).padStart(3, '0')}.json`)])));
  return nums.map((n) => got.get(Math.floor(n / per))?.[n % per]).filter(Boolean);
}

/**
 * Word search over the whole store: the word index's shards for each query
 * word, ranked (every word first, then idf x weight), then the rows of the best
 * `limit` hits. Returns rows in rank order.
 */
export async function findRows(words, limit = 200){
  const toks = [...new Set(tokens(words))].slice(0, 6);
  if(!toks.length) return [];
  const man = await web('manifest.json');
  const lists = await Promise.all(toks.map(async (t) => { try { return (await web(`words/${shardOf(t)}.json`))[t]; } catch { return undefined; } }));
  const nums = rank(lists, man.N, limit);
  return prepL(await rowsByNumber(nums));
}
