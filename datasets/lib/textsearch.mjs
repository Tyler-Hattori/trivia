/**
 * Keyword search (BM25) and the hybrid fusion rule. Pure functions, no Node or
 * DOM APIs, so the server (`lib/search.mjs`) and the browser (the topic page,
 * which must work as a static site with no server) share one implementation —
 * the same arrangement as `years.mjs`.
 *
 * Why hybrid rather than embeddings alone, measured on this corpus (see
 * datasets/SEARCH.md):
 *
 *   - Embeddings find paraphrases ("guy who invented the telephone" -> Bell) and
 *     keywords never will.
 *   - Keywords find exact names and rare terms, and they are free and instant.
 *     "tudor dynasty": keywords put Bosworth Field and the Portrait of Henry VIII
 *     in the top 10; embeddings put Elizabeth of York and Richard III there; the
 *     fusion has all eight Tudor-era monarchs.
 *   - Reciprocal-rank fusion needs no score calibration between the two, which
 *     is the point: a BM25 score and a cosine are not on comparable scales.
 */

const STOP = new Set(('a an and are as at be by for from has have he her his in is it its of on or ' +
  'that the their this to was were which who with what when where how did does do about ' +
  'into than then there these those after before during between over under').split(' '));

const TRANSLIT = { ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ı: 'i', ð: 'd', þ: 'th', ß: 'ss', æ: 'ae', œ: 'oe' };

/** Lowercase, strip diacritics, split on non-alphanumerics, drop stop words. */
export function tokenize(s, { keepStop = false } = {}){
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[łøđħıðþßæœ]/g, (c) => TRANSLIT[c])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 || /\d/.test(w));
  return keepStop ? out : out.filter((w) => !STOP.has(w)).map(stem);
}

/*
 * A deliberately tiny stemmer: plural and possessive endings only. "emperors"
 * must match "emperor" and "wars" must match "war"; anything cleverer (Porter)
 * starts merging names — "Wales" and "wale", "Hastings" and "hasting".
 */
function stem(w){
  if(w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/**
 * The text a document is searched by. Title counts twice — a query naming the
 * entry should beat a query merely mentioned in its excerpt.
 */
export function docText(e){
  const facets = Object.values(e.facets || {}).flat().join(' ');
  return [e.title, e.title, e.subtitle, (e.topics || []).join(' '), facets, String(e.excerpt || '').slice(0, 1500)]
    .filter(Boolean).join(' ');
}

/** Build a BM25 index over `docs` ([{id, text}]). */
export function bm25Index(docs, { k1 = 1.2, b = 0.75 } = {}){
  const ids = docs.map((d) => d.id);
  const tf = [];
  const len = new Float32Array(docs.length);
  const df = new Map();
  docs.forEach((d, i) => {
    const toks = tokenize(d.text);
    len[i] = toks.length;
    const m = new Map();
    for(const t of toks) m.set(t, (m.get(t) || 0) + 1);
    tf.push(m);
    for(const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  });
  const avg = len.reduce((s, x) => s + x, 0) / Math.max(1, docs.length);
  const N = docs.length;
  const idf = (t) => { const n = df.get(t) || 0; return n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0; };

  return {
    ids,
    /**
     * Ranked [{i, id, score, matched}] for a query. `matched` is how many of the
     * query's distinct terms the document contains.
     *
     * A document must contain at least ~60% of the query's terms. Plain BM25 is
     * an OR, so "guy who invented the telephone" returned *John Guy* and
     * *Guy Fawkes Night* in its top 5 on one shared word.
     */
    search(q, { limit = 200 } = {}){
      const terms = [...new Set(tokenize(q))];
      if(!terms.length) return [];
      const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
      const out = [];
      for(let i = 0; i < N; i++){
        let s = 0, matched = 0;
        for(const t of terms){
          const f = tf[i].get(t);
          if(!f) continue;
          matched++;
          s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[i] / avg));
        }
        if(matched >= need) out.push({ i, id: ids[i], score: s, matched });
      }
      out.sort((a, c) => c.score - a.score);
      return out.slice(0, limit);
    },
  };
}

/*
 * Similarity floors for the 768-dim, query-prefixed EmbeddingGemma setup.
 * Calibrated 2026-11-13 over the 8,144-entry store:
 *
 *   nonsense queries ("zzzznotathing", "asdf qwerty", "the")   best match 0.27–0.34
 *   real queries ("black death", "cubism", "tudor dynasty")    best match 0.47–0.64
 *
 * SEM_FLOOR sits in that gap. SEM_WINDOW then keeps only hits close to the best
 * one, so a query with one excellent match ("black death", 0.61, then 0.41 at #5)
 * does not drag in forty loose neighbours.
 */
export const SEM_FLOOR = 0.40;
export const SEM_WINDOW = 0.16;

/**
 * Fuse a keyword ranking and a semantic ranking.
 *
 *   kw   [{id, score}] best first (from bm25Index.search)
 *   sem  [{id, sim}]   best first, already cut by floor/window
 *
 * Reciprocal-rank fusion, k=60 (the standard constant). An id in both lists
 * outranks an id in either alone, which is what you want: agreement between
 * a literal and a semantic match is the strongest evidence available.
 */
export function fuse(kw, sem, { k = 60, limit = 200, wKw = 1, wSem = 1 } = {}){
  const m = new Map();
  const add = (id, r, field, val, w) => {
    let o = m.get(id);
    if(!o) m.set(id, (o = { id, score: 0, kw: null, sem: null }));
    o.score += w / (k + r);
    o[field] = val;
  };
  kw.forEach((h, r) => add(h.id, r, 'kw', h.score, wKw));
  sem.forEach((h, r) => add(h.id, r, 'sem', h.sim, wSem));
  return [...m.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Apply SEM_FLOOR / SEM_WINDOW to a best-first [{id, sim}] list. */
export function cutSemantic(hits, { floor = SEM_FLOOR, window = SEM_WINDOW, limit = 200, minCut = floor } = {}){
  if(!hits.length || hits[0].sim < floor) return [];
  // `minCut` lets a SCOPED search (one topic, already on-subject) reach below the
  // global floor once the best hit has proved the query is meaningful.
  const cut = Math.max(minCut, hits[0].sim - window);
  const out = [];
  for(const h of hits){ if(h.sim < cut || out.length >= limit) break; out.push(h); }
  return out;
}
