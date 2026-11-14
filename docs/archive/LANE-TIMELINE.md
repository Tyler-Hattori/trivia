# The old lane timeline (superseded)

> **Archived.** The code was deleted in the 2026-11 cleanup; the last commit
> that has it is `252c0bf`. The atlas and the Topics timeline replace it. Kept
> only because some of the design notes still apply to the Topics timeline.

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

## Two invariants — breaking either undoes the design

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

## Controls

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

## Where to tune the visuals

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

## Gotchas

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
