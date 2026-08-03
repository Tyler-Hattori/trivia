# Datasets — status and tooling

> **The pipeline has changed.** Entries now live in `atlas/entries.jsonl` and are
> placed on the timeline by embedding, not by category column. Read
> **[ATLAS.md](ATLAS.md)** first — it covers `ingest.mjs` (add entries from
> Wikipedia in bulk, no Claude), `embed-all.mjs`, `atlas.mjs`, `verify.mjs` and
> `inspect.mjs`.
>
> The CSVs below are still a valid authoring format: edit one, then re-run
> `migrate.mjs && embed-all.mjs && atlas.mjs`. `enrich.mjs` and `suggest.mjs`
> still work on them and are still the cheapest way to fill their blanks.

Schema, CSV rules and how to register a new dataset live in the [root README](../README.md).
This file is about **filling** the CSVs.

## Where things stand (measured 2026-07-26)

| dataset | rows | image | excerpt | avg excerpt | house style¹ | what it needs next |
|---|---|---|---|---|---|---|
| `art` | 848 | 848/848 | **1/848** | — | 1 | **excerpts — the single biggest gap.** `enrich.mjs art.csv` fills all 847 for free |
| `leaders` | 999 | 999/999 | 999/999 | 79 ch | 0 | **rewrite:** every excerpt is the terse fragment style ("Cold War end. Gulf War.") the project rejects |
| `film` | 628 | 525/628 | 526/628 | 451 ch | 0 | 103 images + 102 excerpts missing; then a house-style pass |
| `science` | 108 | **31/108** | 108/108 | 453 ch | 22 | images for the iconic ones; broaden past physics (biology, chemistry, medicine, earth) |
| `people` | 21 | 21/21 | 21/21 | 249 ch | 21 | **the quality bar — copy this one's voice.** Grow it: add every figure named in `science` events |
| `philosophy` | 14 | 14/14 | 14/14 | 119 ch | 0 | thin + excerpts too short; expand and deepen |
| `us_history` | 12 | 12/12 | 12/12 | 116 ch | 0 | thin + excerpts too short; expand and deepen |
| `religion` | 9 | 9/9 | 9/9 | 129 ch | 0 | thin + excerpts too short; expand and deepen |

¹ rows using `\n\n` paragraph breaks — a proxy for "written in the project's
flowing multi-paragraph voice" rather than one clipped sentence. `people` and
`science` are the models; the rest are placeholders.

**Highest-value additions, in order**

1. **`enrich.mjs art.csv`** — 847 excerpts for $0. Nothing else comes close on
   effort-to-payoff.
2. **A `wars` / `periods` span dataset.** The timeline's era context band exists
   for long spans, and today the only span data is reigns (median 8 years) and
   lifespans (median 71), so the band is sparse when zoomed out. This is the one
   addition that unlocks a feature rather than just adding rows.
3. **Rewrite `leaders` excerpts.** 999 rows of fragments; the worst
   style-consistency problem in the data.
4. **Grow `people`** from the figures already named in `science` rows —
   occupation `scientist/<type>`, `years` = lifespan.

---

## Tooling

Zero-dependency Node scripts for populating `datasets/*.csv` **thoroughly while
spending almost nothing on Claude**. The strategy: let free APIs do the fetching,
and reserve a model only for judgment.

| script | what it does | cost |
|---|---|---|
| `enrich.mjs` | Fills empty `excerpt`/`image` cells from the Wikipedia REST API | **$0** (no LLM) |
| `misses.mjs` | Triages `*.misses.json` so a model only sees what needs judgement | **$0** (no LLM) |
| `roles.mjs` | Fills a `role` column on `leaders.csv` from Wikidata P39 | **$0** (no LLM) |
| `excerpts.mjs` | Rewrites a whole `excerpt` column: Wikipedia lead + local-model reshape | **$0** (local LLM) |
| `suggest.mjs` | Proposes new entries + new dataset ideas from Wikipedia/Wikidata | **$0** (no LLM) |
| `imgcheck.mjs` | HEAD-checks every image URL as the browser will request it | **$0** (no LLM) |
| `build_thumbnails.js` | Pre-existing local thumbnail cache builder (unchanged) | $0 |

