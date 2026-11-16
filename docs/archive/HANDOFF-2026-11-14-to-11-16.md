# Handoff

The goal: take in as much information as possible, easily, efficiently and
cleanly, on a phone as much as on a laptop. A topic page has to beat reading
the Wikipedia article. The user wants every major field eventually: the history
of life, of every civilisation and country, mathematics and science, geology
and geography.

Older session notes, 2026-07 to 2026-11-14 morning: `docs/archive/HANDOFF-2026-07-to-11-14.md`.
Read them only for the history of a specific decision.

The user's words (session 9): "the goal is to learn as much accurate
information as easily and efficiently as possible, with clean graphics/ui and
ease of exploring related information."

## State (2026-11-15, end of session 9)

- 49 topics built (batch 4, 34 regions and countries, still ingesting); about
  14,000 dated store entries, plus undated ideas in `atlas/ideas.jsonl`.
- Checks: verify 31/31, qa-topic 1094/1094, qa-atlas 91/91, qa-quiz 49/49.
- `topic-report.mjs`: 131 findings (mostly `thin-chapter` and `no-points` in
  batch 3, which has no key points yet).
- Committed and pushed, except `datasets/atlas/*` (batch 4 is writing it).

### Session 9: done (plan A–D from session 8, all of it)

See `docs/TOPICS.md`: "Content audit", "Duplicate events", and the timeline
bullets under "Design decisions".
- **A. Content audit** (`datasets/audit-entries.mjs`, `lib/audit.mjs`,
  `audit-auto.json`): Haiku judged 9,740 (topic, entry) pairs for date, type
  and relevance, plus `--spans` for 353 periods without an end. Applied in
  `topic.mjs`: 852 dates corrected, 607 spans completed, 771 suspect (off the
  timeline), 1,726 off-topic (never essential), 2,864 context (×0.8). All the
  known bad cases are fixed (Meroë, Mesoproterozoic, YBC 7289, Columbia, Apollo
  program, Illinois, Physics' Punic War/Iliad…). Physics essentials: 78 events,
  13 people. Haiku drops BC minus signs and "corrects" reigns to lives: both
  handled in `topic.mjs` (see the doc).
- **B. Duplicate events** (`datasets/dedupe-events.mjs`, `lib/dupes.mjs`,
  `dupes-auto.json`): Haiku confirms candidate pairs; 254 mined duplicates
  merged, and mined events into the article's linked twin (337 in all).
- **C. Detail by zoom** (`layout.js` `layoutTimeline`, `pack(…, { optional,
  maxRows })`): Essentials fill free rows with quieter `.fill` chips; more as
  you zoom in. qa-topic now checks the real `layoutTimeline`.
- **D. Eras track:** periods as bars (4 rows, 2 on a phone), rulers
  (`leaders`) in a track under them, clicking opens the panel, ←/→ steps
  through what is drawn (`V.drawn`). Checked on Inca, Egypt, Japan, China,
  desktop and 390 px.
- **Also:** deep time as "years ago" (`fmtWhen`, `fmtYear`; ticks "66 Mya");
  tick steps up to billions of years (was 1e6 max: thousands of ticks on
  History of Earth); bar and chapter-band labels slide into view as you
  scroll; overview strip labels no longer overlap on a phone; bare-name
  descriptions dropped ("Spain · Pedro Sánchez"); a topic whose chapters go
  back in time is thematic (Aztec); a leading year in a card title that the
  date line shows is hidden; one scroll listener per redraw (was a leak);
  `topic.mjs --all --only a,b` rebuilds some topics.

### Session 9, later: timeline design

**Lanes is the default timeline layout** (Cards stays behind the toggle).
Spans are organised by kind in labelled lanes (States & dynasties, Rulers,
Eras & movements; `audit-entries.mjs --kinds` classified 886 periods), above
Events, People, Works, and Places, groups & other. Clicking any lane's name
pins it to the frozen header; nothing is pinned by default. See
`docs/TOPICS.md`, "Design decisions". The user's verdict on the style: they
like it, and want the rest of the site to match.

**The user will point at Wikipedia's "List of rulers of <country>" /
"List of monarchs of <country>" series.** Plan: a miner for those list pages
(tables of name, reign start, reign end, house), ingesting rulers as entries
with `dataset: leaders`-style reigns (`kind: span`, start/end = reign), so the
Rulers track fills for every country. Today only China (16), Rome (39) and a
few others have reigns; France has 3.

Lanes rough edges: a lane is as tall as its busiest stretch, so quiet
stretches show empty rows; dots just off the left edge show cut titles;
near-duplicate fill ("Wöhler synthesis" / "Wöhler synthesizes urea").

### NEXT SESSION (START HERE)

0. **The user will ask to restyle the atlas to match the Lanes timeline.**
   What "this visual style" means (see `project/features/topic/styles.js`,
   `.tp-ln`, `.tp-lane`, `.tp-era`, and `layout.js` `layoutLanes`):
   - white ground, hairlines, almost no boxes or card frames; text, dots and
     thin lines carry the information;
   - kinds in their own labelled lanes (small grey uppercase names on a
     hairline, sliding into view as you scroll), not mixed and badged;
   - events as a dot + title, or a 3 px line under the title when they
     lasted; people as life lines with the name and a 15 px round portrait
     on them; works as a small square; spans (states, eras) as pale tinted
     bars with the name inside;
   - importance by weight (bold dark essentials, grey fill), not size;
   - chapter colour only as a tint/accent (dot, line, bar edge);
   - 11.5 px labels, 21 px rows: dense, several times what cards held.
   Read `docs/ATLAS.md` and the atlas code first; the atlas is the global
   map of every entry (`#/atlas`), with its own canvas renderer, so the
   restyle is its marks, lanes/grouping and chrome, not a port of the
   topic DOM code. Take before/after screenshots on desktop and 390 px.
   `docs/ATLAS.md` has "Design decisions — do not re-litigate these" (e.g.
   linear x): keep those, and ask the user before changing any of them.

1. **After batch 4 and run-c finish** (see Queue): run, in order,
   `node datasets/title-events.mjs`, `node datasets/audit-entries.mjs`,
   `node datasets/audit-entries.mjs --spans`, `--bare`, `--kinds`,
   `node datasets/dedupe-events.mjs`, then `node datasets/topic.mjs --all`
   and QA. All are incremental (only new entries are asked) and cost cents to
   a few dollars. Then commit `datasets/atlas/*` too.
2. **Spot-check the audit** on a few new topics: corrected dates
   (`dateFixed`, `storedYears` in the topic file) and `offTopic` essentials.
   Fix mistakes in `datasets/audit.json` (same shape as audit-auto.json; it wins).
3. **Key points for batches 3 and 4** (`topic-notes/`; `no-points` in the
   report). Biggest remaining content gap in Learn.
4. Then the "Later" list below. Ideas noticed this session:
   - Rulers: only topics with `leaders` rows have reigns (China 16, Rome 39,
     Inca 0). An audit-style pass could add reign years for the people the
     audit types as rulers; then the rulers track works everywhere.
   - Zoom fill is generous (Japan: 240 fill chips at 12 px/yr). If it feels
     busy, lower `fillRows` or cap fill per screen width.
   - Ancient Egypt and Inca are judged thematic (no chapter bands) although
     their history chapters are chronological; mixed articles (history first,
     then society) could get bands for the chronological part only.

Later (agreed, not started): a "why it matters" line for event panels; wars
and reigns as bars (wars with spans could join the eras track as a second
kind); deep-time spacing (Kush is mostly hatched breaks); phone pinch-zoom and
maybe a vertical layout; comparing two topics' timelines (Meanwhile has the
data: England with France, Rome with Han China).

