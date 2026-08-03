/*
 * One quiz over the whole corpus.
 *
 * Replaces the eight per-dataset quizzes. Those read a CSV over the GitHub API
 * and asked every row for the same fixed column list, which is why the art quiz
 * asked you to type a paragraph of Wikipedia; what a question should be is a
 * property of the ENTRY, and `questions.js` derives it there.
 *
 * The data is `datasets/atlas/atlas.json` plus `details.json` — the same two
 * files the atlas renders, loaded through the same `loadAtlas`. That is the
 * point of sharing them rather than re-reading the CSVs: "quiz me on this
 * cluster" is only a question you can ask because the atlas already computed
 * the clusters, and any rebuild of the map is a rebuild of the quiz.
 *
 * Filtering is by:
 *   - CLUSTER, picked from the same tree the atlas rail shows. Selecting a node
 *     takes every entry under it, at any depth.
 *   - free text / `ds:` / `topic:` / `1750-1800` / `has:image`, by handing the
 *     box straight to the atlas's own `runFilter`, so the query language is one
 *     language and learning it once is enough.
 */

import { loadAtlas, runFilter } from '../atlas/data.js';
import { questionsFor, gradeField } from './questions.js';
import { $, shuffle, thumbUrl, calcRMSE } from '../../utils/helpers.js';
import { render } from '../../app/render.js';

let A = null;                       // the atlas model, loaded once per session
let entries = [];                   // one plain object per point

const S = {
  node: 0,                          // selected cluster; 0 is the root, i.e. everything
  query: '',
  count: 20,
  pool: [],
  queue: [],
  current: null,
  question: null,
  submitted: false,
  answered: 0,
  fieldsAsked: 0,
  fieldsRight: 0,
  perfect: 0,
  streak: 0,
  bestStreak: 0,
  yearErrors: [],
  expanded: new Set([0]),
};

/** Every point index under `node`, itself included. */
function membersOf(node){
  const want = new Set([node]);
  // The tree is small (537 nodes) and stored parent-first, so one pass down the
  // node list closes the descendant set without recursion.
  for(const nd of A.nodes) if(want.has(nd.parent)) want.add(nd.id);
  const out = [];
  for(let i = 0; i < A.n; i++) if(want.has(A.leaf[i])) out.push(i);
  return out;
}

function rebuildPool(){
  const inNode = new Set(membersOf(S.node));
  const filter = runFilter(A, { query: S.query, topics: null, datasets: null });

  S.pool = [];
  for(const i of inNode){
    if(filter && !filter.flags[i]) continue;
    const q = questionsFor(entries[i]);
    /*
     * One question is enough, as long as something names the subject.
     *
     * This was a two-field minimum until the topic question was dropped, and that
     * combination quietly halved the corpus — 4,126 entries to 2,266. The
     * casualties were the mined timeline events, which carry a title and a date
     * and nothing else, so losing `topic` left them with a single question. But
     * "in what year did this happen", asked about a named event, is exactly the
     * question those entries exist to support. The real requirement is not two
     * questions, it is that the prompt identifies something.
     */
    if(!q.fields.length) continue;
    if(!q.prompt.title && !q.prompt.image) continue;
    S.pool.push(i);
  }
}

function startRun(){
  rebuildPool();
  const rows = [...S.pool];
  shuffle(rows);
  S.queue = S.count > 0 ? rows.slice(0, S.count) : rows;
  S.answered = 0; S.fieldsAsked = 0; S.fieldsRight = 0;
  S.perfect = 0; S.streak = 0; S.yearErrors = [];
  advance();
}

