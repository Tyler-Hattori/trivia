# The atlas pipeline

How entries get into the timeline. Everything here runs locally, costs nothing
per entry, and needs no Claude — that is the point of it.

The old flow was: hand-write a CSV row, run `enrich.mjs` to fill the blanks, and
the timeline sorted rows into lanes by one category column. The new flow is:
point a script at Wikipedia, and each entry is embedded and placed on a map where
vertical position means *similarity* rather than category membership.

```
Wikipedia + Wikidata          ingest.mjs      free, no model
        ↓
  entries.jsonl               the store       one JSON object per line
        ↓
  EmbeddingGemma              embed-all.mjs   local, ~200MB, 768→256 dims
        ↓
  vectors.bin                 int8 + per-row scale
        ↓
  cluster tree + y            atlas.mjs       deterministic, ~9s for 3,800
        ↓
  vocab.bin + labels          atlas.mjs       term vectors, cached
        ↓
  atlas.json / details.json                   what the browser loads
```

---

## Setup, once

```
brew install ollama
ollama serve &                      # or just open the Ollama app
ollama pull embeddinggemma          # required, ~200MB
ollama pull qwen3:8b                # optional, ~5GB, only for --reshape
```

**Why EmbeddingGemma.** 308M parameters, 768 dims, trained by Google for
on-device use, and Matryoshka-trained so the first 256 dimensions work on their
own — which is how the store gets a 4× size cut for free rather than by
truncating a model that was never meant to be truncated. It runs at roughly
100 entries/second on an M2 Pro. Alternatives worth knowing: `nomic-embed-text`
(137M, faster, slightly weaker), `bge-m3` (567M, strong, 8k context),
`qwen3-embedding:0.6b` (best raw quality of the three, ~3× the disk).

Override with `TRIVIA_EMBED_MODEL` / `TRIVIA_WRITE_MODEL`.

**Changing the embedding model invalidates the whole store.** Vectors from two
models are not comparable, and mixing them makes entries cluster by *which model
embedded them* before anything else. The scripts refuse to mix and tell you to
run `embed-all.mjs --force`.

---

## Adding entries

`ingest.mjs` is the one command you need.

```bash
# a page, or several
node datasets/ingest.mjs https://en.wikipedia.org/wiki/Guernica_(Picasso)
node datasets/ingest.mjs "The Persistence of Memory" "Battle of Hastings"

# a whole Wikipedia category — this is the bulk lever
node datasets/ingest.mjs --category "Cubist paintings" --domain "art,visual art"
node datasets/ingest.mjs --category "Battles of the Napoleonic Wars" --domain war --deep

# every article linked from a list page
node datasets/ingest.mjs --links "List of Impressionist painters" --domain art

# many dated events out of ONE page — how deep time gets in. Reads the page's
# tables and its dated lines; add --events-prose for a narrative history article
node datasets/ingest.mjs --events "Timeline of natural history" --domain geology --dry
node datasets/ingest.mjs --events "Timeline of English history" --domain politics --dry

# a file of titles or URLs, one per line, # for comments
node datasets/ingest.mjs @my-list.txt --domain science

# your own prose, blank line between entries, first line is the title
cat <<'EOF' | node datasets/ingest.mjs - --domain philosophy
Critique of Pure Reason
year: 1781
Kant's attempt to establish what reason can know prior to experience.

The Prince
year: 1532
Machiavelli's handbook of statecraft, written for the Medici.
EOF
```

Useful flags:

| flag | effect |
|---|---|
| `--domain a,b` | broad buckets for everything in the run. Filterable; deliberately **not** embedded |
| `--topics a,b` | extra topics for everything in the run. These *are* embedded |
| `--deep` | `--category` also descends one level into subcategories |
| `--limit N` | cap the input list (default 500). With `--events`, caps each page |
| `--events <page>` | mine many dated events out of one page's tables and dated lines. Repeatable |
| `--events-prose` | also **keep** the dates found mid-sentence. They are always mined and counted; without this they are reported and discarded. Noisier — see below |
| `--retitle` | let the local LLM name each mined event |
| `--reshape` | rewrite excerpts into the project's voice with the local LLM |
| `--tag-topics` | let the local LLM propose topic tags |
| `--min-year` / `--max-year` | drop anything outside the range |
| `--dry` | report what would happen, write nothing |
| `--no-build` | skip the atlas update (batch several ingests, then build once) |

