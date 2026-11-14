# Adding or extending a dataset

**1. Write the CSV.** First line is the header; the parser is header-driven, so
column order and where `image` sits do not matter.

- **One record per physical line.** Quoted newlines are *not* supported.
  Paragraph breaks inside an excerpt are the literal two characters `\n\n`.
- Quote any field containing a comma. In image URLs, encode commas as `%2C`.
- The parser warns to the console when a row has more columns than the header —
  that almost always means an unquoted comma.

**2. Register it** in two places (the app no longer reads CSVs, so there is
no browser-side config — `project/core/settings.js` was removed in 2026-11):

- `MAP` in `datasets/scripts/migrate.mjs` — how the columns become an entry:
  ```js
  'wars.csv': {
    title: 'name', subtitle: 'region', years: 'years', kind: 'span',
    topics: ['region'], facets: { side: 'side', region: 'region' },
    domains: ['war'],
  },
  ```
  `topics` reach the embedded text; `facets` are shown and quizzable. Never put
  a date or a domain in either (see `docs/PIPELINE.md`).
- `DATASETS` in `datasets/lib/wikilib.mjs` — only if you want `enrich.mjs` /
  `suggest.mjs` to fill its blanks: which column is the name, which is the
  disambiguating extra, and which fields to fill.

**3. Point vs span.** A `point` reads one year from the `years` column; a `span`
reads a range. Both accept `1543`, `1879-1955`, `27 BC - 14 AD`, `1990-present`,
`c. 1500`. Use spans for anything with a duration — people (lifespan), rulers
(reign), wars, eras, periods.

**4. Which dataset does a row belong to?**

| the thing is… | goes in | type |
|---|---|---|
| a person | `people` | span (lifespan) |
| a ruler's reign | `leaders` | span |
| an artwork | `art` | point |
| a film | `film` | point |
| a philosophical work | `philosophy` | point |
| a discovery / experiment / scientific event | `science` | point |
| a religious event | `religion` | point |
| a U.S. event | `us_history` | point |
| a war or historical period | a span dataset | span |

`science` holds **events**, not biographies — scientists go in `people` with
occupation `scientist/<type>`.

**5. Fill it cheaply.** `datasets/scripts/README.md` documents `enrich.mjs` (free Wikipedia
excerpt + image fill) and `suggest.mjs` (proposes new entries). Run those before
writing anything by hand.

**6. Rebuild the atlas**, or your rows exist in the CSV and nowhere the atlas can see:

```
node datasets/scripts/migrate.mjs      # CSVs -> atlas/entries.jsonl (reads CSVs, never writes them)
node datasets/embed-all.mjs    # fill missing vectors (resumable; also writes the 768-d search vectors)
node datasets/classify.mjs     # known subject + region for new entries (free, Wikimedia APIs)
node datasets/atlas.mjs        # place new entries, keep the map stable
node datasets/qa/verify.mjs       # 31 invariants
```

Use plain `atlas.mjs`, **not `--rebuild`**, unless you mean to re-fit the whole
hierarchy: incremental placement holds every existing `y` exactly, so the map does
not move under you. `--rebuild` throws that away.

`embed-all.mjs` only fills *missing* vectors — nothing hashes entry text, so it
cannot see an **edited** title or excerpt. After editing existing rows you need
`--force`, which re-embeds all of them.

## Crawling — the easiest way to add a lot

`crawl.mjs` runs the whole pipeline from a list: list pages → `ingest.mjs`
(dates, images, excerpts, throttled embedding) → `classify.mjs` → `atlas.mjs`.
It's free and resumable, and each line runs once (`crawl-state.json`).

```
node datasets/crawl.mjs --dry      # sizes and examples for every pending line of crawl.txt
node datasets/crawl.mjs            # do it
node datasets/crawl.mjs --redo "Wars of the Roses"
```

A line in `datasets/crawl.txt` is one of three things:

| line | gets you | example |
|---|---|---|
| a **category** | its pages, `depth` levels of subcategories down | `Impressionist paintings \| art \| 1 \| 300` |
| `search:` | Wikipedia search, so `articletopic:<subject>` gives **a subject** | `search: articletopic:military-and-warfare incategory:"Kingdom of England"` |
| `wikidata:` | **a type in a date range, most famous first**: decades, centuries | `wikidata: painting 1880-1889 \| art \| - \| 200` |

Things worth knowing:

- **Wikipedia's category graph has cycles.** `crawl.mjs` keeps a seen-set,
  skips date-bin subcategories ("1066 in England"), and stops at `depth` and
  `limit`. Start from *specific* categories. A few levels down from "History"
  is a large share of the encyclopedia.
- **`wikidata:` uses one date property per type:**

  | types | dated by |
  |---|---|
  | painting, sculpture, building, cathedral, castle, opera, symphony | inception (made) |
  | film, novel, book, poem | publication |
  | battle, siege, election, disaster | point in time |
  | war, rebellion, revolution, expedition | start time |
  | treaty | point in time or inception |
  | invention, discovery | time of discovery or invention |
  | person | birth |

  Mixing date properties over a big class (about 1M paintings) timed out the
  free query service. Notability (≥3 language editions) is filtered first.
  If a decade query still times out, the crawler falls back to Wikipedia's
  decade category ("1880s paintings").
- **Categories bring obscure pages.** "Wars of the Roses" includes *Black Lady
  of Bradley Woods*. `ingest.mjs` drops anything it can't date. Topics' **Key**
  mode and the atlas's fame-weighted labels keep the rest in the background.
  `wikidata:` lines are fame-ordered, so they don't have this problem.

## Adding data without a CSV — the thing to actually use

`ingest.mjs` pulls from Wikipedia/Wikidata straight into the store:

```
node datasets/ingest.mjs --category "Battles of the Napoleonic Wars" --domain war --deep
node datasets/ingest.mjs --links "List of Impressionist painters" --domain art
node datasets/ingest.mjs @list.txt --domain science --reshape
node datasets/ingest.mjs --events "Timeline of natural history" --domain geology --dry
node datasets/ingest.mjs --events "Timeline of English history" --domain politics --dry
```

`--events` is the odd one out: it mines **many** dated events from a single page,
which is the only way deep time gets in — the Hadean is a line in a timeline
article, not a page with an inception date. `--dry` first; it reads prose rather
than a Wikidata claim, so it is the least trustworthy input the pipeline has.

It reads a page **two ways, and needs to**: `wikitable` rows and dated lines of
running text. The split is not a matter of degree — *Timeline of English history* is
22 tables of one event per row and *History of quantum mechanics* is narrative
paragraphs, and both returned zero events until each path was built. Tables and
line-headed text are mined by default and tallied as `mined-table` and
`mined-line`. Mid-sentence dates (`mined-prose`) are **always mined and counted but
only kept with `--events-prose`** — the flag gates writing, not looking, so one
`--dry` run tells you the shape of a page instead of reporting "nothing found" and
making you re-fetch it. They stay opt-in because on an article that is not a
timeline roughly half of them are commentary and cited publication years — 105 such
candidates on *Cubism*. `docs/PIPELINE.md` has the details, including the `rowspan`
trap, why the strict pass must complete before any prose is considered, and how the
era is recovered when a page states it once in a section heading.

**`migrate.mjs` deletes entries, and getting its carry-over rule wrong has cost
data twice.** It rewrites `entries.jsonl` from the CSVs and carries over everything
else, so the rule deciding "everything else" is load-bearing. Keying it on
`origin.dataset` dropped every `--domain art` ingest (`--domain art` *sets*
`dataset: 'art'`); keying it on `origin.wiki || origin.qid` dropped every
hand-entered row (`wiki: ''`, `qid: null`) — the one kind nothing can re-fetch. It
now tests whether a row *looks like a CSV row*, honours `origin.manual: true`, and
refuses to write at all when it would delete something unless you pass `--prune`.
Keep it that way round: a stale row kept is visible and fixable, a mined row
deleted is gone.