Requirements: Node 18+ (uses global `fetch`). No `npm install` needed — the scripts
are self-contained `.mjs` and reuse the app's own CSV parser semantics, so files
round-trip byte-compatibly with what the app writes.

### `imgcheck.mjs` — find images that will not render

```
node imgcheck.mjs               # every dataset
node imgcheck.mjs art.csv       # just one
```

Read-only; never edits a CSV. It applies the same `thumbUrl()` rewrite the app
does, so it tests the URL the **browser** actually requests, and writes
`<name>.deadimg.json` listing every failure with its CSV line number.

Two things make its output easy to misread:

- **429 is not a dead image.** Wikimedia throttles hard. The script backs off and
  retries, and `CONCURRENCY` is deliberately 6 — raise it and healthy images get
  reported as broken.
- **400 means a bad *width*, not a missing file.** Wikimedia only generates
  thumbnails at the standard sizes listed in `WM_STD_WIDTHS`
  (`utils/helpers.js`) and rejects direct hotlinks at anything else. 1,059 URLs
  in these CSVs carry an `800px-` token, which is not a standard size — those
  400 at source. `thumbUrl()` snaps the width for card thumbs and `fullUrl()`
  routes the lightbox through `Special:FilePath`, so both render correctly today
  even where the stored URL would not. Rewriting the stored tokens is still
  worth doing eventually. **404 is the only status that means the file is gone.**

---

## The three-phase workflow (cheapest → costliest)

**Phase 0 — `enrich.mjs` (free).** Scrapes reliable-source prose and a Commons
image per row and writes them into blank cells. Most art/film excerpts and
film/science images fill here with no model spend.

**Phase 1 — cheap-model reshape (only if you want house style).** Phase 0 writes
*raw* Wikipedia lead text. To convert it to the project's flowing `\n\n` excerpt
style, run the rows listed in `<dataset>.enrich-log.json` through **Haiku** in
batches (~20/call) with the style rules as a cached system prompt. Never use Opus
for this. Optional — raw extracts are already accurate and usable as-is.

**Phase 2 — Claude for judgment only.** Run `misses.mjs` first — it decides
mechanically what can be decided, and on the current files that is **91% of them**
(670 rows in, 60 out). Then handle what survives, and curate the new entries
proposed by `suggest.mjs`. Deciding *what belongs* is the part scripts can't do;
deciding that Pissarro's biography is not a description of 32 different paintings
is not.

---

## `misses.mjs` — triage the rejects before paying for them

```
node misses.mjs                    # all *.misses.json
node misses.mjs --write            # record the verdicts in place
node misses.mjs --review work.json # emit just the undecided rows
```

Read as a worklist, `art.misses.json` looks like 341 excerpts waiting to be
approved. It is not: those 341 proposals come from **107 distinct Wikipedia
pages**. Camille Pissarro's biography is proposed for 32 different paintings,
Élisabeth Vigée Le Brun's for 22, Renoir's for 18.

The cause is structural. These rows are individual artworks with no article of
their own ("a plaza in caracas"), so `wpSearch` returned the nearest thing there
was — the artist. Accepting the proposals would write one identical excerpt across
32 entries, which is **worse than leaving them blank**: identical prose makes
identical vectors, and the atlas would then cluster those paintings by the accident
of sharing a painter's bio rather than by anything about the paintings.

| verdict | test | what to do |
|---|---|---|
| `reused-page` | the page is proposed for another row too | rejected, free |
| `creator-page` | the page **is** the row's artist/director/scientist | rejected, free |
| `index-page` | a list, outline or disambiguation page — same `INDEX_TITLE` test `describe()` uses, imported from `lib/wiki.mjs` rather than restated | rejected, free |
| `no-source` | `no-search-hit` / `no-summary` | needs `ingest.mjs` (Wikidata-matched, so it does not depend on title similarity) or hand entry |
| `review` | a unique, plausible page that merely scored under `--min-sim` | **the only rows worth judging** |

