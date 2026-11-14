# Trivia — topics, an atlas, and a quiz over one corpus

A static site (no build step, no npm) built on a corpus of ~9,600 dated
Wikipedia entries. The home screen has three doors:

- **Topics** — one subject at a time (e.g. *England*, built from the article
  *History of England*): an image-card **timeline** split into the article's own
  chapters, a **read** outline, and a **quiz** on order, era and recall. The view
  for *learning* a subject. → [`docs/TOPICS.md`](docs/TOPICS.md)
- **Atlas** — a zoomable map where **x is time** and **y is subject**, with
  known subject layers (History › Military, Culture › Films, Science › Physics…)
  on top and embedding clusters inside each. The view for *exploring across*
  subjects. → [`docs/ATLAS.md`](docs/ATLAS.md)
- **Quiz** — one quiz over the whole corpus, filtered by picking a node of the
  atlas's cluster tree. → [`docs/QUIZ.md`](docs/QUIZ.md)

All three read the same compiled store in `datasets/atlas/`. "Quiz me on this
cluster" only works because the atlas already computed the clusters, so a
rebuild of the map is a rebuild of the quiz.

## Running it

The app uses ES modules and `fetch`, so `file://` will not work — serve it:

```
node datasets/serve.mjs          # then open http://localhost:8777/
```

**Use this, not `python3 -m http.server`.** It serves everything `no-store`, and
it provides `/api/search` (hybrid BM25 + embeddings; needs Ollama running). The
Python server lets Chrome serve stale modules from its disk cache with nothing
in the console, which reads as "my change did nothing".

The atlas opens in a **named popup window**, so allow pop-ups.

## Layout

```
index.html                    app shell (Tailwind via CDN)
project/
  app/init.js, render.js      entry point, hash routing, home render
  ui/home.js, header.js       the three doors
  utils/helpers.js            $, shuffle, Wikimedia thumbUrl/fullUrl
  features/topic/             TOPICS — timeline layout, read view, topic quiz
  features/atlas/             THE ATLAS renderer
  features/quiz/              THE QUIZ — questions.js derives what to ask
datasets/
  atlas/                      the compiled store the browser fetches
  topics/                     one JSON per topic + index.json
  *.csv                       the original hand-curated sources (read by migrate)
  crawl.txt, crawl-state.json what the crawler fetches, and how far it got
  crawl.mjs ingest.mjs        the pipeline — see below
  classify.mjs embed-all.mjs
  atlas.mjs topic.mjs serve.mjs
  lib/                        shared code (store, cluster, wiki, years, search…)
  qa/                         verify + browser QA suites + reload
  scripts/                    one-off/maintenance scripts (own README)
  archive/                    old CSV backups, logs and miss lists
  suggestions/                suggest.mjs output
docs/                         the long-form docs (below)
thumbnails/                   old local thumbnail cache (unused by the app)
```

## The pipeline

Everything is free; only embedding uses the local GPU (Ollama, throttled).

```
crawl.mjs    crawl.txt lines: category | search: articletopic:<subject> | wikidata: <type> <from>-<to>
  → ingest.mjs     Wikipedia/Wikidata → entries.jsonl, embeds new rows (map 256-d + search 768-d)
  → classify.mjs   subject + region per entry → atlas/taxonomy.json (Wikimedia Lift Wing + kNN vote)
  → atlas.mjs      known top layers + clusters below → atlas.json / details.json
topic.mjs "History of X" [--events "Timeline of X"] [--ingest]  → datasets/topics/<slug>.json
```

The crawler is resumable and runs `classify` and an incremental `atlas` itself.
For a full re-fit: `node datasets/atlas.mjs --rebuild`.

## Checks

```
node datasets/qa/verify.mjs       # store invariants, no browser
node datasets/qa/qa-topic.mjs     # topic layout, no browser
node datasets/qa/qa-atlas.mjs     # needs serve.mjs + headless Chrome on :9334
node datasets/qa/qa-quiz.mjs      # same
```

Browser setup and gotchas: [`docs/QA.md`](docs/QA.md).

## Docs

| file | what |
|---|---|
| [`docs/PIPELINE.md`](docs/PIPELINE.md) | the data pipeline — **read before touching any of it** |
| [`docs/ADDING-DATA.md`](docs/ADDING-DATA.md) | crawling, ingesting, extending a dataset |
| [`docs/ATLAS.md`](docs/ATLAS.md) | atlas design decisions, gotchas, rough edges |
| [`docs/TOPICS.md`](docs/TOPICS.md) | how a topic is built from an article |
| [`docs/QUIZ.md`](docs/QUIZ.md) | question derivation and grading |
| [`docs/SEARCH.md`](docs/SEARCH.md) | every search/embedding measurement, and why |
| [`docs/QA.md`](docs/QA.md) | headless-Chrome QA, reloading from the terminal |
| [`datasets/scripts/README.md`](datasets/scripts/README.md) | the one-off CSV/excerpt/enrichment scripts |
| [`HANDOFF.md`](HANDOFF.md) | session-by-session state and what is next |
| `docs/archive/` | the deleted lane timeline, old handoffs |
