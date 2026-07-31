# Handoff — toggleable timeline modes (geologic ⇆ human history)

Written 2026-07-29. **Built 2026-07-29.** The mode mechanism is done and green;
what remains is the *data* problem underneath it. Read this plus the atlas sections
of `README.md`, which now carry the design decisions.

Nothing here is committed. The standing preference is to leave work uncommitted
until asked.

---

## What was asked, and what shipped

Three time ranges, each a strictly linear axis at a different depth. Chosen: the
start of human civilization, the whole human span, and the history of the Earth.

| mode | label | domain | span | fit px/yr @1600px |
|---|---|---|---|---|
| `civ` | Civilization | −3000 … now | 5,026 yr | 0.26 |
| `human` | Humans | −300000 … now | 302,026 yr | 4.4e−3 |
| `earth` | Earth | −4.54e9 … now | 4.54 Gyr | 2.9e−7 |

A toolbar segment (`#modeSeg`), `m` to cycle, and the mode persists in
`atlas:prefs:v1`. `MODES` in `scales.js` is the single table; `fitView`,
`clampView`, `zoomAt`, `ppyRange`, `stopsFor` and `tickStep` all read the active
mode instead of module constants.

**Status: `node datasets/verify.mjs` 26/26, `node datasets/qa-atlas.mjs` 87/87**
(verify was 50/50 with a false pass before the modes work, and 22/22 before the
`--events` work below added four checks).

### The bug this existed to fix

`PPY_MIN = 0.02` was a constant chosen for a ~3,500-year corpus. One entry at
−113,000 pushed the px-per-year that Fit needed to 0.0139, the clamp bit, and Fit
landed on 50,000 years of empty prehistory with **1 point in view**. `PPY_MIN` and
`PPY_MAX` as global constants are gone. `ppyRange(view)` now *derives* the floor as
"the zoom that exactly fits the active domain", so `fitView` lands on the floor by
construction and cannot clamp short of fitting. Fit now shows 3,494 of 3,494
reachable entries in `civ`, and all 3,507 in the other two.

### Decisions made while building

- **Only the widest mode stretches to reach the data.** The first version of
  `domainFor()` widened *every* mode to the oldest entry, which handed Civilization
  mode the same 113,000-year axis that broke Fit — the bug reintroduced by the fix
  for it. Narrower modes hold their fixed edge; `outsideCount()` reports what they
  leave out (`13 before 3000 BC` in the status line).
- **Out-of-domain entries are unreachable, not filtered.** The domain is a camera
  clamp, so nothing was threaded through `runFilter`, the rail counts or the node
  counts. The minimap spans the active domain and skips entries behind it.
- **No auto-switching.** The next-wider button highlights (`.edge`, with a `›`) once
  you are at the current edge, and never acts by itself.
- **Switching keeps your place unless you were zoomed out**, in which case the new
  range is fitted. Both intents are real: "I hit the edge, give me more time" wants
  reframing; "I am reading 1750 and want the other ladder" wants to stay in 1750.
- **`fmtTick` is separate from `fmtYear`.** Entry labels stay `1066` / `3000 BC`
  everywhere (`cards.js`, `detail.js`, `rail.js`). Axis labels take their unit from
  the tick *step*, so one axis is all `ka` or all `Ga` and the spacing reads as even.
  `ka`/`Ma`/`Ga` mean *ago*, so a positive year never wears one — the first version
  printed the padded right edge (year +8066) as "8 ka", eight thousand years in the
  wrong direction. Anything from year 0 forward is `present`.
- **The zoom readout inverts below 0.01 px/yr** — it read `0.00 px/yr` at every
  Earth-mode zoom. Now `3.4 Myr/px`.

### Two bugs found on the way, both fixed

