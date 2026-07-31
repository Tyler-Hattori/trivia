# Handoff — the atlas rework

Written 2026-07-29, updated 2026-07-30.

---

## NEXT SESSION: teach `--events` to read tables and narrative prose

The requested next piece of work. Two real pages return nothing, for two
**different** reasons — both diagnosed, neither fixed.

```bash
node datasets/ingest.mjs --events "Timeline of English history" --dry   # 0 events
node datasets/ingest.mjs --events "History of quantum mechanics" --dry  # 0 events
```

### 1. Tables are invisible to the miner

`mineEvents` (`lib/wiki.mjs:604`) fetches with
`prop=extracts&explaintext=1`, and **`explaintext` strips wiki tables
entirely**. For *Timeline of English history* that returns 1,337 characters —
the intro paragraph and some section headings — while the actual page is
196,989 characters of HTML holding **22 wikitables and 249 rows**, one event per
row under `Year | Date | Event`. The miner is not failing to parse the events;
it never receives them. Hence the misleading `Nothing dated found in 1 lines`.

The fix is a second fetch path. `action=parse&prop=text` returns the rendered
HTML with the tables intact, and a `Year | Date | Event` row maps onto the
existing draft shape almost directly — the year column *is* the date, which
makes it a `mined-line`-grade source (the date plainly governs the row), not a
prose guess. Worth checking how consistent the column headers are across
timeline pages before committing to a shape; `Date`/`Year`/`Event`/`Description`
are the common ones. Note `getJSON` and the whole module are currently
plaintext-only, so this adds the first HTML parsing in the pipeline — keep it to
row/cell extraction rather than pulling in a DOM library, per the
zero-dependency rule.

### 2. Prose mining works, but the yield is poor

*History of quantum mechanics* is the opposite case: the body arrives fine
(42,383 chars, 258 lines), but the dates sit mid-sentence, so `mined-line` finds
nothing and the default run reports zero.

```bash
node datasets/ingest.mjs --events "History of quantum mechanics" --events-prose --dry
#   11 events (0 dated at the line head, 11 mid-sentence)
```

So `--events-prose` is *required* for narrative history pages, and 11 events off
a 258-line article on a subject with dozens of dated milestones is a low catch
rate. Two things to look at: whether the miner only takes the first date per
paragraph, and whether `minChars`/`maxChars` (40/700) are rejecting the long
sentences this kind of writing produces.

Two design points not to lose while doing this:

- **The `--events-prose` trust level is deliberate.** It is off by default
  because on a non-timeline page it also harvests the publication years of cited
  studies. If narrative pages become a first-class input, they need their own
  confidence tier in the `date sources:` tally rather than being folded into
  `mined-line`.
- **`--retitle` changes ids**, because ids are built from titles, so a second
  `--retitle` run over the same page will not recognise its own earlier entries
  as duplicates. Mine with `--dry`, read it, then run once.

---

Picks up mid-Phase-2.

> **See also `HANDOFF-timeline-modes.md`** — the brief for the next requested
> feature, a geologic ⇆ human-history mode toggle. It exists because a single entry
> at −113000 now makes 89% of the linear x axis hold one point, and **Fit shows
> 1 point**. That file also carries the current loose ends, including a data-loss bug
> in `migrate.mjs` affecting hand-entered entries.

**Nothing is committed.** All of this is uncommitted working-tree changes on `main`
(the standing preference is to leave work uncommitted until asked).

---

## Where things stand

| phase | state |
|---|---|
| **1 — the data pipeline** | **Done and verified.** 26/26 invariant checks pass. Usable right now. |
| **2 — the atlas renderer** | **Built and verified. 50/50 browser checks pass**, five consecutive runs. |
| **3 — one unified quiz** | Not started. Design sketch at the bottom. |

The old swimlane timeline in `project/features/timeline/` is **untouched and still
works**. It is reachable from the home page as "Old lane timeline". The decision was
to *replace* it rather than keep it as a real mode, so its five known bugs were
deliberately not patched — they are solved structurally in the atlas instead. Delete
that directory once you are happy with the atlas.

---

## Phase 1: the pipeline (done)

