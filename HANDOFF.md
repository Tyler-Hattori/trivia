# Handoff

The goal: take in as much information as possible, easily, efficiently and
cleanly, on a phone as much as on a laptop. A topic page has to beat reading
the Wikipedia article. The user wants every major field eventually: the history
of life, of every civilisation and country, mathematics and science, geology
and geography.

Older session notes, 2026-07 to 2026-11-14 morning: `docs/archive/HANDOFF-2026-07-to-11-14.md`.
Read them only for the history of a specific decision.

## State (2026-11-14, end of session 5)

- 14 topics; about 12,200 store entries.
- Checks: verify 31/31, qa-topic 306/306, qa-atlas 91/91, qa-quiz 45/45.
- `topic-report.mjs`: 18 findings across 14 topics, all minor.
- Not yet committed.

What changed this session:

- **The home page is the topic list**, with Review, Quiz all and Atlas in its
  bar. The three-door page is at `#/home`, unlinked. The cluster quiz is at
  `#/cluster-quiz`.
- **Phone layout.** The contents rail is a drawer (☰), the detail panel a full
  screen, and the header is compact. Learn rows show the year inline.
- **Spaced repetition** in `topic/quiz.js`: Leitner boxes, with right answers
  due again after 1, 3, 7, 16, 35 and 90 days and misses after 10 minutes.
  **Review** (`#/review`) collects what is due across every topic. **Quiz all**
  (`#/quiz`) runs one quiz over every topic, and its Order questions mix
  subjects. Both read `topics/all.json`. If a mode can't make a question it
  falls back to another, so there are no dead ends.
- **Meanwhile** in every topic detail panel shows what the other topics were
  doing in the same years.
- **The atlas detail panel has "In topics"**, linking to the topic at that
  entry.
- **Topic quality:**
  - `qa/topic-report.mjs` lists, per topic, what a reader would trip over.
  - `topic-overrides.json` holds hand corrections (drop, unkey, key, intro,
    chapterYears, noKeyChapters).
  - New builder rules: no context sentence repeats an intro; essentials need a
    sentence; states get their span from their description; the topic's own
    subject is not an entry; site intros lose boilerplate; one-word name
    matching is guarded.
  - Topic list date ranges are sane.
  - See `docs/TOPICS.md`, "Checking and correcting a topic".
- **Bugs fixed:**
  - The timeline and quiz reopened on the last chapter filter (4 cards, or
    "not enough entries").
  - Impressionism's timeline opened on 1568.
  - The cluster quiz built its data URL with the `#hash` in it.
- **Ideas of Physics** now reads its 4 PDF lectures (poppler is installed).

## Next, in order

1. **Ideas, not just dates: the biggest gap for science and maths.** The store
   only accepts dated entries. `ingest.mjs` skipped 33 of 41 Ideas of Physics
   pages for "no date found", including Energy, Wave and Uncertainty principle.
   Lectures about ideas therefore show an intro and nothing else. Needed:
   - undated entries in the store (`verify.mjs` assumes `start`; the atlas
     needs an x, so leave them off it);
   - a "Key ideas" group per chapter in Learn (concept entries with a context
     sentence);
   - concepts in the quiz as "what is X?" with the context sentence as the
     reveal.

   Check first that mathematics, chemistry and biology topics would actually
   read well with it.
2. **Scale topics, choosing for breadth.** The user wants everything, so use
   shelves:
   - every civilisation and country (`--discover "links:List of sovereign states" --template "History of {}"`);
   - history of life and geology (Evolutionary history of life, Geologic time
     scale, History of Earth);
   - science and maths history (History of mathematics, chemistry, biology,
     medicine, astronomy);
   - art, film and philosophy movements.

   Build about 20 at a time with `--list --ingest`. Run `topic-report.mjs`
   after each batch and fix with overrides or rules. Thin topics (< 60
   timeline entries): ingest more or drop.
3. **Optional, needs the user's go-ahead and an API key: chapter "key
   takeaways"** from a strong model, generated once and cached, each point tied
   to a source sentence. About $1–4 for the current topics, roughly $25 (Haiku)
   to $80 (Sonnet) for 300.
4. **Smaller items:**
   - Learn: mark chapters as read; j/k keys; a flashcard toggle (hide the text,
     reveal on tap).
   - Phone timeline: smaller cards (`GEO` in `topic/layout.js` is one size).
   - Atlas: measure first load (5.4 MB `atlas.json` + 11 MB `details.json`)
     and load details lazily. The toolbar is crowded.
   - Fascist Italy is still an essential of World War II's "Start and end
     dates": its description's dates have days in them, so the span regex
     misses it.
   - Ask before deleting `thumbnails/` (8 MB, unused) and
     `ollama rm qwen3-embedding:0.6b` (640 MB).

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
- **After a builder rule change, run `topic.mjs --all`** (about 100 s; it
  re-fetches each article, without ingest).
- **New store entries reach the atlas only after `atlas.mjs`.** `--ingest` runs
  it.
- **Topic memory is per topic in localStorage** (`topic:mastery:<slug>`).
  Renaming a topic's slug orphans its memory.
