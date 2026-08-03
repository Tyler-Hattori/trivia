# Trivia — an atlas + quiz over CSV datasets

A static site (no build step, no npm) that renders `datasets/*.csv` as:

- **The atlas** — a zoomable map where **x is time** and **y is semantic
  similarity**, derived from local embeddings. Related things sit at the same
  height whatever century they are from.
- **The quiz** — one quiz over the whole corpus, filtered by picking a node of
  the atlas's own cluster tree.

The home screen is those two buttons and nothing else.

Both read the same compiled store (`datasets/atlas/`), not the CSVs directly;
`datasets/ATLAS.md` is the authority on that pipeline and **you should read it before
touching any of it**. That sharing is the point rather than an economy: "quiz me on
this cluster" is only a question you can ask because the atlas already computed the
clusters, so a rebuild of the map is a rebuild of the quiz.

```
index.html                 app shell (Tailwind via CDN)
project/
  core/settings.js         DATASETS — the single source of truth for the CSV path
  core/state.js            runtime state
  data/csv.js              header-driven CSV parser (one record per line)
  utils/normalize.js       raw row -> item (via DATASETS[].map)
  utils/helpers.js         thumbUrl(); year parsing re-exported from datasets/lib/years.mjs
  features/quiz/           THE QUIZ — questions.js derives what to ask; index.js runs it
  features/quiz_engine.js  the old per-dataset CSV quiz — UNLINKED, nothing routes to it
  features/atlas/          THE ATLAS RENDERER (see below)
  features/timeline/       the old lane timeline — superseded, pending deletion
  ui/                      home, header, quiz, stats
datasets/                  the CSVs, the atlas pipeline, and the tooling (own README)
datasets/atlas/            the compiled store the browser fetches
thumbnails/                optional pre-built local thumbnail cache
```

> **Status.** The atlas replaces the lane timeline and the unified quiz replaces the
> eight per-dataset ones. Both superseded features are still on disk and still work,
> but **nothing in the UI routes to either** — the home screen is two buttons. The
> lane engine's five known bugs were deliberately not patched; they are solved
> structurally in the atlas. Those sections below are kept only until
> `project/features/timeline/` is deleted. See `HANDOFF.md` for what is next.

## Running it

The app uses ES modules and `fetch`, so `file://` will not work — serve it:

```
node datasets/serve.mjs          # then open http://localhost:8777/
```

**Use this, not `python3 -m http.server`.** It serves everything `no-store`. The
Python one sends `Last-Modified` with no `Cache-Control`, so Chrome invents a
freshness lifetime and serves modules from its disk cache without revalidating —
`index.html` revalidates while the cached `home.js` does not, so the page renders a
**pre-edit UI with nothing in the console**. That reads as "my change did nothing"
and it cost a whole session: a newly added button was reported missing while the
bytes on the wire were correct the entire time. If you must use Python, every reload
has to be a hard one (`Cmd+Shift+R`).

Both the atlas and the old timeline open in a **named popup window**
(`window.open('', 'atlas')`), so allow pop-ups.

### Reloading from the terminal