Full docs: **`datasets/ATLAS.md`**. Read that before touching any of it.

```bash
# one-time setup (already done on this machine)
brew install ollama && ollama serve &
ollama pull embeddinggemma       # required, ~200MB, 768 dims
ollama pull qwen3:8b             # optional, ~5GB, only for --reshape

# the pipeline
node datasets/migrate.mjs            # 8 CSVs -> atlas/entries.jsonl
node datasets/embed-all.mjs          # fill missing vectors (resumable)
node datasets/atlas.mjs --rebuild    # re-fit the cluster hierarchy
node datasets/atlas.mjs              # OR: place new entries, keep the map stable
node datasets/verify.mjs             # 26 invariant checks, ~1s
node datasets/inspect.mjs --near cubism

# adding data — this is the thing to actually use
node datasets/ingest.mjs --category "Battles of the Napoleonic Wars" --domain war --deep
node datasets/ingest.mjs --links "List of Impressionist painters" --domain art
node datasets/ingest.mjs @list.txt --domain science --reshape
```

Current store: **3,787 entries**, 522 cluster nodes, depth 6, years −4.57e9…2026.
3,194 have excerpts.

### What changed on 2026-07-30

Four things, all in the pipeline. `datasets/ATLAS.md` is the full write-up —
"How many groups a level has is decided by the data" and "Labels" are new
sections there.

1. **Labels are chosen by embedding, not word frequency.** Nodes were called
   `American · Directed · Starring` and `Directed · American · Stars` — two
   sibling film clusters named after Wikipedia credit-line boilerplate. Cause:
   c-TF-IDF rewards terms *rare outside* the cluster, which is the inverse of
   what a broad label needs. Now `harvestVocabulary` collects candidate terms
   from the corpus, `atlas.mjs` embeds them (cached in `atlas/vocab.bin`), and
   each node takes the term nearest its centroid. Depth-1 is now
   `Film · Painting · Political · England · Period · Physics`, narrowing to
   `Film Noir`, `Post-Impressionism`, `Photoelectric Effect` at the leaves —
   with no per-level rules, because a broad centroid is simply nearer a broad
   word. Labels recompute on every build including incremental ones.
2. **`k` per node is chosen by silhouette, not arithmetic.** It used to be the
   branching factor that made a balanced tree hit ~12 entries a leaf — always 7
   for this corpus, whatever it contained, which is why 322 physics entries
   shared a top-level branch with 525 films. `chooseSplit` now tries every k and
   keeps the best split. Root picked 6; Physics splits ten ways, Painting two.
   Depth follows from size, so `maxDepth: 6` is only a backstop. Rebuild cost
   went 3s → 9s and scales with corpus size — watch it past ~10k entries.
3. **The lead-text date fallback is guarded.** `[5-9]\d{2}` took any 3-digit
   number, so "about 560 kilometres" dated the English Channel to AD 560, and
   six others were wrong the same way. `yearInLead` now rejects a number
   followed by a unit (including durations) and requires a date cue for bare
   3-digit years. `origin.dateSource` is stored, so the prose-derived set is
   answerable after the fact.
4. **356 excerpts backfilled** via `enrich.mjs art.csv --fields=excerpt`. This
   was not cosmetic: with 847 art entries carrying no prose, those vectors were
   degenerate enough that `georges seurat` scored 0.93 semantic coverage over
   1,020 entries, and the art cluster was called *Impressionism*. Backfilling
   renamed it *Painting* on its own. **If a cluster is labelled by something
   oddly specific, check its excerpts before touching the scoring.**

Still open from this work: 593 entries have no excerpt, 527 of them in
`art.csv`, where `enrich` found a page but the title similarity fell below
`--min-sim=0.34` and it refused to write prose it was not confident in. The
proposals are in `art.misses.json` for review. Also unactioned: a curation list
of 7 entries whose year is a measurement and ~30 places/concepts with no
meaningful date (Colchester 2021, Celtic languages 1707, History of Ireland 0) —
ids in `/tmp/curation.txt`, which will not survive a reboot.