**Always `--dry` a big category first.** Wikipedia categories contain stray
members — a category page, a "List of…" article, a museum. `--dry` shows you the
title, year, date source, image and topics for each before anything is written.

Ingestion is **idempotent**: an entry already present (matched on Wikidata QID,
then on page URL, then on id) is skipped, so re-running a list is cheap.

### Where the year comes from

A wrong year is worse than a missing entry — it lands in the wrong century and
nothing flags it. So dates come from Wikidata claims in a fixed order of trust,
and only fall back to text scraping:

| source | meaning | result |
|---|---|---|
| `P580`/`P582` | start / end time | span |
| `P569`/`P570` | birth / death | span |
| `P585` | point in time | point |
| `P571` | inception | point |
| `P577` | publication date | point |
| `title` | `"Metropolis (1927 film)"` | point |
| `lead-text` | first year in the opening sentence | point, marked `circa` |

Every run prints a `date sources:` tally, and `origin.dateSource` is stored on
every entry, so the set that came from prose stays answerable later rather than
having to be guessed at.

**`lead-text` is guarded, because it runs exactly when it is least safe.** It
fires only when Wikidata has no date claim — and an article with no date claim is
very often a thing with no date at all: a county, a river, a language, a genus.
Its lead is then full of quantities, and taking the first three-or-four digit
number dated the English Channel to AD 560 from "about 560 kilometres", Surrey to
663 from "663 km", and Oak to 500 from "500 species". Nothing downstream can
catch that; a wrong year renders exactly like a right one. So `yearInLead`
applies two tests, neither needing to know what the article is about: a number
followed by a unit is a measurement (including durations — "over 1,700 years" is
a length of time), and a bare three-digit number needs an explicit date cue on
one side (`in 560`, `560 AD`, `circa 900`). Four-digit years are left alone.

A run that is mostly `lead-text` is still a run to check by hand.

---

## `--events` — many entries out of one page

Everything above is one page, one entry, dated from that page's Wikidata claims.
That shape cannot reach deep time, and it is why the atlas's **Earth** range held
exactly one entry: the Hadean and the Cambrian are not pages with inception dates,
they are lines inside a "Timeline of…" article.

```bash
node datasets/ingest.mjs --events "Timeline of natural history" --domain geology --dry
node datasets/ingest.mjs --events "Timeline of human prehistory" --domain prehistory --limit 40
node datasets/ingest.mjs --events "Cretaceous–Paleogene extinction event" --events-prose --dry
```

`--dry` first, always. This path reads prose rather than a structured claim, so it
is the least trustworthy input the pipeline has, and the report is how you check it.

**Three confidence levels**, tallied separately in `date sources:`:

| source | shape | trust |
|---|---|---|
| `mined-table` | a row under a column headed `Year` | highest: the header says outright that the cell is a date and the row is what it dates |
| `mined-line` | the line **begins** with its date — `541 Ma – The Cambrian explosion…` | high: the date plainly governs the text after it |
| `mined-prose` | a date found inside a sentence | low: the sentence may merely mention a year |

Prose is **always mined and always counted; `--events-prose` decides whether it is
kept.** The flag gates writing, not looking. Without it the run reports how many
mid-sentence dates it found and discards them:

```
mining "Cubism"… Cubism: 0 events (0 from tables, 0 dated at a line head)
    read 0 tables (0 rows) and 74 lines of text
    105 more dates sit mid-sentence and were NOT kept. That tier is noisier —
    on an ordinary article it is mostly commentary and cited publication years.
    Add --events-prose to include them; add --dry first to read them.
```

That is the whole point: one run tells you the shape of the page. The gate used to
sit on the mining, so a prose-shaped article reported "nothing found" and you
re-fetched it to learn why. Mining both costs a second walk over lines already in
memory and no extra request.

Keep the tier opt-in, though. On `Cubism` those 105 candidates are roughly half
real events and half art-historical commentary (`1911 Douglas Cooper's restrictive
use of these`). On a genuine timeline it adds almost nothing — 173 of 187 events on
`Timeline of Earth` are line-headed, and 3 sit mid-sentence.

