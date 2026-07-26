# Dataset tooling

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

Default target fields per dataset: `art`→excerpt, `film`→excerpt+image,
`science`→image (the rest are already full). Override with `--fields`.

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
