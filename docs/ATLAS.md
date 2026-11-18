# The atlas

The whole store as the topic timeline's **Lanes** (2026-11-18). Opened from the
home page's Atlas door or a topic's "Atlas ↗" (`window.openAtlas`, wired in
`project/app/init.js`), in a popup window.

| file | role |
|---|---|
| `project/features/atlas/index.js` | orchestrator: window, toolbar, header, gestures, detail panel, prefs |
| `project/features/atlas/lanes.js` | pure layout (`layoutAtlas`, `capsFor`, `kindOf`, `weightOf`); no DOM, runs in Node |
| `project/features/atlas/lanedata.js` | loads `datasets/web/atlas/`, buckets as you zoom, details, search |
| `project/features/atlas/scales.js` | the x axis: three time ranges (`MODES`), fit, clamp, ticks, year formats |
| `project/features/atlas/styles.js` | the shell's CSS; entries/lanes/eras use `project/ui/lanes-css.js` |
| `project/ui/lanes-css.js` | the Lanes CSS, **shared with the topic timeline** so both draw an entry the same way |
| `datasets/lib/atlas-lanes.mjs` | which lane each entry lives in; sections; eras per time range |
| `datasets/build-web.mjs` | writes `web/atlas/` (section "The atlas") |
| `project/features/atlas/data.js` | the OLD scatter atlas's loader: only the cluster quiz (`#/cluster-quiz`) still uses it, with `atlas.json` |

## What the browser loads (`datasets/web/atlas/`, built by build-web.mjs)

