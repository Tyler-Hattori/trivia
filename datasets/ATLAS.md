# The atlas pipeline

How entries get into the timeline. Everything here runs locally, costs nothing
per entry, and needs no Claude — that is the point of it.

The old flow was: hand-write a CSV row, run `enrich.mjs` to fill the blanks, and
the timeline sorted rows into lanes by one category column. The new flow is:
point a script at Wikipedia, and each entry is embedded and placed on a map where
vertical position means *similarity* rather than category membership.

```
Wikipedia + Wikidata          ingest.mjs      free, no model
        ↓
  entries.jsonl               the store       one JSON object per line
        ↓
  EmbeddingGemma              embed-all.mjs   local, ~200MB, 768→256 dims
        ↓
  vectors.bin                 int8 + per-row scale
        ↓
  cluster tree + y            atlas.mjs       deterministic, ~3s for 2,700
        ↓
  atlas.json / details.json                   what the browser loads
```

---

## Setup, once

```
brew install ollama
ollama serve &                      # or just open the Ollama app
ollama pull embeddinggemma          # required, ~200MB
ollama pull qwen3:8b                # optional, ~5GB, only for --reshape
```

**Why EmbeddingGemma.** 308M parameters, 768 dims, trained by Google for
on-device use, and Matryoshka-trained so the first 256 dimensions work on their
own — which is how the store gets a 4× size cut for free rather than by
truncating a model that was never meant to be truncated. It runs at roughly
100 entries/second on an M2 Pro. Alternatives worth knowing: `nomic-embed-text`
(137M, faster, slightly weaker), `bge-m3` (567M, strong, 8k context),
`qwen3-embedding:0.6b` (best raw quality of the three, ~3× the disk).

Override with `TRIVIA_EMBED_MODEL` / `TRIVIA_WRITE_MODEL`.

**Changing the embedding model invalidates the whole store.** Vectors from two
models are not comparable, and mixing them makes entries cluster by *which model
embedded them* before anything else. The scripts refuse to mix and tell you to
run `embed-all.mjs --force`.

---

## Adding entries

`ingest.mjs` is the one command you need.

```bash
# a page, or several
node datasets/ingest.mjs https://en.wikipedia.org/wiki/Guernica_(Picasso)
node datasets/ingest.mjs "The Persistence of Memory" "Battle of Hastings"

# a whole Wikipedia category — this is the bulk lever
node datasets/ingest.mjs --category "Cubist paintings" --domain "art,visual art"
node datasets/ingest.mjs --category "Battles of the Napoleonic Wars" --domain war --deep

# every article linked from a list page
node datasets/ingest.mjs --links "List of Impressionist painters" --domain art

# a file of titles or URLs, one per line, # for comments
node datasets/ingest.mjs @my-list.txt --domain science

# your own prose, blank line between entries, first line is the title
cat <<'EOF' | node datasets/ingest.mjs - --domain philosophy
Critique of Pure Reason
year: 1781
Kant's attempt to establish what reason can know prior to experience.

The Prince
year: 1532
Machiavelli's handbook of statecraft, written for the Medici.
EOF
```

Useful flags:

| flag | effect |
|---|---|
| `--domain a,b` | broad buckets for everything in the run. Filterable; deliberately **not** embedded |
| `--topics a,b` | extra topics for everything in the run. These *are* embedded |
| `--deep` | `--category` also descends one level into subcategories |
| `--limit N` | cap the input list (default 500) |
| `--reshape` | rewrite excerpts into the project's voice with the local LLM |
| `--tag-topics` | let the local LLM propose topic tags |
| `--min-year` / `--max-year` | drop anything outside the range |
| `--dry` | report what would happen, write nothing |
| `--no-build` | skip the atlas update (batch several ingests, then build once) |

**Always `--dry` a big category first.** Wikipedia categories contain stray
members — a category page, a "List of…" article, a museum. `--dry` shows you the
title, year, date source, image and topics for each before anything is written.

Ingestion is **idempotent**: an entry already present (matched on Wikidata QID,
then on page URL, then on id) is skipped, so re-running a list is cheap.

### Where the year comes from

A wrong year is worse than a missing entry — it lands in the wrong century and
nothing flags it. So dates come from Wikidata claims in a fixed order of trust,
and only fall back to text scraping:

| source | meaning | result |
|---|---|---|
| `P580`/`P582` | start / end time | span |
| `P569`/`P570` | birth / death | span |
| `P585` | point in time | point |
| `P571` | inception | point |
| `P577` | publication date | point |
| `title` | `"Metropolis (1927 film)"` | point |
| `lead-text` | first year in the opening sentence | point, marked `circa` |

Every run prints a `date sources:` tally. A run that is mostly `lead-text` is a
run to check by hand.

---

## Rebuilding the map

```
node datasets/atlas.mjs              # place new entries, keep the map stable
node datasets/atlas.mjs --rebuild    # re-fit the hierarchy from scratch
```

This distinction is the most important thing in this document.

**Default mode treats the hierarchy as frozen.** New entries descend the existing
cluster tree to their nearest leaf and are interpolated into the gaps between
their neighbours. Every entry already on the map keeps *exactly* the y it had —
verified, not asserted: `verify.mjs` checks it and a real 25-entry ingest moved
0 of 2,690 existing points and 0 of 228 cluster bands. This is what makes it safe
to add a few hundred entries and still recognise the map afterwards.