- **`scale` is a frame behind the camera.** It is rebuilt in `paint()`, so two camera
  actions in one tick had the second reading the first's stale geometry:
  `setMode('civ')` then `gotoStop('decades')` took its centre from the Earth-mode
  view it had just left, 2.2 billion years out, and clamped to the domain edge.
  `gotoStop` and `setMode` now use `midYear()`, off `V`. This was latent in
  `gotoStop` before modes existed.
- **The spatial grid's resolution was set by the oldest entry.** `buildGrid` divided
  the raw extent into 128 columns — 899 years each, with 99% of the corpus in six of
  them, so the x half of the grid barely discriminated. `denseExtent()` now trims to
  the 1st/99th percentile: 20.5 years per column, 44× finer. Safe rather than
  approximate, because `query` clamps to the column range and confirms real bounds
  per point. This mattered less for speed than expected (the pan frame time did not
  move) but it is load-bearing for deep-time data: at a 4.54-Ga extent a column is 35
  million years and *all* of human history is one of them.

### QA

The old `fit` check asserted only the **shape** of the status string, which is why
50/50 held while Fit was showing a single point. It now asserts an in-view count
against the number of reachable entries, and there are 24 new checks: per-mode fit
coverage / zoom-out limit / ruler legibility / zoom readout, the hidden-entry report,
the ladders being distinct, all 17 stops landing on themselves, the edge highlight
appearing exactly at the edge and never on the widest mode, keep-your-place vs
reframe on switch, and mode persistence.

`pan stays interactive` is marginal, not flaky-by-luck: 31.6 / 32.3 / 32.7 / 34.4
ms/frame across runs against a **34ms** threshold. It failed once in four runs. It
was near the line before this work; the threshold or the frame cost needs attention
on its own terms.

---

## What is still open

### 1. Earth mode has no data yet — the tooling for it now exists

**Built 2026-07-29 (second pass).** `ingest.mjs --events <page>` mines many dated
events out of one page's body, which was the missing mechanism. Nothing has been
ingested with it yet: the store is still the same 3,507 entries, and deep time still
contains exactly one of them. What remains is **choosing pages and running it**,
which is a judgement call about what belongs on the map rather than a code problem:

```bash
node datasets/ingest.mjs --events "Timeline of natural history" --domain geology --dry
node datasets/ingest.mjs --events "Timeline of human prehistory" --domain prehistory --dry
```

`Timeline of natural history` (which redirects to `Timeline of Earth`) yields **181
events from 4,570 Ma to 315 ka**, 178 of them dated at the head of their line. Its
tail is heavy on Precambrian minutiae — the Blake River Megacaldera Complex appears
three times — so `--limit` plus a read of the `--dry` output is the workflow, not a
bulk run. 30–60 well-chosen entries is still the target.

Notes on what the mining does, in `datasets/ATLAS.md` at length:

- Prose mining is **opt-in** (`--events-prose`). On a timeline article it adds
  nothing (173 of 187 events are line-headed); on a science article it collects the
  publication years of cited studies.
- `lib/years.mjs` grew the deep-time grammar: `66 Ma`, `4.54 billion years ago`,
  `320 kya – 305 kya`, `2 Ma – 500 ka`, `c. 4,567 ±3 Ma`, `11,700 BP`. Relative dates
  convert against a **fixed 1950**, never `new Date()`, or every stored year would
  stop matching its own `yearText` each January.
- `--retitle` names events with the local model and is much better than the
  heuristic, but **ids are built from titles**, so a second `--retitle` run may not
  recognise its own earlier entries as duplicates. `--dry`, read, run once.

### 2. `migrate.mjs` deleting hand-entered entries — fixed

Was: the carry-over kept non-CSV rows only when `e.origin?.wiki || e.origin?.qid`,
so stdin prose (`wiki: ''`, `qid: null`) was silently deleted by a routine run, and
mined events would have been too.

Now three things, because this had already been got wrong twice in the same six
lines:

1. `ingest.mjs` sets **`origin.manual = true`** on hand-entered and mined rows, and
   builds `origin` by spreading rather than by listing fields — the hand-written list
   is what stripped the marker the first time.
