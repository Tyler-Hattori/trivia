# Handoff

Read this first; it is meant to be enough to start work without exploring.
Older session notes (history of specific decisions only):
`docs/archive/HANDOFF-2026-07-to-11-14.md`, `docs/archive/HANDOFF-2026-11-14-to-11-16.md`.

## 1. The goal (the user's words)

"Learn as much accurate information as easily and efficiently as possible,
with clean graphics/UI and ease of exploring related information." On a phone
as much as on a laptop. A topic page has to beat reading the Wikipedia
article. Eventually every major field: the history of life, of every
civilisation and country, mathematics and the sciences, geology, geography.

## 2. The user's standing rules and tastes

- **Accuracy first.** Wrong dates/types/off-topic items are worse than gaps.
  Model-written content (Haiku) is welcome but must be spot-checked; hand
  corrections always win over model output.
- **Events first.** The timeline shows what HAPPENED (discoveries, battles,
  treaties) at a glance. A discovery is its own entry, not an excerpt inside
  its discoverer's. People entries explain the person.
- **Clean, compact, clear organisation.** Each kind of thing in its own clearly
  labelled place; no mixing of types that must be decoded by badges. No wasted
  space (they rejected a lane sidebar as too wide: labels sit inline).
- **The visual style they like is the Lanes timeline** (section 5). They want
  the rest of the site, starting with the atlas, to match it.
- **Interaction they like:** chapter/era bands at the top, click a band to fit
  it; freezing things in a header is good but must be opt-in (click a lane's
  name to pin it; nothing pinned by default).
- **Don't waste money re-exploring.** Use this file and the docs; read code
  only where you are about to change it.
- Commit and push after each finished piece. Keep docs and this file current.

## 3. What the site is