Two rough edges: `England`'s first child is `War · Conflict`, holding
Genocide/Caucasus/Kurdish material that is not English — a placement problem,
not a labelling one. And `covWeight` in `nameFromCentroids` is coupled to the
`vocabOk` filter; it was 0.45 while credit verbs were still candidates, and had
to drop to 0.25 once they were excluded or a leaders cluster came out named
*Military*. Any change to the vocabulary filter is a reason to re-check it.

New files:

```
datasets/lib/years.mjs      year parsing — SINGLE SOURCE, browser re-exports it
datasets/lib/store.mjs      entries.jsonl + int8 vector sidecar
datasets/lib/ollama.mjs     the only model dependency; plain fetch to :11434
datasets/lib/cluster.mjs    k-means, tree, leaf ordering, y assignment, labels, colour
datasets/lib/wiki.mjs       Wikipedia + Wikidata -> a draft entry
datasets/migrate.mjs        CSVs -> JSONL (reads only, never writes the CSVs)
datasets/embed-all.mjs      resumable embedder, prunes orphaned vectors
datasets/atlas.mjs          compiles atlas.json / details.json / layout.json
datasets/ingest.mjs         THE tool for adding data
datasets/inspect.mjs        tree / --near / --leaf / --cross
datasets/verify.mjs         invariants
datasets/reload.mjs         hard-reload the app in a visible Chrome from the terminal
datasets/atlas/*            the built artifacts (committed, the browser fetches them)
```

`project/utils/helpers.js` was slimmed: its three year-parsing functions now
re-export from `datasets/lib/years.mjs` so the tooling and the browser cannot drift.

### Two findings not to undo

1. **Never let `domains` into the embedded text.** A domain tag correlates perfectly
   with its source file, so it carries no information *within* a domain while forcing
   a constant separation *between* domains. The first build did this and the hierarchy
   just re-derived the eight original CSVs. `verify.mjs` asserts it stays out.
2. **Incremental placement holds existing `y` exactly.** `layout.json` stores each
   entry's y; newcomers are interpolated into the gaps between neighbours. Measured:
   a real 25-entry ingest moves **0 of 2,690** points and **0 of 228** bands. The
   naive rank-based version moved 10% of points by up to 0.7% of the axis.

---

## Phase 2: the renderer (where you are)

```
project/features/atlas/
  data.js     load atlas.json, typed arrays, spatial grid, topic index, priority
  scales.js   x/y transforms, zoom model, tier + depth selection, ticks
  paint.js    canvas: bands, spans, dots, chips, label packing, hit testing
  cards.js    pooled DOM image cards + the hover preview
  detail.js   the detail panel (replaces the old row expansion) + enlarged image
  rail.js     cluster rail with collapse/pin + the pinned strip painter
  styles.js   the whole stylesheet
  index.js    orchestrator: window, camera, frame loop, all interaction
```

Wired up in `project/app/init.js` (`window.openAtlas`) and `project/ui/home.js`
("Open the atlas" button). Opens in a named popup, same pattern as the old timeline.

### How to run and test it

```bash
python3 -m http.server 8777
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank

node datasets/qa-atlas.mjs                    # 50 browser checks
node datasets/qa-atlas.mjs --shot /tmp/a.png  # + screenshot
node datasets/qa-atlas.mjs --keep             # leave the windows open
```

`window.__atlas` is a deliberate debug handle on the atlas window, exposing
`atlas, view, scale, visible, placements, filter, tier, depth` and
`select/focusNode/fit/zoom/setQuery/toggleCollapse/togglePin/goto`. The QA suite
drives the view through it — dispatching wheel events at guessed coordinates does
not work on a scatter plot, because most of the canvas is empty space and you end up
measuring a blank screen.

### The 4 failures — fixed

All four were one thing: the QA harness never cleared `localStorage`, so view prefs
leaked between runs (`atlas:prefs:v1` carried `"collapsed":[94],"pinned":[94]`). The
atlas booted with node 94 *already pinned*, so the pin test's click **unpinned** it,
the poll for `pinned.length === 1` timed out, and the later unpin test toggled it
back on. `qa-atlas.mjs` now clears the key on the **opener** before calling
`openAtlas()` — the popup reads prefs once at open time, so clearing afterwards is
too late.