Start the browser with a debug port — drop `--headless=new` when you want to *see* it:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --disable-popup-blocking http://localhost:8777/ &
```

then:

```
node datasets/reload.mjs                  # hard-reload; opens a tab if none is open
node datasets/reload.mjs --atlas          # reload, then reopen the atlas popup
node datasets/reload.mjs --url /quiz.html
CDP_PORT=9333 node datasets/reload.mjs    # a different browser
```

It reloads with `ignoreCache`, which is **not optional after a rebuild** if you are
serving with Python: that sends `Last-Modified` and no `Cache-Control`, so Chrome
applies a heuristic freshness lifetime and serves a stale `atlas.json` from a disk
cache that survives in the `--user-data-dir`. This is not hypothetical — it is why
`qa-atlas.mjs` once reported 50/50 against data that was two builds old.
`datasets/serve.mjs` removes the cause.

> **`reload.mjs` only reloads a Chrome that has a debug port.** It defaults to
> `CDP_PORT=9334`, which is the throwaway `--user-data-dir=/tmp/chrome-atlas`
> instance the QA recipe launches — **not** the Chrome you have on screen. Running it
> while looking at your everyday browser reloads a window you cannot see and appears
> to do nothing. Either launch your visible Chrome with the flags above, or just hit
> `Cmd+Shift+R`.

For your everyday Chrome instead, AppleScript works but needs Automation permission
granted once in System Settings › Privacy & Security, and cannot bypass the cache:

```
osascript -e 'tell application "Google Chrome" to reload active tab of front window'
```

---

## Adding or extending a dataset

**1. Write the CSV.** First line is the header; the parser is header-driven, so
column order and where `image` sits do not matter.

- **One record per physical line.** Quoted newlines are *not* supported.
  Paragraph breaks inside an excerpt are the literal two characters `\n\n`.
- Quote any field containing a comma. In image URLs, encode commas as `%2C`.
- The parser warns to the console when a row has more columns than the header —
  that almost always means an unquoted comma.

**2. Add a `DATASETS` entry** in `project/core/settings.js`:

```js
{
  key:'wars',                       // stable id; used in filters and ds: search
  color:'#0F766E',                  // timeline hue; lane shades derive from it
  title:'Wars & Conflicts',
  file:'datasets/wars.csv',
  count:0,
  layout:'wide',                    // lightbox: 'portrait' | 'wide' | 'split'
  schema:{ type:'image', fields:['name','years','region','excerpt'] },  // quizzable columns
  map:{                             // generic slot -> your column name
    image:'image', title:'name', subtitle:'region',
    years:'years', misc:'side', excerpt:'excerpt'
  },
  timeline:{
    type:'span',                    // 'point' (one year) | 'span' (a range)
    filterable:[                    // each becomes a sub-lane grouping option
      { key:'misc',     label:'Side' },
      { key:'subtitle', label:'Region' }
    ]
  }
}
```

`map` keys are the generic slots the engine understands: `image`, `title`,
`subtitle`, `years`, `misc`, `excerpt`. `filterable[].key` refers to those
generic slots, not to your column names.

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

**5. Fill it cheaply.** `datasets/README.md` documents `enrich.mjs` (free Wikipedia
excerpt + image fill) and `suggest.mjs` (proposes new entries). Run those before
writing anything by hand.

**6. Rebuild the atlas**, or your rows exist in the CSV and nowhere the atlas can see:

```
node datasets/migrate.mjs      # CSVs -> atlas/entries.jsonl (reads CSVs, never writes them)
node datasets/embed-all.mjs    # fill missing vectors (resumable)
node datasets/atlas.mjs        # place new entries, keep the map stable
node datasets/verify.mjs       # 28 invariants
```

Use plain `atlas.mjs`, **not `--rebuild`**, unless you mean to re-fit the whole
hierarchy: incremental placement holds every existing `y` exactly, so the map does
not move under you. `--rebuild` throws that away.

`embed-all.mjs` only fills *missing* vectors — nothing hashes entry text, so it
cannot see an **edited** title or excerpt. After editing existing rows you need
`--force`, which re-embeds all of them.

### Adding data without a CSV — the thing to actually use

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
candidates on *Cubism*. `datasets/ATLAS.md` has the details, including the `rowspan`
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

---

## The atlas

`project/features/atlas/`. Reachable from the home page ("Open the atlas") and wired
in `project/app/init.js` as `window.openAtlas`.

| file | role |
|---|---|
| `data.js` | loads `atlas.json`, typed arrays, spatial grid, topic index, priority |
| `scales.js` | x/y transforms, the zoom model, the three time ranges, tier + depth selection, ticks |
| `paint.js` | canvas: bands, spans, dots, chips, label packing, hit testing |
| `cards.js` | pooled DOM image cards + the hover preview |
| `detail.js` | the detail panel + enlarged image |
| `rail.js` | cluster rail with collapse/pin, and the pinned-strip painter |
| `styles.js` | the whole stylesheet |
| `index.js` | orchestrator: window, camera, frame loop, all interaction |

The data it reads is built by `datasets/atlas.mjs`; see `datasets/ATLAS.md`.

### Design decisions — do not re-litigate these

- **x is linear, always.** Compressing or eliding empty stretches was offered and
  rejected. Gaps should read as real.
- **Three time ranges, one linear axis each.** A single axis cannot serve both a
  5,000-year corpus and the age of the Earth, so a *mode* picks the **domain** and
  the ladder that suits it — `MODES` in `scales.js`:

  | mode | domain | span |
  |---|---|---|
  | `civ` — Civilization | 3000 BC … now | 5,026 yr |
  | `human` — Humans | 300,000 yr ago … now | 302,026 yr |
  | `earth` — Earth | 4.54 Ga … now | 4.54 Gyr |

  This does **not** reopen the decision above: inside a mode x stays strictly
  linear, nothing is warped or elided, and a gap still reads as the real gap it is.
  Only the far edge moves. If a change here starts to need a piecewise or log x
  transform, it has become the rejected design wearing a hat.
- **The zoom-out floor is derived, never hardcoded.** `ppyRange(view)` returns the
  px-per-year that exactly fits the active domain. A constant floor is only right
  for the corpus it was measured against: `PPY_MIN = 0.02` was chosen for ~3,500
  years, one entry at −113,000 pushed the required value to 0.0139, and **Fit
  silently stopped fitting** — landing on 50,000 years of empty prehistory with one
  point on screen. Derived, "zoomed all the way out" and "the whole domain is on
  screen" cannot drift apart.
- **Only the widest mode stretches to reach the data.** `domainFor()` widens `earth`
  left if an entry predates it, so nothing is unreachable everywhere. The narrower
  modes hold their fixed edge and the status line reports what they leave behind
  (`13 before 3000 BC`) — silent truncation would read as "that is all there is".
- **Mode changes are manual.** The next-wider button highlights once you are against
  the current edge, and never acts on its own: an automatic flip redefines the whole
  axis under you and you cannot tell whether you zoomed or the map did. Switching
  keeps your place, *unless* you were already zoomed out — then the new range is
  fitted, because 5,000 years is invisible inside 4.5 billion either way and the
  toggle would look inert.
- **Axis labels use a different vocabulary from entry labels.** An entry is always
  `1066` or `3000 BC` (`fmtYear`). An axis at 250-Myr spacing cannot be, so `fmtTick`
  picks its unit from the **step**, not the value — every label on one axis shares a
  unit and the spacing reads as even. `ka`/`Ma`/`Ga` mean *ago*, so a positive year
  never gets one; the padded right edge is `present`.
- **y is unitless `[0,1]`** and its zoom is *coupled* to x's by
  `coupledYZoom(ppy) = 1 + ppy^0.62 * 1.35`. Alt+wheel zooms y alone. Linear
  coupling ran vertical zoom away long before the cards appeared.
- **Detail arrives gradually, not by tier switching.** `tierFor(ppy)` sets only what
  is *offered*; `packLabels()` then places labels in a fixed **global** priority
  order until space runs out. That priority is viewport-independent on purpose —
  anything position-dependent makes cards shimmer as you pan. Dots always draw.
- **Cluster bands are filled, never stroked.** An outlined band beside an outlined
  card is what read as doubled borders. One hairline at each band's top edge only,
  so adjacent bands share a line.
- **Band labels stick to the viewport's left edge**, not to the band's first entry,
  or the label scrolls away exactly when you still need it.
- **Collapse folds the map band *and* hides the rail's children.** One control,
  because it is one intent.
- **Collapsing warps the y axis; it does not just stop drawing.** A folded cluster
  used to keep its full height and go dark, so folding a big branch bought a tall
  empty stripe and no room. `makeYWarp` in `scales.js` squeezes each folded range to
  a **15px strip** and stretches the rest of the axis back out over the gap. Two y
  spaces exist because of it: `A.y[i]` is **atlas** y and never changes, while
  `yTop`/`iy`/the saved prefs are **layout** y. `sy()` takes atlas y and returns
  pixels, so painting is unaffected; the handful of places that mix the two say so
  with `warpY`/`unwarpY`. The strip is *pixel*-sized rather than axis-sized, so a
  fold cannot grow as you zoom in — which makes the warp mildly zoom-dependent, and
  cursor-anchored zoom drifts a pixel or two beside a strip. That is the cheaper
  error, and `focusNode` runs its fit twice to settle it.
- **A scroll pans, a pinch zooms.** Both arrive as `wheel` and the *only* thing
  separating them is `ctrlKey`, which the browser sets synthetically on a trackpad
  pinch. Plain wheel pans both axes at 1px of delta to 1px of movement, shift pans
  time (a mouse wheel has no `deltaX`), ctrl/cmd zooms at the cursor, alt zooms the
  topic axis. Wheel-as-zoom made a two-finger scroll — the way you move around every
  other map — fly you in and out instead. `ZOOM_RATE` in `index.js` is the one number
  to tune if pinch feels wrong: pinch deltas are much smaller per event than a wheel
  notch and arrive in long streams.
- **Light is the default theme, and both halves have to move.** `styles.js` holds no
  literal colour below `:root` — two variable blocks swapped by `data-theme` on
  `<html>` — because a one-off hex for a hover state is exactly where a second theme
  leaks. The canvas cannot read CSS variables, so `PALETTES` in `paint.js` is the
  matching pair and `setCanvasTheme` mutates `COLORS` in place. Band alphas are
  per-theme, not shared: a cluster colour is OKLCH lightness ~0.6, so a 7.5% wash
  reads on near-black and vanishes on white. `hueInk()` darkens a cluster colour
  before it is used as *text*, since the same hue is only ~3:1 on white.
- **The sidebar folds to a 22px spine, it does not vanish.** Hidden outright, the
  only way back is a toolbar button you have to already know about; the spine keeps
  the chevron on the edge you clicked.
- **Pin lifts a cluster into a top strip sharing the map's x transform**, so you can
  hold "Cubism" pinned and pan four centuries past it. Max 6 pins, ≤42% of viewport.

### Atlas gotchas

These all cost time at least once.

- **NO BACKTICKS IN A COMMENT INSIDE `styles.js`'s CSS TEMPLATE.** One closes the
  string and the rest of the stylesheet is parsed as JavaScript, surfacing as
  `Unexpected identifier` or `Invalid left-hand side expression in postfix operation`
  (`--bg` read as a decrement) pointing at a line of CSS, with the whole atlas failing
  to load. **Three separate sessions have lost time to this.** `verify.mjs` now greps
  for it, so `node datasets/verify.mjs` catches it in a second instead.
- **A flex item's automatic minimum size beats `flex-basis`.** `.rail` is written
  `flex:0 0 216px` and was rendering at **466px**, eating a third of the map, because
  `min-width` defaults to `auto` = min-content and the longest cluster label
  ("Great Britain · Kingdom · House Of Windsor") is `nowrap`. `.rlabel`'s ellipsis
  never engaged because the row was never actually constrained. `min-width:0` is the
  fix and is asserted by QA.
- **`window.__atlas.view` changes synchronously; `window.__atlas.scale` does not.**
  `scale` is rebuilt in `paint()` one frame later, so a check that toggles a fold and
  then measures with `sy()` reads the *old* geometry. Poll on `scale.warp.n`, not on
  `view.folded.length`. This made a working fold report "folding freed no space".

- **Wikimedia only serves a fixed set of thumbnail widths** — 20, 40, 60, 120, 250,
  330, 500, 960, 1280, 1920, 3840 (`WM_STD_WIDTHS` in `utils/helpers.js`). Since 2025
  a direct hotlink at *any* other width is rejected with **HTTP 400**, not rounded.
  Asking for 320px broke every card image at once, and because a failed image
  degrades silently to a text card it looked like a data gap rather than a bug.
  `thumbUrl()` snaps to the nearest standard width — if you change `IMG_W` in
  `cards.js`, every value must stay on that list. Run `datasets/imgcheck.mjs` after
  touching any of this.
- **Dead image URLs** degrade to text cards, so a broken Wikimedia link looks
  intentional rather than broken. Worth a periodic link check.
- **Images are never cropped.** `object-fit: contain` on the card, hover preview,
  detail panel and enlarged view. `qa-atlas.mjs` asserts loaded images keep their
  aspect ratio to within 4%, and that no card carries a border *and* an outline —
  selection and hover are `box-shadow` rings outside the border.
- **This module's code runs in the *opener's* realm.** Two consequences:
  - **Timers must come from the atlas window.** Browsers throttle a backgrounded
    tab's timers to ~1s, and the opener is backgrounded the whole time you use the
    atlas. The search debounce and resize handler were both ~1s late. Use
    `w.setTimeout` / `w.clearTimeout`.
  - **DOM nodes must be created by the popup's document.** `document.createElement`
    builds nodes in the opener's document; browsers auto-adopt on append but
    `ownerDocument` stays wrong. Use `root.ownerDocument.createElement`, and
    `D.defaultView.innerWidth` rather than `window.innerWidth`.
- **Never put a backtick in a comment inside a template literal.** A comment reading
  `` `--hue` `` inside `styles.js`'s CSS template closed the string, and the CSS was
  then parsed as JavaScript — surfacing as `SyntaxError: Invalid left-hand side
  expression in postfix operation`, because `--bg` read as a decrement. This bit
  twice: once in `styles.js`, once in a page-side probe in `qa-atlas.mjs`.
- **View prefs persist** in `localStorage` under `atlas:prefs:v1`, including
  `collapsed`, `pinned` and `mode`. If the atlas opens in a state you did not expect,
  that is why. `node datasets/reload.mjs --atlas` clears them. Prefs are read **once
  at open time**, so a test that clears them must do it on the *opener*, before
  `openAtlas()` — clearing afterwards silently inverted the pin and collapse tests.
- **`scale` is a frame behind the camera.** It is rebuilt in `paint()`, i.e. on the
  next animation frame, so two camera actions in one tick had the second reading the
  first's stale geometry: `setMode('civ')` then `gotoStop()` computed a centre from
  the mode it had just left, 2.2 billion years out, and clamped to the edge. Read the
  camera (`V`, or `midYear()`) rather than `scale` when acting.
- **The spatial grid resolves where the data is, not the full extent.** `denseExtent()`
  in `data.js` trims to the 1st/99th percentile before dividing into 128 columns.
  On the raw extent the resolution is set by the single oldest entry — one row at
  −113,000 made a column 899 years wide and put 99% of the corpus in six of them, so
  the x half of the grid stopped discriminating. Trimming is safe, not approximate:
  `query` clamps to the column range and then confirms real bounds per point.
- **`setPointerCapture` throws** `NotFoundError` when the pointer is already gone
  (synthetic events, fast clicks). Keep it in a try/catch.
- **The rail must rebuild when zoom changes its depth.** `depthFor()` picks which
  tree level the rail lists; only the collapse/pin/filter flags set `dirty.rail`, so
  `paint()` also compares against the previous depth.
- **`membersOf()` in `rail.js`** memoises per node in a `WeakMap` keyed by the atlas
  and scans all points on first call per node. Fine at 2.7k, revisit at 100k.
- **`atlas.json` (792KB) and `details.json` (794KB) load whole.** Points are columnar
  so parsing is fast, and details load after first paint. Past ~50k entries these
  want sharding or a binary blob; there is a note in `atlas.mjs`.

### Known rough edges (judgement calls, not bugs)

- The status readout can show a year range wider than the data (e.g. `1571 BC–3349`)
  when the whole extent fits in the viewport. Correct, looks odd.
- **78 of 227 cluster nodes share a label with a sibling**, so the rail shows
  `Byzantine` ×5 and `United States` ×4 — rows you cannot tell apart. Labelling picks
  each node's top topics independently; it needs to prefer a token that
  *distinguishes a node from its siblings*.
- **Band labels are occluded by cards** at detail zoom, since they pin to the
  viewport's left edge and a card can sit there.
- 88% of leaf clusters are single-source, expected while `art` + `leaders` are 68% of
  the corpus. Watch with `node datasets/inspect.mjs --cross`.

---

## The quiz

```
project/features/quiz/
  questions.js   what an entry can be asked, and whether an answer is right
  index.js       cluster picker, run state, rendering
