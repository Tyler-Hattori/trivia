# Topics

```
datasets/topic.mjs            build a topic from one Wikipedia article
datasets/topics/<slug>.json   what the page loads (self-contained: items, chapters, excerpts)
datasets/topics/index.json    the list
datasets/lib/etype.mjs        what KIND of thing an entry is (event, person, work, period, place, group, concept)
project/features/topic/       index.js (routes, learn, timeline, detail, search) · layout.js · quiz.js (+ memory) · styles.js
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

## The bar: better than reading the article

For England, the 92 key entries' own Wikipedia leads add up to ~120,000
characters, more than the whole *History of England* article (~94,000). They are
also generic: Julius Caesar's lead is about Caesar, not about England. Showing
those leads is slower than the article and loses its story. So the page leads
with the article's own words, cut down:

- **`context`** on each item: the sentence in the article that links it,
  scored to find the one that is *about* it (link near the start, few
  competing links, has a date). "Main article:" hatnote targets fall back to
  their section's opening. No two entries of a chapter share a sentence; the
  more important one keeps it, the other takes its next best or falls back to
  its own lead's first sentence.
- **`intro`** on the topic and each chapter (and subsection): the opening
  sentences of that part of the article. This is the narrative the entries
  hang off.
- **`related`**: other entries linked in the same sentence (strong) or
  paragraph (weak), on the timeline only. The detail panel's "Connected" row.
- **`sub`**: the subsection the chosen sentence is in. Learn groups by it, in
  the article's order.

The Learn view (the default) is intro → chapter intro → one line per entry,
grouped by subsection, with a "test yourself" at the end of each chapter.
England's essentials read in ~17 minutes; the article takes over an hour.

Key ("Essentials") rules worth keeping:

- **Places, groups and concepts are only key with a "Main article" hatnote.**
  Greater Manchester, Merseyside and the European Union were key on lead
  mentions alone.
- **Unknown fame is the median, not zero.** Old-CSV entries (Elizabeth I) have
  no Wikidata id; scored 0 they lost their key slot to Francis Drake.

The quiz remembers answers per entry (`topic:mastery:<slug>` in localStorage),
draws missed and unseen entries more often, and drives the progress bars in the
contents rail and on the topic list. "Known" = last answer right.

## Many topics: the batch pipeline

```
datasets/topics.txt                          one topic per line: article | name= | events= | group=
node datasets/topic.mjs --discover <source>  append candidates (category:, links:, search:)
node datasets/topic.mjs --list --ingest      build everything pending (resumable; --force rebuilds)
node datasets/topic.mjs --all                rebuild every built topic from the store (seconds each)
```

`--list --ingest` runs three phases: ingest each pending topic's missing linked
pages (capped by `--ingest-limit`, default 250), classify and place them on the atlas
once for the batch, then build each topic. One topic's failure doesn't stop the
batch. Cost is network: ~7–13 min per topic at the default cap, because
`lib/wikilib.mjs` shares one politeness budget across all parallel requests (a
minimum gap, plus a cool-down every worker respects after any 429). Without
that, Wikipedia started refusing even the topic articles, and 30% of the
"no such page" skips were really throttling.

Builder rules that came from the first 13 topics:

- **A dominant chapter is split into its subsections.** The test is the
  biggest chapter holding over 38% of the links to DATED store entries.
  Examples: "History" in *Ancient Egypt* (Predynastic, Old Kingdom…) and
  *Ancient Rome* (Kingdom, Republic, Empire…), and "Course of the war" in *World
  War II*.
- **Chronological only if the eras mostly don't overlap** (≤ 40% of dated
  chapters). Otherwise the article is thematic: chapters stay, dates go.
  The timeline then drops chapter bands (they pile up) and uses the Chapter
  menu and card colours.
- **Gallery sections aren't chapters.** Their works count; museums linked
  only from a gallery are dropped.
- **Works by member creators are pulled in from the store** (artist, director,
  author, scientist… facets, up to 14 per person, spread across the career).
  An art topic shows its paintings: Impressionism went from 22 works to 197
  (346 on the timeline). The creator's two best-known works can be essentials.
- **Reading lists ("Articles on…", "List of…") are apparatus**, cut like "See also".
- **Places, groups and concepts are only essentials with a hatnote,** unless a
  chapter has nothing else (it then gets its best two).

Across topics: `topics/members.json` (entries in 2+ topics; the detail panel's
"Also in") and `topics/members-all.json` (every entry; the atlas's Topic
filter). The topic list has search, shelves, sorting, a Continue row, and
per-topic hiding.

## Other websites: `--site`

```
node datasets/topic.mjs --site <index url> --name "Ideas of Physics" --hint physics \
  --credit "David Taylor, Northwestern University" --group Science --ingest
```

or a line in `topics.txt` whose first field is the URL. `lib/site.mjs` reads
any site shaped as an index page linking to pages of prose. The site supplies
the structure and the words: chapters (the index's links, in order), intros,
the sentence each entry is mentioned in, and a `note` from the entry's own page
on the site. Wikipedia supplies each entry's dates, image and lead. The credit
shows on the topic page and on every note.

How names become entries:

- **Links to the site's own pages:** "copernicus.html", titled "Phyx 103-0,
  Copernicus", becomes *Nicolaus Copernicus*. The site-wide title prefix is
  stripped. The order of trust:
  1. the exact Wikipedia title, skipping disambiguation pages;
  2. the link text, if it's a proper noun (so "shape" never becomes *Shape*);
  3. a Wikipedia search with `--hint` plus the chapter title, kept only if
     the result's title is close.

  "Mercury" in an astronomy lecture is the planet.
- **Names in unlinked prose** (most sites don't link). The store is the name
  list: full titles, plus a person's surname when one person clearly owns it
  ("Newton" is Isaac; "Thomson" is ambiguous and skipped). Unknown 2–3-word
  capitalised names ("Edmond Halley") are tried as exact titles only.
- **Timeline pages** (≥ 8 lines that open with a year) are mined as events
  through `ingest.mjs --events <url>`. Their entries run long, so the limit is
  2,500 characters. A line's leading "Name, a …" becomes a person, and the line
  is that person's context. Events go into the timeline page's own chapter.
- **PDFs** need `pdftotext` (`brew install poppler`); without it they are
  skipped and reported.

Requests to the site are one at a time, 400 ms apart (`SITE_GAP_MS`).

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