Three real fixes came out of it:

1. **Production bug: the pin bar never emptied.** In `index.js` `paint()`, the
   `$('pinBar').innerHTML = …` assignment sat inside `if(pins.rows.length)`, so
   removing the last pin left a stale unpin button in the DOM. Now outside the
   guard. `#pinWrap` is `display:none` without `.on`, so it was invisible rather
   than on-screen as first described — but the next pin would have inherited it.
   Locked in by a new 50th check.
2. **The suite's `sleep(900)` after loading the app was a real flake** — it passed
   most runs and failed the rest, reading as "openAtlas is not a function", i.e. as
   an app bug. Now polls with `until`; resolves in ~62ms.
3. **DOM assertions must poll.** The first version of the new pin-bar check used
   `evaluate`, and failed 1 run in 3: view state empties synchronously in the click
   handler, but the bar is rewritten in `paint()` one frame later. The passing runs
   show both 1ms and 62ms, which is the race made visible.

One thing that cost time and is not in the code: **`python3 -m http.server` had
died** partway through, and every check failed in a way that looked like a module
error. `ERR_CONNECTION_REFUSED` only shows up in the page's log, which the suite
does not surface. If everything fails at once, `curl -sf localhost:8777/` first.

### Then `--shot` turned out to be lying, and that exposed three more

`--shot` used to dispatch synthetic wheel events at the centre of the canvas —
exactly the mistake this file's own header warns about. The middle of a scatter plot
is empty, so every screenshot came out a blank grid reading `0 in view`, which is
why nobody had *looked* at the thing. It now reuses the densest-with-excerpts entry
the suite already located and waits for points to be in frame.

The first honest screenshot showed two mangled strings, both from `\b` in a
title-caser. **`\b` is ASCII-only even under the `u` flag**, so every non-ASCII
letter reads as a non-word character and the letter after it starts a new "word":

| was | now |
|---|---|
| `FranÇOis Truffaut · … · Katsuhiro ōTomo` | `François Truffaut · … · Katsuhiro Ōtomo` |
| `Portrait of the Artist'S Wife` | `Portrait of the Artist's Wife` |

`cluster.mjs` and `migrate.mjs` had **two separate copies of the same function with
the same bug**, so `titleCase` is now exported from `cluster.mjs` and imported by
`migrate.mjs`, the way `years.mjs` is single-sourced. An apostrophe still breaks a
word, because `o'keeffe` → `O'Keeffe` must work; the exception is a trailing
possessive `'s`. 35 of 2,697 entries were affected.

**Data-loss bug in the documented pipeline, found on the way.** `migrate.mjs` decided
what to carry over with `!MAP[`${e.origin?.dataset}.csv`]`. But `ingest.mjs --domain
art` files entries under `origin.dataset: 'art'`, and `art.csv` exists — so all **58
ingested entries would have been silently deleted** by a routine `node
datasets/migrate.mjs`. The dry run said `total 2639` with no carry-over note while
the store held 2,697; that 58-entry gap was the only symptom. The discriminator is
now `origin.wiki || origin.qid`, which is what actually distinguishes an ingest from
a CSV row. **If you had run the documented pipeline before this fix, you would have
lost them.**

**The QA suite was verifying stale data.** `python3 -m http.server` sends
`Last-Modified` and no `Cache-Control`, so Chrome applied a heuristic freshness
lifetime and served `atlas.json` from a disk cache that persists in
`--user-data-dir`. After a full rebuild the suite still reported 50/50 — against
two-build-old data, and the screenshot still showed `FranÇOis`. `attach()` now sends
`Network.setCacheDisabled`.

### Rebuild after those fixes — the map did not move

```
node datasets/migrate.mjs        # 2697 entries, 58 carried over, 0 mangled titles
node datasets/embed-all.mjs --force
node datasets/atlas.mjs          # incremental, NOT --rebuild
node datasets/verify.mjs         # 21/21
node datasets/qa-atlas.mjs       # 50/50
```

