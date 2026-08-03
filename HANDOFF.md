# Handoff — the atlas rework

Written 2026-07-29, updated 2026-07-31.

---

## START HERE 2026-07-31 (session 4): art excerpts, and Phase 3 is done

**Phase 3 — the unified quiz — is built.** Home is two buttons. The 527 blank
`art.csv` excerpts are filled. Store rebuilt: **4,126 entries, 4,066 with excerpts
(was 3,572), 28/28 verify, 88/88 atlas QA, 39/39 quiz QA.**

### 1. `datasets/era-excerpts.mjs` — the art backfill

Full write-up in `datasets/README.md`. Two tiers: the work's own page when it has
one (97 of 527), otherwise paragraphs of the *creator's* article scored by how near
their years sit to the row's year. Pissarro in 1870 is Norwood and the
Franco-Prussian War; in 1885 it is meeting Seurat. **494 filled, era fit median 1
year off, p90 7 years.**

**Read the measurement before you touch the scoring.** Mean pairwise cosine over
Pissarro's 60 paintings:

```
                              excerpt channel      full embedded text
before (48 of 60 blank)            0.742                 0.820
naive: one bio for all             1.0000                0.814
era-anchored                       0.669                 0.797
```

The naive fill really does produce **identical vectors** — the bug is real and this
fixes it. But in the text that is actually embedded the spread is 0.820 / 0.814 /
0.797, because `entryText` also carries `artist` and `movement` as facets and those
are identical across every Pissarro. **The shared facets dominate and mask most of
the excerpt's effect.** So: this was worth doing and it is the largest gain
available in the excerpt channel, but it does not on its own spread one artist's
output across the map. Per-artist leaves went 1 → 6; y-spread is still ~0.015.

**If you want them genuinely separated, the lever is Wikidata**, not more excerpt
tuning — a painting with no article usually still has an item carrying collection,
medium and depicted subject, which is per-work fact. Not built.

Four traps, all of which produced fluent prose about the wrong thing, all in
`datasets/README.md`: the `[5-9]\d\d` year pattern giving a paragraph a 1,509-year
span, span-edge distance instead of nearest-year, provenance sections needing a
veto rather than a penalty, and **`titleSim` being the wrong metric for matching a
person** (it scored the correct `rembrandt van rijn` → *Rembrandt* at 0.33, below
the floor meant to catch `casper david friedrich` → *Joseph Koerner*).

`stripApparatus` moved out of `excerpts.mjs` into `lib/wiki.mjs`; both import it now.

### 2. The quiz — `project/features/quiz/`

One quiz over `atlas.json` + `details.json`, filtered by picking a cluster node.
`questions.js` derives what to ask from the entry rather than from a config, which
is the whole point — the old quiz read a fixed column list out of `settings.js`,
and for `art.csv` that list ended in `excerpt`, so it asked you to type a paragraph
of Wikipedia from memory.

