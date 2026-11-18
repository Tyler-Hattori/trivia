/**
 * Server-side hybrid search over the whole store: BM25 + EmbeddingGemma at full
 * width (768) with the query prefix, fused by reciprocal rank. Used by
 * `serve.mjs`'s `/api/search` and by `datasets/topic.mjs`.
 *
 * Fails soft: if Ollama is unreachable, or the search vectors were never built,
 * results are keyword-only and `semantic` in the response says so.
 *
 * Indexes are cached and rebuilt when entries.jsonl or the search vectors change
 * on disk, so an ingest is picked up by a running server without a restart.
 */

import fs from 'node:fs';
import { readEntries, readSearchVectors, readVectors, PATHS, storeStamp } from './store.mjs';
import { embedQuery, ensureUp } from './ollama.mjs';
import { bm25Index, docText, fuse, cutSemantic } from './textsearch.mjs';

let cache = null;

/** Keyword hits below this similarity to the query are dropped as unrelated. */
const KW_SEM_MIN = 0.26;   // Norman Conquest is 0.277 to "battle of hastings"; Saturn Devouring is 0.235 to "black death"

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

function load(){
  const key = String(storeStamp());
  if(cache && cache.key === key) return cache;

  const entries = readEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const kw = bm25Index(entries.map((e) => ({ id: e.id, text: docText(e) })));

  // Prefer full-width search vectors; fall back to the map's 256-dim ones.
  let vec = null;
  try { vec = readSearchVectors(); } catch { vec = null; }
  if(!vec){ try { vec = readVectors(); } catch { vec = null; } }

  // Dequantise once into one flat Float32Array: ~25MB at 8k x 768, and a full
  // scan is then ~6M multiply-adds, a few ms.
  let M = null, rowIds = [], dim = 0;
  if(vec){
    dim = vec.dim;
    rowIds = vec.ids.filter((id) => byId.has(id));
    M = new Float32Array(rowIds.length * dim);
    rowIds.forEach((id, r) => M.set(vec.get(id), r * dim));
  }
  cache = { key, entries, byId, kw, M, rowIds, dim };
  return cache;
}

/** Cosine against every stored vector, best first, optionally limited to `scope`. */
function semanticScan(C, qvec, scope){
  const { M, rowIds, dim } = C;
  let s0 = 0;
  for(let d = 0; d < dim; d++) s0 += qvec[d] * qvec[d];
  const inv = 1 / Math.sqrt(s0 || 1);
  const out = [];
  for(let r = 0; r < rowIds.length; r++){
    if(scope && !scope.has(rowIds[r])) continue;
    let t = 0;
    const off = r * dim;
    for(let d = 0; d < dim; d++) t += M[off + d] * qvec[d];
    out.push({ id: rowIds[r], sim: t * inv });
  }
  return out.sort((a, b) => b.sim - a.sim);
}

/**
 * Hybrid search.
 *
 *   q        the query text
 *   scope    optional Set of ids to restrict to (a topic's members)
 *   limit    max results
 *   timeoutMs  how long to wait for the query embedding before going keyword-only
 *
 * Returns { hits: [{id, score, kw, sem}], semantic: bool, dim }.
 */
export async function search(q, { scope = null, limit = 200, timeoutMs = 6000 } = {}){
  const C = load();
  q = String(q || '').trim();
  if(!q) return { hits: [], semantic: false, dim: C.dim };

  let kw = C.kw.search(q, { limit: 2000 });
  if(scope) kw = kw.filter((h) => scope.has(h.id));
  // Keep only keyword hits within reach of the best one; BM25 has a long tail of
  // one-word matches that fusion would otherwise rank above nothing.
  if(kw.length){ const top = kw[0].score; kw = kw.filter((h) => h.score >= top * 0.3).slice(0, limit); }

  let sem = [];
  let semantic = false;
  if(C.M){
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
      await Promise.race([ensureUp(), timeout]);
      const [v] = await Promise.race([embedQuery([q]), timeout]);
      const qvec = Float32Array.from(v.slice(0, C.dim));
      const all = semanticScan(C, qvec, scope);
      /*
       * Inside a topic every candidate is already on-subject, so once the best hit
       * clears the floor the next dozen are worth showing even if they score
       * lower: "who broke with the pope" puts *Henry VIII severs ties with the
       * Catholic Church* 7th at 0.317, below the global cut. Corpus-wide that
       * reach would pull in noise; inside a topic it does not.
       */
      sem = scope
        ? cutSemantic(all, { limit: Math.min(limit, 12), minCut: 0.30, window: 0.2 })
        : cutSemantic(all, { limit });
      semantic = true;
      /*
       * A keyword hit must also be at least loosely ABOUT the query. Every
       * document's similarity was just computed, so this costs nothing, and it is
       * what removes "black death" -> *Saturn Devouring One of His Sons* (an
       * excerpt that says "black" and, elsewhere, "death"). The bar is below
       * SEM_FLOOR on purpose: it vetoes the unrelated, it does not demand a
       * semantic match — *Norman Conquest* (0.277) for "battle of hastings" stays.
       */
      const simOf = new Map(all.map((h) => [h.id, h.sim]));
      kw = kw.filter((h) => (simOf.get(h.id) ?? 1) >= KW_SEM_MIN);
    } catch { /* keyword-only */ }
  }

  // Semantic weighted a touch above keywords, so a tie at equal rank goes to the
  // match that understood the question rather than the one that shared a word.
  return { hits: fuse(kw, sem, { limit, wKw: 0.9, wSem: 1 }), semantic, dim: C.dim };
}

/** Entry lookup for callers that already hold ids. */
export function entryById(id){ return load().byId.get(id) || null; }