`--force` was needed because nothing hashes entry text, so the embedder cannot see a
changed title — it only fills missing vectors. Verified afterwards that this
introduced no drift: **2,662 of 2,697 vectors came back byte-identical and exactly
the 35 retitled entries changed**, min cosine 0.992. Incremental placement then held
**2,697 y-positions exactly, 0 interpolated**, same 227 nodes and depth 3, so the
reviewed layout survived. Use plain `atlas.mjs`, not `--rebuild`, or you re-fit the
hierarchy and throw that away for a 35-entry casing change.

### What the passing checks confirm

- **Images are never cropped** — `object-fit: contain` on card, hover preview,
  detail panel and enlarged view; 6 loaded images verified to keep their aspect
  ratio to within 4%.
- **No doubled outlines** — asserted that no card carries a border *and* an
  outline. Selection/hover are `box-shadow` rings outside the border.
- **Collapse works** — "Politics · Reign · Leaders" (7 children) folded 35 → 28 rail
  rows in 11ms, 595 members collapsed into one band, status reflects it, expanding
  restores exactly 35 rows.
- **Hover preview at every zoom**, including fully zoomed out (`tier=dot`) — this was
  an explicit request.
- **Detail panel** opens with cluster breadcrumbs, 6 nearest neighbours, 8 topic
  chips, prose, and neighbour-click navigation.
- **Search**: free text (`cubism` → 54), year range (`1750-1800` → 155),
  `ds:film` → 628, `topic:surrealism` → 7, `has:image` → 2,512, and the empty state.
- **Performance**: 40 pan frames in 327ms = **8.2ms/frame** at 2,697 points.

### Bugs already found and fixed during Phase 2

Keep these in mind; three are traps that will recur.

1. **Backticks inside a CSS/JS template literal terminate it.** A comment reading
   `` `--hue` `` inside `styles.js`'s CSS template closed the string, and the CSS
   was then parsed as JavaScript — surfacing as
   `SyntaxError: Invalid left-hand side expression in postfix operation` (`--bg`
   read as a decrement). Bit me twice: once in `styles.js`, once in a page-side
   probe in `qa-atlas.mjs`. **Never use backticks in a comment inside a template
   literal.**
2. **Timers must come from the atlas window, not the opener.** This module's code
   runs in the *opener's* realm, and browsers throttle a backgrounded tab's timers to
   ~1s — and the opener is backgrounded the entire time you are using the atlas. The
   search debounce and the resize handler were both ~1s late. Now `w.setTimeout` /
   `w.clearTimeout`. `requestAnimationFrame` was already `w.`-prefixed.
3. **DOM nodes must be created by the popup's document.** `document.createElement`
   in `cards.js` / `detail.js` / `rail.js` built nodes in the opener's document.
   Browsers auto-adopt on append, but `ownerDocument` stays wrong. Now
   `root.ownerDocument.createElement`, and the tip reads `D.defaultView.innerWidth`.
4. **The rail never rebuilt when zoom changed its depth.** `depthFor()` picks which
   tree level the rail lists, but only the collapse/pin/filter flags set
   `dirty.rail` — so the rail showed a stale level until an unrelated action forced a
   rebuild. `paint()` now compares against the previous depth.
5. **`#railHost` was the flex item, not `.rail`.** `.rail` is written as
   `flex:0 0 216px` with a bounded scroll column, but a plain wrapper div sat between
   it and `#mid`. Fixed with `#railHost{display:contents}`.
6. **`setPointerCapture` throws** `NotFoundError` when the pointer is already gone
   (synthetic events, fast clicks). Now wrapped in try/catch.

### Design decisions worth not re-litigating

- **x is linear, always.** Explicitly chosen; compressed/elided empty stretches were
  offered and rejected. Gaps should read as real.
- **y is unitless [0,1]**, and its zoom is *coupled* to x's by
  `coupledYZoom(ppy) = 1 + ppy^0.62 * 1.35`. Alt+wheel zooms y alone. Linear coupling
  ran vertical zoom away long before the cards appeared.
- **Detail arrives gradually, not by tier switching.** `tierFor(ppy)` only sets what
  is *offered*; `packLabels()` then places labels in a fixed global priority order
  until the space runs out. Priority is viewport-independent on purpose — anything
  position-dependent makes cards shimmer as you pan. Dots are always drawn.