Rules, and each exists because the naive version broke it: no excerpt is ever a
question; `title` is asked only when the image IS the work (a creator facet says
so — an `england` entry's stock photo of Port Isaac identifies nothing); no topic
question; one question is enough if the prompt names the subject. The excerpt is
revealed after grading.

**Two grader bugs worth not reintroducing**: `-?\d+` reads the hyphen in
`1837-1901` as a minus sign, so a correctly typed reign parsed as 1837 and *minus*
1901; and NFKD does not decompose `ł`, so `Chełmoński` split into "che" and
"monski" and no typeable spelling matched.

`node datasets/qa-quiz.mjs` — 39 checks, including the grader as unit tests.

### 3. Still open

- The old per-dataset quiz (`features/quiz_engine.js`, `ui/quiz.js`,
  `ui/stats.js`, the `DATASETS` quiz config) is **unlinked but still on disk**, by
  request. `loadQuizCounts()` is no longer called.
- **33 art rows still blank** — no creator page resolves. Listed in
  `art.era-misses.json`.
- 6 rows found no paragraph within 25 years of their date; all are correctly
  resolved artists with thin articles, all named in the run output.
- The root node's label is still stale, and `art.csv.bak` is still the two-day-old
  one — the current pre-run snapshot is **`art.csv.pre-era`**.

---

## START HERE 2026-07-31 (session 3): the reshape was never needed

**The `President · United States` problem is fixed, and it was fixed for free.**

```
 1610  -3000–2026   Politician
 ├─  354   -3000–2026   England · King
 ├─  444    -500–2026   Emperor · King
 ├─  551    1789–2026   President · Prime Minister
 └─  261   -1000–2026   History · War
```

That was one undifferentiated cluster of 612 leaders. Store is now **4,126
entries, 3,572 with excerpts, 28/28 verify checks passing**, rebuilt and current.

### Read this before you run the local model for anything

Session 2 designed `excerpts.mjs` around a two-step fetch-then-reshape, and spent
about three hours of `qwen3:8b` on it across two attempts. **The reshape step
contributed nothing.** The whole gain came from step one, fetching the Wikipedia
lead, which takes about a second per hundred rows and needs no model at all:

```bash
node datasets/excerpts.mjs leaders.csv --no-reshape
#   982 of 999 rows · median 815 chars  (was: median 77)
```

Three separate reasons it contributed nothing, all measurable:

- **`entryText` truncates the excerpt at 700 characters before embedding**
  (`lib/store.mjs:212`). Raw leads run p25 739 / median 816, so they saturate that
  cap. The reshape prompt targets 60–110 words, roughly 400–700 characters. It
  compresses ~900 characters of sourced text into *less* than the embedder was
  willing to read, so for clustering it is lossy, not neutral.
- **Length barely matters above 300 characters anyway.** Swept the truncation
  against how often an entry's 10 nearest neighbours share its Wikidata-derived
  role, 192 leaders over 4 roles, label stripped from the input:

  ```
  150 chars  75.3%   ·   450 chars  75.8%   ·   700 chars  76.8%
  300 chars  76.6%   ·   600 chars  76.1%   ·   900 chars  76.9%
  ```

  Flat above 300, falling below it. 700 is the peak and is already the cap, so the
  useful rule is **clear 300**, which any lead does three times over. That number
  is now `MIN_EXCERPT` in `lib/wiki.mjs`, with the table in the comment.
- **The model invents.** Session 2 already recorded the reshape turning the
  source's *"his stepfather Augustus"* into *"his stepson's"*.

**Recommendation: leave `--reshape` opt-in and don't use it.** It buys a
consistent house voice and nothing else. `lib/style.mjs` + one branch each in
`ingest.mjs` and `excerpts.mjs` is all there is to delete if you want it gone.

> The first measurement of this was contaminated and it is an easy trap to repeat:
> `entryText` puts **facets** into the embedded text and `role` is a facet, so the
> string being embedded contained `role: president` and the neighbour test was
> scoring its own answer key. It read 81.5% at 150 chars — highest where the
> excerpt is barely present, which is the tell. Strip the label from the input.

### What actually got done

1. **`excerpts.mjs` is now resumable.** Checkpoints the CSV every `--checkpoint`
   rows (default 25) and caches fetched leads in `<base>.excerpt-leads.json`. The
   CSV *is* the resume state — a committed row is over the length filter, so the
   next run skips it. Proven in anger: a run killed mid-way had already saved 25
   reshaped rows and 891 leads, and the resume re-fetched nothing.
   **A row is only committed once its reshape is decided**, so a kill never
   strands a row on raw text that a later run would then skip.
2. **All eight datasets backfilled** from Wikipedia leads, no model:
   leaders 982 rows, film 104, philosophy 12, religion 9, us_history 12. Medians
   ~815–848 against 77 before. Zero pages reused across any of them — checked,
   because that is the `art.csv` failure mode.
3. **`ingest.mjs` has an excerpt gate**, on by default. See below.
4. **Atlas gained an axis-zoom control.** Toolbar segment `⇔⇕ / ⇔ / ⇕` scoping the
   `+`/`−` controls, plus `⇧+pinch` for time-only. **Never opened in a browser** —
   syntax-checked only. `scales.js` is +5 lines; the work is in `index.js`.

### The excerpt gate in `ingest.mjs`

Any draft under `MIN_EXCERPT` gets its subject looked up and that page's lead
**appended, never substituted**. Substituting is what makes 32 paintings share
Pissarro's biography and land on one point. Anything still short is listed and
skipped; `--allow-thin` overrides. A page may lend context to 3 entries per run.

Subject resolution, in order of trust:

1. **The row's own `/wiki/` links.** `cellText` was discarding these; `cellLinks`
   now keeps them. An editor already decided "trilobites" means *Trilobite*, so
   this cannot pick the wrong page, only fail to find one. **Ranked by overlap
   with the row's title, not document order** — first-wins gave a row about
   Hadrian's Wall the *Hadrian* page, and gave a Julius Caesar row *Roman
   Republic*.
2. **A noun-phrase search**, for prose-mined rows, which come from `explaintext`
   and have no links.

Table pages fill 25 of 25, 24 by link. Prose pages fill about 10 of 18.

**Two mechanisms tried and rejected, both on measurement — do not re-litigate:**

- **Cosine-validating the context page does not work.** The wrong page shares its
  surface wording with the row, so `Lifetime` scored **0.542** against its row
  while the correct `Late Heavy Bombardment` scored **0.415**. No threshold
  separates them. The failure is ontological — a generic concept page instead of
  the entity — and an embedding cannot see that.
- **Single-word subject extraction is poison.** Every wrong match came from one:
  `Evidence of life` → *Evidence*, `Lifetime of the Last universal ancestor` →
  *Lifetime*, `earliest evidence for life` → *Carboniferous*, a period 3.9 billion
  years adrift. Every multi-word extraction was right. `properNoun` requires two
  words; rejected singles fall through to a whole-title search, which does better
  on exactly those cases. It costs recall — 16 filled dropped to 10 on one page —
  and that trade was taken deliberately, because **a wrong context page is
  invisible afterwards**. One line in `properNoun` if you want the coverage back.

### Memory and heat — the earlier advice was half wrong

- **`num_ctx` was the memory problem, not concurrency.** Ollama reserves a KV
  cache of `num_ctx × OLLAMA_NUM_PARALLEL` at load time, so the 8192 default
  served four ways reserved 32k tokens on top of 8B of weights. These prompts peak
  near 800. `generate` now takes `numCtx` (and `keepAlive`); `excerpts.mjs` asks
  for 2048 and gives up nothing.
- **Concurrency fixes memory, NOT heat.** One 8B model saturates the GPU at
  concurrency 1 as thoroughly as at 4; lower concurrency just spreads the same
  load over more wall-clock. The only real fix for heat is not running it.
- **Free swap is not a pressure signal on macOS.** It grows the swapfile on demand
  and shrinks it lazily, so it read ~1 GB free of 8 GB at pressure level 1 with
  42% memory free — a machine with nothing wrong with it. A first cut of the guard
  in `excerpts.mjs` read that as an emergency. Use
  `kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical) plus the
  free-page share.

### Still open

- **`art.csv`: 527 of 848 rows have no excerpt.** The one dataset that is *not*
  safe to backfill blind — its rows are artworks with no article of their own, so
  the search returns the artist. `excerpts.mjs` has no reuse cap; the
  `CONTEXT_REUSE` logic now in `ingest.mjs` is the same idea and needs porting.
- **The axis-zoom control has never been rendered.** Needs `node
  datasets/serve.mjs` up, then `node datasets/qa-atlas.mjs`.
- The **root node's label is still stale** (`President · Emperor · Reign`) — see
  the depth-0 note further down. Unchanged.

---

## Session 2, 2026-07-31: roles, triage, and the events work

Everything in this section is **free to run** — Wikipedia/Wikidata APIs and the
local `qwen3:8b`. No Claude in any of these paths. Nothing is committed.

### 1. `--events-prose` now gates writing, not mining — done, verified

The flag moved off the mining step. Prose is always mined, always counted, and
kept only with the flag, so one `--dry` run tells you the shape of a page instead
of reporting "nothing found" and making you re-fetch it:

```
mining "Cubism"… Cubism: 0 events (0 from tables, 0 dated at a line head)
    105 more dates sit mid-sentence and were NOT kept. That tier is noisier —
    Add --events-prose to include them; add --dry first to read them.
```

Regression-swept all 12 pages in the yields table below; every strict count is
identical. Two things this had to get right, both silent when wrong, both written
up in `datasets/ATLAS.md`:

- **The strict pass must complete before any prose is considered.** Dedupe is by
  `start|title`, so interleaved, a loose match on line 5 claims the key and blocks
  the line-anchored version of the same event on line 800 — which is then dropped
  again for being prose, so the event vanishes from a run that never asked for it.
- **`--limit` now applies per tier**, so discardable sentences cannot eat the budget.

> **Two numbers in the yields table further down this file are wrong.**
> *Evolutionary history of life* is **72**, not 137. *History of the Roman Empire*
> is **68**, not 594. Verified against the pre-change code, so this is a stale
> note, not a regression.

### 2. `datasets/misses.mjs` — triage before paying. Done

```
670 rows in  ->  60 need judgement  (357 rejected mechanically, 253 have no source)
91% decided without a model.
```

`art.misses.json` looked like 341 excerpts awaiting approval. It was not: those 341
proposals come from **107 distinct Wikipedia pages**. Pissarro's biography is
proposed for **32 different paintings**, Vigée Le Brun's for 22, Renoir's for 18 —
because the rows are artworks with no article of their own, so the search returned
the artist. Writing them would have been worse than leaving the cells blank:
identical prose makes identical vectors, and the atlas would cluster those 32
paintings by the accident of sharing a painter's bio.

Four mechanical verdicts (`reused-page`, `creator-page`, `index-page`,
`no-source`), written back into the three files. `review-worklist.json` holds the
60 survivors, which are a genuine mix — `schindlers list`→*Schindler's List* and
`8 1/2`→*8½* are correct matches punctuation hid, `destruction of tyre`→*Tyrion
Lannister* is not. Full write-up in `datasets/README.md`.

### 3. `datasets/roles.mjs` — a `role` column from Wikidata P39. Done

**893 of 999 filled, 825 of them verified by date overlap.**

```
308 president · 208 emperor · 123 prime minister · 96 king · 35 monarch · 24 sultan …
```

Why it exists: the label vocabulary is harvested from the corpus, six-entry floor.
Rescoring the 612-entry world-leaders cluster showed `politician` has the **highest
cosine to that centroid of any term in the corpus** (0.700) yet finishes 46th,
because it appears in 20 of 4,126 entries and the generality term is computed from
literal document frequency. `leader` appears in 69; `head of state` never clears the
floor. Every leader carried exactly two facets, `country` and `party` — rich enough
for good *fine-grained* labels and silent on what any of these people were.

`role` is wired into `migrate.mjs` in **both** `topics` and `facets`, matching how
`people.csv` carries `occupation`.

Two traps, both cost a full 999-row run to find:

- **Never put the country in the search query.** Copied from `enrich.mjs`, it cost
  110 rows: `Marcus Aurelius rome` ranks *Equestrian statue of Marcus Aurelius*
  first, `Septimius Severus rome` ranks *Arch of Septimius Severus*. A monument is
  not a person. Searching the bare name for 5 candidates fixed it.
- **The row's own year span picks the person AND the office.** `Constantine II of
  Greece` (1964–73) and `Constantine II (emperor)` (337–40) are both humans holding
  real offices; only one overlaps a row dated 337. First pass filled 488/999,
  second filled 893.
- A contiguous block of 329 `no-search-hit` rows was **throttling, not missing
  pages** — they all resolved on retry. Concurrency is now 3 with a back-off.

### 4. `datasets/excerpts.mjs` — rewriting all 999 leaders excerpts. DONE, but see the top

> **The diagnosis below is right and the cure is half wrong.** The 77-character
> fragments really were the problem; *fetching the lead* is what fixed it, and the
> reshape half contributed nothing measurable. Session 3 ran this with
> `--no-reshape` and got median 815 characters in about a second. Read the top of
> this file before acting on anything in this section.

`leaders.csv` excerpts were a **median of 77 characters** of the fragment style you
do not want (`"Cold War end. Gulf War. Single term."`), against 250 in `people.csv`
and 420 in `science.csv`. That is functional, not cosmetic: `entryText` feeds the
excerpt to EmbeddingGemma, so a 77-character excerpt makes a weak vector, and weak
vectors are why 612 unrelated leaders landed in one cluster at all.

`enrich.mjs` could not do this — it only fills *blank* cells, and all 999 are full.

Two free steps: fetch the `exintro` lead, then reshape with local `qwen3:8b` using
the shared brief now in `lib/style.mjs`. Measured on a 6-row dry run, **median 77 →
769 characters** of flowing prose.

Three things worth not undoing:

- **The fetched lead is the floor.** A reshape that trips `styleReject`
  (`lib/style.mjs`) is discarded and the encyclopedia text kept, so the local model
  can improve the voice but never make a row worse.
- **`stripApparatus` runs before the model sees anything.** A lead opens
  `Tiberius Julius Caesar Augustus ( ty-BEER-ee-əs; 16 November 42 BC – …)`, and
  every instruction the model has to follow is another chance to paraphrase.
  Parentheticals are matched by *content* — IPA, date range, `Language:` gloss.
- **The prompt is extractive on purpose.** Before that change the reshape turned
  the source's *"his stepfather Augustus"* into *"his stepson's"* — a real invented
  relation. Telling it to copy relationships, titles and dates rather than restate
  them fixed that specific case. **Spot-check `leaders.excerpt-log.json` anyway**;
  an 8B model paraphrasing 999 biographies will have slipped somewhere, and
  `--no-reshape` re-runs the whole thing as raw (accurate, uglier) Wikipedia leads.
- 113 rows got no lead (`{"lead-too-thin":107,"no-page":6}`) and keep their old
  fragment excerpt.

### What is NOT done, and what to check first

**Whether any of this actually fixes the `President · United States` label is
unmeasured.** The rebuild had not run when this was written. Look at
`node datasets/inspect.mjs --tree 2` first and judge it with your own eyes.

Be sceptical, because **the depth-1 labels have almost no margin** — I measured
the gap between the winning term and the runner-up:

```
Film       0.2641      Painting   0.0481   <- impressionism has the HIGHER cosine (0.777 vs 0.722)
England    0.1230      Physics    0.0239
Period     0.0708      Political  0.0153   <- one nudge from being called "American"
```

`genWeight` is the only thing keeping `Painting` from being `Impressionism`. I tried
three principled fixes to the scoring and **every one regressed the top level**:
setting `genWeight: 0`, clamping the penalty at 0.20/0.15/0.12, and replacing
literal document frequency with a semantic count of entries within a cosine
threshold (that one turned `Political` into `French Painter`). Do not re-litigate
those three — the numbers are in this session's analysis and they all fail the same
way. The data fix above is the one that has a chance, precisely because it changes
what words *exist* rather than how they are ranked.

Also still open, and cheap:

- The **root node's label is stale**. `atlas.json` node 0 reads
  `England · Reign · Politics`, identical to its `terms` array — that is the
  leftover c-TF-IDF label, because `nameFromCentroids` deliberately skips depth 0
  (`lib/cluster.mjs:797`) and nothing blanks it afterwards.
- **`want = 2` at depth 2** (`lib/cluster.mjs:836`) forces a second term, and
  `President · United States` reads as the single phrase "US President" — worse than
  either word alone. Allowing one term when the runner-up trails badly would help.
- **Junk in that cluster**: "Digital object identifier" and "Command and control"
  are sitting among the world leaders.
- 517 P39 office labels fell through `ROLE_PATTERNS` to a head-word guess; the
  common ones are legislature seats (`United States senator` 118, `Knesset member`
  80). `roles.mjs` prints them with counts so the table can grow.

### New files

```
datasets/misses.mjs            triage *.misses.json — 91% decided free
datasets/roles.mjs             leaders.csv role column from Wikidata P39
datasets/excerpts.mjs          rewrite an excerpt column: lead + local reshape
datasets/lib/style.mjs         STYLE + styleReject, shared with ingest.mjs --reshape
datasets/leaders.roles-log.json / .roles-misses.json
datasets/review-worklist.json  the 60 misses that need judgement
```

Session 3 added, per dataset backfilled:

```
datasets/<base>.excerpt-leads.json   fetched leads, so a kill costs no re-fetching
datasets/<base>.excerpt-log.json     what was written, with the source page + URL
datasets/leaders.csv.pre-excerpts    pre-run snapshot; the .bak was two days stale
```

`INDEX_TITLE` is now exported from `lib/wiki.mjs` and imported by `misses.mjs`, and
`STYLE` moved out of `ingest.mjs` into `lib/style.mjs` — same single-sourcing rule
as `years.mjs` and `titleCase`.

---

## DONE 2026-07-31: `--events` reads tables and narrative prose

Both pages that returned nothing now work, and **nothing has been ingested** —
the capability is built and verified, the data is still yours to add.

```bash
node datasets/ingest.mjs --events "Timeline of English history" --dry
#   180 events (180 from tables) — was 0
node datasets/ingest.mjs --events "History of quantum mechanics" --events-prose --dry
#   49 events (49 mid-sentence) — was 11
```

Full write-up in `datasets/ATLAS.md` under `--events`; that is the file to read.
What follows is only what a summary would lose.

### The table diagnosis was right; the prose one was wrong

Tables were exactly as described — `explaintext` strips them, so a second
`action=parse&prop=text` fetch was the fix, with regex row/cell extraction rather
than a DOM library. `Year | Date | Event` headed **90 of 91** usable tables across
six timeline articles. `rowspan` turned out to be the thing that would have
quietly ruined it: a year cell spanning several event rows is how these tables
avoid repeating a date (274 of them on *Timeline of Chinese history*), and the
rows underneath carry one fewer `<td>`, so read positionally every one of them
takes the *Date* column as its year. Hence a real grid, not a positional read.

Both prose hypotheses in the old brief were checked and **both were false**:
`maxChars` rejected 0 sentences, and the `continue`-after-anchored path fired on
0 lines (that page has no line-headed dates at all). The actual cause was
grammar coverage — of 397 sentences, 41 carried a year and `findDate` took 12,
because a bare mid-sentence year needs a preposition in front of it and narrative
history writes "his 1912 paper", "won the 1918 Nobel Prize", "the planetary model
of the atom (1911)". `findDate(s, {loose: true})` accepts those and only
`--events-prose` passes it.

### Four bugs found on the way, all of them silent

None of these announced itself; each one just produced fewer or wronger entries.

1. **A bare year followed by a comma was never a date.** The guard after
   `DATE_BARE` was `(?![\d,.])`, so `1066, the Norman conquest of England` matched
   nothing — the commonest timeline line there is — and worse, on a range it
   backtracked rather than failing: `1914–1918, the Great War` matched only
   `1914` and left `–1918,` in the title. Cost ~30 dates each on *History of
   science* and *History of the Roman Empire*.
2. **The 40-char floor was throwing away real events.** It is the right guess for
   a sentence pulled out of a paragraph and wrong for a line that opens with its
   own year. It was discarding **72 events from *Timeline of natural history***,
   among them "First trilobites." and "Vredefort impact structure forms." — the
   deep-time rows this path exists for. Table rows and line-headed text now use a
   12-char floor; prose keeps 40, where it does useful work rejecting
   `Peter Zeeman (1896)`-shaped list items.
3. **A page that states its era once, in a heading, dated every entry AD.**
   *Timeline of ancient Greece* writes `777: Cumae is founded by Chalcis` under
   `Archaic Period (785–481 BC)`. All 189 entries were in the wrong millennium and
   twenty were spans running backwards. Now the heading supplies the era, written
   into `yearText` so it still re-parses to the stored year. **Not in the store —
   that page had never been ingested.** The 617 mined entries that *are* in the
   store were checked (Timeline of Earth / quantum mechanics / mathematics /
   electrical engineering) and their years are right.
4. **Two range shapes produced backwards spans**: `1601–03` (far half abbreviated)
   and `180–10 AD` (straddles the era boundary). Both fixed in `years.mjs`; a
   draft whose span still runs backwards is now refused and reported rather than
   written, since `verify.mjs` asserts the store holds none.

### Traps for whoever touches this next

- **`yearText` must re-parse to `start`** — `verify.mjs` asserts it. This is why
  the finer `Date` column goes to `facets.date` and not into `yearText`:
  `"24 January AD 41"` parses to the year 24. `store.mjs` now also keeps a `date`
  facet out of the embedded text, where it would cluster entries by calendar
  coincidence.
- **A section heading is only sometimes a topic.** On a timeline page it is
  usually the period (`1st century BC`), which as a topic does what letting
  `domains` into the embedded text did — clusters entries by a value the x axis
  already carries. `topicFrom` drops period-only headings, strips a trailing span
  (`Proto-Cubism: 1907–1908` → `proto-cubism`) and refuses anything over 48 chars,
  which is a sentence rather than a label.
- **`--retitle` changes ids**, because ids are built from titles, so a second
  `--retitle` run over the same page will not recognise its own earlier entries as
  duplicates. Mine with `--dry`, read it, then run once.
- The unit list is now single-sourced in `years.mjs` (`UNIT_AFTER`), because the
  loose grammar and `yearInLead` both need it and a second copy of that list is
  how "560 kilometres" became the year 560 the first time.

### Verified

- `node datasets/verify.mjs` → **28 checks pass** (26 before; the two new ones
  lock in the comma/range fixes and the bounds on the loose grammar).
- 4,528 drafts mined from 12 pages, every one satisfying every invariant
  `verify.mjs` enforces on the store — parseable year, forward span, `yearText`
  round-trip both ends, non-empty title and excerpt, no HTML litter, no date in
  the embedded text.
- Yields: English history 0→180, quantum mechanics 11→49, ancient Greece 80→189
  (and correctly BC), natural history 181→253, evolutionary history of life
  3→~~137~~ **72**, Chinese history 0→1223, Russian 0→792, Roman Empire
  0→~~594~~ **68**, Middle Ages 0→295, Japanese 0→521. Ordinary pages (Cubism,
  Akira Kurosawa, Impressionism) still yield 0 without `--events-prose`.
  (The two struck numbers were wrong when written — re-measured 2026-07-31
  against both the old and the new code, which agree.)

### Not done, deliberately

- **Nothing ingested.** ~4,500 events are available from the pages above; adding
  them is a data decision, and the atlas rebuild that follows is not free.
- The wordiest-column fallback picks prose over names, so on
  `List of Nobel laureates in Physics` the title becomes the citation rather than
  the laureate. Right for excerpts, imperfect for titles; only matters on award
  lists, not on timelines.
- A prose title can still be anaphoric (*"These theories"*) when the sentence's
  subject sits in the previous one. Two of 49 on the quantum page. `--retitle`.

---

Picks up mid-Phase-2.

> **See also `HANDOFF-timeline-modes.md`** — the brief for the next requested
> feature, a geologic ⇆ human-history mode toggle. It exists because a single entry
> at −113000 now makes 89% of the linear x axis hold one point, and **Fit shows
> 1 point**. That file also carries the current loose ends, including a data-loss bug
> in `migrate.mjs` affecting hand-entered entries.

**Nothing is committed.** All of this is uncommitted working-tree changes on `main`
(the standing preference is to leave work uncommitted until asked).

---

## Where things stand

| phase | state |
|---|---|
| **1 — the data pipeline** | **Done and verified.** 28/28 invariant checks pass. Usable right now. |
| **2 — the atlas renderer** | **Built and verified. 50/50 browser checks pass**, five consecutive runs. |
| **3 — one unified quiz** | Not started. Design sketch at the bottom. |

The old swimlane timeline in `project/features/timeline/` is **untouched and still
works**. It is reachable from the home page as "Old lane timeline". The decision was
to *replace* it rather than keep it as a real mode, so its five known bugs were
deliberately not patched — they are solved structurally in the atlas instead. Delete
that directory once you are happy with the atlas.

---

## Phase 1: the pipeline (done)

Full docs: **`datasets/ATLAS.md`**. Read that before touching any of it.

```bash
# one-time setup (already done on this machine)
brew install ollama && ollama serve &
ollama pull embeddinggemma       # required, ~200MB, 768 dims
ollama pull qwen3:8b             # optional, ~5GB, only for --reshape

# the pipeline
node datasets/migrate.mjs            # 8 CSVs -> atlas/entries.jsonl
node datasets/embed-all.mjs          # fill missing vectors (resumable)
node datasets/atlas.mjs --rebuild    # re-fit the cluster hierarchy
node datasets/atlas.mjs              # OR: place new entries, keep the map stable
node datasets/verify.mjs             # 28 invariant checks, ~1s
node datasets/inspect.mjs --near cubism

# adding data — this is the thing to actually use
node datasets/ingest.mjs --category "Battles of the Napoleonic Wars" --domain war --deep
node datasets/ingest.mjs --links "List of Impressionist painters" --domain art
node datasets/ingest.mjs @list.txt --domain science --reshape
```

Current store: **4,126 entries**, 537 cluster nodes, depth 6, years −4.57e9…2026.
3,572 have excerpts (554 without, 527 of them in `art.csv`).

### What changed on 2026-07-30

Four things, all in the pipeline. `datasets/ATLAS.md` is the full write-up —
"How many groups a level has is decided by the data" and "Labels" are new
sections there.

1. **Labels are chosen by embedding, not word frequency.** Nodes were called
   `American · Directed · Starring` and `Directed · American · Stars` — two
   sibling film clusters named after Wikipedia credit-line boilerplate. Cause:
   c-TF-IDF rewards terms *rare outside* the cluster, which is the inverse of
   what a broad label needs. Now `harvestVocabulary` collects candidate terms
   from the corpus, `atlas.mjs` embeds them (cached in `atlas/vocab.bin`), and
   each node takes the term nearest its centroid. Depth-1 is now
   `Film · Painting · Political · England · Period · Physics`, narrowing to
   `Film Noir`, `Post-Impressionism`, `Photoelectric Effect` at the leaves —
   with no per-level rules, because a broad centroid is simply nearer a broad
   word. Labels recompute on every build including incremental ones.
2. **`k` per node is chosen by silhouette, not arithmetic.** It used to be the
   branching factor that made a balanced tree hit ~12 entries a leaf — always 7
   for this corpus, whatever it contained, which is why 322 physics entries
   shared a top-level branch with 525 films. `chooseSplit` now tries every k and
   keeps the best split. Root picked 6; Physics splits ten ways, Painting two.
   Depth follows from size, so `maxDepth: 6` is only a backstop. Rebuild cost
   went 3s → 9s and scales with corpus size — watch it past ~10k entries.
3. **The lead-text date fallback is guarded.** `[5-9]\d{2}` took any 3-digit
   number, so "about 560 kilometres" dated the English Channel to AD 560, and
   six others were wrong the same way. `yearInLead` now rejects a number
   followed by a unit (including durations) and requires a date cue for bare
   3-digit years. `origin.dateSource` is stored, so the prose-derived set is
   answerable after the fact.
4. **356 excerpts backfilled** via `enrich.mjs art.csv --fields=excerpt`. This
   was not cosmetic: with 847 art entries carrying no prose, those vectors were
   degenerate enough that `georges seurat` scored 0.93 semantic coverage over
   1,020 entries, and the art cluster was called *Impressionism*. Backfilling
   renamed it *Painting* on its own. **If a cluster is labelled by something
   oddly specific, check its excerpts before touching the scoring.**

Still open from this work: **554** entries have no excerpt (was 593), 527 of them
in `art.csv`, where `enrich` found a page but the title similarity fell below
`--min-sim=0.34` and it refused to write prose it was not confident in. That
refusal was the right call — `misses.mjs` later showed those 341 proposals came
from 107 distinct pages. The proposals are in `art.misses.json` for review. Also unactioned: a curation list
of 7 entries whose year is a measurement and ~30 places/concepts with no
meaningful date (Colchester 2021, Celtic languages 1707, History of Ireland 0) —
ids in `/tmp/curation.txt`, which will not survive a reboot.

Two rough edges: `England`'s first child is `War · Conflict`, holding
Genocide/Caucasus/Kurdish material that is not English — a placement problem,
not a labelling one. And `covWeight` in `nameFromCentroids` is coupled to the
`vocabOk` filter; it was 0.45 while credit verbs were still candidates, and had
to drop to 0.25 once they were excluded or a leaders cluster came out named
*Military*. Any change to the vocabulary filter is a reason to re-check it.

New files:

```
datasets/lib/years.mjs      year parsing — SINGLE SOURCE, browser re-exports it
datasets/lib/store.mjs      entries.jsonl + int8 vector sidecar
datasets/lib/ollama.mjs     the only model dependency; plain fetch to :11434
datasets/lib/cluster.mjs    k-means, tree, leaf ordering, y assignment, labels, colour
datasets/lib/wiki.mjs       Wikipedia + Wikidata -> a draft entry
datasets/migrate.mjs        CSVs -> JSONL (reads only, never writes the CSVs)
datasets/embed-all.mjs      resumable embedder, prunes orphaned vectors
datasets/atlas.mjs          compiles atlas.json / details.json / layout.json
datasets/ingest.mjs         THE tool for adding data
datasets/inspect.mjs        tree / --near / --leaf / --cross
datasets/verify.mjs         invariants
datasets/reload.mjs         hard-reload the app in a visible Chrome from the terminal
datasets/atlas/*            the built artifacts (committed, the browser fetches them)
```

`project/utils/helpers.js` was slimmed: its three year-parsing functions now
re-export from `datasets/lib/years.mjs` so the tooling and the browser cannot drift.

### Two findings not to undo

1. **Never let `domains` into the embedded text.** A domain tag correlates perfectly
   with its source file, so it carries no information *within* a domain while forcing
   a constant separation *between* domains. The first build did this and the hierarchy
   just re-derived the eight original CSVs. `verify.mjs` asserts it stays out.
2. **Incremental placement holds existing `y` exactly.** `layout.json` stores each
   entry's y; newcomers are interpolated into the gaps between neighbours. Measured:
   a real 25-entry ingest moves **0 of 2,690** points and **0 of 228** bands. The
   naive rank-based version moved 10% of points by up to 0.7% of the axis.

---

## Phase 2: the renderer (where you are)

```
project/features/atlas/
  data.js     load atlas.json, typed arrays, spatial grid, topic index, priority
  scales.js   x/y transforms, zoom model, tier + depth selection, ticks
  paint.js    canvas: bands, spans, dots, chips, label packing, hit testing
  cards.js    pooled DOM image cards + the hover preview
  detail.js   the detail panel (replaces the old row expansion) + enlarged image
  rail.js     cluster rail with collapse/pin + the pinned strip painter
  styles.js   the whole stylesheet
  index.js    orchestrator: window, camera, frame loop, all interaction
```

Wired up in `project/app/init.js` (`window.openAtlas`) and `project/ui/home.js`
("Open the atlas" button). Opens in a named popup, same pattern as the old timeline.

### How to run and test it

```bash
node datasets/serve.mjs                 # NOT python3 -m http.server — this file
                                        # said that for two sessions and it is
                                        # what the repo actually uses; a pkill
                                        # written against the wrong pattern
                                        # reported success and killed nothing
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank

node datasets/qa-atlas.mjs                    # 50 browser checks
node datasets/qa-atlas.mjs --shot /tmp/a.png  # + screenshot
node datasets/qa-atlas.mjs --keep             # leave the windows open
```

`window.__atlas` is a deliberate debug handle on the atlas window, exposing
`atlas, view, scale, visible, placements, filter, tier, depth` and
`select/focusNode/fit/zoom/setQuery/toggleCollapse/togglePin/goto`. The QA suite
drives the view through it — dispatching wheel events at guessed coordinates does
not work on a scatter plot, because most of the canvas is empty space and you end up
measuring a blank screen.

### The 4 failures — fixed

All four were one thing: the QA harness never cleared `localStorage`, so view prefs
leaked between runs (`atlas:prefs:v1` carried `"collapsed":[94],"pinned":[94]`). The
atlas booted with node 94 *already pinned*, so the pin test's click **unpinned** it,
the poll for `pinned.length === 1` timed out, and the later unpin test toggled it
back on. `qa-atlas.mjs` now clears the key on the **opener** before calling
`openAtlas()` — the popup reads prefs once at open time, so clearing afterwards is
too late.

Three real fixes came out of it:

1. **Production bug: the pin bar never emptied.** In `index.js` `paint()`, the
   `$('pinBar').innerHTML = …` assignment sat inside `if(pins.rows.length)`, so
   removing the last pin left a stale unpin button in the DOM. Now outside the
   guard. `#pinWrap` is `display:none` without `.on`, so it was invisible rather
   than on-screen as first described — but the next pin would have inherited it.
   Locked in by a new 50th check.
2. **The suite's `sleep(900)` after loading the app was a real flake** — it passed
   most runs and failed the rest, reading as "openAtlas is not a function", i.e. as
   an app bug. Now polls with `until`; resolves in ~62ms.
3. **DOM assertions must poll.** The first version of the new pin-bar check used
   `evaluate`, and failed 1 run in 3: view state empties synchronously in the click
   handler, but the bar is rewritten in `paint()` one frame later. The passing runs
   show both 1ms and 62ms, which is the race made visible.

One thing that cost time and is not in the code: **the static server had died**
partway through, and every check failed in a way that looked like a module error.
`ERR_CONNECTION_REFUSED` only shows up in the page's log, which the suite does not
surface. If everything fails at once, `curl -sf localhost:8777/` first.

The inverse also cost time, in session 3: **`lsof -nP -iTCP:8777 -sTCP:LISTEN` is
how you find out what is really on that port.** The server is `node
datasets/serve.mjs`, it can outlive its terminal (it was found parented to launchd
after two days), and a `pkill -f "http.server 8777"` matches nothing, reports
nothing wrong, and leaves it running.

### Then `--shot` turned out to be lying, and that exposed three more

`--shot` used to dispatch synthetic wheel events at the centre of the canvas —
exactly the mistake this file's own header warns about. The middle of a scatter plot
is empty, so every screenshot came out a blank grid reading `0 in view`, which is
why nobody had *looked* at the thing. It now reuses the densest-with-excerpts entry
the suite already located and waits for points to be in frame.

The first honest screenshot showed two mangled strings, both from `\b` in a
title-caser. **`\b` is ASCII-only even under the `u` flag**, so every non-ASCII
letter reads as a non-word character and the letter after it starts a new "word":

| was | now |
|---|---|
| `FranÇOis Truffaut · … · Katsuhiro ōTomo` | `François Truffaut · … · Katsuhiro Ōtomo` |
| `Portrait of the Artist'S Wife` | `Portrait of the Artist's Wife` |

`cluster.mjs` and `migrate.mjs` had **two separate copies of the same function with
the same bug**, so `titleCase` is now exported from `cluster.mjs` and imported by
`migrate.mjs`, the way `years.mjs` is single-sourced. An apostrophe still breaks a
word, because `o'keeffe` → `O'Keeffe` must work; the exception is a trailing
possessive `'s`. 35 of 2,697 entries were affected.

**Data-loss bug in the documented pipeline, found on the way.** `migrate.mjs` decided
what to carry over with `!MAP[`${e.origin?.dataset}.csv`]`. But `ingest.mjs --domain
art` files entries under `origin.dataset: 'art'`, and `art.csv` exists — so all **58
ingested entries would have been silently deleted** by a routine `node
datasets/migrate.mjs`. The dry run said `total 2639` with no carry-over note while
the store held 2,697; that 58-entry gap was the only symptom. The discriminator is
now `origin.wiki || origin.qid`, which is what actually distinguishes an ingest from
a CSV row. **If you had run the documented pipeline before this fix, you would have
lost them.**

**The QA suite was verifying stale data.** `python3 -m http.server` sends
`Last-Modified` and no `Cache-Control`, so Chrome applied a heuristic freshness
lifetime and served `atlas.json` from a disk cache that persists in
`--user-data-dir`. After a full rebuild the suite still reported 50/50 — against
two-build-old data, and the screenshot still showed `FranÇOis`. `attach()` now sends
`Network.setCacheDisabled`.

### Rebuild after those fixes — the map did not move

```
node datasets/migrate.mjs        # 2697 entries, 58 carried over, 0 mangled titles
node datasets/embed-all.mjs --force
node datasets/atlas.mjs          # incremental, NOT --rebuild
node datasets/verify.mjs         # 21/21
node datasets/qa-atlas.mjs       # 50/50
```

`--force` was needed because nothing hashes entry text, so the embedder cannot see a
changed title — it only fills missing vectors. Verified afterwards that this
introduced no drift: **2,662 of 2,697 vectors came back byte-identical and exactly
the 35 retitled entries changed**, min cosine 0.992. Incremental placement then held
**2,697 y-positions exactly, 0 interpolated**, same 227 nodes and depth 3, so the
reviewed layout survived. Use plain `atlas.mjs`, not `--rebuild`, or you re-fit the
hierarchy and throw that away for a 35-entry casing change.

### What the passing checks confirm

- **Images are never cropped** — `object-fit: contain` on card, hover preview,
  detail panel and enlarged view; 6 loaded images verified to keep their aspect
  ratio to within 4%.
- **No doubled outlines** — asserted that no card carries a border *and* an
  outline. Selection/hover are `box-shadow` rings outside the border.
- **Collapse works** — "Politics · Reign · Leaders" (7 children) folded 35 → 28 rail
  rows in 11ms, 595 members collapsed into one band, status reflects it, expanding
  restores exactly 35 rows.
- **Hover preview at every zoom**, including fully zoomed out (`tier=dot`) — this was
  an explicit request.
- **Detail panel** opens with cluster breadcrumbs, 6 nearest neighbours, 8 topic
  chips, prose, and neighbour-click navigation.
- **Search**: free text (`cubism` → 54), year range (`1750-1800` → 155),
  `ds:film` → 628, `topic:surrealism` → 7, `has:image` → 2,512, and the empty state.
- **Performance**: 40 pan frames in 327ms = **8.2ms/frame** at 2,697 points.

### Bugs already found and fixed during Phase 2

Keep these in mind; three are traps that will recur.

1. **Backticks inside a CSS/JS template literal terminate it.** A comment reading
   `` `--hue` `` inside `styles.js`'s CSS template closed the string, and the CSS
   was then parsed as JavaScript — surfacing as
   `SyntaxError: Invalid left-hand side expression in postfix operation` (`--bg`
   read as a decrement). Bit me twice: once in `styles.js`, once in a page-side
   probe in `qa-atlas.mjs`. **Never use backticks in a comment inside a template
   literal.**
2. **Timers must come from the atlas window, not the opener.** This module's code
   runs in the *opener's* realm, and browsers throttle a backgrounded tab's timers to
   ~1s — and the opener is backgrounded the entire time you are using the atlas. The
   search debounce and the resize handler were both ~1s late. Now `w.setTimeout` /
   `w.clearTimeout`. `requestAnimationFrame` was already `w.`-prefixed.
3. **DOM nodes must be created by the popup's document.** `document.createElement`
   in `cards.js` / `detail.js` / `rail.js` built nodes in the opener's document.
   Browsers auto-adopt on append, but `ownerDocument` stays wrong. Now
   `root.ownerDocument.createElement`, and the tip reads `D.defaultView.innerWidth`.
4. **The rail never rebuilt when zoom changed its depth.** `depthFor()` picks which
   tree level the rail lists, but only the collapse/pin/filter flags set
   `dirty.rail` — so the rail showed a stale level until an unrelated action forced a
   rebuild. `paint()` now compares against the previous depth.
5. **`#railHost` was the flex item, not `.rail`.** `.rail` is written as
   `flex:0 0 216px` with a bounded scroll column, but a plain wrapper div sat between
   it and `#mid`. Fixed with `#railHost{display:contents}`.
6. **`setPointerCapture` throws** `NotFoundError` when the pointer is already gone
   (synthetic events, fast clicks). Now wrapped in try/catch.

### Design decisions worth not re-litigating

- **x is linear, always.** Explicitly chosen; compressed/elided empty stretches were
  offered and rejected. Gaps should read as real.
- **y is unitless [0,1]**, and its zoom is *coupled* to x's by
  `coupledYZoom(ppy) = 1 + ppy^0.62 * 1.35`. Alt+wheel zooms y alone. Linear coupling
  ran vertical zoom away long before the cards appeared.
- **Detail arrives gradually, not by tier switching.** `tierFor(ppy)` only sets what
  is *offered*; `packLabels()` then places labels in a fixed global priority order
  until the space runs out. Priority is viewport-independent on purpose — anything
  position-dependent makes cards shimmer as you pan. Dots are always drawn.
- **Cluster bands are filled, never stroked.** An outlined band next to an outlined
  card is what read as doubled borders. One hairline at each band's top edge only, so
  adjacent bands share a line.
- **Band labels stick to the viewport's left edge**, not to the band's first entry —
  otherwise the label scrolls away exactly when you still need it.
- **Collapse folds the map band *and* hides rail children.** One control, because it
  is one intent.
- **Pin lifts a cluster into a top strip sharing the map's x transform**, so you can
  hold "Cubism" pinned and pan four centuries past it. Max 6 pins, ≤42% of viewport.

---

## Suggested order of work from here

1. ~~The two fixes above.~~ **Done — 50/50.**
2. **Look at it with human eyes.** `--shot` now produces an honest picture and the
   map does read well at card/detail zoom — uncropped images, sane label density,
   bands legible. Still open, and still a judgement call:
   - ~~**Duplicate sibling labels.**~~ **Largely addressed 2026-07-30** by the
     labelling rework — a node may not reuse an ancestor's term, so each level
     is forced to add information. Sibling collisions are no longer excluded
     outright though (only ancestor ones), so `Comedy Film · Drama Film` and
     `Drama Film · Comedy Film` still appear as siblings under `Film`. Worth a
     look with `node datasets/inspect.mjs --tree 2` if it reads badly.
   - **Band labels are occluded by cards.** They stick to the viewport's left edge
     (deliberately), but at detail zoom a card sitting at the left of the viewport
     covers them — visible in the screenshot as a clipped `Post-Impress…` and
     `…icism`. The label wants to win, or to dodge.
3. ~~Update the root `README.md`.~~ **Done.** The atlas is now the primary view: it
   has its own module table, design decisions, gotchas and rough edges; the QA
   section documents `qa-atlas.mjs` and the three traps that made it lie; the
   dataset section gained the rebuild steps and the `ingest.mjs` carry-over rule.
   The lane sections are retained under a "superseded" banner and should go with the
   directory. **The Wikimedia thumbnail-width gotcha was moved out of them** into the
   atlas gotchas — the atlas uses `thumbUrl` in `cards.js` and `detail.js`, so that
   note must not be deleted along with the lane engine.
4. **Delete `project/features/timeline/`** and the `timeline_engine.js` shim once the
   atlas is confirmed good, plus the "Old lane timeline" button in `ui/home.js`.
5. **Phase 3, the unified quiz.** Sketch: one page over `entries.jsonl`, no
   per-dataset quizzes. Topic filter = the cluster tree picker plus free text, reusing
   `data.js`'s `runFilter`. "Entries with aligning embeddings" is served by the
   precomputed `knn` already in `atlas.json` — pick a seed entry or cluster and quiz
   over its neighbourhood, which needs no model in the browser. Question types fall
   out of the fields present: year, creator/subtitle, topic, image.
6. **Data.** Still the biggest quality lever, now measurably so — twice over:
   backfilling excerpts renamed a whole top-level cluster on 2026-07-30, and doing
   it properly in session 3 turned `President · United States` into `Politician`
   with four sensible children. **554 entries have no excerpt (down from 949),
   527 of them in `art.csv`** — which is now essentially the whole of the gap.
   That dataset is the one that cannot be backfilled blind: its rows are artworks
   with no article of their own, so a search returns the artist and one biography
   gets proposed for 32 paintings. It needs the `CONTEXT_REUSE` cap from
   `ingest.mjs` ported into `excerpts.mjs`, or a pass over `art.misses.json`,
   which already holds the proposed text and has been triaged by `misses.mjs`.

## Running the local generative model without killing the machine

Applies to `--reshape`, `--retitle`, `--tag-topics` and `excerpts.mjs` — anything
that touches `qwen3:8b`. Embedding is not affected; `embeddinggemma` is ~200MB
and irrelevant here.

**First ask whether you need it at all.** Session 3's finding is that the one job
this was written for did not — see the top of this file. The cheapest generative
run is the one you skip.

- **`num_ctx` costs more than concurrency does.** Ollama reserves a KV cache of
  `num_ctx × OLLAMA_NUM_PARALLEL` when it loads the model, so the 8192 default
  served four ways reserves 32k tokens on top of the weights. `generate` takes
  `numCtx` now; anything with short prompts should say so.
- **Concurrency is a memory dial, not a heat dial.** One 8B model saturates the
  GPU at concurrency 1 too — lower concurrency spreads the same load over more
  wall-clock, which for heat is arguably worse. Nothing but not running it will
  keep the machine cool.
- **One 8B model at concurrency 4 pins ~4.5 GB resident** and, on this machine,
  pushed swap to 16.35 of 17.4 GB with 1 GB free. Everything else — Chrome, VS
  Code — is competing for what is left. Keep `--gen-concurrency` at 1–2.
- **Check before starting a long run**, not after:
  `ps -Ao pid,rss,args | grep llama-server` and
  `sysctl kern.memorystatus_vm_pressure_level` — 1 normal, 2 warning, 4 critical.
  **Not `vm.swapusage`.** macOS grows the swapfile on demand and shrinks it
  lazily, so it reports the high-water mark of the last few days, not the current
  state: measured at ~1 GB free of 8 GB while pressure was 1 and half of RAM was
  available.
- **To reclaim it, stop the consumer first, then the model.**

  ```bash
  kill <node pid>          # or it reloads the model on its next request
  ollama stop qwen3:8b     # frees the ~4.5 GB
  ```

  **Do not kill `ollama serve`.** It is ~40 MB and it is also what serves
  `embeddinggemma` — take it down and `embed-all.mjs` and the atlas label
  vocabulary stop working. Unloading the one model is enough.
- **Assume a long local-model run is not resumable unless you have checked.**
  `excerpts.mjs` now is — it checkpoints the CSV and caches fetched leads. `roles.mjs`
  is not, and neither is `ingest.mjs --reshape`.

## Known rough edges (not bugs, judgement calls)

- The status readout can show a year range wider than the data (e.g. `1571 BC–3349`)
  when the whole extent fits in the viewport. Correct behaviour, looks odd.
- 88% of leaf clusters are single-source. Expected while `art` + `leaders` are 68% of
  the corpus, and it will loosen as excerpts fill in and other domains grow. Watch it
  with `node datasets/inspect.mjs --cross`.
- `membersOf()` in `rail.js` memoises per node in a `WeakMap` keyed by the atlas; it
  scans all points on first call per node. Fine at 2.7k, worth revisiting at 100k.
- `atlas.json` is 792KB and `details.json` 794KB, both loaded whole. Points are
  columnar so parsing is fast, and details load after first paint. Past ~50k entries
  these want sharding or a binary blob; there is a note in `atlas.mjs`.