Two things this arrangement had to get right, both invisible when wrong:

- **The strict pass runs to completion before any prose is considered.** Dedupe is
  by `start|title`, so interleaved — which is what one pass does — a loose match
  early in the article claims the key and silently blocks the line-anchored
  statement of the same event later on. That draft is then discarded again for
  being prose, and the event disappears from a run that never asked for prose.
- **`--limit` applies per tier**, so a page's trustworthy events can no longer be
  crowded out of the budget by sentences the caller is about to throw away.

### Tables and prose are separate sources, and each was broken separately

A page states its events either in tables or in narrative, and this is not a
matter of degree. Two real pages returned **nothing**, for unrelated reasons:

```
Timeline of English history    22 wikitables, one event per row     → was 0, now 180
History of quantum mechanics   225 lines of narrative paragraphs    → was 0, now 49
```

**Tables were never fetched.** `prop=extracts&explaintext=1` strips wiki tables
entirely, so *Timeline of English history* arrived as 1,337 characters of intro and
headings out of 197,000. The miner was not failing to parse those rows; it never
received them, and `Nothing dated found in 1 lines` was the only symptom. There is
now a second fetch, `action=parse&prop=text`, and the only HTML parsing in the
pipeline — regex, not a DOM library, per the zero-dependency rule.

Three things about it worth knowing before touching it:

- **Only `wikitable`s are read.** That class is what MediaWiki puts on a content
  table and withholds from navboxes, infoboxes and maintenance banners. Across six
  timeline articles the filter was exact: every `wikitable` was rows of events,
  every other table was apparatus. A table whose header names no date column is
  skipped **and counted** in the report, not guessed at positionally.
- **`rowspan` is resolved into a real grid, and has to be.** A year cell spanning
  several event rows is how these tables avoid repeating a date — 274 of them on
  *Timeline of Chinese history*. The rows underneath carry one fewer `<td>`, so read
  positionally they shift left and the Date column's value lands in Year.
- **`Year | Date | Event` headed 90 of 91 usable tables** across six articles (the
  odd one out being `Events`). Matching is on synonyms anyway. The second date
  column is the finer grain within the year, and it goes to `facets.date` rather
  than `yearText` — "24 January AD 41" parses to the year 24, and `verify.mjs`
  requires the stored text to re-parse to the stored year. `store.mjs` keeps a
  `date` facet out of the embedded text, where it would cluster entries by calendar
  coincidence.