- **Cluster bands are filled, never stroked.** An outlined band next to an outlined
  card is what read as doubled borders. One hairline at each band's top edge only, so
  adjacent bands share a line.
- **Band labels stick to the viewport's left edge**, not to the band's first entry —
  otherwise the label scrolls away exactly when you still need it.
- **Collapse folds the map band *and* hides rail children.** One control, because it
  is one intent.
- **Pin lifts a cluster into a top strip sharing the map's x transform**, so you can
  hold "Cubism" pinned and pan four centuries past it. Max 6 pins, ≤42% of viewport.

---

## Suggested order of work from here

1. ~~The two fixes above.~~ **Done — 50/50.**
2. **Look at it with human eyes.** `--shot` now produces an honest picture and the
   map does read well at card/detail zoom — uncropped images, sane label density,
   bands legible. Still open, and still a judgement call:
   - ~~**Duplicate sibling labels.**~~ **Largely addressed 2026-07-30** by the
     labelling rework — a node may not reuse an ancestor's term, so each level
     is forced to add information. Sibling collisions are no longer excluded
     outright though (only ancestor ones), so `Comedy Film · Drama Film` and
     `Drama Film · Comedy Film` still appear as siblings under `Film`. Worth a
     look with `node datasets/inspect.mjs --tree 2` if it reads badly.
   - **Band labels are occluded by cards.** They stick to the viewport's left edge
     (deliberately), but at detail zoom a card sitting at the left of the viewport
     covers them — visible in the screenshot as a clipped `Post-Impress…` and
     `…icism`. The label wants to win, or to dodge.
3. ~~Update the root `README.md`.~~ **Done.** The atlas is now the primary view: it
   has its own module table, design decisions, gotchas and rough edges; the QA
   section documents `qa-atlas.mjs` and the three traps that made it lie; the
   dataset section gained the rebuild steps and the `ingest.mjs` carry-over rule.
   The lane sections are retained under a "superseded" banner and should go with the
   directory. **The Wikimedia thumbnail-width gotcha was moved out of them** into the
   atlas gotchas — the atlas uses `thumbUrl` in `cards.js` and `detail.js`, so that
   note must not be deleted along with the lane engine.
4. **Delete `project/features/timeline/`** and the `timeline_engine.js` shim once the
   atlas is confirmed good, plus the "Old lane timeline" button in `ui/home.js`.
5. **Phase 3, the unified quiz.** Sketch: one page over `entries.jsonl`, no
   per-dataset quizzes. Topic filter = the cluster tree picker plus free text, reusing
   `data.js`'s `runFilter`. "Entries with aligning embeddings" is served by the
   precomputed `knn` already in `atlas.json` — pick a seed entry or cluster and quiz
   over its neighbourhood, which needs no model in the browser. Question types fall
   out of the fields present: year, creator/subtitle, topic, image.
6. **Data.** Still the biggest quality lever, now measurably so — see
   "What changed on 2026-07-30", where backfilling excerpts renamed a whole
   top-level cluster. 593 entries have no excerpt (down from 949), 527 of them
   in `art.csv`. `enrich.mjs` has taken those as far as it safely can; the
   remainder need either `ingest.mjs` on the same subjects (Wikidata-matched, so
   it does not depend on title similarity) or a pass over
   `art.misses.json`, which already holds the proposed text.

## Known rough edges (not bugs, judgement calls)

- The status readout can show a year range wider than the data (e.g. `1571 BC–3349`)
  when the whole extent fits in the viewport. Correct behaviour, looks odd.
- 88% of leaf clusters are single-source. Expected while `art` + `leaders` are 68% of
  the corpus, and it will loosen as excerpts fill in and other domains grow. Watch it
  with `node datasets/inspect.mjs --cross`.
- `membersOf()` in `rail.js` memoises per node in a `WeakMap` keyed by the atlas; it
  scans all points on first call per node. Fine at 2.7k, worth revisiting at 100k.
- `atlas.json` is 792KB and `details.json` 794KB, both loaded whole. Points are
  columnar so parsing is fast, and details load after first paint. Past ~50k entries
  these want sharding or a binary blob; there is a note in `atlas.mjs`.
