/**
 * The atlas store.
 *
 * datasets/store/ is the source of truth, tracked in git; everything else under
 * datasets/ (atlas/, topics/, site.db) is generated from it and is not:
 *
 *   store/entries/entries-NNN.jsonl  one JSON object per line, in the order
 *                                    entries were added, split into ~20 MB chunks
 *                                    (GitHub refuses files over 100 MB; the single
 *                                    entries.jsonl reached 83 MB). Appends go to
 *                                    the last chunk; an edit rewrites only the
 *                                    chunks whose bytes change.
 *   store/vectors/map-NNN.bin        one quantised 256-dim embedding per entry,
 *   store/vectors/search-NNN.bin     and 768-dim for search; fixed-width rows,
 *                                    CHUNK_ROWS rows per file, ids in map.json /
 *                                    search.json
 *   store/layout.json, taxonomy.json, ideas.jsonl, vocab.*   caches that cost
 *                                    network or model time to recreate
 *
 * Why JSONL and not CSV: excerpts contain commas, quotes and paragraph breaks.
 * The old CSV parser handled none of those without escaping (`%2C` for commas in
 * URLs, the literal characters `\n\n` for a paragraph break), and a single
 * unquoted comma silently shifted every later column. JSONL has no such traps
 * and appending one entry is one line.
 *
 * ## Vector quantisation
 *
 * Embeddings arrive L2-normalised, so components cluster around 1/sqrt(dim) —
 * about 0.036 for 768 dims, with the largest around 0.19. A fixed int8 scale
 * over [-1,1] would therefore use only ~5 of 255 levels and destroy the
 * distances the whole atlas is built on. Each row instead carries its own
 * float32 scale, giving ~2% cosine error at a quarter the size of float32:
 *
 *   row = [ float32 scale ][ int8 x DIM ]     = 4 + DIM bytes
 *
 * DIM is a Matryoshka truncation of the model's native width (EmbeddingGemma
 * emits 768 and is trained so that the first 256 dims stand alone), taken and
 * re-normalised at embed time. Changing DIM or the model invalidates every
 * stored vector — `embed-all.mjs --force` is the only way back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo path contains a space. `new URL(import.meta.url).pathname` leaves it
// as %20 and silently writes into a stray "my%20shit" directory — this bit the
// project once already. Always resolve through fileURLToPath.
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DATASETS_DIR = path.dirname(HERE);
export const REPO_DIR     = path.dirname(DATASETS_DIR);
export const ATLAS_DIR    = path.join(DATASETS_DIR, 'atlas');     // generated (gitignored)
export const STORE_DIR    = path.join(DATASETS_DIR, 'store');     // source of truth (tracked)

export const PATHS = {
  store:   STORE_DIR,
  entries: path.join(STORE_DIR, 'entries'),                 // a directory of chunks
  vectors: path.join(STORE_DIR, 'vectors', 'map'),          // chunk prefix: map-000.bin…
  vecMeta: path.join(STORE_DIR, 'vectors', 'map.json'),
  layout:  path.join(STORE_DIR, 'layout.json'),
  taxonomy: path.join(STORE_DIR, 'taxonomy.json'),
  ideas:   path.join(STORE_DIR, 'ideas.jsonl'),
  vocab:     path.join(STORE_DIR, 'vocab.bin'),
  vocabMeta: path.join(STORE_DIR, 'vocab.json'),
  // Full-width vectors for SEARCH only. The map keeps using the 256-dim
  // vectors (changing that would re-fit every y on the atlas); search reads
  // these, because the Matryoshka cut costs retrieval ~5 points of R-precision.
  searchVectors: path.join(STORE_DIR, 'vectors', 'search'),
  searchVecMeta: path.join(STORE_DIR, 'vectors', 'search.json'),
  // Generated.
  atlas:   path.join(ATLAS_DIR, 'atlas.json'),
  details: path.join(ATLAS_DIR, 'details.json'),
  knnCache: path.join(ATLAS_DIR, 'knn-cache.json'),
  topics:  path.join(DATASETS_DIR, 'topics'),
  db:      path.join(DATASETS_DIR, 'site.db'),
};

/** Entry chunks are cut at about this many bytes. */
const ENTRY_CHUNK_BYTES = 20e6;
/** Rows per vector chunk: 25,000 x 772 bytes = 19 MB for search, 6.5 MB for the map. */
export const CHUNK_ROWS = 25000;