**Prose arrived fine but the grammar refused it.** Not the length limits and not
the one-date-per-paragraph rule — both were checked and neither was firing. Of 397
sentences on *History of quantum mechanics*, 41 carried a year and `findDate` took
12, because a bare year mid-sentence needs a preposition in front of it and
narrative history writes "his 1912 paper", "won the 1918 Nobel Prize", "the
planetary model of the atom (1911)", "throughout the 1920s". `findDate(s, {loose:
true})` accepts those and **only** `--events-prose` passes it.

What keeps the loose grammar honest is the number itself: it requires a bare
**4-digit** year in 1000–2099, so `400 members` and `663 km` cannot reach it at
all, and a unit lookahead handles `1500 metres` and `2000 people`. It is still
looser than the default, and an author-prominent citation — `Smith (1923)` — is
structurally identical to a real parenthetical date. That residual is why the tier
is opt-in and reported separately.

### The date forms it reads

Deep time is written a dozen ways and `lib/years.mjs` handles them, because a year
read wrong by a factor of a thousand still renders:

```
66 Ma          4.54 billion years ago      541 to 485 million years ago
c. 4,570 Ma    320 kya – 305 kya           2 Ma – 500 ka        11,700 BP
```

Three decisions in there are worth knowing:

- **`ago` is required on the spelled-out forms.** "flora recovered over 1.7 million
  years" is a *duration*; read as a date it put a Paleocene recovery interval in the
  Pleistocene. The symbol forms (`66 Ma`) need no suffix — they only ever mean an age.
- **A relative date converts against a fixed 1950**, and only when the date is
  precise enough for two millennia to matter. `11,700 BP` is 9750 BC; `66 Ma` stores
  `-66000000`, not `-65998050`, so an id and a diff read the way the source does.
  Fixed rather than "this year", or every stored year would stop matching its own
  `yearText` each January.
- **An unresolvable number is skipped and reported, not guessed.** One page carries
  `3,400 Ma`, `3.400 Ma` and `0.315 Ma`; the second is a mistyped thousands
  separator and the third a real decimal. A zero integer part settles one, and the
  age of the Earth settles another (`66.038 Ma` must be a decimal — 66,038 Ma
  predates the universe). What survives both tests really is ambiguous. The same
  refusal covers a bare `90,000` in a Year column: on *Timeline of Japanese
  history* it means 90,000 years ago, and read literally it is a date 88,000 years
  in the future. Nothing in the page or in arithmetic settles it.

### The era is often stated once, above the rows

*Timeline of ancient Greece* writes all 189 of its datable lines as bare numbers —
`777: Cumae is founded by Chalcis` — and names the era once, in the heading above
them: `Archaic Period (785–481 BC)`. Read literally **every entry on that page
lands in the wrong millennium**, and twenty come out as spans running backwards.

So an unambiguously-BC heading (or page title) supplies the era for a bare year
under it, and the `BC` is written into `yearText` so the card says what the page
means and the text still re-parses to the stored year. A heading naming *both* eras
(`Han dynasty (206 BC – 220 AD)`) settles nothing and is ignored, which is right —
those pages date their rows explicitly, and an explicit era on the row always wins.

Two range shapes are fixed in `years.mjs` for the same reason, both of which used
to produce a backwards span:

| written | means | why |
|---|---|---|
| `1601–03` | 1601–1603 | the far half is abbreviated against the near half |
| `180–10 AD` | 180 BC – AD 10 | a range marked AD that descends straddles the era boundary |

And a last line of defence: a draft whose span still runs backwards is **refused
and reported**, because at that point the date is one this code has misread and
`verify.mjs` asserts the store holds none.

### Titles

Without `--retitle` a title comes from the event's own words, cut at the first
strong break: `541 Ma – The Cambrian explosion begins, when…` becomes *"The
Cambrian explosion begins"*. Serviceable, occasionally a truncated sentence.

The date is cut out of the title **only when it leads**, which is when it is
punctuation rather than grammar. `1066 – the Norman conquest` wants it gone; excising
1877 from "Boltzmann suggested in 1877 that…" leaves *"suggested in that"*. So
mid-sentence the date stays where the author put it, which is most of what
`--events-prose` produces.

A prose title can still be anaphoric — *"These theories"*, *"He also pioneered…"* —
because the sentence's subject is in the previous one. Two of 49 on the quantum
mechanics page. That is what `--retitle` is for.

`--retitle` asks the local model for a name instead, which is markedly better
(*"Formation of the First Known Mineral"* over *"The first known mineral is found
at Jack Hills in Western"*). Two costs: it sometimes names a line's secondary
clause rather than its subject, and **ids are built from titles**, so a second
`--retitle` run over the same page may not recognise its own earlier entries as
duplicates. Mine with `--dry`, read it, then run once. Without the flag, re-runs
dedupe exactly.

### Mined entries are marked `origin.manual`

Nothing can re-fetch a mined event — there is no QID, and its page URL is the
source article shared with every other event on it. So mined and hand-entered rows
carry `origin.manual: true`, and `migrate.mjs` must never drop a row that has it.
See **The old CSVs** below.

---

## Rebuilding the map

```
node datasets/atlas.mjs              # place new entries, keep the map stable
node datasets/atlas.mjs --rebuild    # re-fit the hierarchy from scratch
```

This distinction is the most important thing in this document.

**Default mode treats the hierarchy as frozen.** New entries descend the existing
cluster tree to their nearest leaf and are interpolated into the gaps between
their neighbours. Every entry already on the map keeps *exactly* the y it had —
verified, not asserted: `verify.mjs` checks it and a real 25-entry ingest moved
0 of 2,690 existing points and 0 of 228 cluster bands. This is what makes it safe
to add a few hundred entries and still recognise the map afterwards.

**`--rebuild` re-fits everything.** Every y coordinate, cluster boundary and
colour can change. Do it when the corpus has grown enough that the old grouping
no longer describes it — roughly, when a `--rebuild` starts producing visibly
better labels than the frozen tree. The cost of not rebuilding is that bands
slowly crowd as gaps subdivide.

`layout.json` is the file that must persist for stability. Delete it and the next
build is a rebuild whether you asked for one or not.

### How many groups a level has is decided by the data

There is no configured branching factor. At every node `chooseSplit` tries every
k from 2 to `maxBranch` and keeps whichever scores the best mean **simplified
silhouette** — each entry's distance to its own centroid against its distance to
the nearest other centroid. A cheap 8-iteration k-means ranks the candidates,
then the winner is re-fitted properly, because ranking tolerates a rough fit and
k-means is the expensive part.

The old rule computed k arithmetically: the branching factor that makes a
balanced tree of the target depth land near `leafTarget` entries per leaf. For
3,787 entries that is always 7, whatever those entries are — so it had to fuse
unrelated material to fill the quota, and 322 physics entries spent a release
sharing a branch with 525 films because the politics material was heterogeneous
enough to absorb four of the seven slots. Now the root picks 6, and the count
tracks the content: Physics splits ten ways, Painting two.

Depth follows from this rather than being budgeted. Recursion stops on size, so
`maxDepth: 6` is only a backstop and a branch that keeps separating cleanly runs
deeper than its siblings.

### Labels

```
node datasets/atlas.mjs --rebuild                 # re-fit + relabel
node datasets/atlas.mjs                           # relabel, keep the geometry
node datasets/atlas.mjs --no-semantic-labels      # c-TF-IDF labels instead
node datasets/inspect.mjs --tree 2                # read the result
```

**Labels are recomputed on every build, including incremental ones**, so adding
entries relabels the tree for free — there is nothing to re-run separately and
nothing hand-written to maintain. A new subject area brings its own vocabulary
in with it and becomes nameable on the next build.

Each node is named by the vocabulary term nearest its centroid. Candidates come
from the corpus itself — unigrams, bigrams, topics and facet values appearing in
at least six entries — and are embedded with the same model as the entries, then
cached in `vocab.bin`. Only terms missing from that cache are embedded, so a
build after an ingest costs a few hundred short strings rather than three
thousand.

The graded behaviour is geometry, not configuration. A depth-1 centroid is the
mean of hundreds of varied entries, so the nearest term to it is generic; a leaf
centroid is tight, so the nearest term is specific. `Film → Comedy Film → Film
Noir` needs no per-level rule.

Three things worth knowing before tuning it:

- **c-TF-IDF is the wrong tool for a broad label** and the old labels showed it.
  It rewards a term frequent inside the cluster and *rare outside* it, so asked
  to name 258 films it returns "Directed · Starring" — the words unique to film
  boilerplate — and never "Film", which is too widespread to score. That
  measure is right for a leaf and inverted at the top. It is still what
  `--no-semantic-labels` falls back to when Ollama is unreachable, since a
  layout-only rebuild should work offline.
- **The root is deliberately unnamed.** Its centroid is the corpus mean, so the
  nearest term is just whichever domain is largest — and because a child may not
  reuse an ancestor's term, naming it robbed the one cluster the term described.
  Against ancestors the test is exact match, so a parent "Film" still leaves
  "Film Noir" free for a child.
- **`covWeight` corrects toward words literally present, and that cuts both
  ways.** It was 0.45 while the vocabulary still held credit-line verbs, because
  it took that much lexical evidence to stop "Directed" beating "Film". Once
  those were excluded it only distorted: a leaders cluster whose terse excerpts
  say "Military power." got named *Military*, though by cosine alone the corpus
  ranks `politician` (0.676) and `political` (0.672) far above `military`
  (0.567). At 0.25 it is a tie-breaker rather than half the score. Any change to
  the vocabulary filter is a reason to re-check this weight.

`vocabOk` is the filter that keeps labels readable. A multi-word term may not
open or close on a function word — "Painting By", "The Film", "Of England" are
sentence fragments, not names — and `CREDIT_STOP` drops Wikipedia's film-lead
credit verbs (`directed`, `starring`, `written`, `produced`) as *candidates*
while leaving them in the embedded text, where they do no harm.

A caveat that outlives this note: **a label can only be as good as the excerpts
under it.** While 847 art entries had no excerpt, the word "painting" appeared in
53 of 906 and the art cluster was called *Impressionism*; worse, those vectors
were so degenerate that `georges seurat` scored 0.93 semantic coverage over 1,020
entries. Backfilling excerpts renamed the cluster to *Painting* on its own. If a
group is labelled by something oddly specific, check its excerpts before
touching the scoring.

---

## Checking your work

```
node datasets/verify.mjs                  # 30 invariant checks, ~1s
node datasets/inspect.mjs                 # the tree, top level
node datasets/inspect.mjs --tree 2        # two levels deep
node datasets/inspect.mjs --near cubism   # nearest neighbours — the real test
node datasets/inspect.mjs --leaf 113      # one cluster's members, in y order
node datasets/inspect.mjs --cross         # do clusters cross source files?
node datasets/dedupe.mjs --dry            # one-off: drop rows sharing a QID
```

`--near` is the check that catches bad data fastest. If an entry's nearest
neighbours are not obviously its kin, its excerpt is too thin to embed well:

```
Les Demoiselles D'Avignon (pablo picasso) [1907]   y=0.4896  leaf 113 "Cubism"
  0.901 · Three Women (pablo picasso) [1908]
  0.850 · Nude With Raised Arms (pablo picasso) [1907]
  0.823 · Femme Assise (pablo picasso) [1909]
