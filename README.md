# Trivia — topics, an atlas, and a quiz over one corpus

A static site (no build step, no npm) built on a corpus of ~12,000 dated
Wikipedia entries. **The home page is the topic list.**

- **Topics** — one subject at a time (e.g. *England*, built from the article
  *History of England*): a **Learn** view in the article's own words, an
  image-card **timeline**, and a **quiz** (Order / Era / Recall). Each entry's
  detail panel has **Meanwhile**: what the other topics were doing in the same
  years. → [`docs/TOPICS.md`](docs/TOPICS.md)
- **Review** (`#/review`) — spaced repetition across every topic: what you
  answered before comes back after 1, 3, 7, 16, 35 and 90 days.
- **Quiz all** (`#/quiz`) — one quiz over every topic; Order questions mix
  subjects ("which came first?"). → [`docs/QUIZ.md`](docs/QUIZ.md)
- **Atlas** — a zoomable map where **x is time** and **y is subject**. The view
  for *exploring across* subjects; its detail panel links back to the topics an
  entry is in. → [`docs/ATLAS.md`](docs/ATLAS.md)
- The older **cluster quiz** over the whole corpus is at `#/cluster-quiz`.

Works on a phone: the contents rail becomes a drawer and the detail panel a
full screen.

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
  app/init.js, render.js      entry point, hash routing
  ui/home.js, header.js       the old three-door page (#/home, unlinked)
  utils/helpers.js            $, shuffle, Wikimedia thumbUrl/fullUrl
  features/topic/             TOPICS — the home list, learn, timeline, quiz (+ review,
                              cross-topic quiz, Meanwhile)
  features/atlas/             THE ATLAS renderer
  features/quiz/              THE QUIZ — questions.js derives what to ask
datasets/
  store/                      THE STORE (tracked): entries/ chunks, vectors/ chunks,
                              layout, taxonomy, ideas, vocab, id-aliases
  atlas/                      generated: atlas.json (+ details.json, knn cache)
  topics/                     generated: one JSON per topic + index.json, members*.json
  web/                        generated: the whole-store files the browser fetches, cut small
  topics.txt                  every topic (the registry); topic-structure.json the tree
  topic-overrides.json        hand corrections per topic (see docs/TOPICS.md)
  *.csv                       the original hand-curated sources (read by migrate)
  crawl.txt, crawl-state.json what the crawler fetches, and how far it got
  crawl.mjs ingest.mjs        the pipeline — see below
  classify.mjs embed-all.mjs
  atlas.mjs topic.mjs serve.mjs
  build-web.mjs deploy.mjs    web/ files; publish to the gh-pages branch
  lib/                        shared code (store, cluster, wiki, years, search…)
  qa/                         verify + browser QA suites + reload
  scripts/                    one-off/maintenance scripts (own README)
  archive/                    old CSV backups, logs and miss lists
  suggestions/                suggest.mjs output
docs/                         the long-form docs (below)
```

## The pipeline

Everything is free; only embedding uses the local GPU (Ollama, throttled).

```
crawl.mjs    crawl.txt lines: category | search: articletopic:<subject> | wikidata: <type> <from>-<to>
  → ingest.mjs     Wikipedia/Wikidata → store/entries, embeds new rows (map 256-d + search 768-d)
  → classify.mjs   subject + region per entry → store/taxonomy.json (Wikimedia Lift Wing + kNN vote)
  → atlas.mjs      known top layers + clusters below → atlas/atlas.json, details.json
topic.mjs "History of X" [--events "Timeline of X"] [--ingest]  → datasets/topics/<slug>.json
build-web.mjs    (run by the above) → datasets/web/
deploy.mjs       → the gh-pages branch, which GitHub Pages serves (one commit, replaced each time)
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
