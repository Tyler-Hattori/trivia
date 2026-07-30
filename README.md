# Trivia — an atlas + quiz over CSV datasets

A static site (no build step, no npm) that renders `datasets/*.csv` as:

- **The atlas** — the main view. A zoomable map where **x is time** and **y is
  semantic similarity**, derived from local embeddings. Related things sit at the
  same height whatever century they are from.
- **Quiz** — field-guessing drills over the same rows.

The atlas is fed by a compiled store (`datasets/atlas/`), not by the CSVs directly;
`datasets/ATLAS.md` is the authority on that pipeline and **you should read it before
touching any of it**. The quiz is still config-driven from
`project/core/settings.js`, where adding a dataset is a CSV plus one array entry.

```
index.html                 app shell (Tailwind via CDN)
project/
  core/settings.js         DATASETS — the single source of truth for the CSV path
  core/state.js            runtime state
  data/csv.js              header-driven CSV parser (one record per line)
  utils/normalize.js       raw row -> item (via DATASETS[].map)
  utils/helpers.js         thumbUrl(); year parsing re-exported from datasets/lib/years.mjs
  features/quiz_engine.js  quiz
  features/atlas/          THE ATLAS RENDERER (see below)
  features/timeline/       the old lane timeline — superseded, pending deletion
  ui/                      home, header, quiz, stats
datasets/                  the CSVs, the atlas pipeline, and the tooling (own README)
datasets/atlas/            the compiled store the browser fetches
thumbnails/                optional pre-built local thumbnail cache
```

> **Status.** The atlas replaces the lane timeline. The lane engine still works and
> is still reachable from the home page as "Old lane timeline", but its five known
> bugs were deliberately not patched — they are solved structurally in the atlas.
> Its sections below are kept only until `project/features/timeline/` is deleted.
> See `HANDOFF.md` for what is done and what is next.

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
node datasets/verify.mjs       # 21 invariants
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
```

Ingested entries are distinguished from CSV rows by `origin.wiki` / `origin.qid`,
**not** by `origin.dataset` — `--domain art` sets `origin.dataset: 'art'`, colliding
with `art.csv`. `migrate.mjs` used to key its carry-over on the dataset name, which
meant a routine re-run silently deleted every ingested entry. Keep that distinction
intact.

---

## The atlas

`project/features/atlas/`. Reachable from the home page ("Open the atlas") and wired
in `project/app/init.js` as `window.openAtlas`.

| file | role |
|---|---|
| `data.js` | loads `atlas.json`, typed arrays, spatial grid, topic index, priority |
| `scales.js` | x/y transforms, the zoom model, tier + depth selection, ticks |
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
- **Pin lifts a cluster into a top strip sharing the map's x transform**, so you can
  hold "Cubism" pinned and pan four centuries past it. Max 6 pins, ≤42% of viewport.

### Atlas gotchas

These all cost time at least once.

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
  `collapsed` and `pinned`. If the atlas opens in a state you did not expect, that is
  why. `node datasets/reload.mjs --atlas` clears them.
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

node datasets/verify.mjs                      # 21 data invariants, ~1s
node datasets/qa-atlas.mjs                    # 50 browser checks
node datasets/qa-atlas.mjs --shot /tmp/a.png  # + a screenshot
node datasets/qa-atlas.mjs --keep             # leave the windows open
```

`window.__atlas` on the atlas window is a deliberate debug handle, exposing
`atlas, view, scale, visible, placements, filter, tier, depth` and
`select/focusNode/fit/zoom/setQuery/toggleCollapse/togglePin/goto`.

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