function advance(){
  const i = S.queue.shift();
  S.current = i == null ? null : entries[i];
  S.question = S.current ? questionsFor(S.current) : null;
  S.submitted = false;
  draw();
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

function submit(){
  if(S.submitted || !S.current) return;
  S.submitted = true;

  let right = 0;
  const marks = [];

  for(const f of S.question.fields){
    const input = $(`#qf-${cssId(f.key)}`);
    const typed = input ? input.value : '';
    const { ok, delta } = gradeField(f, typed, S.current);

    if(input) input.disabled = true;
    if(ok) right++;
    S.fieldsAsked++;
    if(ok) S.fieldsRight++;
    if(delta != null && Math.abs(S.current.x0) <= 3000) S.yearErrors.push(delta);

    marks.push({ f, typed, ok });
  }

  S.answered++;
  if(right === S.question.fields.length){
    S.perfect++;
    S.streak++;
    if(S.streak > S.bestStreak) S.bestStreak = S.streak;
  } else {
    S.streak = 0;
  }

  draw(marks);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A field key may hold a colon (`facet:artist`); an id must not.
const cssId = (k) => String(k).replace(/[^a-z0-9]+/gi, '-');

/** The cluster tree, as far as it has been expanded. */
function treeRows(id = 0, depth = 0, out = []){
  const nd = A.nodes[id];
  if(!nd) return out;
  const kids = nd.children || [];
  const open = S.expanded.has(id);
  const sel = S.node === id;

  out.push(`
    <div class="flex items-center gap-1" style="padding-left:${depth * 12}px">
      <button onclick="quizToggle(${id})"
        class="w-4 shrink-0 text-zinc-400 hover:text-zinc-900 ${kids.length ? '' : 'invisible'}">
        ${open ? '▾' : '▸'}
      </button>
      <button onclick="quizPick(${id})"
        class="flex-1 text-left truncate px-2 py-1 rounded-lg text-sm
               ${sel ? 'bg-black text-white' : 'hover:bg-zinc-100'}"
        title="${esc(nd.label)}">
        ${esc(depth === 0 ? 'Everything' : nd.label)}
        <span class="${sel ? 'text-zinc-300' : 'text-zinc-400'}">${nd.n}</span>
      </button>
    </div>
  `);

  if(open) for(const k of kids) treeRows(k, depth + 1, out);
  return out;
}

function draw(marks = null){
  const q = S.question;
  const e = S.current;

  const acc = S.fieldsAsked ? Math.round(100 * S.fieldsRight / S.fieldsAsked) : 0;
  const rmse = calcRMSE(S.yearErrors);

  const panel = !e
    ? finishedPanel(acc, rmse)
    : `
      <div class="bg-white p-6 rounded-3xl shadow-sm border border-zinc-200">

        ${q.prompt.image ? `
          <img src="${esc(thumbUrl(q.prompt.image, 900))}"
            class="w-full max-h-[46vh] object-contain bg-zinc-50 rounded-2xl mb-5">
        ` : ''}

        ${/* Both can show at once: an entry may have an illustrative photo AND
              still need its title given, because the photo does not identify it. */''}
        ${q.prompt.title ? `
          <div class="mb-5">
            <div class="text-xs uppercase tracking-wider text-zinc-400 mb-1">
              ${esc(q.prompt.dataset)}
            </div>
            <div class="text-3xl font-bold leading-tight">${esc(q.prompt.title)}</div>
          </div>
        ` : ''}

        ${/*
           * After grading the inputs keep what was typed and go disabled.
           *
           * `draw()` rebuilds this panel from scratch, so the first version came
           * back with four empty, still-editable boxes sitting above the marks —
           * it read as though the answers had been thrown away and the entry was
           * live again. The typed value is carried on the mark for exactly this.
           */''}
        <div class="grid md:grid-cols-2 gap-3" id="quizFields">
          ${q.fields.map((f, i) => {
            const mark = marks?.[i];
            const ring = !mark ? 'border-zinc-200'
              : mark.ok ? 'border-green-500 bg-green-50' : 'border-red-300 bg-red-50';
            return `
            <div>
              <label class="block text-sm font-medium text-zinc-500 mb-1">${esc(f.label)}</label>
              <input id="qf-${cssId(f.key)}"
                class="border ${ring} bg-white px-4 py-3 w-full rounded-2xl text-lg
                       focus:outline-none focus:ring-2 focus:ring-zinc-300 disabled:text-zinc-500"
                placeholder="${esc(f.label.toLowerCase())}"
                value="${esc(mark ? mark.typed : '')}"
                ${mark ? 'disabled' : ''}
                autocomplete="off">
            </div>`;
          }).join('')}
        </div>

        ${/* Only the answers that were missed. What was typed is in the boxes above. */''}
        ${marks ? `
          <div class="mt-5 flex items-start gap-5">
            <div class="text-2xl font-bold shrink-0">
              ${marks.filter((m) => m.ok).length}/${marks.length}
            </div>
            <div class="flex-1">
              ${marks.filter((m) => !m.ok).map((m) => `
                <div class="text-sm mb-1">
                  <span class="text-zinc-500">${esc(m.f.label)}</span>
                  <span class="font-medium ml-2">${esc(m.f.answer)}</span>
                </div>
              `).join('') || '<div class="text-sm text-green-600 font-medium">All correct.</div>'}
            </div>
          </div>
        ` : ''}

        ${/*
           * The excerpt, revealed only after grading.
           *
           * It is excluded from the questions because its first sentence usually
           * contains every answer, and because asking anyone to type 600
           * characters of encyclopedia is absurd. Neither objection applies once
           * the answers are already on screen — at that point it is the only
           * thing here that teaches you anything, so it gets shown in full and
           * with its paragraph breaks intact.
           */''}
        ${marks && S.current.excerpt ? `
          <div class="mt-4 border-l-4 border-zinc-300 pl-4 py-1">
            <div class="text-xs uppercase tracking-wider text-zinc-400 mb-2">
              ${esc(S.current.title)}${S.current.yearText ? ` · ${esc(S.current.yearText)}` : ''}
            </div>
            ${S.current.excerpt.split(/\n{2,}/).map((p) =>
              `<p class="text-zinc-600 leading-relaxed mb-2">${esc(p)}</p>`).join('')}
          </div>
        ` : ''}

        <div class="flex gap-2 mt-5">
          ${S.submitted
            ? `<button onclick="quizNext()"
                 class="ml-auto bg-black text-white px-6 py-3 rounded-2xl font-medium">
                 Next →
               </button>`
            : `<button onclick="quizSubmit()"
                 class="bg-blue-600 text-white px-6 py-3 rounded-2xl font-medium hover:bg-blue-700">
                 Submit
               </button>`}
        </div>
      </div>
    `;

  $('#app').innerHTML = `
    <div class="grid xl:grid-cols-[300px_1fr] gap-8 items-start">

      <div class="space-y-5">
        <div class="bg-white p-5 rounded-2xl shadow-sm border border-zinc-200">
          <div class="font-semibold mb-3">Cluster</div>
          <div class="max-h-[46vh] overflow-auto -mx-1 px-1">
            ${treeRows().join('')}
          </div>
        </div>

        <div class="bg-white p-5 rounded-2xl shadow-sm border border-zinc-200 space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Filter</label>
            <input id="quizQuery" value="${esc(S.query)}"
              placeholder="cubism · ds:film · 1750-1800"
              class="border border-zinc-200 rounded-xl w-full px-3 py-2">
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Questions</label>
            <select id="quizCount" class="border border-zinc-200 rounded-xl w-full px-3 py-2">
              ${[10, 20, 50, 100, 0].map((n) => `
                <option value="${n}" ${n === S.count ? 'selected' : ''}>
                  ${n === 0 ? 'All available' : n}
                </option>
              `).join('')}
            </select>
          </div>
          <div class="text-sm text-zinc-500">
            ${S.pool.length} entries can be asked about
          </div>
          <button onclick="quizStart()"
            class="w-full bg-black text-white rounded-xl px-4 py-2.5 font-medium hover:bg-zinc-800">
            Start
          </button>
        </div>
      </div>

      <div>
        <div class="flex items-center gap-4 mb-4 text-sm">
          <button onclick="quizHome()"
            class="border border-zinc-200 bg-white hover:bg-zinc-50 px-4 py-2 rounded-2xl">
            ← Home
          </button>
          <div class="ml-auto flex gap-5 bg-white px-5 py-2.5 rounded-2xl border border-zinc-200">
            <span><b>${S.answered}</b> done</span>
            <span><b>${S.queue.length}</b> left</span>
            <span><b>${acc}%</b> fields</span>
            <span>streak <b>${S.streak}</b></span>
          </div>
        </div>
        ${panel}
      </div>
    </div>
  `;

  const box = $('#quizQuery');
  if(box){
    box.oninput = () => { S.query = box.value; };
    // Re-pooling on every keystroke would re-render and take the focus out of
    // the box being typed into, so the count refreshes on blur or on Start.
    box.onchange = () => { rebuildPool(); draw(marks); };
  }
  const cnt = $('#quizCount');
  if(cnt) cnt.onchange = () => { S.count = Number(cnt.value); };

  const first = q?.fields?.length ? $(`#qf-${cssId(q.fields[0].key)}`) : null;
  if(first && !S.submitted) first.focus();
}

function finishedPanel(acc, rmse){
  if(S.answered === 0){
    return `
      <div class="bg-white p-10 rounded-3xl shadow-sm border border-zinc-200 text-center">
        <div class="text-2xl font-bold mb-2">Pick a cluster</div>
        <div class="text-zinc-500">
          ${S.pool.length} entries match. Press Start.
        </div>
      </div>`;
  }
  return `
    <div class="bg-white p-10 rounded-3xl shadow-sm border border-zinc-200 text-center">
      <div class="text-4xl font-bold mb-6">Run complete</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        ${[
          ['Entries', S.answered],
          ['Fields right', `${acc}%`],
          ['Perfect', S.perfect],
          ['Year RMSE', S.yearErrors.length ? `±${rmse.toFixed(1)}y` : '—'],
        ].map(([k, v]) => `
          <div class="border border-zinc-200 rounded-2xl p-4">
            <div class="text-sm text-zinc-500 mb-2">${k}</div>
            <div class="text-2xl font-bold">${v}</div>
          </div>
        `).join('')}
      </div>
      <button onclick="quizStart()" class="bg-black text-white px-6 py-3 rounded-2xl font-medium">
        Again
      </button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function openQuiz(){
  $('#siteHeader').innerHTML = '';

  if(!A){
    $('#app').innerHTML = `
      <div class="bg-white p-10 rounded-3xl border border-zinc-200 text-zinc-500">
        Loading the atlas…
      </div>`;
    try {
      const base = location.href.replace(/[^/]*$/, '');
      A = await loadAtlas({ base });
      // Facets and excerpts live in details.json, which `loadAtlas` starts but
      // does not await. The quiz needs the facets to know what to ask, so unlike
      // the atlas it cannot draw a first frame without them.
      await A.detailsPromise;
    } catch(err){
      $('#app').innerHTML = `
        <div class="bg-white p-8 rounded-3xl border border-zinc-200">
          <div class="font-bold mb-2">The atlas is not built.</div>
          <pre class="text-sm text-zinc-500 whitespace-pre-wrap">${esc(err.message)}</pre>
        </div>`;
      return;
    }

    entries = Array.from({ length: A.n }, (_, i) => ({
      id: A.id[i], title: A.title[i], subtitle: A.subtitle[i],
      yearText: A.yearText[i], image: A.image[i], dataset: A.dataset[i],
      topics: A.topics[i] || [], x0: A.x0[i], x1: A.x1[i],
      isSpan: Boolean(A.isSpan[i]),
      facets: A.details?.[A.id[i]]?.facets || {},
      // Never a question — see questions.js — but shown once the answers are in,
      // which is the moment it stops being a giveaway and starts being the point.
      excerpt: A.details?.[A.id[i]]?.excerpt || '',
    }));
  }

  rebuildPool();
  draw();
}

window.quizStart = startRun;
window.quizSubmit = submit;
window.quizNext = advance;
window.quizPick = (id) => { S.node = id; S.expanded.add(id); rebuildPool(); draw(); };
window.quizToggle = (id) => {
  if(S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
  draw();
};
window.quizHome = () => {
  document.onkeydown = null;
  S.current = null; S.answered = 0;
  render();
};

/*
 * Enter submits, then Enter advances. Bound on the document rather than per
 * input because the fields are rebuilt on every draw and a per-input handler
 * would have to be rebound each time.
 */
document.addEventListener('keydown', (ev) => {
  if(ev.key !== 'Enter' || !S.current) return;
  if(!$('#quizFields') && !S.submitted) return;
  ev.preventDefault();
  if(S.submitted) advance(); else submit();
});
