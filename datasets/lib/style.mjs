/**
 * The project's excerpt house style, as a system prompt.
 *
 * Single-sourced because two scripts now reshape prose with it — `ingest.mjs`
 * behind `--reshape`, and `excerpts.mjs` when rewriting a whole dataset — and a
 * second copy of a style guide is how two halves of one corpus end up in two
 * different voices.
 *
 * Wikipedia leads are accurate but written as encyclopedia openings: heavy on
 * parenthetical dates, native spellings and disambiguation. This turns one into
 * the flowing two-paragraph prose the datasets use.
 *
 * The bar is `people.csv` and `science.csv`. Measured, those sit at a median of
 * 250 and 420 characters against `leaders.csv`'s 77 — and the length is not
 * cosmetic. `entryText` in store.mjs feeds the excerpt to the embedder, so a
 * terse excerpt makes a weak vector, and a weak vector both clusters badly and
 * leaves the labeller with no word to name the cluster by.
 */
export const STYLE = `You rewrite encyclopedia text into a house style for a history timeline.

RULES
- Flowing prose in complete sentences. Never clipped fragments like "Cold War end. Gulf War. Single term."
- One or two paragraphs, 40-120 words total. Separate paragraphs with a blank line.
- Paragraph one: what the thing is and why it matters. Paragraph two (optional): its consequence or context.
- Drop parenthetical birth/death dates, IPA, native-script names and "not to be confused with".
- Keep every fact from the source. Invent nothing. If the source is thin, write less.
- No opening throat-clearing ("This article is about..."), no lists, no headings, no markdown.
- Past tense for events. Do not begin with the subject's name in bold.`;

/**
 * Reasons a reshaped excerpt must be thrown away and the source kept instead.
 *
 * A local 8B model fails in a small number of recognisable ways, and every one
 * of them is worse than the accurate encyclopedia text it was asked to improve:
 * it answers the prompt instead of doing it, it emits its own reasoning, or it
 * pads a thin source into invention. `<think>` in particular is qwen3's visible
 * chain of thought, which is not prose about a historical figure.
 */
const REFUSAL = /^(?:i (?:cannot|can't|am unable)|sorry|as an ai|here is|here's|certainly|okay,|sure,)/i;
const MARKUP = /^#{1,6}\s|^\s*[-*]\s|\*\*|<think>|\[\[|\{\{/;

/**
 * Judge a reshape. Returns null when it is fine, or a reason string when the
 * original should be kept.
 *
 * `srcLen` bounds growth: a model that turns 200 characters into 900 has stopped
 * summarising and started composing, and the facts in the extra 700 came from
 * nowhere the source can vouch for.
 */
export function styleReject(out, srcLen){
  const s = String(out || '').trim();
  if(s.length < 80) return 'too short';
  if(s.length > 1200) return 'too long';
  if(srcLen && s.length > srcLen * 2.2) return `grew ${Math.round(s.length / srcLen)}x over source`;
  if(REFUSAL.test(s)) return 'model addressed the prompt rather than answering it';
  if(MARKUP.test(s)) return 'contains markup or visible reasoning';
  // A fragment run is the exact failure this rewrite exists to remove, so it is
  // not acceptable as output either: four or more sentences averaging under 25
  // characters is the "Cold War end. Gulf War. Single term." shape.
  const sents = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  if(sents.length >= 4 && s.length / sents.length < 25) return 'still fragmented';
  return null;
}
