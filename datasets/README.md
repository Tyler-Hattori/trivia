# Datasets — status and tooling

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

Two zero-dependency Node scripts for populating `datasets/*.csv` **thoroughly while
spending almost nothing on Claude**. The strategy: let free APIs do the fetching,
and reserve a model only for judgment.

| script | what it does | cost |
|---|---|---|
| `enrich.mjs` | Fills empty `excerpt`/`image` cells from the Wikipedia REST API | **$0** (no LLM) |
| `suggest.mjs` | Proposes new entries + new dataset ideas from Wikipedia/Wikidata | **$0** (no LLM) |
| `build_thumbnails.js` | Pre-existing local thumbnail cache builder (unchanged) | $0 |

Requirements: Node 18+ (uses global `fetch`). No `npm install` needed — the scripts
are self-contained `.mjs` and reuse the app's own CSV parser semantics, so files
round-trip byte-compatibly with what the app writes.

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

**Phase 2 — Claude for judgment only.** Handle the rows in `<dataset>.misses.json`
(no match / low-confidence), and curate the new entries proposed by `suggest.mjs`.
Deciding *what belongs* is the part scripts can't do.

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
