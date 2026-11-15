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

## Titles for mined events

Lines mined from "Timeline of…" pages are titled by their own first words,
which reads as a sentence fragment ("Harry Brearley invents stainless steel in
Sheffield, Yorkshire"). `datasets/titles.json` maps entry id → a short title
("Stainless steel invented in Sheffield"), written for the site (by Claude, in
session; 898 so far, every mined event in the first 14 topics). `topic.mjs`
applies them (keeping `origTitle`, so overrides naming the old title still
match) and so does the search index. Write them for each new batch: dump the
mined events with 4+ word titles, title them, merge into `titles.json`.

### Titles by a small model (`title-events.mjs`)

`node datasets/title-events.mjs [slug…]` asks Claude Haiku (`ANTHROPIC_API_KEY`;
`TITLE_MODEL` overrides the model), 30 at a time, for a short timeline label
for every untitled mined event. Those are all prose events, and timeline lines
of 5+ words. It returns `null` for sentences that are not events: historians'
arguments, citations, statistics, restated spans.
- Results go to `datasets/titles-auto.json`. `null` means rejected, and it is
  never asked again.
- Hand titles in `titles.json` win (`lib/lite.mjs` `readTitles`).
- Run it after a batch, then rebuild the affected topics.
- First run: 4,900 events, 4,150 titled, 870 rejected, about $1.60.
- Spot-check: it occasionally "corrects" a fact ("Prigogine wins Nobel Prize
  in Physics": it was Chemistry). Fix such cases in `titles.json`.

## Content audit (`audit-entries.mjs`)

Wikidata dates and types are often wrong for a timeline: *YBC 7289* (a
Babylonian tablet) at 1945, its publication; the Mesoproterozoic ending in
1 BC; *Apollo program* and *Smallpox* typed as people; the First Punic War and
the *Iliad* among Physics' essentials because the article mentions them.

`node datasets/audit-entries.mjs [slug…]` asks Claude Haiku (`AUDIT_MODEL`),
30 per call, about every dated entry that is not a mined event:

1. Is the stored date the one that matters? `ok`, or `wrong` with the right
   start and end (`y`, `e`).
2. What is it? person, event, period, work, place, group or concept.
3. How relevant is it to this topic? `core`, `context` or `off`.

Output: `datasets/audit-auto.json` (`entries`: id → `{d, t, y, e, span}`;
`topics`: slug → id → relevance). Hand corrections in `datasets/audit.json`
(same shape) win (`lib/audit.mjs`). `--spans` asks for the years of periods
stored with a start only (the Akkadian Empire was "2334 BC"); the eras track
needs them. `--bare` re-asks entries whose description is only a name (see
below). First run: 9,740 judgments, 353 spans, about $2.70.

`topic.mjs` applies it:
- **Type:** the audit's type overrides `etype` (also in the search index).
- **Date:** `wrong` with a year far from the stored one (5% of its distance
  from today, at least 3 years) is corrected (`dateFixed`, `storedYears`
  keeps the old one); a year or two out is left alone; `wrong` with no year is
  `dateSuspect`, off the timeline. A right start with no stored end gets the
  audit's end. Rulers (`dataset: leaders`) are skipped: their span is the
  reign, which the model "corrects" to the life.
- **BC signs:** the model often drops the minus (Demosthenes "384..322"). A
  stored BC date with a positive, descending or single answer is read as BC.
- **Relevance:** `off` is never an essential (`offTopic`, importance ×0.5,
  not an era bar, not zoom fill); `context` ranks ×0.8. A chapter with only
  off-topic entries (the Hoover Dam in "Waves") has no essentials.
- **Bare-name descriptions:** Wikidata's description of *Spain* was "Pedro
  Sánchez" (the head of government). On places, groups and periods a
  description that is only a name is dropped.

Spot-check after each run: it is mostly right, but confident.

## Duplicate events (`dedupe-events.mjs`)

Related-article mining finds one happening on several pages ("Spain licenses
Pizarro to conquer Peru", "Pizarro receives royal approval to conquer Peru").
Title words cannot tell those apart from "Túpac Amaru becomes Inca" vs
"Execution of Túpac Amaru", a year apart. `lib/dupes.mjs` finds loose
candidates (years ±1, shared words with plurals folded, or 2 shared names);
`node datasets/dedupe-events.mjs` asks Haiku "same happening?" for each pair
and writes `datasets/dupes-auto.json`. `topic.mjs` merges confirmed pairs:
mined with mined (timeline-page line over prose, then importance; the
survivor keeps the other's sentence and picture), and mined into the
article's own linked event. Unjudged pairs merge only at title Jaccard ≥ 0.6.
First run: 650 pairs judged ($0.11); the rebuild merged 254 mined duplicates, and 337 mined events into linked twins (most by title, as before). Haiku is not fully consistent on granularity ("Mongol invasions of Japan" vs "First Mongol invasion repelled" was judged same once, different once).

## The search page (#/search/<query>)

`topics/store-lite.json` (`lib/lite.mjs`, rewritten by every topic build) is
the whole store compressed for the browser: title, years, type, description,
first sentence, image, subject, fame, topics. About 1.4 MB gzipped, loaded only
when searching.
- **A year or span** ("1294", "1290–1300", "1290s", "13th century", "3rd
  millennium BC", "66 million years ago") builds a page for those years. It has
  your topics' entries for those years, then what happened, began, ended, who
  was born and died, and what was under way (specific before vast), with
  subject chips and ←/→ to the neighbouring span.
- **Words** list every matching store entry in time order (BM25, then the
  hybrid server ranking when `serve.mjs` is up), with matching topics and
  ideas first. Words plus a date ("mongol 1294") combine.
- Inside a topic, searching a year filters by date ("1294" in the Mongol Empire
  finds Kublai Khan's death).

## What the browser loads

- `topics/<slug>.json` — the topic, self-contained.
- `topics/index.json` — the list.
- `topics/store-lite.json` — the whole store, for the search page.
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

### Events first (the user's rule)

The timeline exists to show **what happened, at a glance**: discoveries,
inventions, experiments, battles, treaties. A discovery is its own card
("Pascal's mountain barometer experiment"), never an excerpt inside the
discoverer's card. People cards are welcome, but they explain the *person*, not
one event. If scrolling a timeline shows mostly faces, it is broken.

How this is enforced:
- `tlOnly`: a person named only on timeline lines is not a card; the event is.
- Mined events merge with linked twins, borrow the picture of what they name,
  and are scored by kind (`minedBase`).
- Each chapter's essentials are at least 50% events and at most 40% people,
  **but only if events exist**. A topic needs an `events=` timeline page in
  `topics.txt`, or a history-of-a-science topic ends up all people (Chemistry
  had 69 people and 3 events among its essentials).
- The miner reads three layouts: tables, lines that start with their date,
  and paragraphs under a heading that is only a date (`=== c. 450 BC ===`,
  as in *Timeline of chemistry* and *Timeline of astronomy*).
- **Cards** (`layout.js` `cardTiers`): most entries are one-row chips (date over
  title). A three-row picture card only for the top essentials with a picture
  of their OWN; a borrowed picture (`imageFrom`) never makes one. People are
  chips with a round portrait and a life line (grey, end ticks) above them; only
  the top ~22% of essential people get a picture card.
- **People <-> events** (`linkPeople` in `index.js`): `about`, `by`, a borrowed
  picture, or the title naming the person (full name, or a surname no other
  person in the topic has). Selecting either side lights up the other in
  amber; the panel shows "By" chips on events and "<person> on this timeline"
  on people.
- Check with the person/event counts of each topic's essentials after every
  batch (see HANDOFF).
- `resolveTitle` fuzzy-matches: "Timeline of geography" silently became
  *Timeline of paleontology*. Test each `events=` page with `mineEvents` first.

## Design decisions

- **Looks like the original art timeline**:
  - white background, hairlines
  - image cards with a chapter-colour strip, images never cropped
  - chapter chips that filter; horizontal scroll
- **Lanes are packed in importance order**, so the top lane is the headline
  sequence of the topic and can be read left to right.
- **Periods are bars, not cards** (`layout.js` `layoutTimeline`, `packBars`).
  Dynasties, kingdoms and eras with a span are drawn in a thin eras track
  under the chapter bands (4 rows; 2 on a phone), packed essentials first,
  then by importance. A period with no room stays a card; one spanning far
  more than the whole view (Pre-Columbian era on the Inca timeline) is left
  out; two bars for one era (*Kamakura shogunate*, *Kamakura period*) become
  one. Rulers (`dataset: leaders`, reigns) get a track under it, and keep
  their cards. Labels of bars and chapter bands slide along as you scroll.
- **Detail by zoom.** Essentials are packed first, on a scale of their own;
  then the free space is filled with other entries (events, people, works;
  not places or off-topic ones) as quieter chips (`.fill`), most important
  first, in rows up to max(the essentials' rows, 8). Zooming in leaves more
  room, so more appear, the way a map adds street names. Everything shows
  all of it.
- **Deep time reads as "years ago"** (`fmtYear`, `fmtWhen`): "4.57–4.03
  billion years ago", ticks "66 Mya", from 100,000 BC back.
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
