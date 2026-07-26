# Trivia — timeline + quiz over CSV datasets

A static site (no build step, no npm) that renders `datasets/*.csv` two ways:

- **Timeline** — a zoomable, filterable, searchable history canvas.
- **Quiz** — field-guessing drills over the same rows.

Everything is config-driven from `project/core/settings.js`. Adding a dataset is a
CSV plus one entry in that array — no engine edits.

```
index.html                 app shell (Tailwind via CDN)
project/
  core/settings.js         DATASETS — the single source of truth
  core/state.js            runtime state
  data/csv.js              header-driven CSV parser (one record per line)
  utils/normalize.js       raw row -> timeline item (via DATASETS[].map)
  utils/helpers.js         thumbUrl(), parseYears(), yearValue()
  features/quiz_engine.js  quiz
  features/global_timeline.js   loads every CSV -> timeline
  features/timeline/       the timeline engine (see below)
  ui/                      home, header, quiz, stats
datasets/                  the CSVs + zero-dependency tooling (own README)
thumbnails/                optional pre-built local thumbnail cache
```

## Running it

The app uses ES modules and `fetch`, so `file://` will not work — serve it:

```
python3 -m http.server 8777      # then open http://localhost:8777/
```

The timeline opens in a **named popup window** (`window.open('', 'timeline')`), so
allow pop-ups. To verify changes in a real browser without installing anything,
see "Visual QA" at the bottom.

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

**5. Fill it cheaply.** `datasets/README.md` documents `enrich.mjs` (free
Wikipedia excerpt + image fill) and `suggest.mjs` (proposes new entries). Run
those before writing anything by hand.

---

## The timeline engine

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

Search accepts free text plus `1750-1800`, `ds:science`, `field:optics`.
**Dim** keeps non-matches visible at low opacity (the shape of history stays
legible); **Hide** drops them.

### Where to tune the visuals

| want to change | edit |
|---|---|
| card / chip / dot / span sizes, gaps, lane padding | `GEO` at the top of `layout.js` |
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
`<10 chip`, `<38 card`, else `detail` (px/year). `CARD_H` 170, `CHIP_H` 48 and
`DETAIL_TEXT_H` 150 are sized to the *worst case* text (2-line title + subtitle
+ year); shrink them and text clips silently, because `.body` is `overflow:hidden`.
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
- **Dead image URLs** degrade to text cards (`.card img.failed`), so a broken
  Wikimedia link looks intentional rather than broken. Worth a periodic link check.

---

## Visual QA without installing anything

Chrome is enough; there is no Playwright/Puppeteer and none is needed.

```
python3 -m http.server 8777
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-tl
```

Then drive it over the DevTools Protocol from Node (global `WebSocket`):
`Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`.

- Use a **fresh `--user-data-dir` every run** — otherwise persisted view prefs
  leak between runs and results are not reproducible.
- `Runtime.evaluate` needs `userGesture: true`, or `window.open` is popup-blocked
  and the real timeline path never opens.
- Handle `Page.javascriptDialogOpening`; an unhandled `alert()` wedges the page.
- `--headless --screenshot --virtual-time-budget` hangs here. Use CDP.
- Count only nodes with `style.display !== 'none'` — the renderer keeps a hidden
  recycling pool attached to the canvas.
- Add `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"` for fast
  logic runs; drop it when you actually want to see the images.

For layout logic, a pure-Node harness beats screenshots: shim `window`,
`localStorage` and `document.createElement`, import `model.js` / `layout.js` /
`scales.js` directly, and assert invariants — lane `y` monotonic, specs sorted by
`x`, no overlap within a packed sub-row, `specsInWindow` matches brute force,
dim-mode layout byte-identical to unfiltered. It runs in about a second.
