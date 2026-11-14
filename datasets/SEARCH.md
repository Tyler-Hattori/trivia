# Search and embeddings — what was measured, and what changed (2026-11-13)

Short version: the embedding model was fine. Search was weak for three other
reasons, and "filter to a subject" can't be done with similarity alone.

## 1. The query was embedded without EmbeddingGemma's query prefix

EmbeddingGemma is trained asymmetrically. Documents are `title: … | text: …`
(which `entryText` already did) and **queries are
`task: search result | query: …`**. `serve.mjs` sent the query bare, so it was
embedded *as a document*. The old README blamed "anisotropy" for this, but it
was the missing prefix:

| query | bare (old) best match | with prefix, 768-d (new) |
|---|---|---|
| `zzzznotathing` | 0.58 | **0.28** |
| `asdf qwerty` / `the` | — | 0.29 / 0.31 |
| `cubism` | 0.557 | 0.57 |
| `tudor dynasty` | 0.59 (Habsburg 3rd) | 0.61 (all Tudor monarchs top 8) |
| `black death` | — | 0.61 |

Nonsense now tops out near 0.34 and real queries start near 0.47, so
**`SEM_FLOOR = 0.40`** separates them and a nonsense search returns nothing.
`QUERY_PREFIX` / `embedQuery()` are in `lib/ollama.mjs`.

## 2. Search used the 256-dim map vectors

Retrieval benchmark: 13 queries with structurally defined gold sets (a movement,
a role + country, or the source page). Scores are P@20 / R-precision, averaged:

| vectors | text format | mean P@20 / R-prec |
|---|---|---|
| stored (256-d, int8) | current `entryText` | 66.2 / 58.9 |
| 768-d | current `entryText` | **67.3 / 64.4** |
| 768-d | clean: title + first ~500 chars, no topics/facets | 65.0 / 58.2 |
| 768-d | clean + key facets | 65.8 / 61.1 |
| 256-d | each of the above | 53.6 – 58.9 |

- **Full width is worth ~5.5 points of R-precision.** Search now reads
  `atlas/search-vectors.bin` (768-d int8, 6.3 MB, server-side only). The
  **map** keeps its 256-d `vectors.bin`, so no point on the atlas moved.
- **int8 storage costs nothing** (stored 256 = float 256).
- **Text format barely matters**, and the current one is best. The Wikipedia
  categories in `topics` help slightly.

### Is embedding very different text lengths a problem?

Mostly no. Excerpts run from ~100 to ~1,500 characters (`entryText` caps the
excerpt at 700). Hubness, i.e. how often an entry lands in other entries'
top-10, by excerpt length:

| excerpt chars | n | mean k-occurrence (10 = fair) | % hubs (≥30) |
|---|---|---|---|
| 0–150 | 719 | 8.9 | 0.7% |
| 150–300 | 648 | 8.0 | 0.8% |
| 300–500 | 1443 | 9.0 | 0.7% |
| 500–800 | 2546 | 10.1 | 1.2% |
| 800+ | 2788 | 11.1 | 2.8% |

There's a mild tilt toward long entries, but the biggest hubs are broad
*overview* articles (Kingdom of Italy, Paleolithic, Napoleonic Wars). That is
about breadth of subject, not length, and a "card" format that normalises length
scored no better (table above). The `MIN_EXCERPT = 300` rule in `lib/wiki.mjs`
already covers the short end.

## 3. Keywords were substring-only and semantic was top-40-always

`/api/search` (`lib/search.mjs`) is now hybrid:

- **BM25** (`lib/textsearch.mjs`): title counted twice, a tiny plural-only
  stemmer, and ≥60% of query terms must match. Plain BM25 is an OR, so
  "guy who invented the telephone" ranked *John Guy* 5th.
- **Semantic** at 768-d with the prefix, cut at the floor, then within
  `SEM_WINDOW = 0.16` of the best hit.
- **Keyword hits must be loosely about the query** (similarity ≥ 0.26). This
  removed "black death" → *Saturn Devouring One of His Sons*, whose excerpt says
  "black" and, separately, "death". It keeps "battle of hastings" →
  *Norman Conquest* (0.277). The gap is narrow, so treat 0.26 as a judgement call.
- **Reciprocal-rank fusion** (k=60, semantic weighted 1.0, keywords 0.9).
- **Inside a topic** (`?topic=slug`) the cut is looser (top 12, down to 0.30),
  because every candidate is already on-subject. "who broke with the pope" needs
  that to reach *Henry VIII severs ties with the Catholic Church* (0.317).

Without Ollama it fails soft to keyword-only (`semantic: false`). The topic page
also runs BM25 in the browser, so it searches on a static host too.

## 4. Similarity cannot define a subject — which is why Topics exist

For "English history" at full width with the prefix: 33 entries score ≥ 0.45.
*Richard II* is #100 (0.41) and *Stonehenge* #300 (0.35), with French events
between them. R-precision for "history of Germany" stays ~35% across every
format and width above. Embeddings rank well, but they can't tell you where a
subject ends.

So a topic's **membership** comes from structure, not from a threshold. See
`topic.mjs`:

- the pages its source article links to, and a timeline page's mined events
- **chapters** from the article's own headings
- **date checks** against the chapter that mentions each entry

Embeddings are used for what they're good at: ranking a search inside the topic.

## Running models without heating the laptop

A full-corpus re-embed at full speed holds the GPU at 100% for minutes. That
happened once during the measurements above. The defaults are now gentle:

- `embed-all.mjs` uses batches of 16 with a 400 ms pause (`--batch`,
  `--pause 0` to go fast). Normal use only embeds new rows anyway.
- `ingest.mjs` uses batches of 16 with a 250 ms pause.
- Embedding requests set `keep_alive: 2m` (`TRIVIA_EMBED_KEEPALIVE`), so the
  ~600 MB model unloads soon after you stop searching.
- Recommended server limits:

  ```
  OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=2m ollama serve
  ```

- A search query is one short string, a few ms of GPU time.
- Avoid the larger models here (`qwen3-embedding`, `qwen3:8b`) unless you mean to
  run something long.