**`--rebuild` re-fits everything.** Every y coordinate, cluster boundary and
colour can change. Do it when the corpus has grown enough that the old grouping
no longer describes it — roughly, when a `--rebuild` starts producing visibly
better labels than the frozen tree. The cost of not rebuilding is that bands
slowly crowd as gaps subdivide.

`layout.json` is the file that must persist for stability. Delete it and the next
build is a rebuild whether you asked for one or not.

---

## Checking your work

```
node datasets/verify.mjs                  # 21 invariant checks, ~1s
node datasets/inspect.mjs                 # the tree, top level
node datasets/inspect.mjs --tree 2        # two levels deep
node datasets/inspect.mjs --near cubism   # nearest neighbours — the real test
node datasets/inspect.mjs --leaf 113      # one cluster's members, in y order
node datasets/inspect.mjs --cross         # do clusters cross source files?
```

`--near` is the check that catches bad data fastest. If an entry's nearest
neighbours are not obviously its kin, its excerpt is too thin to embed well:

```
Les Demoiselles D'Avignon (pablo picasso) [1907]   y=0.4896  leaf 113 "Cubism"
  0.901 · Three Women (pablo picasso) [1908]
  0.850 · Nude With Raised Arms (pablo picasso) [1907]
  0.823 · Femme Assise (pablo picasso) [1909]
```

Two checks in `verify.mjs` deserve naming, because they are the design's core
claims and both would fail silently:

- **vertical neighbours are semantic neighbours** — mean similarity of y-adjacent
  pairs must clearly beat random pairs. Currently 0.631 vs 0.285.
- **the axis is not a proxy for time** — y must not correlate with year, or the
  second dimension is wasted duplicating the first. Currently r=0.014.

`--cross` is the one to watch after touching `entryText()`. If every cluster is
100% one source file, the embedding has re-derived the old CSVs and the atlas is
a swimlane chart with extra steps.

---

## The data model

`atlas/entries.jsonl`, one object per line:

```json
{
  "id": "art:les-demoiselles-davignon:1907",
  "title": "Les Demoiselles D'Avignon",
  "subtitle": "pablo picasso",
  "yearText": "1907", "start": 1907, "end": 1907, "kind": "point", "circa": false,
  "domains": ["art", "visual art"],
  "topics": ["cubism", "proto-cubism"],
  "facets": { "artist": "pablo picasso", "movement": "cubism" },
  "excerpt": "…",
  "image": "https://…",
  "origin": { "dataset": "art", "wiki": "https://…", "qid": "Q…" },
  "addedAt": "2026-07-28"
}
```

**JSONL, not CSV.** Excerpts contain commas, quotes and paragraph breaks. The CSV
parser handled none of those without escaping (`%2C` for commas in URLs, the
literal characters `\n\n` for a paragraph break, no quoted newlines at all), and
one unquoted comma silently shifted every later column. Appending an entry here
is appending a line.

**`domains` vs `topics` — the distinction that makes the atlas work.** Domains are
broad buckets implied by where an entry came from; topics are its own specific
subject tags. Only topics are embedded. Domains were embedded in the first
version and it wrecked the map: a domain tag is perfectly correlated with the
source file, so it carries no information *within* a domain while forcing a large
constant separation *between* domains. The hierarchy dutifully re-derived the
eight original CSVs — exactly the category-per-row structure this rework exists
to escape. Left out, a Picasso painting can sit beside Picasso the person and
beside Cubism as a movement.

**Multi-value by construction.** `topics` is a list, so a cell reading
`"science fiction / horror"` becomes two topics and the entry belongs to both.
There is no single slot to force a compound value into, which is why
`"genre 1 / genre 2"` can no longer become a category of its own.

### Vector storage

`vectors.bin` holds one fixed-width row per entry: a float32 scale followed by
256 int8 components.

Per-row scaling is not an optimisation, it is required. Embeddings arrive
L2-normalised, so components cluster near 1/√256 ≈ 0.06 with the largest around
0.19. A fixed int8 scale over [-1,1] would use about 24 of 255 available levels
and throw away the distances the entire atlas is built on.

---

## The old CSVs

`migrate.mjs` converts all eight into `entries.jsonl`. It reads them and never
writes them, so they remain a valid authoring format — write a CSV row, re-run
`migrate.mjs`, then `embed-all.mjs` and `atlas.mjs`. Anything added by
`ingest.mjs` that no CSV accounts for is carried over rather than dropped.

`enrich.mjs` and `suggest.mjs` still work on the CSVs and are still the cheapest
way to fill blanks in them; see the rest of this directory's README. For new
data, `ingest.mjs` supersedes both — it fetches prose, dates, images and topics
in one pass and places the result on the map.

---

## Cost discipline

Unchanged from before, and now easier to honour:

- **Retrieval is not a model's job.** Wikipedia and Wikidata APIs fetch. Free.
- **Embedding is local.** EmbeddingGemma, on your machine, no per-token cost.
- **A generative model is for judgement only** — house-voice reshaping
  (`--reshape`) and topic proposals (`--tag-topics`), both local, both optional.
- **Claude is for what scripts cannot do**: deciding what belongs, resolving the
  entries a run could not date, and curating. Not for bulk text.