Screenshots: `/tmp/shots/shot.mjs "<#hash>" out.png [w h mobile js]` (it
may be gone after a reboot; it's a small CDP script, see Setup).

### Queue (started session 8; at the end of session 9, batch 4 was ingesting 9 of 34)

Check: `grep -E "── (ingest|build)" /tmp/batch4.log | tail -1`, and
`ls /tmp/*.done`. These scripts run one after another under caffeinate:
1. `/tmp/run-b.sh`: re-runs batch 3 with `--ingest --force` to mine related
   articles (`/tmp/batch3b.log`, then `/tmp/batch3b.done`). Then batch 4
   (`/tmp/batch4.log`, then `/tmp/batch34.done`), about 18 to 20 hours.
2. `/tmp/run-c.sh`: waits for `batch34.done`, then rebuilds 14 older topics
   that need related articles: Dinosaurs, Cambrian explosion, Ice ages, Plate
   tectonics, Geologic time, Geology, Ancient Egypt, Ancient Rome, China, US,
   Renaissance, Impressionism, Cold War and WWII, then batch 3 again to mine
   main-article pages beyond the old top 10 (`/tmp/batch12b.log`, then
   `/tmp/batch12b.done`).

After each batch: the model passes in "NEXT SESSION" step 1 (titles, audit,
spans, dedupe), then `topic.mjs --all`.
Mined events stay OFF the timeline until they have a short title in
`titles.json` (`it.prose && !it.origTitle`). Inca Empire is done (32 titles).
Every other prose topic needs its titles written:
`node -e` over `topics/<slug>.json` items with `prose: true`, sorted by start;
title the real events and skip commentary and restatements.

### Session 8

**The user's rule (read it):** the timeline must show *events* (discoveries,
inventions, battles) at a glance. A discovery gets its own card, not an
excerpt in its discoverer's card. People cards explain the person. See
`docs/TOPICS.md`, "Events first".