const chunkName = (i) => `entries-${String(i).padStart(3, '0')}.jsonl`;
/** The entry chunk files, in order. */
export function entryChunks(){
  if(!fs.existsSync(PATHS.entries)) return [];
  return fs.readdirSync(PATHS.entries).filter((f) => /^entries-\d{3}\.jsonl$/.test(f)).sort().map((f) => path.join(PATHS.entries, f));
}
/** Latest modification time across the store's entries and vectors: a cache key. */
export function storeStamp(){
  const files = [...entryChunks(), ...vecChunks(PATHS.vectors), ...vecChunks(PATHS.searchVectors)];
  return files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).reduce((a, b) => Math.max(a, b), 0) + files.length;
}

/** Width of the search vectors: EmbeddingGemma's native output, uncut. */
export const SEARCH_DIM = 768;

/** Stored vector width. A Matryoshka prefix of the model's native output. */
export const DIM = 256;

/** Bytes per stored row: one float32 scale plus DIM int8 components. */
export const ROW_BYTES = 4 + DIM;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * The canonical entry shape. Every field is present on every entry so that
 * consumers never branch on existence.
 *
 *   id        stable slug; the join key to vectors.bin and atlas.json
 *   title     the thing itself ("Les Demoiselles d'Avignon")
 *   subtitle  its one-line attribution ("Pablo Picasso")
 *   yearText  the date exactly as authored ("c. 1500 BC", "1879-1955")
 *   start,end signed years; equal for a point, distinct for a span
 *   kind      'point' | 'span'
 *   circa     the date is approximate
 *   domains   BROAD provenance-ish buckets ("art", "film", "politics"). Kept out
 *             of the embedded text on purpose — see `entryText`.
 *   topics    FLAT, MULTI-VALUE specific labels. An entry tagged
 *             ["noir","crime"] genuinely belongs to both. This is what kills the
 *             old "genre 1 / genre 2" pseudo-category: there is no single slot
 *             to force a compound value into.
 *   facets    named attributes for filtering and quizzing: {artist, movement, …}
 *             Values may be a string or an array of strings.
 *   excerpt   prose, real newlines allowed (JSONL escapes them)
 *   image     absolute URL or ''
 *   sitelinks number of language Wikipedias with an article on this entity, or
 *             null when there is no QID to ask. A free notability signal, kept
 *             raw here; `atlas.mjs` normalises it into `fame` on the built
 *             points, the same relationship `y` has to the entry text.
 *   origin    {dataset, wiki, qid} — provenance, so a re-ingest can dedupe.
 *             Plus an optional `manual: true`, meaning "authored here, not
 *             derived from one page": hand-entered prose, or an event mined out
 *             of a page body. Such a row cannot be recreated by re-fetching
 *             anything, so `migrate.mjs` must never drop it — see the carry-over
 *             discriminator there.
 */
export function makeEntry(o = {}){
  return {
    id:       o.id || '',
    title:    o.title || '',
    subtitle: o.subtitle || '',
    yearText: o.yearText || '',
    start:    o.start ?? null,
    end:      o.end ?? null,
    kind:     o.kind || 'point',
    circa:    !!o.circa,
    /*
     * No end year is recorded, so the stored `end` is today standing in for one.
     *
     * Named for what is known rather than what is guessed. The obvious name was
     * `ongoing`, and it would have been a claim the data does not support: of the
     * 109 spans this flags, most really are unfinished — living people, extant
     * taxa, active conflicts — but Vikings, Ancient Rome and Olmecs are in there
     * too, and they are flagged because Wikidata has no P582 for them, not
     * because they are still going. Open-ended is true of all of them.
     *
     * Also inferred from the text, because the CSV route never had a structured
     * end claim to be absent — it wrote "1990-present" and `parseYears` replaced
     * the word with the current year, losing the distinction just as thoroughly.
     */
    openEnded: !!o.openEnded || /\b(present|current|now|incumbent|ongoing)\b/i.test(o.yearText || ''),
    domains:  dedupeLower(o.domains || []),
    topics:   dedupeLower(o.topics || []),
    facets:   o.facets || {},
    excerpt:  o.excerpt || '',
    image:    o.image || '',
    sitelinks: o.sitelinks ?? null,
    origin:   { dataset: '', wiki: '', qid: null, ...(o.origin || {}) },
    addedAt:  o.addedAt || null,
  };
}