```
670 rows in  ->  60 need judgement  (357 rejected mechanically, 253 have no source)
91% decided without a model.
```

The survivors are a genuine mix, which is the point — `schindlers list` →
*Schindler's List* and `8 1/2` → *8½* are correct matches that `titleSim` cannot
see through the punctuation, while `you cant take it with you` → *Polari* and
`destruction of tyre` → *Tyrion Lannister* are not.

Nothing here writes a CSV. This tool decides what to look at; filling the cells
stays with `enrich.mjs` and `ingest.mjs`.

---

## `roles.mjs` — a `role` column for `leaders.csv`, from Wikidata P39

```
node roles.mjs --dry            # report only
node roles.mjs                  # write the column
node roles.mjs --force          # redo rows that already have one
```

The atlas names a cluster with the vocabulary term nearest its centroid, and that
vocabulary is **harvested from the corpus** — a term needs six entries to be a
candidate at all. So the corpus can only name a cluster with words the corpus
uses.

The 612-entry cluster of world political leaders came out labelled
`President · United States`, true of about 11% of its members. Rescoring it showed
why: `politician` has the **highest cosine to that centroid of any term in the
corpus** (0.700) and finishes 46th, because it appears in 20 of 4,126 entries and
the generality term is computed from literal document frequency. `leader` appears
in 69. `head of state` never clears the six-entry floor. The words were missing,
not mis-ranked — every leader carried exactly two facets, `country` and `party`,
which is rich enough for good fine-grained labels and silent on what any of these
people *were*.

Two things this has to get right, both found the hard way:

- **Do not put the country in the search query.** Copying `enrich.mjs`'s
  `name + extra` pattern cost 110 rows: `Marcus Aurelius rome` ranks *Equestrian
  statue of Marcus Aurelius* first, `Septimius Severus rome` ranks *Arch of
  Septimius Severus*. A monument is not a person.
