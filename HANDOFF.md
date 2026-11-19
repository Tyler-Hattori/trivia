# Handoff

Read this first; it is meant to be enough to start work without exploring.
Older session notes (history of specific decisions only):
`docs/archive/HANDOFF-2026-07-to-11-14.md`, `docs/archive/HANDOFF-2026-11-14-to-11-16.md`.

**First thing next session: section 8** (the user asked to move on to "the site
ready for more data, and logins" after the lanes atlas).

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

A static site (no build step, no npm; ES modules, Tailwind via CDN). Locally
`node datasets/serve.mjs` (http://localhost:8777; `/api/search` = hybrid
semantic search, dev only, needs Ollama). Published on GitHub Pages
(https://tyler-hattori.github.io/trivia/) from the `gh-pages` branch, written by
`node datasets/deploy.mjs` (see section 7). Over one store of ~70,000 dated
Wikipedia/Wikidata entries plus undated "ideas". No server: everything the
browser needs is static files, the whole-store ones cut small (`datasets/web/`).
Logins, when they come: a hosted auth+database (Supabase) called from the
browser, syncing the per-entry answer map (`mastery:v2`); no server to run.

| Route | What | Code |
|---|---|---|
| `#/` | home: three doors (Topics, Atlas, Quiz) + search box + Review banner | `project/ui/home.js` |
| `#/topics` | the topic list (shelves, search, Continue row) | `features/topic/index.js` `showList` |
| `#/topic/<slug>` | **Learn** (article's own words by chapter, key points, key ideas) | `features/topic/index.js` `drawLearn` |
| `#/topic/<slug>/timeline` | **Timeline** (Lanes by default, Cards behind a toggle) | `index.js` `drawTimeline`, `layout.js` |
| `#/topic/<slug>/quiz` | quiz: Order / Recall / Ideas / Era | `features/topic/quiz.js` |
| `#/quiz`, `#/review` | quiz over all topics; spaced-repetition review | `features/topic/quiz.js` |
| `#/search/<q>` | year/span pages ("1294", "13th century", "66 million years ago") or word search | `features/topic/search.js` via `webdata.js` (web/ time buckets + word index) |
| atlas | the whole store as Lanes: sections > topic lanes > kinds, x = time; opens in a **popup window** (`window.openAtlas`) | `features/atlas/*`, `docs/ATLAS.md` |
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
  quiz.js     topic quiz + answer memory (mastery:v2, per entry; migrateMastery)
  search.js   the search page; webdata.js loads datasets/web/ pieces (cached per session)
project/features/atlas/   the lanes atlas: index.js (orchestrator), lanes.js (pure layout),
              lanedata.js (web/atlas/ loader), scales.js (x axis, 3 time ranges),
              styles.js; data.js = the old loader, only for the cluster quiz
project/ui/lanes-css.js   the Lanes CSS shared by the topic timeline and the atlas
datasets/
  topic.mjs           builds one topic from a Wikipedia article (+ timeline pages, store)
  audit-entries.mjs   Haiku: date/type/relevance per entry; --spans --kinds --bare
  title-events.mjs    Haiku: short titles for mined events
  dedupe-events.mjs   Haiku: are two mined events the same happening?
  series.mjs          Wikipedia series (sidebars/navboxes) for an article, topic or category
  build-web.mjs       datasets/web/: the browser's whole-store files, cut small (~4 s; run by builds),
                      incl. web/atlas/ (lanes via lib/atlas-lanes.mjs)
  deploy.mjs          publish to gh-pages (one commit, force-pushed); --dry to /tmp/trivia-site
  lib/                audit.mjs dupes.mjs etype.mjs (types) lite.mjs (store-lite rows)
                      wiki.mjs (event miner) wikilib.mjs (all Wikipedia requests) store.mjs years.mjs
                      series.mjs webindex.mjs (word index, shared with the browser)
  store/              TRACKED source of truth: entries/entries-NNN.jsonl (~20 MB chunks),
                      vectors/map-NNN.bin + search-NNN.bin (25k rows each) + map/search.json,
                      layout.json, taxonomy.json (44 MB, the one big whole file), ideas.jsonl,
                      vocab.*, id-aliases.json
  atlas/              GENERATED: atlas.json, details.json, knn-cache.json
  topics/             GENERATED: <slug>.json, index.json, members*.json, all.json + store-lite.json
                      (inputs to build-web, not fetched by the browser)
  web/                GENERATED: trows/ lite/ words/ details/ aliases.json manifest.json
  topics.txt          every topic (the registry): "Article | name= | events=Timeline of… | group="
  topic-structure.json  the tree: parent / series / rulers / role collection / absorb
  ingest-refused.json   pages the store refused; topic.mjs never asks for them again
  topic-overrides.json  per topic: drop / unkey / key / noKeyChapters / chapterYears / intros
  topic-notes/<slug>.json  key points per chapter (hand/Claude-written)
  titles.json (hand) / titles-auto.json (Haiku)   short titles for mined events
  audit-auto.json (Haiku) / audit.json (hand, wins); dupes-auto.json
  qa/                 verify, qa-topic (Node), qa-atlas + qa-quiz (headless Chrome), topic-report
docs/  TOPICS.md (how topics are built, "Series and the topic tree", "What the browser
       loads"), ATLAS.md (atlas decisions NOT to re-litigate + gotchas), PIPELINE.md
       ("What is tracked, what is generated", stable ids), QUIZ.md, SEARCH.md, QA.md
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
5. QA (section 10), commit + push main (code, hand files, `datasets/store/`
   when no ingest is running), then `node datasets/deploy.mjs` to publish.
   Generated folders are not committed (`.gitignore`).

Builder facts worth knowing: essentials ≈ 90 per topic, ≥4 per chapter, ≥50%
events and ≤40% people per chapter; places/groups/concepts essential only with
a "Main article" hatnote; audit `off` entries never essential; mined prose
events stay off the timeline until titled; date-suspect entries off the
timeline; spans that cover far more than the view are dropped as umbrellas.

## 7. State (2026-11-18, end of session)

- **83 topics**, store **70,356 entries**, topic tree in `topic-structure.json`
  (TOPICS.md "Series and the topic tree").
- **Live site = `gh-pages`** (Pages source switched by the user, checked:
  `#/search/1294` fetches `datasets/web/...`). `restructure` merged into `main`
  (fast-forward) and deleted. Main no longer tracks generated data.
- **The atlas is the Lanes** (this session; docs/ATLAS.md is rewritten, read it
  before touching the atlas): sections from the topic tree, one lane per topic
  (category/region lanes for entries in no topic), kinds inside each lane as on
  the timeline, bold = famous, round portraits, overview strip + era bands,
  one-row folding toolbar, pins, section folds, "N more", search as lanes, detail
  panel (bottom sheet on phones). Data: `web/atlas/` (build-web.mjs, lib/atlas-lanes.mjs):
  ~400 KB gz to open instead of the 27 MB atlas.json; time buckets as you zoom.
  The Lanes CSS is shared (`project/ui/lanes-css.js`) by the topic timeline and the atlas.
- **The atlas shows 24,109 entries**: what the topics show (their dated, titled,
  on-timeline entries, with the audit's corrections) plus titled entries in no
  topic. Left out: 25k untitled prose sentences that topics keep off their
  timelines, and 21k untitled sentences in no topic. **Titling them**
  (`title-events.mjs`, Haiku) is the biggest content gain available.
- Store fix: 5 spans whose end was stored as 1 BC (Stenian, Middle Stone Age,
  Magdalenian, Bølling–Allerød, hominin expansions) now have real ends.
- QA: verify 34/34, qa-atlas 38/38 (rewritten for the lanes), qa-quiz 49/49,
  qa-topic 2370/2375 (the 5 known intro-less chapters).
- Nothing running in the background.

## 7b. Session 2026-11-19 (done)

- **135 topics** (52 new): *Art history* (collection, events=Timeline of art) +
  26 periods/regions (Impressionism, Renaissance moved under it); *Film
  history* (collection; series Academy Award for Best Picture; events
  `1888..2025 in film`, a range syntax in topics.txt) + 10; *Sports*
  (collection; prose History of sport + Sports dynasty) + 14 sports, each
  `prose=` its history article(s) + `events=` winners lists.
- Code: `lib/wiki.mjs` mines "YYYY in X" year pages (Events list only, page
  year); `lib/results.mjs` recipes turn winners tables into events ("X win the
  World Series, beating Y 4–3"); `prose` saved in topics and passed on `--all`;
  atlas sections Art / Film / Sports (`lib/atlas-lanes.mjs`).
- Model passes (~$16 total this session): titles for all topics (22k old +
  9k new; ~40% rejected as non-events, spot-checked OK), audit (22k), spans,
  kinds, bare, dedupe. All incremental: next runs only ask about new things.
- **Accounts live**: Supabase (docs/ACCOUNTS.md), email link + Google, sign-in
  line beside the tagline. User had not yet confirmed a sign-in round-trip.
- QA: verify 32/34 (taxonomy.json 50.4 MB, must chunk before ~100 MB; web
  atlas/top.json > 1.5 MB), qa-topic 3815/3839 (new topics' list-like
  chapters lack intros, e.g. "Notable artists", "Notes and citations"),
  qa-atlas 38/38, qa-quiz 49/49. Site 507 MB of Pages' 1 GB.
- Not done: key points for the 52 new topics (suggested Haiku drafts, ~$1,
  instead of in-session writing); off-topic links in art lanes (Battle of the
  Milvian Bridge in Art history); some near-duplicate events (National League
  "founded"/"established"); the user's film spreadsheet (asked: personal
  "watched" mark?).
- **Money rule** (user): run long free jobs in the background and check once;
  say what costs money before running it.

## 8. Next, in order

1. **"Ready for more data"** (user, 2026-11-18). What grows with the store and
   what to do about it:
   - `store/taxonomy.json` 44 MB, one file: chunk it like entries before 50 MB
     (verify warns); GitHub rejects files over 100 MB.
   - `web/details/facets.json` 1.4 MB (cluster quiz) and `web/lite/time/long.json`
     870 KB grow linearly: shard by time or by need.
   - `atlas/atlas.json` 27 MB now only feeds the old cluster quiz: move that quiz
     to `web/` data (or retire it), then stop deploying atlas.json.
   - `topic.mjs --all` is ~25 min, mostly Wikipedia fetches: cache article HTML
     by revision id so rebuilds are local (the gotcha below cost 35 min).
   - Pages: site 223 MB of 1 GB; past ~700 MB deploy the same folder to
     Cloudflare Pages/R2 (deploy.mjs writes a plain folder).
   - The titling pass (above) multiplies what the atlas and timelines show.
2. **Logins** (user asked): Supabase auth (email magic link + Google) and a
   `progress(user_id, entry_id, record jsonb, updated_at)` table with row-level
   security; on first login merge local `mastery:v2` up, then sync both ways
   (newest record wins per entry); apply `web/aliases.json` when merging. The
   anon key is public by design. **Needs the user**: create the Supabase project
   and give its URL + anon key; add the site URL to its auth redirect list.
3. **The user will say what data to glean next.** Pipeline: section 6.
4. **Pipeline steps 2–5 for the series-run topics** (titles, audit, spans/bare/
   kinds, dedupe, key points, the 5 intro-less chapters, Physics spot-check).
5. **Rulers from series templates** (`rulers` in topic-structure.json).
6. Lanes polish (timeline and atlas): empty rows in quiet stretches; slide point
   labels; near-duplicate fill; atlas duplicates across lanes (Napoleon /
   Napoleon Bonaparte).

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
- Atlas: "Europe: other" style catch-all lanes could become topics (Southern
  Europe: other has 2.5k entries); a lane-level "Meanwhile" (compare two lanes).
- README is stale in places (says the home page is the topic list; it is
  three doors since session 7; says the timeline is image cards). Its data
  section is current.

## 10. Setup, QA, screenshots

```
OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=2m ollama serve   # search embeddings
node datasets/serve.mjs &                        # http://localhost:8777
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox \
  --disable-popup-blocking --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank &
node datasets/qa/verify.mjs && node datasets/qa/qa-topic.mjs && node datasets/qa/qa-atlas.mjs && node datasets/qa/qa-quiz.mjs
node datasets/qa/topic-report.mjs --summary
node datasets/deploy.mjs                          # publish (after QA); --dry to check
```

Atlas screenshots: `node /tmp/shots/atlas-shot.mjs out.png [w h mobile js]` opens
the popup (clears `atlas:prefs:v2`), waits for boot, runs `js` in the popup;
`REOPEN=1` reopens it at the emulated width (needed for phone boot). Don't run
two at once (the popup is found as "the new target").
Screenshots: `node /tmp/shots/shot.mjs "<#hash>" out.png [w h mobile js]`
(argument order matters: `mobile` is `1` or `0` and comes BEFORE `js`)
(opens a CDP tab on :9334, waits 15 s, runs `js` as an expression, captures).
If `/tmp/shots` is gone, recreate it: ~20 lines using `Target.createTarget`,
`Emulation.setDeviceMetricsOverride` (390×844, mobile, dpr 2 for the phone),
`Page.navigate`, `Runtime.evaluate` (awaitPromise), `Page.captureScreenshot`.
The first run after a page change sometimes writes no file: rerun. A script
that reloads the page kills the evaluation: clear localStorage in one call,
test in the next. The `read` tool sometimes needs the `/private/tmp/...` path,
and it caches images by path: write each screenshot to a NEW file name.

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
  `topic:prefs:v2:<slug>`, `mastery:v2` (answers, per entry; the old
  `topic:mastery:<slug>` keys are a merged-in backup), `atlas:prefs:v1`. If
  something opens in an unexpected state, that is why.
- **The repo is in iCloud Drive `Documents`**: iCloud evicted `.git/index`
  ("dataless", git: "unable to map index file: Operation timed out"). Check
  with `find . -flags +dataless`; `.git/index` can be rebuilt with
  `mv .git/index <aside> && git reset` (nothing else was ever affected).
- **Switching to an old commit that TRACKED generated data deletes it** (this
  session: `git checkout main` (old, tracked topics/ atlas/) then the merge that
  untracked them removed `datasets/topics/` and `atlas.json`). Rebuild: `node
  datasets/atlas.mjs` (25 s) then `node datasets/topic.mjs --list --force`
  (~35 min, Wikipedia fetches; it runs build-web at the end). iCloud also left
  "lite 2"/"trows 2" duplicate folders in web/ (deleted; build-web replaces web/).
- **Generated data is not on main.** A fresh clone has no topics/atlas/web:
  `node datasets/atlas.mjs && node datasets/topic.mjs --list --force && node
  datasets/topic.mjs --all` (minutes, plus Wikipedia fetches for the articles).
- **Store writes go through `lib/store.mjs`** (writeEntries/appendEntries,
  write/append(Search)Vectors). Never write chunks by hand; never re-quantise
  vectors by read-then-write (bytes drift and every chunk churns in git).
- **Entry ids never change.** A date fix keeps the old id; a merge records an
  alias (`recordAliases`). The atlas k-NN cache is keyed by id.
- **`web/` is rebuilt by builds** (single topic, `--all`, `--list`,
  `atlas.mjs`); children of a batch skip it (`TOPIC_BATCH=1`). If the site
  shows stale search/Meanwhile: `node datasets/build-web.mjs`.
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