```

Two checks in `verify.mjs` deserve naming, because they are the design's core
claims and both would fail silently:

- **vertical neighbours are semantic neighbours** — mean similarity of y-adjacent
  pairs must clearly beat random pairs. Currently 0.578 vs 0.215.
- **the axis is not a proxy for time** — y must not correlate with year, or the
  second dimension is wasted duplicating the first. Currently r=-0.204.

`--cross` is the one to watch after touching `entryText()`. If every cluster is
100% one source file, the embedding has re-derived the old CSVs and the atlas is
a swimlane chart with extra steps.

Two more that were added after each caught a bug already in the store:

- **nothing is dated after the present** — the x extent is a max over every row,
  so one misread date moves the whole axis. Five rows once ran past 2026 and the
  only visible symptom was a time axis reaching the year 3200 with a millennium
  of dead space on the right.
- **no QID appears twice** — `ingest.mjs` deduped only against the store as it
  stood when the run started, so a QID reached twice within one run passed both
  times and the `~N` id-collision suffix quietly made room for it. 65 rows across
  58 QIDs. `dedupe.mjs` cleared the ones already stored; the gate is fixed, so it
  should never need running again.

---

## The data model

`atlas/entries.jsonl`, one object per line:

```json
{
  "id": "art:les-demoiselles-davignon:1907",
  "title": "Les Demoiselles D'Avignon",
  "subtitle": "pablo picasso",
  "yearText": "1907", "start": 1907, "end": 1907, "kind": "point", "circa": false,
  // "openEnded": true on a span whose end year is not recorded — see below
  "openEnded": false,
  "domains": ["art", "visual art"],
  "topics": ["cubism", "proto-cubism"],
  "facets": { "artist": "pablo picasso", "movement": "cubism" },
  "excerpt": "…",
  "image": "https://…",
  "origin": { "dataset": "art", "wiki": "https://…", "qid": "Q…" },
  // hand-entered and mined rows also carry  "manual": true
  "addedAt": "2026-07-28"
}
```

**JSONL, not CSV.** Excerpts contain commas, quotes and paragraph breaks. The CSV
parser handled none of those without escaping (`%2C` for commas in URLs, the
literal characters `\n\n` for a paragraph break, no quoted newlines at all), and
one unquoted comma silently shifted every later column. Appending an entry here
is appending a line.

**`domains` vs `topics` — the distinction that makes the atlas work.** Domains are
broad buckets implied by where an entry came from; topics are its own specific
subject tags. Only topics are embedded. Domains were embedded in the first
version and it wrecked the map: a domain tag is perfectly correlated with the
source file, so it carries no information *within* a domain while forcing a large
constant separation *between* domains. The hierarchy dutifully re-derived the
eight original CSVs — exactly the category-per-row structure this rework exists
to escape. Left out, a Picasso painting can sit beside Picasso the person and
beside Cubism as a movement.

**Domains ARE a label input, and were missing from it.** Keeping them out of
`entryText` is right and `verify.mjs` enforces it; keeping them out of
`vocabTokens` was an oversight. Labels come from `nameFromCentroids`, which
matches a node's centroid against a harvested vocabulary — and that vocabulary
took topics, facets and prose but not domains, so "us history" and "visual art"
could never be offered no matter how squarely a cluster sat on one. Adding a word
to the vocabulary moves no point on the map; adding it to `entryText` moves every
point. They are separate decisions and only the second one is dangerous.

**`openEnded` — the end year is not recorded.** An absent Wikidata P582 (and the
word "present" on the CSV route) leaves a span with no right edge, and the only
number available to draw to is the current year. Stored plainly that is
indistinguishable from a real end date, so the Phanerozoic, Animal and Fungus all
drew as bars stopping dead at 2026 in the same shape as a reign that genuinely
ended there — the most conspicuous marks on the map, and the reason spans looked
like they overshot the present. Flagged, they get a fading tail instead and the
detail panel prints `745 –` rather than inventing an ending. Deliberately *not*
called `ongoing`: most of the 109 really are unfinished, but Vikings, Ancient Rome
and Olmecs are in there because Wikidata never dated their end, not because they
are still going.

**Multi-value by construction.** `topics` is a list, so a cell reading
`"science fiction / horror"` becomes two topics and the entry belongs to both.
There is no single slot to force a compound value into, which is why
`"genre 1 / genre 2"` can no longer become a category of its own.

### Vector storage

`vectors.bin` holds one fixed-width row per entry: a float32 scale followed by
256 int8 components.

Per-row scaling is not an optimisation, it is required. Embeddings arrive
L2-normalised, so components cluster near 1/√256 ≈ 0.06 with the largest around
0.19. A fixed int8 scale over [-1,1] would use about 24 of 255 available levels
and throw away the distances the entire atlas is built on.

---

## The old CSVs

`migrate.mjs` converts all eight into `entries.jsonl`. It reads them and never
writes them, so they remain a valid authoring format — write a CSV row, re-run
`migrate.mjs`, then `embed-all.mjs` and `atlas.mjs`. Anything added by
`ingest.mjs` that no CSV accounts for is carried over rather than dropped.

### It refuses to delete

`migrate.mjs` rewrites `entries.jsonl` wholesale, which makes it the only script
here that can *remove* an entry. A stored row that no CSV produces any more now
**stops the run** and is listed; `--prune` says you have read the list and agree.

This has been got wrong twice, in the same six lines, and both times it took the
data that cannot be re-fetched:

| rule | what it dropped |
|---|---|
| keep rows whose `origin.dataset` has no CSV | every `ingest.mjs --domain art` entry — `--domain art` *sets* `dataset: 'art'` |
| keep rows with `origin.wiki` or `origin.qid` | every hand-entered row, which has `wiki: ''` and `qid: null` |

So the test now runs the other way round — a row is a CSV row only if it names a
dataset a CSV actually produces **and** carries no `manual` marker, no page URL and
no QID — and even then the deletion has to be asked for. The two errors are not
symmetric: a stale row wrongly kept is visible in the atlas and removable by hand,
while a mined or hand-entered row wrongly deleted is simply gone.

`enrich.mjs` and `suggest.mjs` still work on the CSVs and are still the cheapest
way to fill blanks in them; see the rest of this directory's README. For new
data, `ingest.mjs` supersedes both — it fetches prose, dates, images and topics
in one pass and places the result on the map.

---

## Cost discipline

Unchanged from before, and now easier to honour:

- **Retrieval is not a model's job.** Wikipedia and Wikidata APIs fetch. Free.
- **Embedding is local.** EmbeddingGemma, on your machine, no per-token cost.
- **A generative model is for judgement only** — house-voice reshaping
  (`--reshape`) and topic proposals (`--tag-topics`), both local, both optional.
- **Claude is for what scripts cannot do**: deciding what belongs, resolving the
  entries a run could not date, and curating. Not for bulk text.