- **The row's year span picks both the person and the office.** `Constantine II of
  Greece` (1964–73) and `Constantine II (emperor)` (337–40) are both humans holding
  real offices; only one overlaps a row dated 337. The same P580/P582 test stops a
  career politician's `Member of the 32nd Parliament` beating `Prime Minister`.

The office is stored **normalised to its head noun** — `President of Mexico` →
`president` — because the specific office lands in a handful of entries and never
clears the frequency floor. The country is already its own facet.

Writes `leaders.roles-log.json` and `leaders.roles-misses.json`. Office labels
that fall through `ROLE_PATTERNS` are reported with counts, so the table can grow.

---

## `excerpts.mjs` — rewrite a whole excerpt column

```
node excerpts.mjs leaders.csv --dry --limit 5
node excerpts.mjs leaders.csv
node excerpts.mjs leaders.csv --no-reshape     # raw Wikipedia leads, no model
```

`enrich.mjs` only fills a **blank** cell, and all 999 `leaders.csv` excerpts are
already full — of the fragment style the project explicitly does not want
(`"Cold War end. Gulf War. Single term."`). Median **77 characters**, against 250
in `people.csv` and 420 in `science.csv`, which are the bar.

That gap is functional, not cosmetic. `entryText` in `lib/store.mjs` feeds the
excerpt to EmbeddingGemma, so a 77-character excerpt makes a weak vector — which is
why 612 unrelated world leaders landed in one cluster in the first place.

Two steps, both free:

1. **Fetch the lead** (`exintro`, plain text — the several paragraphs, not the REST
   summary's one sentence). Accurate, sourced, already flowing prose.
   `--no-reshape` stops here and the result is usable.
2. **Reshape** with `qwen3:8b` through Ollama, using the shared brief in
   `lib/style.mjs`. Local, so free.

The page comes from `leaders.roles-log.json` when it exists, because `roles.mjs`
already resolved each row to a page **and verified it against the row's own year
span** — a far stronger match than title similarity, inherited for nothing. Rows
the log misses fall back to a bare-name search and are counted separately.

**The fetched lead is the floor.** A reshape that trips `styleReject`
(`lib/style.mjs`) is discarded and the encyclopedia text kept, so the local model
can improve the voice but never make a row worse. Rejection reasons are tallied at
the end — refusals, visible `<think>` reasoning, and text that grew more than 2.2×
its source, which is a model that stopped summarising and started composing.

---

## `era-excerpts.mjs` — excerpts for rows that are WORKS, not subjects

```
node era-excerpts.mjs art.csv --dry --limit 12
node era-excerpts.mjs art.csv
node era-excerpts.mjs art.csv --no-own-page    # force the era path, for testing
node era-excerpts.mjs art.csv --only pissarro  # one creator, for tuning
```

`art.csv` had **527 rows with no excerpt across 106 artists** — Pissarro 48,
Renoir 27, Poussin 25, Vigée Le Brun 24. It is the one dataset that cannot be
backfilled by search, because its rows are artworks with no article of their own,
so every search returns the *artist* and one biography gets written into 48 cells.
`misses.mjs` caught that and refused to write, which is why they stayed blank.

Identical excerpts are identical vectors. Those 48 paintings would have collapsed
onto one point and clustered by the accident of sharing a painter.

**Two tiers, in order of trust.**

1. **The work's own page**, when it has one — 97 of 527 did. Gated on three things
   that must all hold: the lead names the creator, the page is not the creator's
   own page, and the titles overlap. The creator check is the one that matters —
   it is a fact, where the earlier attempt to validate by cosine could not work
   (a wrong generic page scored **0.542** against its row while the correct entity
   page scored **0.415**; the failure is ontological and an embedding cannot see
   ontology).
2. **Era context** — paragraphs of the creator's article scored by how near their
   years sit to the row's year, behind a one-line opener naming the work, its
   movement and its date. Pissarro in 1870 is the Franco-Prussian War and Norwood;
   in 1885 it is meeting Seurat and Signac. Same page, different decade, different
   vector.

Result: **494 filled, median 570 chars, era fit median 1 year off, p90 7 years**,
and the 6 rows that found nothing within 25 years are named in the run output.

### What it is worth, measured

Mean pairwise cosine over Pissarro's 60 paintings, embedded three ways:

| | excerpt channel alone | full embedded text |
|---|---|---|
| before (48 of 60 blank) | 0.742 | 0.820 |
| naive: one artist bio for all | **1.0000** | 0.814 |
| era-anchored | **0.669** | 0.797 |

The middle row is the bug, and it is exactly as bad as predicted: an identical
excerpt is an identical vector, so those 48 paintings would have been one point.
Era-anchoring beats it, and beats leaving the cells blank.

**But read the right-hand column before celebrating.** In the text that is actually
embedded the same three conditions run 0.820 / 0.814 / 0.797 — a far smaller
spread, because `entryText` also carries `artist` and `movement` as facets and
those are identical across every Pissarro. The shared facets dominate the vector
and mask most of the excerpt's effect, which is why the naive fill's 1.0 collapse
came out as a barely-worse 0.814 overall. The excerpt fix is the largest gain
available in the channel it controls; it is not, on its own, enough to spread one
artist's output across the map. Genuinely separating them needs per-work fact —
Wikidata collection, medium and depicted subject — which is not built.

**Works from the same season may share an era paragraph, and that is correct.**
An earlier version handed each reuse a sliding window of the same paragraph purely
so the strings would differ; that manufactured difference corresponding to nothing
about either painting, and opened excerpts mid-thought. What separates two rows is
the opener, which is real per-work fact. If they ever need to be genuinely
distinct, the lever is Wikidata — a painting with no article often still has an
item carrying its collection, medium and depicted subject. Not built.

### Four traps, each of which cost a run

- **`[5-9]\d\d` is not a year.** A `$500` in a paragraph that also said 2009 gave
  it a **1,509-year span**, and a span that wide brackets *every* target — so a
  section on Nazi-era restitution scored a perfect era match against a canvas from
  1856. The floor is now 1000. Same lesson as `yearInLead`, where "about 560
  kilometres" became AD 560.
- **Distance is to the nearest individual year, not the nearest edge of the
  min..max span.** Same failure, second door in.
- **Provenance, market and legacy sections are vetoed, not penalised.** They are
  systematically attractive to a year-matcher and systematically wrong, because
  they cite each painting's creation year while discussing what happened to it
  afterwards. No weight can fix a section that earns `d=0` honestly.
- **`titleSim` is the wrong metric for matching a person.** It divides by the
  longer name, so it scored the correct `rembrandt van rijn` → *Rembrandt* at
  0.33 — below the floor meant to catch `casper david friedrich` → *Joseph
  Koerner*, the art historian who wrote the book about him. Counting shared words
  of 4+ characters instead is indifferent to name length, and separates
  `louis-michel van loo` from *Jean-Baptiste van Loo*, which share only "van" and
  "loo".

Every one of those produced fluent, well-formed prose about the wrong thing.
That is the failure mode of this whole script and why the run prints an **era fit**
line rather than just a count.

### Outputs

```
art.era-articles.json   creator articles, cached
art.era-leads.json      candidate leads, cached
art.era-log.json        per row: tier, page, sections, paragraphs, years off
art.era-misses.json     rows left blank, with the reason
art.csv.pre-era         pre-run snapshot (the .bak was already stale)
```

Safe to kill and re-run: the CSV is checkpointed, and paragraph **use counts are
rebuilt from the log**, so a resumed run does not hand the popular paragraphs out
a second time.

---

## `enrich.mjs` — fill blank cells

```
node enrich.mjs <dataset.csv> [options]
```

Only ever fills **empty** `excerpt`/`image` cells (idempotent — safe to re-run).

| option | default | meaning |
|---|---|---|
| `--fields=excerpt,image` | per-dataset | which fields to fill |
| `--limit=N` | all | process only the first N rows needing work |
| `--concurrency=N` | `5` | parallel requests |
| `--min-sim=0.34` | `0.34` | hold back matches below this title-similarity for manual review |
| `--force` | off | overwrite non-empty cells too |
| `--dry-run` | off | report what would change; write nothing |

**Recommended first run — always dry-run, then a small real batch:**

```
node enrich.mjs film.csv --dry-run          # see the counts
node enrich.mjs film.csv --limit=20         # write 20, inspect quality
node enrich.mjs film.csv                     # full run once happy
```

Default target fields come from the `DATASETS` table at the top of `wikilib.mjs`
(which also tells the matcher which column is the *name* and which adds
disambiguating context):

| file | name column | context | fills by default |
|---|---|---|---|
| `art.csv` | `title` | `artist` | `excerpt` |
| `film.csv` | `title` | `director` | `excerpt`, `image` |
| `science.csv` | `discovery` | `scientist` | `image` |
| `people.csv` | `name` | `occupation` | `excerpt`, `image` |
| `leaders.csv` | `name` | `country` | `excerpt`, `image` |
| `philosophy.csv` | `work` | `philosopher` | `excerpt`, `image` |
| `religion.csv` | `event` | `tradition` | `excerpt`, `image` |
| `us_history.csv` | `event` | `category` | `excerpt`, `image` |

Override per run with `--fields`. **A new dataset must be added to that table**
or it falls back to a generic `excerpt`+`image` fill with no name column, which
matches poorly.

Note that `enrich.mjs` only fills *blank* cells, so it will not touch the 999
terse `leaders` excerpts — those need `--force` (after you have decided the raw
Wikipedia lead is better than what is there, which for `leaders` it is).

### Outputs

- `<dataset>.csv` — updated in place.
- `<dataset>.csv.bak` — one-time backup of the original (written on first run).
  **Revert with:** `mv film.csv.bak film.csv`.
- `<dataset>.enrich-log.json` — every excerpt filled, with the source page title,
  URL, and confidence. **This is the Phase 1 reshape worklist.**
- `<dataset>.misses.json` — rows skipped: no search hit, no summary, or
  **low-confidence** matches (with the proposed value, for you to accept/reject).
  Run `misses.mjs` over this before reading it — most of it is provably wrong and
  can be rejected for free. See above.

### Reading the log (spot-check quality)

`sim` is title similarity (1.0 = exact). Watch for high-`sim` false friends: e.g.
`the tramp` matched the Chaplin *character* page, not `The Tramp (1915 film)`.
Skim the log, fix the handful that are wrong, re-run those rows with `--force`
after correcting the title (or fill by hand).

---

## `suggest.mjs` — propose more entries & datasets

```
node suggest.mjs [dataset.csv ...] [--seeds=N] [--top=K]
```

No dataset args → runs across all datasets. Reads the API only; **never touches
your CSVs.**

| option | default | meaning |
|---|---|---|
| `--seeds=N` | `25` | how many existing rows to use as "more like this" seeds |
| `--top=K` | `30` | how many entry suggestions to keep per dataset |

How it works: samples your existing rows, asks Wikipedia for similar pages
(CirrusSearch `morelike:`, category-members fallback), drops anything you already
have, then annotates each candidate with a Wikidata year + "instance of" type.

### Outputs (in `datasets/suggestions/`)

- `<dataset>.md` / `.json` — ranked candidate **entries** not yet in that dataset,
  with year, type, and a snippet. Review, then add the good ones and run
  `enrich.mjs` to fill them.
- `_new_datasets.md` — the **new-dataset radar**: Wikidata types that show up a lot
  among your neighbours but aren't covered by any current dataset. This is where
  ideas like *wars* / *time periods* (span datasets, per the handoff) surface.

Examples:

```
node suggest.mjs                       # scan everything
node suggest.mjs philosophy.csv        # just grow the thin philosophy set
node suggest.mjs us_history.csv --seeds=12 --top=50
```

---

## Excerpt house style (the thing scripts can't do)

The excerpt is the main readable payload — it is shown only in the timeline
lightbox, never on a card. Match `people.csv` and `science.csv`:

- **Flowing complete prose**, a few sentences that give historical perspective
  plus the concrete details. Never clipped fragments.
- **Paragraph breaks are the literal two characters `\n\n`**, no indentation.
  The lightbox turns `\n` into `<br>`, so `\n\n` renders as a blank line.
- Keep the whole record **on one physical line** and quote the field.
- Accurate, from reliable sources. Do not invent. When given a link, cover
  **every** entry on it, not a sample.

Good (from `people.csv`):

> `"A church canon and astronomer, Copernicus proposed that the Earth and planets orbit the Sun, overturning the 1,400-year-old Earth-centered cosmos of Ptolemy.\n\nPublished as he lay dying in 1543, ..."`

Bad (the current `leaders.csv` pattern, ~79 chars, no perspective):

> `Cold War end. Gulf War. Single term.`

## Refreshing the status table

```
node --input-type=module -e '
import fs from "node:fs";
const {parseCSV} = await import("./project/data/csv.js");
for(const f of ["art","leaders","film","science","people","philosophy","us_history","religion"]){
  const r = parseCSV(fs.readFileSync("datasets/"+f+".csv","utf8"));
  const ex = r.filter(x=>(x.excerpt||"").trim());
  const avg = ex.length ? Math.round(ex.reduce((s,x)=>s+x.excerpt.length,0)/ex.length) : 0;
  console.log(f.padEnd(11), "rows",String(r.length).padStart(4),
    "img", (r.filter(x=>(x.image||"").trim()).length+"/"+r.length).padStart(9),
    "excerpt", (ex.length+"/"+r.length).padStart(9),
    "avg", String(avg).padStart(4),
    "multi-para", r.filter(x=>(x.excerpt||"").includes(String.raw`\n\n`)).length);
}'
```

Run from the repo root (not from `datasets/`).

## Guardrails

- Both scripts send a descriptive `User-Agent` (Wikipedia requires it) and back off
  on 429/5xx. Keep `--concurrency` modest (≤8) to stay polite.
- `enrich.mjs` writes only blank cells unless `--force`, and keeps a `.bak` — so a
  bad run is always one `mv` away from undone.
- Excerpts are stored as single-line quoted fields (paragraph breaks are the literal
  `\n\n`); the scripts never emit real newlines, so the app's one-record-per-line
  parser stays happy.
- Accuracy is Wikipedia's, then yours. Treat Phase 0 output as a strong draft to
  audit via the logs — not final copy.