Done and pushed:
- The session 7 work and data are committed.
- **Miner fix** (`lib/wiki.mjs`): a heading that is only a date now dates the
  paragraphs under it. Timeline of chemistry went from 0 to 138 events,
  astronomy from 1 to 88.
- **`events=` pages added in `topics.txt`** for the people-heavy topics:
  Science, Physics, History of Earth, Geologic time, Ice ages, Plate tectonics,
  Computing, Geology, Geography. Before this, essentials were mostly people
  (Chemistry 69/86, Physics 59/91, Geology 31/40).
- **Key points written** for all 16 batch 1–2 topics (`topic-notes/`).
- **Timeline redesign** (see `docs/TOPICS.md`, Events first): most entries are
  chips, with picture cards only for top essentials with their own picture.
  People are portrait chips with life lines. People and events link both ways,
  and selecting one lights up the other in amber. The panel leads with the
  description. The phone toolbar is three rows.
- Ideas, not done: pinch-zoom on phones (there are only +/- buttons); a short
  line under each event chip's title; clean Wikipedia leads in the builder
  rather than the browser.

Running: `/tmp/run-next.sh` under caffeinate.
1. Batch 3 finishes (its node pid is 38566).
2. Then `/tmp/science.txt` (those 11 topics) is rebuilt with
   `--ingest --force` → `/tmp/science.log`, `/tmp/science.done`.
3. Then batch 4 → `/tmp/batch4.log`, `/tmp/batch34.done`.

Next:
- After the queue: `topic.mjs --all` (applies key points to the 8 batch 1–2
  topics not in science.txt), then QA.
- Compare person/event counts of the essentials (one-liner: count
  `items.filter(x=>x.key)` by `type`). Expect events to dominate in Chemistry,
  Astronomy and Physics now.
- Titles for the new mined events (they are sentence fragments).
- Computing's 1980s and 2000s timeline pages are tables the miner skips (10
  tables each, about 0 rows).
- Data oddities seen in essentials: "Apollo program(person)", "Agriculture
  (person)", "Science(person)", "Nature(person)", "Columbia (period) 2002",
  Mesoproterozoic ending in 1 BC, "Smallpox(person)", "Goseck Circle(person)".
- Plate tectonics qa-topic check (recheck after the rebuild).

### Session 7

Done and pushed:
- **The home page is three doors again** (Topics, Atlas, Quiz), plus a search
  box and a Review banner. The topic list is at `#/topics`.
- **Search** (`#/search/<q>`, `project/features/topic/search.js`, and
  `lib/lite.mjs` → `topics/store-lite.json`):
  - years and spans ("1294", "1290s", "13th century", "66 million years ago")
    build a page from the whole store;
  - words give a timeline of matches;
  - inside a topic, a year filters by date.
