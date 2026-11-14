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
node datasets/qa/topic-report.mjs england   # what a reader would trip over
```

## Checking and correcting a topic

**`datasets/qa/topic-report.mjs`** lists, per topic, what a reader would trip
over: generic essentials ("World war", "Classical antiquity"), essentials the
article never puts in a sentence, essentials dated far outside their chapter,
boilerplate or pronunciation guides in intros, chapters with fewer than two
essentials, topics with fewer than 60 timeline entries. Run it after every
build; `--summary` gives one line per topic.

**`datasets/topic-overrides.json`** fixes what no rule should have to know, per
topic slug. Titles match case-insensitively; rebuild the topic afterwards
(seconds, no `--ingest` needed).

```json
{
  "ideas-of-physics": { "drop": ["Sammy Sosa"], "unkey": ["New Mexico"] },
  "science": { "noKeyChapters": ["Approaches to history of science"] }
}
```

| key | effect |
|---|---|
| `drop` | not in the topic at all |
| `unkey` | never an essential; the next best takes the slot |
| `key` | always an essential (and on the timeline) |
| `intro`, `blurb` | replace the topic's intro / its one-liner on the list |
| `chapterYears` | `{ "chapter title": [from, to] }` |
| `chapterIntro` | `{ "chapter title": "text" }` |
| `noKeyChapters` | chapters that give no essentials (historiography: a list of historians) |

Rule of thumb: the same kind of finding in two or more topics is a builder rule;
a one-off is an override. Rules added from the 2026-11-14 review:

- **A context sentence never repeats the chapter's (or topic's) intro.** An
  entry told only there is flagged `inIntro`, and Learn shows its own
  Wikipedia first line instead, which adds to the intro.
- **An essential needs a sentence.** A linked entry the article never puts in
  a sentence (and not in the intro) loses 30% importance.
- **States stored as one year** (*Soviet Union* 1922) take their span from the
  description ("former country in Eurasia (1922–1991)"); without one they count
  as umbrellas, like long spans.
- **The topic's own subject is not an entry** (Cold War had four "Cold War"
  essentials).
- **A chapter of only places gets its best two** only when it has no other
  candidate (Relativity: Einstein, not Einstein + ETH Zurich).
- **Intros** drop sentences about the website ("Welcome to…", "QuickTime") and
  pronunciation guides.
- **Site topics: a one-word name** (a bare surname or title) is not matched at
  the start of a sentence, nor when the same site uses the word in lower case:
  "More recently" was Thomas More, "the Church" Alonzo Church.
- **The list's date range** is the first chapter's start for chronological
  articles, else the essentials' 4th–96th percentile (people at their prime),
  rounded to two significant figures.

## Key ideas (undated entries)

The store (`entries.jsonl`) holds only DATED entries; the atlas, `verify.mjs`
and search depend on it. Science and maths are mostly about ideas with no date
(Energy, Wave, Uncertainty principle, Natural selection), so those live beside
it in `datasets/atlas/ideas.jsonl` (`lib/ideas.mjs`): one Wikipedia summary each,
fetched by `topic.mjs --ideas` (and by `--ingest`) for linked pages the store
lacks. About a second per idea, no model, no embedding.

- In a topic they are members with `idea: true`, `start: null`, never on the
  timeline.
- **Key ideas** (`keyIdea`, up to 6 per chapter) are concepts, dated or not,
  that a chapter is about. They need a sentence in the article, more than a
  passing mention, and a description that is not a language, office, country,
  institution, food, publication… In a chronological history only undated
  ideas qualify, because there the timeline carries what happened, and a dated
  "concept" is usually a mistyped event.
- An idea goes to the chapter whose title it shares the most words with ("Newton's
  laws of motion" → "Newton's Laws"), else the one that mentions it most.
- A missing page that is really an event or a "history of…" article is not an
  idea (`NOT_IDEA_PAGE`); it belongs in the store via `--ingest`.
- Learn shows them first in each chapter, defined by their lead's first
  sentence, with the article's sentence under it. The quiz has an **Ideas** mode:
  the definition with the name blanked, four names from the topic.
- `topic.mjs --all --ideas` fetches ideas for every topic.

## Key points (chapter summaries)

`datasets/topic-notes/<slug>.json`: `{ "topic": [..], "chapters": { "<chapter
title>": [..] } }`, 3–5 short factual points per chapter, written for the site
(by Claude, from the article and the essentials) and shown in Learn as "Key
points · summary", so they are never mistaken for the article's words. They
are kept outside the built topic so rebuilds keep them; titles match with
whitespace normalised. `topic-report.mjs` flags chapters without points
(`no-points`). Write them for every new topic before calling it done.

## What the browser loads

- `topics/<slug>.json` — the topic, self-contained.
- `topics/index.json` — the list.
- `topics/all.json` — every timeline entry of every topic, compact (~2 MB):
  **Meanwhile**, the cross-topic quiz and review. Written by every build.
- `topics/members.json` / `members-all.json` — "Also in", and the atlas's Topic
  filter and "In topics".

**Meanwhile** (detail panel): entries from other topics within a window that
grows with distance from today (±4 years in 1940, ±80 at year 0, ±200 at 3000
BC). A war or reign uses its own span, a person their adult life. Each thing
once, essentials first, at most three per topic and six topics.

Then open it from the topic list (the home page). Without `--ingest` it builds from what
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