A static site (no build step, no npm; ES modules, Tailwind via CDN), served by
`node datasets/serve.mjs` (http://localhost:8777, also `/api/search`). Over one
store of ~14,000 dated Wikipedia/Wikidata entries plus undated "ideas".

| Route | What | Code |
|---|---|---|
| `#/` | home: three doors (Topics, Atlas, Quiz) + search box + Review banner | `project/ui/home.js` |
| `#/topics` | the topic list (shelves, search, Continue row) | `features/topic/index.js` `showList` |
| `#/topic/<slug>` | **Learn** (article's own words by chapter, key points, key ideas) | `features/topic/index.js` `drawLearn` |
| `#/topic/<slug>/timeline` | **Timeline** (Lanes by default, Cards behind a toggle) | `index.js` `drawTimeline`, `layout.js` |
| `#/topic/<slug>/quiz` | quiz: Order / Recall / Ideas / Era | `features/topic/quiz.js` |
| `#/quiz`, `#/review` | quiz over all topics; spaced-repetition review | `features/topic/quiz.js` |
| `#/search/<q>` | year/span pages ("1294", "13th century", "66 million years ago") or word search | `features/topic/search.js`, `topics/store-lite.json` |
| atlas | zoomable map of everything: x = time, y = subject; opens in a **popup window** (`window.openAtlas`) | `features/atlas/*`, `docs/ATLAS.md` |
| `#/cluster-quiz` | old quiz by atlas cluster | `features/quiz/` |

Detail panel (topics): description first, people↔events links (amber
highlight), "Also in" other topics, "Connected", **Meanwhile** (same years in
other topics). ←/→ step through what is drawn.

## 4. Repo map (what to open for what)

```
project/features/topic/
  index.js    (1.4k lines) routing, list, Learn, Timeline drawing (drawTimeline, lanesHtml),
              detail panel, search box, gestures, pins, prefs
  layout.js   pure layout, tested in Node: scale with hatched breaks (makeScale),
              cards (pack, layoutTimeline), span tracks (TRACKS, planTimeline, packBars),
              lanes (layoutLanes), date formats (fmtYear, fmtRange, fmtWhen)
  styles.js   all topic CSS (one template string: NO backticks inside it)
  quiz.js, search.js
project/features/atlas/   index.js (orchestrator, 1.6k), paint.js (canvas: bands, spans,
              dots, chips, label packing), cards.js (DOM image cards), scales.js (x/y,
              3 time modes), rail.js (subject tree, collapse/pin), detail.js, styles.js
datasets/
  topic.mjs           builds one topic from a Wikipedia article (+ timeline pages, store)
  audit-entries.mjs   Haiku: date/type/relevance per entry; --spans --kinds --bare
  title-events.mjs    Haiku: short titles for mined events
  dedupe-events.mjs   Haiku: are two mined events the same happening?
  lib/                audit.mjs dupes.mjs etype.mjs (types) lite.mjs (search index)
                      wiki.mjs (event miner) wikilib.mjs (all Wikipedia requests) store.mjs years.mjs
  topics/<slug>.json  built topics; index.json, all.json (Meanwhile), members*.json
  topics.txt          what to build: "Article | name= | events=Timeline of… | group="
  topic-overrides.json  per topic: drop / unkey / key / noKeyChapters / chapterYears / intros
  topic-notes/<slug>.json  key points per chapter (hand/Claude-written)
  titles.json (hand) / titles-auto.json (Haiku)   short titles for mined events
  audit-auto.json (Haiku) / audit.json (hand, wins); dupes-auto.json
  atlas/              the compiled store (entries.jsonl, atlas.json, details.json, vectors)
  qa/                 verify, qa-topic (Node), qa-atlas + qa-quiz (headless Chrome), topic-report
docs/  TOPICS.md (how topics are built + timeline design decisions), ATLAS.md (atlas
       decisions NOT to re-litigate + gotchas), PIPELINE.md, QUIZ.md, SEARCH.md, QA.md
```

## 5. The Lanes timeline: the style to propagate

Code: `layout.js` (`layoutLanes`, `planTimeline`, `packBars`, `TRACKS`),
`index.js` (`lanesHtml`, `drawTimeline`, the sync loop in `drawOverview`),
`styles.js` (`.tp-ln`, `.tp-lane`, `.tp-lanelab`, `.tp-era`, `.tp-band`).

- White ground, hairlines, almost no boxes or card frames. Text, dots and thin
  lines carry the information. Chapter colour only as an accent/tint.
- Header (frozen vertically): overview strip; chapter bands (click to fit;
  only for chronological articles); year ticks; then any pinned lanes.
- Lanes, each under a hairline with a small grey uppercase name (sliding into
  view as you scroll; click the name to pin/unpin; `topic:pinned`):
  **States & dynasties**, **Rulers** (reigns), **Eras & movements** (spans as
  pale tinted bars, name inside, label slides along), then **Events** (dot +
  title; a 3px line under the title if it lasted), **People** (life line with
  the name and a 15px round portrait on it, Priestley's *Chart of Biography*),
  **Works** (small square + title), **Places, groups & other**.
- Importance by weight, not size: essentials bold/dark; zoom fill grey. Rows
  are 21px, labels 11.5px: several times denser than the old cards.
- Detail by zoom: Essentials mode adds lower-importance entries into free rows
  as you zoom in (`FILL_ROWS`). Everything mode shows all.
- Kinds come from data: entry `type` (etype + audit), periods' `periodKind`
  (audit `--kinds`: state/era/event/other).
- Known rough edges: a lane is as tall as its busiest stretch (empty rows in
  quiet stretches); a dot just off the left edge shows a cut title; some
  near-duplicate fill entries; Cards layout still exists (keep or retire).

## 6. How content is made (pipeline, per batch)

1. `node datasets/topic.mjs --list <file> --ingest` (slow: ~10 min/topic of
   Wikipedia fetches, rate-limited) builds new topics from `topics.txt` lines.
2. Model passes (incremental; only new things are asked; cents to ~$3; need
   `ANTHROPIC_API_KEY`): `title-events.mjs`; `audit-entries.mjs`;
   `audit-entries.mjs --spans`, `--bare`, `--kinds`; `dedupe-events.mjs`.
3. `node datasets/topic.mjs --all` (rebuild all, no ingest; ~25 min, longer
   while an ingest runs; `--only a,b` for some).
4. Review: `qa/topic-report.mjs --summary`, unkeys in `topic-overrides.json`,
   key points in `topic-notes/<slug>.json` (3–5 per chapter, written by Claude
   in-session from the article + essentials), spot-check audit corrections
   (`dateFixed`/`storedYears`/`offTopic` in topic files; fix in `audit.json`).
5. QA (section 9), commit, push (include `datasets/atlas/*` when no ingest is running).

Builder facts worth knowing: essentials ≈ 90 per topic, ≥4 per chapter, ≥50%
events and ≤40% people per chapter; places/groups/concepts essential only with
a "Main article" hatnote; audit `off` entries never essential; mined prose
events stay off the timeline until titled; date-suspect entries off the
timeline; spans that cover far more than the view are dropped as umbrellas.

## 7. State (2026-11-17)

- 83 topics built (82 on the list: Ideas of Physics is folded into Physics).
- **Topics now follow Wikipedia's own organisation** (docs/TOPICS.md, "Series
  and the topic tree"): `datasets/topic-structure.json` gives each topic its
  series (sidebar/navbox, chosen by hand from the probe), its parent
  (country > continent; era/empire > country; science > Science; deep time >
  History of Earth / History of life), collections (the 6 regions) and absorb
  (Physics absorbs Ideas of Physics). `node datasets/series.mjs` explores
  series; `topic.mjs --structure` applies the tree without rebuilding.
- **Background run** (started 2026-11-17 ~09:00; do not start another
  `--ingest` until it ends): `/tmp/run-series.sh` re-ingests the 58 topics
  that have a series (`/tmp/series-run.txt`, biggest series first, cap 150
  pages each), then `topic.mjs --all` rebuilds everything in tree order.
  Progress: `grep -E "── " /tmp/series-run.log | tail -1`. Done when
  `/tmp/series-run.done` exists. If `/tmp` is gone: regenerate the list from
  index.json + topic-structure.json (topics with a non-empty series) and run
  `node datasets/topic.mjs --list <file> --ingest --force --ingest-limit 150`,
  then `--all`.
- `datasets/ingest-refused.json` (new) remembers pages the store refused (no
  date / no such page / too thin) so re-runs stop re-fetching them.
- QA at last run: verify 31/31, qa-topic 2369/2374 (5 batch-4 chapters with
  no intro: Pakistan "History by region", Netherlands "Historians", Spain
  "Historical population", Europe "Chronology", Israel "Demographics"),
  qa-atlas 91/91, qa-quiz 49/49.
- `datasets/atlas/entries.jsonl` is 65 MB: GitHub warns over 50 MB and refuses
  over 100 MB. Plan Git LFS or splitting it before it grows much more.

## 8. Next, in order

1. **When the series run ends:** pipeline steps 2–5 (section 6) for all
   topics: Haiku passes (titles, audit, spans/bare/kinds, dedupe), review
   (`topic-report --summary`), key points for batch 3 + batch 4 + changed
   chapters, fix the 5 intro-less chapters (likely apparatus sections:
   STOP_SECTIONS or `topic-overrides.json`), QA, commit. Spot-check Physics
   essentials: lost *Maxwell publishes electromagnetic field theory*, gained
   *Darby smelts iron with coal* (off-topic) when the course was folded in.
2. **Rulers from series templates.** `rulers` in topic-structure.json names the
   template (Monarchs of France: houses with reign ranges as headings; Roman
   emperors; Holy Roman emperors; Kushite Monarchs footer). Mine reigns
   (name, start–end, house) as `kind: 'span'` leader entries so the Rulers lane
   fills. England has no monarchs template on its article: use "List of
   English monarchs" / "English monarchs" navbox. Monarchs exist today only as
   people with lifespans (Alfred 849–899), and Edward I / Victoria are missing.
3. **New topics from series categories**, biggest first:
   `node datasets/series.mjs --category "History sidebar templates by country"`
   (and Biology/Evolution/Science sidebar categories). Add to
   topic-structure.json with a parent, then `--list --ingest`.
4. **Restyle the atlas to match the Lanes style** (the user will ask). The
   atlas is a canvas renderer (`paint.js`), not DOM: restyle its marks,
   grouping and chrome; don't port topic code. **`docs/ATLAS.md` lists
   decisions not to re-litigate**: keep them; ask the user before changing
   any. Before/after screenshots, desktop and 390px; qa-atlas must pass.
5. Lanes polish: compress empty rows in quiet stretches; slide point labels
   too; make the zoom fill less near-duplicate.

## 9. Improvement backlog (agreed or noticed, not started)

- Content: a one-line "why it matters" for event panels; key points for every
  topic; audit spot-check list (doubtful: Gandhara 745–11 BC, Maghan I,
  "Mongol invasions of Tibet" 1206–1723); Computing's 1980s/2000s timeline
  pages are tables the miner skips; mixed articles (Egypt, Inca: history
  chapters then society) are judged thematic, so they get no chapter bands.
- Timeline: deep-time spacing (Kush is mostly hatched breaks); phone
  pinch-zoom (only +/- now) and maybe a vertical layout; compare two topics'
  timelines (Meanwhile has the data: England with France, Rome with Han China).
- Learn: mark chapters read; j/k keys; flashcard toggle.
- Atlas: lazy-load `details.json` (20 MB); simplify toolbar; 78 of 227 rail
  nodes share a label with a sibling.
- README is stale in places (says the home page is the topic list; it is
  three doors since session 7; says the timeline is image cards).

## 10. Setup, QA, screenshots

```
OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=2m ollama serve   # search embeddings
node datasets/serve.mjs &                        # http://localhost:8777
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox \
  --disable-popup-blocking --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank &
node datasets/qa/verify.mjs && node datasets/qa/qa-topic.mjs && node datasets/qa/qa-atlas.mjs && node datasets/qa/qa-quiz.mjs
node datasets/qa/topic-report.mjs --summary
```

Screenshots: `node /tmp/shots/shot.mjs "<#hash>" out.png [w h mobile js]`
(opens a CDP tab on :9334, waits 15 s, runs `js` as an expression, captures).
If `/tmp/shots` is gone, recreate it: ~20 lines using `Target.createTarget`,
`Emulation.setDeviceMetricsOverride` (390×844, mobile, dpr 2 for the phone),
`Page.navigate`, `Runtime.evaluate` (awaitPromise), `Page.captureScreenshot`.
The first run after a page change sometimes writes no file: rerun. A script
that reloads the page kills the evaluation: clear localStorage in one call,
test in the next. The `read` tool sometimes needs the `/private/tmp/...` path.

## 11. Gotchas (each cost time)

- **No backticks inside any `styles.js` CSS template** (the string closes and
  CSS parses as JS). `verify.mjs` greps for it.
- **Drag-to-pan captures the pointer**: anything clickable on the timeline
  canvas must be excluded in `bindTimelineGestures` (the first pin buttons
  never got clicks).
- **Haiku output quirks**: drops BC minus signs; "corrects" reigns to
  lifespans; answers vary run to run on borderline cases. Handled in
  `topic.mjs`; keep hand overrides for the rest.
- **Wikidata descriptions can be a bare name** (Spain → "Pedro Sánchez"):
  dropped for places/groups/periods.
- **Single-year entries store `end === start`**, not `null`.
- **Prefs live in localStorage**: `topic:layout`, `topic:pinned`(`:phone`),
  `topic:prefs:v2:<slug>`, `topic:mastery:<slug>` (renaming a slug orphans it),
  `atlas:prefs:v1`. If something opens in an unexpected state, that is why.
- **QA closes Chrome tabs**; `evaluate` in QA takes an expression, not statements.
- **No text inside inline `onerror`**: use `imgRetry(this,'card'|'hide')`.
- **All Wikipedia requests go through `lib/wikilib.mjs` `getJSON`** (shared
  rate limit; a parallel rebuild during an ingest is slow, not broken).
- **New store entries reach the atlas only after `atlas.mjs`** (`--ingest` runs it).
- **Key points match chapters by title**; a renamed chapter loses its points
  (`no-points` in the report).
- **Python heredocs that edit JS: use raw strings** or `\b` becomes a backspace.
- `pkill -f "topic.mjs.*--name"` also matches the background batch's
  children: kill rebuilds by their own pattern (`topic.mjs --all`).