- **Quiz settings:** length, question kinds (Order/Recall/Ideas/Era) mixed at
  random, focus (everything / weak spots / new), and years. Sessions end with
  a summary. Stored as `quiz:settings:v1`.
- **`datasets/titles.json`:** short titles for 898 mined events in the first
  14 topics. `topic.mjs` applies them and keeps `origTitle`.

Done but NOT committed (commit early next session):
- **Events first.**
  - On site timeline pages, a person named only on timeline lines is no
    longer a card (`tlOnly`); the event is the card.
  - Mined events: twins of linked events are merged; each borrows the
    picture of what it names (a case-sensitive title match, `about`); they are
    scored by kind of happening (`minedBase`: battles and inventions up,
    births down).
  - Each chapter's essentials are now at least 50% events and at most 40%
    people.
  - Result: the Dateline of Thermodynamics is now events ("Pascal's mountain
    barometer experiment"), and England has 37 mined events among its
    essentials (was 4).
- **Works by member creators** now covers artistic creators only (no
  scientists or philosophers): Darwin's and Aristotle's books were turning up
  in unrelated topics.
- **`topic-overrides.json`:** unkey lists for the 16 batch 1–2 topics.
- **`lib/store.mjs` `readEntries`** skips a half-written last line.
- A `topic.mjs --all` was ABORTED midway, so topic files may be mixed old and
  new. First thing: run `node datasets/topic.mjs --all` (about 5 minutes for
  30+ topics), then `qa-topic` and `topic-report`.

Batches (background via `/tmp/run34.sh` under caffeinate; `/tmp` may be gone
after a reboot):
- **1–2: built**, 16 topics:
  - Life & Earth: History of Earth, Geologic time, History of life, Human
    evolution, Ice ages, Dinosaurs, Plate tectonics, Cambrian explosion;
  - Science: Mathematics, Chemistry, Biology, Medicine, Astronomy, Computing,
    Geology, Geography.

  Still to do for them:
  - key points in `topic-notes/<slug>.json`;
  - titles for their mined events (History of life, Human evolution,
    Mathematics, Biology and Medicine have many sentence titles);
  - fix Plate tectonics failing qa-topic's "most key links have an
    in-article sentence" check (37/56).
- **3 (19 civilisations, `/tmp/batch3.txt`):** was ingesting topic 11 of 19.
  Check `/tmp/batch3.log`.
- **4 (6 regions + 28 countries, `/tmp/batch4.txt`):** starts after 3. Check
  `/tmp/batch4.log`; `/tmp/batch34.done` marks the end.

  If `/tmp` is lost, re-run the pending ones:
  `node datasets/topic.mjs --list --ingest` (topics.txt; built topics are
  skipped).

Per-batch review checklist:
1. `topic.mjs --all` (applies titles and overrides).
2. `topic-report.mjs`, plus a scan of each topic's essentials (in history-of-X
   articles, look for eras, civilisations, journals and places mentioned in
   passing), then add unkeys to `topic-overrides.json`.
3. Key points: 3–5 per chapter in `topic-notes/<slug>.json` (titles match
   with whitespace normalised).
4. Titles: dump mined events with 4+ word titles (see `docs/TOPICS.md`,
   "Titles for mined events"), write short titles, merge into `titles.json`.
5. QA: `verify`, `qa-topic`, `qa-atlas`, `qa-quiz` (49 checks), then commit,
   including `datasets/atlas/*`.

### Session 6

- **Key ideas.**
  - Undated concepts live in `datasets/atlas/ideas.jsonl` (`lib/ideas.mjs`),
    fetched with `topic.mjs --ideas` (`--all --ideas` for every topic).
  - Learn shows "Key ideas" per chapter; the quiz has an "Ideas" mode (pick the
    idea from its definition).
  - See `docs/TOPICS.md`, "Key ideas".
- **Key points.** Every chapter of all 14 topics has 3–5 summary points,
  written in-session by Claude into `datasets/topic-notes/<slug>.json` and
  labelled "summary" in the UI. Every new topic needs these; `topic-report`
  flags missing ones.
- **`etype` fixes.** Three kinds of entry were typed "concept" and so were off
  the timeline:
  - descriptions that date themselves ("intended to attack England in 1588",
    "1986 Soviet-American summit");
  - Wikidata start+end dates (P580+P582);
  - summit, intervention, operation and similar words.

  The Spanish Armada is back on England's timeline.
