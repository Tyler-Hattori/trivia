# The quizzes

There are two, plus review:

- **The topic quiz** (`project/features/topic/quiz.js`) — the main one. Inside a
  topic (`#/topic/<slug>/quiz`), across every topic (`#/quiz`), and as **Review**
  (`#/review`, only what is due). Modes: **Order** (put four in time order; across
  topics, the four nearest in time), **Era** (which chapter; one topic only),
  **Recall** (type the year). If the chosen mode cannot make a question in the
  current scope it falls back to another instead of a dead end.
- **The cluster quiz** (`project/features/quiz/`, `#/cluster-quiz`) — the older
  quiz over the whole corpus, scoped by a node of the atlas's cluster tree.
  Below.

Both use `questions.js` for what an entry can be asked.

## Memory: spaced repetition

Every answer is stored per topic in localStorage, `topic:mastery:<slug>` →
`{ <entry id>: { r, w, last, box, at, due } }`. Right moves an entry up a Leitner
box (due again after 1, 3, 7, 16, 35, 90 days); wrong sends it to box 0 (due in
10 minutes). Questions are drawn weighted towards due, missed and unseen
entries. `dueSummary()` counts what is due across every topic for the home
page's Review button. The cross-topic quiz uses ids `<slug>|<entry id>` and
records each answer in its own topic, so it counts there too. Records from
before boxes existed are treated as due a day after a right answer.

The cross-topic quiz and review read `datasets/topics/all.json` (every
timeline entry of every topic, ~2 MB), not the full topic files.

# The cluster quiz
```
project/features/quiz/
  questions.js   what an entry can be asked, and whether an answer is right
  index.js       cluster picker, run state, rendering
```

One quiz over `datasets/atlas/atlas.json` + `details.json`, loaded through the
atlas's own `loadAtlas`. There are no per-dataset quizzes any more.

**The question is derived from the entry, not from a config.** That is the whole
substance of `questions.js`, and it exists because the old quiz asked every row for
the same fixed column list out of `settings.js` — a list that for `art.csv` ended in
`excerpt`, so it put a text box on screen and waited for 600 characters of Wikipedia
to be typed from memory. The rules:

- **The excerpt is never a question**, at any length.
- **A field with no value is never a question.**
- **`title` is asked only when the image IS the work.** Not merely "has an image":
  an `england` entry for Port Isaac carries a stock photograph of the village, which
  identifies nothing. A creator facet (`artist`, `director`, `creator`, `author`) is
  what says the picture is a reproduction of the thing being asked about; otherwise
  the title is shown as the prompt.
- **A span is asked for both ends**, a point for one year.
- **The categorical questions are whichever facets the entry actually carries**, so
  a painting is asked artist and movement and a leader country and role.
- **There is no topic question.** `migrate.mjs` puts a leader's country, party and
  role into `topics` as well as `facets`, so the answer was a free copy of a box
  already on screen; and where it was not a copy it was "name any bucket this
  belongs to", with no way to know which of several the grader held.
- **One question is enough**, as long as the prompt names the subject. A mined
  timeline event carries a title and a date and nothing else, and "in what year
  did this happen" is exactly the question it exists to support. A two-field
  minimum combined with dropping `topic` silently halved the corpus, 4,126 to
  2,266, and every casualty was one of those.

**The excerpt is shown once the answers are revealed.** Both halves of that are
deliberate: before grading its first sentence gives away every answer, and after
grading it is the only thing on screen that teaches you anything.

Filtering is by cluster — any node of the tree, taking every entry beneath it — plus
the atlas's own query language handed straight to `runFilter`, so `ds:film`,
`topic:surrealism`, `1750-1800` and `has:image` all work in the quiz too.

## Grading

Free text. Four rules worth not undoing, each of which has a test in `qa-quiz.mjs`:

- **A surname alone is correct.** "renoir" is what anyone looking at a Renoir types.
- **Whole-word containment only.** The old rule was
  `guess.includes(answer) || answer.includes(guess)`, which marked a single letter
  correct against every answer containing it — typing `a` scored.
- **A hyphen between two digits is a separator, not a minus sign.** `-?\d+` read
  the range `1837-1901` as 1837 and *minus* 1901, so a correctly typed reign was
  marked wrong.
- **Deep time is graded on magnitude and a relative tolerance.** The entry states
  itself as "c. 4,570 Ma"; demanding the sign would fail every honest answer.

`ł`, `ø`, `ß` and friends are transliterated before comparison — NFKD does not
decompose them, so `Chełmoński` was being split into the two words "che" and
"monski" and no keyboard-typeable spelling could match it.