const dedupeLower = (arr) => [
  ...new Set(
    (Array.isArray(arr) ? arr : [arr])
      .flatMap((t) => String(t || '').split(/\s*[|/;]\s*/))   // "genre1 / genre2" -> both
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** Slugify into a stable id. Collisions are resolved by the caller. */
export function slugify(s){
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'x';
}

/**
 * A stable id: dataset, slug of the title, and the year. Deliberately readable
 * so a git diff of entries.jsonl is reviewable, and deliberately including the
 * year so two works of the same name do not collide.
 */
export function entryId(entry){
  const y = entry.start == null ? 'nd' : (entry.start < 0 ? `${Math.abs(entry.start)}bc` : String(entry.start));
  return `${entry.origin?.dataset || 'x'}:${slugify(entry.title)}:${y}`;
}

export function readEntries(){
  const out = [];
  const files = entryChunks();
  files.forEach((file, fi) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let lineNo = 0;
    for(const line of lines){
      lineNo++;
      const s = line.trim();
      if(!s) continue;
      try { out.push(JSON.parse(s)); }
      catch(e){
        // The last line of the last chunk may be half-written by an ingest
        // running at the same moment. Anywhere else it is corruption.
        if(fi === files.length - 1 && lines.slice(lineNo).every((l) => !l.trim())){ console.warn(`  (${path.basename(file)}: skipped a half-written last line)`); continue; }
        throw new Error(`${path.basename(file)}:${lineNo} is not valid JSON — ${e.message}`);
      }
    }
  });
  return out;
}

/** Serialise one entry to a single line, with keys in a stable order. */
export function entryLine(e){
  const ordered = {};
  for(const k of ['id','title','subtitle','yearText','start','end','kind','circa','openEnded',
                  'domains','topics','facets','excerpt','image','sitelinks','origin','addedAt']){
    ordered[k] = e[k];
  }
  return JSON.stringify(ordered);
}

/**
 * Rewrite the store. Lines are packed into chunks of about ENTRY_CHUNK_BYTES in
 * order; a chunk whose bytes did not change is not touched (so git sees only the
 * chunks an edit reached). Each chunk is written atomically (temp file, rename).
 */
export function writeEntries(entries){
  fs.mkdirSync(PATHS.entries, { recursive: true });
  const chunks = [];
  let cur = [], bytes = 0;
  for(const e of entries){
    const line = entryLine(e) + '\n';
    if(bytes + line.length > ENTRY_CHUNK_BYTES && cur.length){ chunks.push(cur.join('')); cur = []; bytes = 0; }
    cur.push(line); bytes += Buffer.byteLength(line);
  }
  if(cur.length || !chunks.length) chunks.push(cur.join(''));
  chunks.forEach((text, i) => {
    const f = path.join(PATHS.entries, chunkName(i));
    if(fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) return;
    fs.writeFileSync(f + '.tmp', text);
    fs.renameSync(f + '.tmp', f);
  });
  for(const f of entryChunks().slice(chunks.length)) fs.unlinkSync(f);
}

export function appendEntries(entries){
  if(!entries.length) return;
  fs.mkdirSync(PATHS.entries, { recursive: true });
  const files = entryChunks();
  let i = Math.max(0, files.length - 1);
  let f = path.join(PATHS.entries, chunkName(i));
  let size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  let buf = '';
  const flush = () => { if(buf){ fs.appendFileSync(f, buf); buf = ''; } };
  for(const e of entries){
    const line = entryLine(e) + '\n';
    if(size + line.length > ENTRY_CHUNK_BYTES && size > 0){ flush(); i++; f = path.join(PATHS.entries, chunkName(i)); size = 0; }
    buf += line; size += Buffer.byteLength(line);
  }
  flush();
}

// ---------------------------------------------------------------------------
// The text that gets embedded
// ---------------------------------------------------------------------------

/**
 * Build the document string for an entry.
 *
 * This function decides the shape of the whole atlas, because clusters form on
 * whatever the embedding sees. Included, in order of weight:
 *
 *   title + subtitle   the strongest identity signal
 *   topics             curated and specific, so they pull genuine kin together
 *   excerpt            the substance; truncated because the tail of a long
 *                      excerpt is usually context that dilutes the topic
 *
 * Two things are deliberately EXCLUDED.
 *
 * `domains` — the broad bucket an entry came from ("art", "film", "leaders").
 * Including it was tried and it wrecked the map: because a domain tag is
 * perfectly correlated with the source file, it carries zero information *within*
 * a domain while forcing a large constant separation *between* domains. The
 * hierarchy then just re-derived the eight original CSVs, which is exactly the
 * category-per-row structure this rework exists to escape. Left out, a Picasso
 * painting can sit beside Picasso the person and beside Cubism as a movement.
 *
 * The date — year is already the x-axis. Letting it into the vector would make y
 * partly redundant with x and bend the whole map into a diagonal, wasting the
 * dimension that is supposed to carry meaning.
 */
/*
 * Topic tags that are really DATES: Wikipedia's date categories ("1066 in
 * england", "1491 births", "8th-century bc establishments"). 26% of all tags on
 * 35% of entries, measured 2026-11-13. Time is the x axis and a number on every
 * entry; inside the embedding it only adds noise (embedding models represent
 * numbers poorly) and pulls entries together by calendar coincidence. Kept on
 * the entry for filtering, removed from what is embedded.
 */
export const DATE_TAG = /\b\d{1,4}s?\b|\bcentury\b|\bcenturies\b|\bmillennium\b|\bbirths\b|\bdeaths\b|\bestablishments\b|\bdisestablishments\b/i;

export function entryText(e, maxExcerpt = 700){
  const head = [e.title, e.subtitle].filter(Boolean).join(' — ');
  const topics = (e.topics || []).filter((t) => !DATE_TAG.test(t)).join(', ');
  const facets = Object.entries(e.facets || {})
    // A date is `start`/`end`'s job. In the text it only pulls entries together by
    // calendar coincidence — "24 January" is not what an event is about.
    .filter(([k]) => !/^(year|years|date|dates)$/.test(k))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('; ');
  const body = String(e.excerpt || '').replace(/\s+/g, ' ').slice(0, maxExcerpt);

  const text = [topics && `[${topics}]`, facets, body].filter(Boolean).join(' ');

  // EmbeddingGemma is trained on this exact `title: … | text: …` document form;
  // feeding it bare text measurably degrades neighbourhood quality. An entry
  // with no excerpt yet still needs a non-empty body, so fall back to the head.
  return `title: ${head} | text: ${text || head}`;
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

function readVecMeta(metaPath = PATHS.vecMeta, dim = DIM){
  if(!fs.existsSync(metaPath)) return { model: null, dim, native: null, ids: [] };
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

/**
 * The search-vector store: same int8-plus-scale row format as `vectors.bin`, at
 * SEARCH_DIM. Returns the same shape as `readVectors`, or null when absent — a
 * store built before search vectors existed simply searches at 256 dims.
 */
export function readSearchVectors(){
  if(!fs.existsSync(PATHS.searchVecMeta) || !vecChunks(PATHS.searchVectors).length) return null;
  return readVecFile(PATHS.searchVectors, PATHS.searchVecMeta, SEARCH_DIM);
}

export function writeSearchVectors(pairs, { model } = {}){
  writeVecFile(PATHS.searchVectors, PATHS.searchVecMeta, pairs, { model, native: SEARCH_DIM });
}

/**
 * Load every stored vector as float32, keyed by entry id.
 * Returns `{ model, dim, ids, get(id) -> Float32Array|null }`.
 */
export function readVectors(){
  return readVecFile(PATHS.vectors, PATHS.vecMeta, DIM);
}

/** The chunk files of a vector store (prefix -> prefix-000.bin, …), in order. */
export function vecChunks(prefix){
  const dir = path.dirname(prefix), base = path.basename(prefix);
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => new RegExp(`^${base}-\\d{3}\\.bin$`).test(f)).sort().map((f) => path.join(dir, f));
}
const vecChunkName = (prefix, i) => `${prefix}-${String(i).padStart(3, '0')}.bin`;

function readVecFile(binPath, metaPath, defaultDim){
  const meta = readVecMeta(metaPath, defaultDim);
  const dim = meta.dim || defaultDim;
  const rowBytes = 4 + dim;
  const parts = vecChunks(binPath).map((f) => fs.readFileSync(f));
  const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  const rows = Math.floor(buf.length / rowBytes);

  if(rows !== meta.ids.length){
    throw new Error(
      `${path.basename(binPath)}-*.bin hold ${rows} rows but ${path.basename(metaPath)} indexes ${meta.ids.length}. ` +
      `Re-run: node datasets/embed-all.mjs --force`,
    );
  }

  const index = new Map(meta.ids.map((id, i) => [id, i]));

  const get = (id) => {
    const i = index.get(id);
    if(i === undefined) return null;
    const off = i * rowBytes;
    const scale = buf.readFloatLE(off);
    const out = new Float32Array(dim);
    for(let d = 0; d < dim; d++) out[d] = buf.readInt8(off + 4 + d) * scale;
    return out;
  };

  return { model: meta.model, dim, native: meta.native, ids: meta.ids, index, get, has: (id) => index.has(id), buf, rowBytes };
}

/** Write rows (Buffers) as chunks of CHUNK_ROWS, skipping chunks whose bytes are unchanged. */
function writeVecChunks(prefix, rowBufs){
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const n = Math.max(1, Math.ceil(rowBufs.length / CHUNK_ROWS));
  for(let i = 0; i < n; i++){
    const b = Buffer.concat(rowBufs.slice(i * CHUNK_ROWS, (i + 1) * CHUNK_ROWS));
    const f = vecChunkName(prefix, i);
    if(fs.existsSync(f) && fs.readFileSync(f).equals(b)) continue;
    fs.writeFileSync(f + '.tmp', b);
    fs.renameSync(f + '.tmp', f);
  }
  for(const f of vecChunks(prefix).slice(n)) fs.unlinkSync(f);
}

/** Quantise one float vector to a `4 + dim` byte row. */
export function packVector(vec){
  const dim = vec.length;
  let maxAbs = 0;
  for(let d = 0; d < dim; d++){ const a = Math.abs(vec[d]); if(a > maxAbs) maxAbs = a; }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const row = Buffer.alloc(4 + dim);
  row.writeFloatLE(scale, 0);
  for(let d = 0; d < dim; d++){
    row.writeInt8(Math.max(-127, Math.min(127, Math.round(vec[d] / scale))), 4 + d);
  }
  return row;
}

/**
 * Truncate to `dim` (Matryoshka prefix) and re-normalise to unit length, so
 * every stored vector is directly comparable by dot product.
 */
export function truncateNormalize(vec, dim = DIM){
  const n = Math.min(dim, vec.length);
  const out = new Float32Array(n);
  let sum = 0;
  for(let d = 0; d < n; d++){ out[d] = vec[d]; sum += vec[d] * vec[d]; }
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for(let d = 0; d < n; d++) out[d] *= inv;
  return out;
}

/**
 * Rewrite the vector store from `pairs` ([id, Float32Array][]) in the given
 * order. Order is the file's own; nothing outside relies on it.
 */
export function writeVectors(pairs, { model, native } = {}){
  writeVecFile(PATHS.vectors, PATHS.vecMeta, pairs, { model, native });
}

function writeVecFile(binPath, metaPath, pairs, { model, native } = {}){
  const dim = pairs.length ? pairs[0][1].length : DIM;
  writeVecChunks(binPath, pairs.map(([, v]) => packVector(v)));
  fs.writeFileSync(metaPath, JSON.stringify({
    model, native, dim, count: pairs.length, ids: pairs.map(([id]) => id),
  }, null, 0) + '\n');
}

/** Append new map vectors, keeping existing rows (and full chunks) byte-identical. */
export function appendVectors(pairs, opts = {}){
  appendVecFile(PATHS.vectors, PATHS.vecMeta, DIM, pairs, opts);
}
/** Same for the search vectors. */
export function appendSearchVectors(pairs, opts = {}){
  appendVecFile(PATHS.searchVectors, PATHS.searchVecMeta, SEARCH_DIM, pairs, opts);
}
function appendVecFile(prefix, metaPath, defaultDim, pairs, { model, native } = {}){
  if(!pairs.length) return;
  const meta = readVecMeta(metaPath, defaultDim);
  const dim = meta.dim || pairs[0][1].length;
  const rowBytes = 4 + dim;
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  let row = meta.ids.length;
  for(const [, v] of pairs){
    const i = Math.floor(row / CHUNK_ROWS);
    fs.appendFileSync(vecChunkName(prefix, i), packVector(v));
    row++;
  }
  // Sanity: the last chunk holds exactly the rows past the full ones.
  const last = vecChunks(prefix).at(-1);
  if(last && fs.statSync(last).size !== ((row - 1) % CHUNK_ROWS + 1) * rowBytes) throw new Error(`${path.basename(last)}: row count drifted`);
  fs.writeFileSync(metaPath, JSON.stringify({
    model: model || meta.model,
    native: native || meta.native,
    dim,
    count: meta.ids.length + pairs.length,
    ids: [...meta.ids, ...pairs.map(([id]) => id)],
  }, null, 0) + '\n');
}

// ---------------------------------------------------------------------------
// Label vocabulary
// ---------------------------------------------------------------------------
//
// Cluster labels are chosen by embedding a candidate vocabulary and taking the
// term nearest each node's centroid, so a build needs vectors for words as well
// as for entries. They are cached because the vocabulary barely moves between
// builds — a term qualifies by appearing in several entries, so adding a few
// hundred entries changes a handful of rows. Same int8-plus-scale row format as
// `vectors.bin`, and for the same reason: a fixed scale over [-1,1] would waste
// nine tenths of the available levels on L2-normalised input.

/** Write vocabulary vectors. `pairs` is `[term, Float32Array][]`. */
export function writeVocab(pairs, { model } = {}){
  fs.mkdirSync(ATLAS_DIR, { recursive: true });
  const dim = pairs.length ? pairs[0][1].length : DIM;
  fs.writeFileSync(PATHS.vocab + '.tmp', Buffer.concat(pairs.map(([, v]) => packVector(v))));
  fs.renameSync(PATHS.vocab + '.tmp', PATHS.vocab);
  fs.writeFileSync(PATHS.vocabMeta, JSON.stringify({
    model, dim, count: pairs.length, terms: pairs.map(([t]) => t),
  }, null, 0) + '\n');
}

/**
 * Load cached vocabulary vectors as `{ model, dim, terms, get(term) }`, or null
 * if absent. A mismatch between the two files is treated as no cache rather than
 * an error — it costs one re-embed of a few thousand short strings.
 */
export function readVocab(){
  if(!fs.existsSync(PATHS.vocab) || !fs.existsSync(PATHS.vocabMeta)) return null;
  const meta = JSON.parse(fs.readFileSync(PATHS.vocabMeta, 'utf8'));
  const dim = meta.dim || DIM;
  const rowBytes = 4 + dim;
  const buf = fs.readFileSync(PATHS.vocab);
  if(Math.floor(buf.length / rowBytes) !== meta.terms.length) return null;

  const index = new Map(meta.terms.map((t, i) => [t, i]));
  const get = (term) => {
    const i = index.get(term);
    if(i === undefined) return null;
    const off = i * rowBytes;
    const scale = buf.readFloatLE(off);
    const out = new Float32Array(dim);
    for(let d = 0; d < dim; d++) out[d] = buf.readInt8(off + 4 + d) * scale;
    return out;
  };
  return { model: meta.model, dim, terms: meta.terms, get };
}

/**
 * Entry ids are stable: nothing renames one. When a script MERGES entries
 * (dedupe) or must re-id one, it records old id -> surviving id here, in
 * store/id-aliases.json (tracked). build-web.mjs publishes it as
 * web/aliases.json and the browser moves a learner's answer records
 * (quiz.js migrateMastery); a server will do the same for logged-in users.
 */
export function recordAliases(map){
  const f = path.join(STORE_DIR, 'id-aliases.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for(const [from, to] of Object.entries(map)) if(from && to && from !== to) cur[from] = to;
  // Chains (a -> b, b -> c) resolve to the end.
  for(const k of Object.keys(cur)){ let t = cur[k], guard = 0; while(cur[t] && guard++ < 20) t = cur[t]; cur[k] = t; }
  fs.writeFileSync(f, JSON.stringify(cur, null, 1) + '\n');
}

export const readJSON = (p, fallback = null) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;

export function writeJSON(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
}