- **Deleted:** `thumbnails/`, `build_thumbnails.js`, and the
  `qwen3-embedding:0.6b` model. `qwen3:8b` (5.2 GB, only used by the unused
  `--reshape`) is still installed.

### Session 5

- **The home page is the topic list.**
- **Phone layout:** a drawer rail and a full-screen detail panel.
- **Spaced-repetition Review** (`#/review`) and **Quiz all** (`#/quiz`).
- **Meanwhile** in the detail panel, and **In topics** in the atlas.
- **Topic quality:** `qa/topic-report.mjs` and `topic-overrides.json`.
- **PDF lectures** for Ideas of Physics.

## Next, in order

1. **Scale topics, choosing for breadth.** The user wants everything. Proposed
   shelves, about 20 topics per batch:
   - **Life & Earth:** History of Earth, Geologic time scale, Evolutionary
     history of life, Timeline of human evolution, Plate tectonics, Ice age,
     Dinosaur, Cambrian explosion, Human evolution, History of geography.
   - **Maths & sciences:** History of mathematics, History of chemistry,
     History of biology, History of medicine, History of astronomy, History of
     computing, History of geology.
   - **Civilisations:** Mesopotamia, Ancient Greece, Byzantine Empire,
     Islamic Golden Age, Mongol Empire, Ottoman Empire, Maya civilization,
     Aztec Empire, Inca Empire, Mughal Empire, Ancient India, Persian Empire.
   - **Countries:** `--discover "links:List of sovereign states" --template "History of {}"`,
     biggest first.

   For each batch:
   - `node datasets/topic.mjs --list --ingest`, then `--ideas` for those
     topics;
   - `topic-report.mjs`, then overrides;
   - write key points in `topic-notes/`;
   - QA, then commit.
2. **Smaller items:**
   - Mined timeline-event titles are often whole sentences ("Blaise Pascal, a
     French mathematician whose health is not…").
   - United States' "Cold War" chapter lists "Cold War" four times; the
     self-title rule only removes the topic's own title.
   - Learn: mark chapters as read; j/k keys; a flashcard toggle.
   - Phone timeline: smaller cards (`GEO` in `topic/layout.js`).
   - Atlas: lazy-load `details.json` (11 MB); simplify the toolbar.

## Setup (every session)

```
OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=2m ollama serve
node datasets/serve.mjs &                        # http://localhost:8777
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox \
  --disable-popup-blocking --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank &
node datasets/qa/verify.mjs && node datasets/qa/qa-topic.mjs && node datasets/qa/qa-atlas.mjs && node datasets/qa/qa-quiz.mjs
node datasets/qa/topic-report.mjs --summary
```

Screenshots: open a tab with `PUT /json/new`, then use `Page.navigate`,
`Runtime.evaluate` and `Page.captureScreenshot`. Pass a 390×844 viewport for
the phone view.

## Gotchas

- **QA closes Chrome tabs.** Open a new tab before driving a page by hand.
- **`evaluate` in the QA scripts takes an expression, not statements.** Use
  `(a(), b)`, not `a(); b`.
- **No text inside inline `onerror`.** Use `imgRetry(this,'card'|'hide')`.
- **No backticks inside any `styles.js` CSS template.**
- **Build data URLs from `location.href` with `#…` and `?…` stripped first.**
- **All Wikipedia requests go through `lib/wikilib.mjs` `getJSON`.**
- **After a builder or `etype` rule change, run `topic.mjs --all`** (about
  100 s; it re-fetches each article, without ingest).
- **New store entries reach the atlas only after `atlas.mjs`.** `--ingest` runs
  it.
- **Topic memory is per topic in localStorage** (`topic:mastery:<slug>`).
  Renaming a topic's slug orphans its memory.
- **Key points are matched to chapters by title.** If a rebuild renames a
  chapter, its points disappear until `topic-notes/` is updated. Watch for
  `no-points` in the report.
- **Python heredocs that edit JS:** use raw strings (`r"""…"""`), or `\b`
  becomes a backspace.
