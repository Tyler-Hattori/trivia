/**
 * The atlas store.
 *
 * Two files hold everything:
 *
 *   atlas/entries.jsonl   one JSON object per line, append-only, git-diffable
 *   atlas/vectors.bin     one quantised embedding per entry, fixed-width rows
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
export const ATLAS_DIR    = path.join(DATASETS_DIR, 'atlas');

export const PATHS = {
  entries: path.join(ATLAS_DIR, 'entries.jsonl'),
  vectors: path.join(ATLAS_DIR, 'vectors.bin'),
  vecMeta: path.join(ATLAS_DIR, 'vectors.json'),
  layout:  path.join(ATLAS_DIR, 'layout.json'),
  atlas:   path.join(ATLAS_DIR, 'atlas.json'),
  details: path.join(ATLAS_DIR, 'details.json'),
  vocab:     path.join(ATLAS_DIR, 'vocab.bin'),
  vocabMeta: path.join(ATLAS_DIR, 'vocab.json'),
};

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
  if(!fs.existsSync(PATHS.entries)) return [];
  const out = [];
  const text = fs.readFileSync(PATHS.entries, 'utf8');
  let lineNo = 0;
  for(const line of text.split('\n')){
    lineNo++;
    const s = line.trim();
    if(!s) continue;
    try { out.push(JSON.parse(s)); }
    catch(e){ throw new Error(`entries.jsonl:${lineNo} is not valid JSON — ${e.message}`); }
  }
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

/** Rewrite the whole file. Atomic: write a temp file, then rename. */
export function writeEntries(entries){
  fs.mkdirSync(ATLAS_DIR, { recursive: true });
  const tmp = PATHS.entries + '.tmp';
  fs.writeFileSync(tmp, entries.map(entryLine).join('\n') + '\n');
  fs.renameSync(tmp, PATHS.entries);
}

export function appendEntries(entries){
  if(!entries.length) return;
  fs.mkdirSync(ATLAS_DIR, { recursive: true });
  fs.appendFileSync(PATHS.entries, entries.map(entryLine).join('\n') + '\n');
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
export function entryText(e, maxExcerpt = 700){
  const head = [e.title, e.subtitle].filter(Boolean).join(' — ');
  const topics = (e.topics || []).join(', ');
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

function readVecMeta(){
  if(!fs.existsSync(PATHS.vecMeta)) return { model: null, dim: DIM, native: null, ids: [] };
  return JSON.parse(fs.readFileSync(PATHS.vecMeta, 'utf8'));
}

/**
 * Load every stored vector as float32, keyed by entry id.
 * Returns `{ model, dim, ids, get(id) -> Float32Array|null }`.
 */
export function readVectors(){
  const meta = readVecMeta();
  const dim = meta.dim || DIM;
  const rowBytes = 4 + dim;
  const buf = fs.existsSync(PATHS.vectors) ? fs.readFileSync(PATHS.vectors) : Buffer.alloc(0);
  const rows = Math.floor(buf.length / rowBytes);

  if(rows !== meta.ids.length){
    throw new Error(
      `vectors.bin holds ${rows} rows but vectors.json indexes ${meta.ids.length}. ` +
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

  return { model: meta.model, dim, native: meta.native, ids: meta.ids, index, get, has: (id) => index.has(id) };
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
  fs.mkdirSync(ATLAS_DIR, { recursive: true });
  const dim = pairs.length ? pairs[0][1].length : DIM;
  const buf = Buffer.concat(pairs.map(([, v]) => packVector(v)));
  fs.writeFileSync(PATHS.vectors + '.tmp', buf);
  fs.renameSync(PATHS.vectors + '.tmp', PATHS.vectors);
  fs.writeFileSync(PATHS.vecMeta, JSON.stringify({
    model, native, dim, count: pairs.length, ids: pairs.map(([id]) => id),
  }, null, 0) + '\n');
}

/** Append new vectors, keeping existing rows byte-identical. */
export function appendVectors(pairs, { model, native } = {}){
  if(!pairs.length) return;
  const meta = readVecMeta();
  fs.mkdirSync(ATLAS_DIR, { recursive: true });
  fs.appendFileSync(PATHS.vectors, Buffer.concat(pairs.map(([, v]) => packVector(v))));
  fs.writeFileSync(PATHS.vecMeta, JSON.stringify({
    model: model || meta.model,
    native: native || meta.native,
    dim: meta.dim || pairs[0][1].length,
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

export const readJSON = (p, fallback = null) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;

export function writeJSON(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
}