- `meta.json`: sections, lanes (with each lane's time extent), eras per range, the bucket list.
- `top.json`: the 5,000 most important entries, at least 40 per lane: all there is
  room for zoomed out. `long.json`: spans too long for a bucket.
- `b-NNN.json`: everything else by start year (a span joins every bucket it reaches),
  loaded only when the window on screen needs at most 10 buckets.

Opening costs ~400 KB gzipped (was `atlas.json`, 27 MB / 7 MB gz). A view's bytes do
not grow with the store; only the bucket count does. Entries are the topic files'
versions: the audit's date corrections and types, the short titles of mined events
(`titles*.json`), and nothing a topic keeps off its timeline (untitled prose
sentences, suspect dates, undated ideas). An entry in no topic that is an untitled
mined sentence is left out too (21k of them today: the titling pass brings them in).
Excerpts and neighbours (`nn`) load per entry from `web/details/` (its `g` group).
Search hits come back as lite rows, which carry the lane (`ln`, `p`, `g`), so a hit
not loaded yet is still placed.

## Organisation (datasets/lib/atlas-lanes.mjs)

- **Sections** are the topic tree's roots (`topic-structure.json` parent links):
  World, Europe, Middle East, Africa, Asia, Americas, Oceania, Science, Arts & ideas,
  Earth & life (first in the Humans and Earth ranges, last in Civilization).
- **Lanes** are topics, depth-first in the tree (Italy, then Ancient Rome), each
  entry in exactly ONE lane: the topic where it matters most (essential there 4,
  importance x3, on the timeline 1, off-topic −3, depth 0.6 per level, collection
  −2, +1.5 for the topic whose article brought it in: Battle of Hastings in
  England, not Viking Age).
- **No topic: its category and region.** Science subjects go to the science topic
  that covers them (Physics, Chemistry…); culture subjects get lanes of their own
  (Visual arts, Films…); history by region, split by subregion ("Southern Europe:
  other"). A fallback lane under 25 entries joins its section's catch-all.
- **Inside a lane, kinds in the timeline's order**: eras/states (tinted bars, name
  inside, the label slides along), events (dot + title; 3px line under the title if
  it lasted), people (life line, name, 15px round portrait), works (square) and
  places/groups (hollow dot). Only events and lives get a duration line.
- **Weight, not size**: bold = famous (fame ≥ 0.6, Wikidata sitelinks) or an
  essential of its topic; grey = little known (priority < 8); else medium.

## Layout (lanes.js)

- Packed most important first (`p`: fame, essential, importance, picture) into the
  first row with room, per lane per kind, up to `capsFor(zoom)` rows (more as you
  zoom in; "N more ▾" on a lane gives it three times as many; search too).
  Occupancy is a 4px-cell bitmap per row, ~30 ms for a full re-layout.
- Laid out for a window **three screens wide**; panning inside it only moves a
  transform. Leaving it, zooming, a filter, a fold or a pin lays out again, keeping
  the lane at the top of the screen where it was.
- The DOM holds only the lanes within a screen of the scroll position.
- Labels against the present (the right end of time) flip to the left of their dot.
- A span covering the whole view and more than twice it is context, not drawn
  (the timeline's umbrellas).

## Interaction

Toolbar: one row (search, range, − +, Fit, ⋯ for zoom stops / go to a lane / fold
all / help, ▲ hides the bar). Header: overview strip (eras of the range, the box is
the view; click or drag), era bands (click to fit), ticks, pinned lanes. Body:
scroll = up/down (native, so phones scroll naturally); drag, shift+scroll or
sideways scroll = time; pinch / ctrl+scroll = zoom at the cursor. Click a lane name
to pin it (max 6, ≤ 40% of the height), a section to fold it, an entry to open it
(‹ › or ←/→ step through its lane; Esc closes). Prefs: `atlas:prefs:v2` (range,
camera, pins, folds, toolbar).

## Decisions: do not re-litigate

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
- **Lanes, not a scatter** (user, 2026-11-18): the atlas looks and reads like the
  topic timeline: no sidebar, no image cards, no canvas, no embedding y. The
  embedding tree (`atlas.mjs`) still exists for neighbours ("Related") and the
  details grouping, not for position.
- **Organised by topic and category, not only by kind** (user): topic lanes first,
  category/region lanes for the rest, kinds inside each lane.
- **Fame is bold text** (user), not a bigger dot or a ring.
- **Portraits are small and round** (user, accepting the crop): `object-fit:cover`
  as on the timeline. The detail panel's picture is still uncropped (`contain`).
- **Light only.** The dark theme went with the canvas (the timeline has none).
- **What a topic keeps off its timeline, the atlas does not show.** Accuracy first.

## Gotchas

- **NO BACKTICKS INSIDE A CSS TEMPLATE** (`styles.js`, `topic/styles.js`,
  `ui/lanes-css.js`): one closes the string and the CSS parses as JavaScript.
  `verify.mjs` checks all three.
- **This module's code runs in the opener's realm.** Create nodes with the popup's
  document (`D`), take timers from the popup (`w.setTimeout`), and give the popup
  any global an inline handler calls (`w.imgRetry = imgRetry`).
- **The popup is reused by name** (`window.open('', 'atlas')`): QA that reopens it
  must emulate the atlas target, not just the opener.
- **A mode change scrolls to the top** (sections reorder); every other re-layout
  keeps the top lane anchored.
- **Generated data is not on main**: `web/atlas/` comes from `build-web.mjs`, which
  needs `topics/` and `atlas/` (see HANDOFF).
- Wikimedia serves fixed thumbnail widths (`WM_STD_WIDTHS`, `thumbUrl` snaps); the
  web build strips the API's `?utm_source=` suffix from image URLs.

## Rough edges

- Spans with no data in their bucket's stretch can briefly appear/disappear at a
  window edge while buckets load.
- Linear time crowds the recent end at the full Civilization fit (most entries are
  after 1500); zoom or the era bands are the way in.
- Store duplicates show as two entries in different lanes (Napoleon / Napoleon
  Bonaparte): `dedupe-events.mjs` territory.
- `scales.js` still holds the scatter's y-axis helpers (`makeYWarp`, `coupledYZoom`,
  `tierFor`, `depthFor`): unused by the lanes atlas, kept for nothing; remove when
  touching that file.
