# Handoff

The goal: take in as much information as possible, easily, efficiently and
cleanly, on a phone as much as on a laptop. A topic page has to beat reading
the Wikipedia article. The user wants every major field eventually: the history
of life, of every civilisation and country, mathematics and science, geology
and geography.

Older session notes, 2026-07 to 2026-11-14 morning: `docs/archive/HANDOFF-2026-07-to-11-14.md`.
Read them only for the history of a specific decision.

## State (2026-11-14, end of session 6)

- 14 topics; about 12,200 dated store entries, plus about 940 undated ideas in
  `atlas/ideas.jsonl`.
- Checks: verify 31/31, qa-topic 320/320, qa-atlas 91/91, qa-quiz 45/45.
- `topic-report.mjs`: about 25 minor findings.
- Committed and pushed.

### Session 7 (this one, in progress)

- **The home page is three doors again** (Topics, Atlas, Quiz), plus a search
  box and a Review banner. The topic list is at `#/topics`.
- **Search** (`#/search/<q>`) builds a page from the whole store for a year,
  a span or words (`project/features/topic/search.js`, `lib/lite.mjs`). Inside
  a topic, a year filters by date.
- **Quiz settings:** length 10/20/50/endless; question kinds (Order, Recall,
  Ideas, Era) mixed at random; focus (everything / weak spots / new only); a
  year span. Sessions end with a score and a list of misses. Saved as
  `quiz:settings:v1`.
- **Titles:** `datasets/titles.json` gives 898 mined events short titles.
- **Batches running in the background:** 1–2 (16 Life & Earth and science
  topics), then 3 (19 civilisations, `/tmp/batch3.txt`), then 4 (6 regions +
  28 countries, `/tmp/batch4.txt`), via `/tmp/run34.sh` under caffeinate.
  Logs are `/tmp/batch12.log`, `/tmp/batch3.log` and `/tmp/batch4.log`.
  `/tmp/batch34.done` appears at the end.

  After each batch:
  - `--ideas` for the new topics;
  - `topic-report`, then overrides;
  - key points in `topic-notes/`;
  - titles for new mined events in `titles.json`;
  - QA, then commit, including `datasets/atlas/*`.
- `readEntries` now skips a half-written LAST line (a build during an ingest).

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