2. The discriminator tests whether a row **looks like a CSV row** (names a dataset a
   CSV produces, and carries no marker, URL or QID) instead of trying to enumerate
   every way an entry can arrive. Wrong in this direction keeps a stale row, which is
   visible and fixable.
3. `migrate.mjs` **refuses to write** when it would delete anything, lists the rows,
   and needs `--prune` to proceed. Verified: unmarked orphan → exit 1 and no write;
   marked `manual` → carried; `--prune` → deleted as asked.

`verify.mjs` also gained `every entry migrate.mjs cannot rebuild is marked`, so the
store cannot quietly drift back into the old state.

### 3. Smaller

- **The `Last Glacial Period` row** (`england:last-glacial-period:113000bc`) no longer
  breaks anything — modes made it harmless, and it is the only thing giving `human`
  mode any depth at all. Keeping it. `--min-year` on `ingest.mjs` exists if that
  changes.
- **Sibling cluster labels collide** — 78 of 227 nodes share a label with a sibling
  (`Byzantine` ×5). Pre-existing, documented in `README.md`, unrelated.
- **`civ` mode's "All" ruler steps by 500 years**, because 78px is the minimum tick
  spacing and 0.26 px/yr cannot do better. Correct, slightly coarse.

---

## Testing

```bash
node datasets/migrate.mjs --dry               # never deletes; --prune to let it
node datasets/serve.mjs                       # NOT python3 -m http.server, see below
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank

node datasets/verify.mjs                      # 26 data invariants, currently 26/26
node datasets/qa-atlas.mjs                    # 87 browser checks, currently 87/87
node datasets/qa-atlas.mjs --shot /tmp/a.png  # + screenshot
```

`window.__atlas` now also exposes `mode, modes, domain, ppyRange, atEdge, outside`
and `setMode/gotoStop`. **Drive the view through that handle**, not through synthetic
wheel events — most of a scatter plot is empty space, so wheeling at guessed
coordinates measures a blank screen.

Traps that have each cost a session:

- **Serve with `node datasets/serve.mjs`.** `python3 -m http.server` sends
  `Last-Modified` with no `Cache-Control`, so Chrome invents a freshness lifetime
  per file. Because the lifetime is ~10% of the file's age, a file you just edited
  is refetched while an older one is served from disk — you end up running **two
  versions of the app at once**, with no error anywhere. `serve.mjs` sends `no-store`.
- **`datasets/reload.mjs` only reloads a Chrome with a debug port**, defaulting to
  `CDP_PORT=9334` — the throwaway `/tmp/chrome-atlas` profile. Run it while looking
  at your everyday browser and it reloads a window you cannot see.
- **Prefs are read once at open time**, so a test must clear `atlas:prefs:v1` on the
  **opener, before `openAtlas()`**. Now carries `mode` as well as `collapsed`/`pinned`.
- **No CSS escapes in `styles.js`.** The stylesheet is a JS template literal, so a
  backslash escape is eaten by JS before CSS sees it — `content:'\00a0\203a'` is a
  hard `SyntaxError: Octal escape sequences are not allowed in template strings`. Use
  the literal characters. Same family as the never-a-backtick-in-a-comment rule,
  which `verify.mjs` checks.
- **`setPointerCapture` throws** `NotFoundError` when the pointer is already gone.
  Keep it in try/catch.
- **Timers must come from the atlas window** (`w.setTimeout`), and **DOM nodes from
  the popup's document** (`root.ownerDocument.createElement`). This module's code
  runs in the *opener's* realm and the opener is backgrounded the whole time.
- **`Runtime.evaluate` with `returnByValue` on `openAtlas()`** fails with `Object
  reference chain is too long` — it tries to serialise the whole atlas model. Use
  `void window.openAtlas()`, or `awaitPromise: false` as `qa-atlas.mjs` does.
