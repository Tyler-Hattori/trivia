/*
 * What the lanes atlas loads (datasets/web/atlas/, built by build-web.mjs).
 *
 *   meta.json   sections, lanes, eras, the bucket list        (on open)
 *   top.json    the most important entries, every lane's top   (on open)
 *   long.json   spans too long for a bucket                    (on open)
 *   b-NNN.json  everything else by start year                  (as you zoom in)
 *
 * Zoomed out, top + long are all there is room to show anyway; zooming in on a
 * stretch of time loads the few buckets under it. So what a view downloads does
 * not grow with the store; only the number of buckets does.
 *
 * Entries are plain objects (rows of build-web.mjs), kept in one Map by id and
 * one array sorted most important first (what lanes.js packs in).
 */
import { findRows } from '../topic/webdata.js';
import { kindOf } from './lanes.js';

const IMG = 'https://upload.wikimedia.org/wikipedia/';
const MAX_BUCKETS = 10;   // load buckets only when the window needs at most this many

export async function loadLaneAtlas(base = ''){
  const get = (f) => fetch(`${base}datasets/web/atlas/${f}`).then((r) => {
    if(!r.ok) throw new Error(`datasets/web/atlas/${f}: HTTP ${r.status}. Build it: node datasets/build-web.mjs`);
    return r.json();
  });
  const [meta, top, long] = await Promise.all([get('meta.json'), get('top.json'), get('long.json')]);
  const byId = new Map();
  let sorted = [];
  let dirty = true;
  const add = (rows) => {
    let n = 0;
    for(const r of rows){
      if(byId.has(r.id)) continue;
      if(r.im && r.im[0] === '~') r.im = IMG + r.im.slice(1);
      r.kind = kindOf(r);
      byId.set(r.id, r);
      n++;
    }
    if(n) dirty = true;
    return n;
  };
  add(top); add(long);
  const loaded = new Map();   // bucket file -> promise

  const A = {
    meta,
    byId,
    /** Every loaded entry, most important first. */
    get sorted(){
      if(dirty){ sorted = [...byId.values()].sort((a, b) => b.p - a.p || a.s - b.s); dirty = false; }
      return sorted;
    },
    /** Load the buckets under [lo, hi] years if there are few enough. Resolves true if anything new arrived. */
    async ensure(lo, hi, { force = false } = {}){
      const need = meta.buckets.filter((b) => (b.hi == null || b.hi >= lo) && b.lo <= hi);
      if(!force && need.length > MAX_BUCKETS) return false;
      const todo = need.filter((b) => !loaded.has(b.f));
      if(!todo.length) return false;
      const got = await Promise.all(todo.map((b) => {
        const p = get(b.f).then(add).catch(() => { loaded.delete(b.f); return 0; });
        loaded.set(b.f, p);
        return p;
      }));
      return got.some((n) => n > 0);
    },
    /** Make sure an entry starting at `year` is loaded (its bucket). */
    async ensureAt(year){ return A.ensure(year, year, { force: true }); },

    // ---- details (excerpt, facets, neighbours), by details group ---------------
    details: {},
    async loadDetails(e){
      if(!e || A.details[e.id] || e.g == null) return A.details[e?.id] || null;
      const f = `l-${String(e.g).padStart(3, '0')}.json`;
      if(!detailP.has(f)){
        detailP.set(f, fetch(`${base}datasets/web/details/${f}`).then((r) => (r.ok ? r.json() : {}))
          .then((d) => Object.assign(A.details, d)).catch(() => { detailP.delete(f); }));
      }
      await detailP.get(f);
      return A.details[e.id] || null;
    },

    /**
     * Search: the site's word index (web/words, the same one #/search uses) over
     * the whole store, then whatever those rows are among the atlas entries.
     * Lite rows carry the lane, so a hit not loaded yet is still placed.
     */
    async search(text, limit = 600){
      const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
      if(!words.length) return null;
      let rows = [];
      try { rows = await findRows(words.join(' '), limit); } catch { rows = []; }
      const ids = new Set();
      const fresh = [];
      for(const r of rows){
        const id = r.id;
        if(!byId.has(id) && r.ln != null) fresh.push({ ...r, f: r.af ?? 0 });
        ids.add(id);
      }
      add(fresh);
      // Also anything loaded whose title has every word (the index keeps the
      // best postings per word, so a rare combination can miss it there).
      for(const e of byId.values()){
        if(ids.has(e.id)) continue;
        const t = e.t.toLowerCase();
        if(words.every((w) => t.includes(w))) ids.add(e.id);
      }
      return ids;
    },
  };
  const detailP = new Map();
  return A;
}
