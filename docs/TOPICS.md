# Topics

```
datasets/topic.mjs            build a topic from one Wikipedia article
datasets/topics/<slug>.json   what the page loads (self-contained: items, chapters, excerpts)
datasets/topics/index.json    the list
datasets/lib/etype.mjs        what KIND of thing an entry is (event, person, work, period, place, group, concept)
project/features/topic/       index.js (routes, timeline, read, detail, search) · layout.js · quiz.js · styles.js
```

Build one:

```
node datasets/topic.mjs "History of England" --name England --events "Timeline of English history" --ingest
node datasets/qa/qa-topic.mjs          # invariants + layout, ~1s
```

Then open `#/topics` from the home page. Without `--ingest` it builds from what
the store already has and lists the linked pages that are missing. With
`--ingest` it pulls them through `ingest.mjs` first (throttled, only new rows
embedded) and places them on the atlas.

## Why a topic comes from an article and not from embeddings

Measured (see `docs/SEARCH.md`): no similarity threshold returns "everything
in English history". *Richard II* ranks #100 and *Stonehenge* #300 for the query
"English history", with French events between them. Similarity ranks well but
can't define a set. The article already holds what the clustering was guessing at:

- **Membership:** the pages it links to from prose and "Main article:" hatnotes,
  not tables or navboxes. Plus the events mined from a "Timeline of…" page.
- **Chapters:** its own section headings, in its own order (Prehistory, Roman
  Britain, Anglo-Saxon, Norman, Plantagenet, Tudor…). Date ranges come from the
  heading when it states one ("14th century"); otherwise they're inferred from
  members as the split that misplaces the fewest.
- **Date checks:** an entry linked in "Roman Britain" whose stored year is 2021
  (*Colchester*, city status) stays in the topic but off the timeline.
- **Importance:** a weighted mention count (hatnote ×4, lead ×2) plus Wikidata
  fame, scaled by type. **Key** takes about 90 entries, proportional per chapter
  with at least 4 each.

## What goes on the timeline

`etype.mjs` types every entry:

- **Events, people, works and periods** go on the timeline.
- **Concepts** (languages, "History of …" articles) never do.
- **Places and groups** go on only when their date is a real one: not prose-derived,
  not an open span to today, and consistent with the chapter that mentions them.

The same types keep year questions away from places and concepts in **both**
quizzes. "What year: Trinovantes?" (an Iron Age tribe) is gone.

## Design decisions

- **Looks like the original art timeline**:
  - white background, hairlines
  - image cards with a chapter-colour strip, images never cropped
  - chapter chips that filter; horizontal scroll
- **Lanes are packed in importance order**, so the top lane is the headline
  sequence of the topic and can be read left to right.
- **Long empty stretches are cut out and marked.** A hatched break says how many
  years were skipped; within a segment x is linear. Unlike the atlas — this view
  is for reading a story, and 80,000 empty years of Palaeolithic scroll serve no
  one.
- **People sit at 60% of their lifespan**, not at birth: Shakespeare is
  Elizabethan. Leaders' spans are already reigns and sit at their start.
- **Read view** is the same items as an outline per chapter: year, title, two
  sentences, image. ←/→ steps through entries in time order in both views.
- **Search** runs BM25 in the browser instantly, then upgrades to the hybrid
  `/api/search?topic=` ranking when the dev server is up.
- **The quiz has three modes:**
  - **Order:** four events from the same or neighbouring chapters.
  - **Era:** which chapter something belongs to.
  - **Recall:** the global quiz's typed fields, minus country and occupation,
    which inside a topic are free or unguessable.
