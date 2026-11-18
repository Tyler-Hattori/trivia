# The atlas

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

The data it reads is built by `datasets/atlas.mjs`; see `docs/PIPELINE.md`.

## Look: the Lanes style (2026-11-17)

The atlas is being brought to the look of the topic timeline's Lanes view
(`project/features/topic/styles.js` `.tp-ln`/`.tp-lanelab`). Done, without
touching any decision below:

- white ground and panels, `#e5e7eb` hairlines, near-black (not blue) for the
  active state; band wash kept but pale (light `bandFill` 0.035); a band's top
  edge is a neutral hairline (`COLORS.hair`), a folded band keeps its hued edges;
- band names drawn like lane names (`laneLabel` in `paint.js`): small grey
  uppercase, letter-spaced, a 6px swatch of the band colour in front; also used
  by focus bands and the pinned strip; entry labels are packed around them;
- entry labels are bare text (no chip box or colour stripe) on a ground-coloured
  backing; famous = 700 near-black, others 500 slate, 11.5px (`labelFont`);
  a labelled point gets a round 3-4px dot; a labelled span that is visibly long
  (and under `LONG_SPAN_FRAC`) has its title ABOVE its line and the line drawn
  3px with end ticks, the Lanes' duration underline;
- phones (< 700px) start with the rail folded to its spine unless the saved
  prefs say otherwise.

Not done, because each changes a decision below (ask the user first): packed
rows instead of embedding y, retiring the rail for inline band names, image
cards replaced by labels with small round portraits (crops), fame shown by
weight only (no bigger dot/ring), era bands + overview strip in the header.

## Design decisions — do not re-litigate these

- **The top two layers are KNOWN; only the layers below are learned.**
  - **Layers:**
    - depth 1 is a subject group (History & Society, Culture, Science &
      Technology, Geography)
    - depth 2 is a subject (History, Politics and government, Military and
      warfare, Visual arts, Films, Physics, Mathematics…)
    - embedding clusters exist only inside one subject
  - **Where the names come from:** Wikimedia's articletopic taxonomy, fetched
    free by `datasets/classify.mjs`.
  - **Why:** this fixed the worst of the old rail ("Politician · President" ×5,
    "Byzantine" ×5, a "Rococo" band over 1400). Embeddings are good at "which
    paintings are closest" and bad at naming broad subjects.
  - **Why not Wikipedia's own category graph:** walking up from *Battle of
    Hastings* touches 1,260 categories in six levels and reaches Politics before
    History.
  - **Labels are used structurally, never embedded.** Embedding `domains` made
    the map re-derive its source CSVs (`docs/PIPELINE.md`).
  - **People are filed by their field, not under "Biography":** Henry VIII is
    Biography 0.87 / History 0.29 → History, beside Bosworth.
  - Subjects under 25 entries fold into one "Other …" row per group.
  - Sibling clusters that still share a name get a distinguishing second term.
  - Search with `subject:physics` and `region:northern_europe`. The detail
    panel's breadcrumb shows the path.
- **A span much wider than the screen is context, not a mark.** Past 75% of the
  viewport (`LONG_SPAN_FRAC` in `paint.js`):
  - it draws as a 1px line at low alpha
  - it can't be grabbed along its bar, only at its start point

  Also, a nearby point **always** beats a span's bar. Before this, *Plants*
  (hundreds of millions of years) crossed the screen at most zooms, and because
  bar distance was compared against points' full distance, hovering near its
  row anywhere selected it.

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
- **Fame is a highlight, not a filter.** `A.fame` (Wikidata sitelinks, log-scaled —
  see `docs/PIPELINE.md`) feeds `A.prio` and drives a restrained highlight above
  `FAME_HI` in `paint.js`: a larger dot, a hairline ring, a bold chip label. Kept to
  bigger-mark-plus-ring rather than a glow or a colour change, to match the
  filled-not-stroked, one-hairline aesthetic everywhere else on the canvas. An entry
  with no QID (a mined event, a hand-entered row) just gets fame 0, same treatment as
  an entry with no image.
- **Free-text search adds hybrid matches from `/api/search`.** That route
  combines BM25 with 768-d EmbeddingGemma scores, using the model's
  `task: search result | query:` prefix, a calibrated similarity floor, and
  rank fusion. So a phrase with no literal overlap ("guy who invented the
  telephone") still finds Bell, and **a nonsense query finds nothing**.
  - **Corrected 2026-11-13:** the README used to say no threshold could separate
    real matches from noise, because `zzzznotathing` scored 0.58. That was the
    query being embedded without its prefix. With the prefix it scores 0.28, and
    real queries start near 0.47.
  - Hybrid matches are still an OR on top of literal substring matching, and fail
    soft to substring-only without Ollama.
  - Full measurements: `docs/SEARCH.md`.

## Atlas gotchas

These all cost time at least once.

- **NO BACKTICKS IN A COMMENT INSIDE `styles.js`'s CSS TEMPLATE.** One closes the
  string and the rest of the stylesheet is parsed as JavaScript, surfacing as
  `Unexpected identifier` or `Invalid left-hand side expression in postfix operation`
  (`--bg` read as a decrement) pointing at a line of CSS, with the whole atlas failing
  to load. **Three separate sessions have lost time to this.** `verify.mjs` now greps
  for it, so `node datasets/qa/verify.mjs` catches it in a second instead.
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
  `cards.js`, every value must stay on that list. Run `datasets/scripts/imgcheck.mjs` after
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
  that is why. `node datasets/qa/reload.mjs --atlas` clears them. Prefs are read **once
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

## Known rough edges (judgement calls, not bugs)

- The status readout can show a year range wider than the data (e.g. `1571 BC–3349`)
  when the whole extent fits in the viewport. Correct, looks odd.
- **78 of 227 cluster nodes share a label with a sibling**, so the rail shows
  `Byzantine` ×5 and `United States` ×4 — rows you cannot tell apart. Labelling picks
  each node's top topics independently; it needs to prefer a token that
  *distinguishes a node from its siblings*.
- **Band labels are occluded by cards** at detail zoom, since they pin to the
  viewport's left edge and a card can sit there.
- 88% of leaf clusters are single-source, expected while `art` + `leaders` are 68% of
  the corpus. Watch with `node datasets/scripts/inspect.mjs --cross`.