```

One quiz over `datasets/atlas/atlas.json` + `details.json`, loaded through the
atlas's own `loadAtlas`. There are no per-dataset quizzes any more.

**The question is derived from the entry, not from a config.** That is the whole
substance of `questions.js`, and it exists because the old quiz asked every row for
the same fixed column list out of `settings.js` — a list that for `art.csv` ended in
`excerpt`, so it put a text box on screen and waited for 600 characters of Wikipedia
to be typed from memory. The rules:

- **The excerpt is never a question**, at any length.
- **A field with no value is never a question.**
- **`title` is asked only when the image IS the work.** Not merely "has an image":
  an `england` entry for Port Isaac carries a stock photograph of the village, which
  identifies nothing. A creator facet (`artist`, `director`, `creator`, `author`) is
  what says the picture is a reproduction of the thing being asked about; otherwise
  the title is shown as the prompt.
- **A span is asked for both ends**, a point for one year.
- **The categorical questions are whichever facets the entry actually carries**, so
  a painting is asked artist and movement and a leader country and role.
- **There is no topic question.** `migrate.mjs` puts a leader's country, party and
  role into `topics` as well as `facets`, so the answer was a free copy of a box
  already on screen; and where it was not a copy it was "name any bucket this
  belongs to", with no way to know which of several the grader held.
- **One question is enough**, as long as the prompt names the subject. A mined
  timeline event carries a title and a date and nothing else, and "in what year
  did this happen" is exactly the question it exists to support. A two-field
  minimum combined with dropping `topic` silently halved the corpus, 4,126 to
  2,266, and every casualty was one of those.

**The excerpt is shown once the answers are revealed.** Both halves of that are
deliberate: before grading its first sentence gives away every answer, and after
grading it is the only thing on screen that teaches you anything.

Filtering is by cluster — any node of the tree, taking every entry beneath it — plus
the atlas's own query language handed straight to `runFilter`, so `ds:film`,
`topic:surrealism`, `1750-1800` and `has:image` all work in the quiz too.

### Grading

Free text. Four rules worth not undoing, each of which has a test in `qa-quiz.mjs`:

- **A surname alone is correct.** "renoir" is what anyone looking at a Renoir types.
- **Whole-word containment only.** The old rule was
  `guess.includes(answer) || answer.includes(guess)`, which marked a single letter
  correct against every answer containing it — typing `a` scored.
- **A hyphen between two digits is a separator, not a minus sign.** `-?\d+` read
  the range `1837-1901` as 1837 and *minus* 1901, so a correctly typed reign was
  marked wrong.
- **Deep time is graded on magnitude and a relative tolerance.** The entry states
  itself as "c. 4,570 Ma"; demanding the sign would fail every honest answer.

`ł`, `ø`, `ß` and friends are transliterated before comparison — NFKD does not
decompose them, so `Chełmoński` was being split into the two words "che" and
"monski" and no keyboard-typeable spelling could match it.

---

## The old lane timeline (superseded)

> Kept for reference until `project/features/timeline/` and the
> `timeline_engine.js` shim are deleted. The atlas replaces all of it. Do not build
> on this.

`project/features/timeline_engine.js` is only a re-export. The engine is:

| file | role |
|---|---|
| `scales.js` | the px/year ladder, tick steps, cursor-anchored zoom |
| `model.js` | rows → items, search index, query parser |
| `layout.js` | lanes, packing, tier geometry — pure math, no DOM |
| `view.js` | virtualised renderer, node pool, delegated events |
| `chrome.js` | ruler, era band, minimap |
| `rail.js` | left rail (lane index + filter surface) |
| `lightbox.js` | detail view with lane navigation |
| `styles.js` | the whole stylesheet, injected once |
| `index.js` | orchestration, view state, the frame loop |

### Two invariants — breaking either undoes the design

1. **Layout never reads scroll position.** `computeLayout()` places lanes over
   the *full* time extent, so scrolling horizontally can never move anything
   vertically. Related topics stay at the same height as you travel through time.
   Lane packing (below) respects this: which band a lane lands in depends only on
   view state, never on where you happen to be looking.
2. **Representation is a function of zoom, not of the data.** One number
   (px/year) picks the tier. This is why "long eras" and "year by year" are the
   same control, and why the renderer never materialises thousands of cards.

Also load-bearing: the canvas is virtualised with a per-kind node pool
(~50–800 live nodes at any zoom), positioning is pure `transform`, gridlines are
a repeating CSS background, and there is **one** delegated listener per surface.
Do not reintroduce full-`innerHTML` re-renders or per-element handlers — that was
the original bottleneck.

### Controls

| | |
|---|---|
| `Eras / Centuries / Decades / Years / Detail` | the scale ladder |
| `⌘/ctrl + wheel` | zoom at the cursor |
| drag, `←/→`, `Home/End` | pan |
| `/` | focus search · `⌘K` palette · `0` fit · `r` rail · `f` filters |
| minimap | drag to pan, shift-drag to zoom to a range, double-click to fit |
| rail row | click to filter to that lane; `◆` pins it to the sticky band |
| section header | collapse the dataset |
| cluster / heat bin | click to zoom into its range |
| **Dense** | pack lanes that never overlap in time into one band (default on) |

Search accepts free text plus `1750-1800`, `ds:science`, `field:optics`.
**Dim** keeps non-matches visible at low opacity (the shape of history stays
legible); **Hide** drops them.

### Where to tune the visuals

| want to change | edit |
|---|---|
| card / chip / dot / span sizes, gaps, lane padding | `GEO` at the top of `layout.js` |
| how aggressively lanes share a band | `GEO.BAND_GAP` + `packBands()` in `layout.js` |
| when cards become chips become dots become heat | `tierFor()` in `scales.js` |
| what each ladder button zooms to | `STOPS` in `scales.js` |
| zoom limits | `PPY_MIN` / `PPY_MAX` in `scales.js` |
| colours, typography, borders, the lightbox | `CSS` in `styles.js` |
| dataset hue | `color` on the `DATASETS` entry |
| card/chip/detail markup | `itemHTML()` in `view.js` |
| how far offscreen to pre-render | `MARGIN_X` / `MARGIN_Y` in `view.js` |
| pinned-band max height | `PIN_BAND_MAX` in `index.js` |
| default lane cap / sort / era band | the `V` object in `index.js` |

Current values worth knowing: tier thresholds are `<0.35 heat`, `<2.2 dot`,
`<10 chip`, `<38 card`, else `detail` (px/year). `CARD_H` 196, `CHIP_H` 48 and
`DETAIL_TEXT_H` 156 are sized to the *worst case* text; shrink them and text
clips silently, because `.body` is `overflow:hidden`. A card is now image-led —
the picture takes every pixel the caption does not, and the caption is title +
year only (the subtitle moved to the tooltip and lightbox).
`TAG_INSET` (17px) reserves the strip the sticky lane tag sits in — if you remove
lane tags, that space is reclaimed automatically.

If you change a geometry constant, re-check for clipping (the QA recipe below
measures it) rather than eyeballing it.

### Gotchas

- **Lane count explodes on high-cardinality facets.** `film → Director` and
  `art → Artist` produce ~500 lanes / 126,000px. The **Max lanes** control
  (default 24) folds the tail into one "N smaller lanes" rollup; clicking it
  expands to all. Nothing is dropped.
- **View prefs persist** in `localStorage` under `tl:prefs:<title>`. If the
  timeline opens in a state you did not expect, that is why — hit **Reset view**,
  or use a fresh browser profile when testing.
- **Multi-value facet cells** (`a|b`) put the item in the *first* value's lane
  only, deliberately: duplicating it would make lane heights depend on the data.
- **The era band needs long spans.** It shows spans wide enough to label at the
  current zoom and reports how many were too short. With only reigns (median
  8 years) and lifespans (median 71) it is sparse when zoomed out — a wars /
  periods dataset is what it was built for.
- **`layout.rows` lane entries are bands, not lanes**: `{type:'lane', lanes:[…], y, h}`.
  With **Dense** on a band holds several non-overlapping lanes; with it off,
  exactly one. Anything reading `row.lane` (singular) is out of date.

---

## Visual QA without installing anything

Chrome is enough; there is no Playwright/Puppeteer and none is needed.

```
node datasets/serve.mjs
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank

node datasets/verify.mjs                      # 26 data invariants, ~1s
node datasets/qa-atlas.mjs                    # 87 browser checks
node datasets/qa-atlas.mjs --shot /tmp/a.png  # + a screenshot
node datasets/qa-atlas.mjs --keep             # leave the windows open

node datasets/qa-quiz.mjs                     # 42 checks: home + quiz + grader
node datasets/qa-quiz.mjs --shot /tmp/q.png
```

`window.__atlas` on the atlas window is a deliberate debug handle, exposing
`atlas, view, scale, visible, placements, filter, tier, depth`, the time-range
readouts `mode, modes, domain, ppyRange, atEdge, outside`, and
`select/focusNode/fit/zoom/setQuery/toggleCollapse/togglePin/goto/setMode/gotoStop`.

**Drive the view through that handle, not through synthetic wheel events.** Most of
a scatter plot is empty space, so wheeling at guessed coordinates lands on nothing
and you end up measuring a blank screen. `--shot` used to do exactly that and
produced blank screenshots reading `0 in view` for weeks; it now goes to the densest
entry that has an excerpt and waits for points to be in frame.

Things this cost time to learn:

- **Disable the HTTP cache** (`Network.setCacheDisabled`). Otherwise Chrome serves a
  cached `atlas.json` from the persistent `--user-data-dir` and your suite passes
  against data you already rebuilt.
- **Clear `localStorage` on the opener, before `openAtlas()`.** Prefs are read once at
  open time, so clearing them afterwards is too late. Leaked `collapsed`/`pinned`
  state silently inverts the pin and collapse tests.
- **Assert on the DOM with a poll, not a snapshot.** View state changes synchronously
  in the event handler; the DOM catches up in `paint()`, a frame later. A snapshot
  read passes or fails depending on timing.
- **If everything fails at once, check the server** — `curl -sf localhost:8777/`. A
  dead server surfaces as `ERR_CONNECTION_REFUSED` in the *page's* log, which the
  suite does not print, so it reads as a module error in your own code. The server
  dying between sessions is common; a stale tab then looks like an app that ignored
  your edits.
- `Runtime.evaluate` needs `userGesture: true`, or `window.open` is popup-blocked and
  the atlas never opens.
- The atlas is a separate **target**, not a frame; attach and use its own `sessionId`.
- Handle `Page.javascriptDialogOpening`; an unhandled `alert()` wedges the page.
- `--headless --screenshot --virtual-time-budget` hangs here. Use CDP.
- Count only nodes with `style.display !== 'none'` — the card layer keeps a hidden
  recycling pool attached to the DOM.
- Add `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"` for fast logic
  runs; drop it when you actually want to see the images.

For pure layout logic, a Node harness still beats screenshots: shim `window`,
`localStorage` and `document.createElement`, import the modules directly, and assert
invariants. It runs in about a second.
