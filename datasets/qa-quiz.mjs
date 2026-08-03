#!/usr/bin/env node
/**
 * Headless QA for the home screen and the unified quiz.
 *
 *   node datasets/serve.mjs
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
 *     --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
 *     --window-size=1600,1000 about:blank
 *   node datasets/qa-quiz.mjs [--shot out.png] [--keep]
 *
 * Same protocol plumbing as `qa-atlas.mjs`, and the same three traps apply:
 * disable the HTTP cache or you verify a stale atlas.json, poll the DOM rather
 * than snapshot it, and check the page's own console when everything fails at
 * once — a dead static server reads exactly like a module error.
 *
 * Unlike the atlas, the quiz renders in the MAIN page rather than a popup, so
 * there is no second target to attach to.
 */

import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9334);
const ORIGIN = process.env.QA_ORIGIN || 'http://localhost:8777';
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;

const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
const listeners = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if(m.id && pending.has(m.id)){
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(`${m.error.message} ${JSON.stringify(m.error.data ?? '')}`)) : resolve(m.result);
    return;
  }
  for(const fn of listeners) fn(m);
};

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(session, expression, { awaitPromise = true, userGesture = false } = {}){
  const expr = awaitPromise
    ? `(async()=>{ try { return await (${expression}); }
        catch(e){ return {__err: String((e && e.stack) || e)}; } })()`
    : expression;
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise, userGesture, returnByValue: true,
  }, session);
  if(r.exceptionDetails){
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  const v = r.result.value;
  if(v && typeof v === 'object' && v.__err) throw new Error(`page: ${v.__err}`);
  return v;
}

async function until(session, expression, { timeout = 15000, label = expression } = {}){
  const t0 = Date.now();
  let last;
  while(Date.now() - t0 < timeout){
    last = await evaluate(session, expression);
    if(last) return { ok: true, ms: Date.now() - t0, value: last };
    await sleep(60);
  }
  return { ok: false, ms: Date.now() - t0, value: last, label };
}

async function attach(targetId){
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  return sessionId;
}

const results = [];
const fail = (n, d) => { results.push(['FAIL', n, d]); console.log(`  FAIL  ${n}\n          ${d}`); };
const ok = (n, d = '') => { results.push(['ok', n, d]); console.log(`  ok    ${n}${d ? `   ${d}` : ''}`); };
const check = (n, c, d = '') => (c ? ok(n, d) : fail(n, d || 'assertion failed'));

console.log(`\n  ${ver.Browser}  →  ${ORIGIN}\n`);

for(const t of (await send('Target.getTargets')).targetInfos){
  if(t.type === 'page') await send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const app = await attach(targetId);

// Surface page errors: without this a module that fails to import looks like
// every assertion failing for no reason.
const pageErrors = [];
listeners.push((m) => {
  if(m.sessionId !== app) return;
  if(m.method === 'Runtime.exceptionThrown'){
    pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  }
  if(m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error'){
    pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

await send('Page.navigate', { url: `${ORIGIN}/index.html` }, app);
await until(app, `!!document.querySelector('#app')`, { label: 'app root' });

// ---- home -----------------------------------------------------------------

const home = await until(app, `
  (() => {
    const b = [...document.querySelectorAll('#app button')];
    return b.length ? { n: b.length, labels: b.map(x => (x.textContent.match(/\\S.*?\\n/) || [''])[0].trim()) } : null;
  })()`, { label: 'home buttons' });

check('home renders', home.ok, JSON.stringify(home.value));
check('home has exactly two doors', home.value?.n === 2,
  `found ${home.value?.n} buttons: ${JSON.stringify(home.value?.labels)}`);

const hasBoth = await evaluate(app, `
  (() => {
    const t = document.querySelector('#app').textContent;
    return { atlas: /Atlas/.test(t), quiz: /Quiz/.test(t),
             token: /GitHub Token/.test(t), lanes: /Old lane timeline/.test(t) };
  })()`);
check('Atlas door present', hasBoth.atlas);
check('Quiz door present', hasBoth.quiz);
check('GitHub token panel gone', !hasBoth.token);
check('old lane timeline button gone', !hasBoth.lanes);

// ---- open the quiz --------------------------------------------------------

await evaluate(app, `window.openQuiz()`, { awaitPromise: false, userGesture: true });

const loaded = await until(app, `
  (() => {
    const t = document.querySelector('#app').textContent || '';
    return /entries can be asked about/.test(t) ? t.match(/(\\d+) entries can be asked about/)[1] : null;
  })()`, { timeout: 25000, label: 'quiz loaded' });

check('quiz loads the atlas', loaded.ok, `${loaded.value} askable entries in ${loaded.ms}ms`);
if(!loaded.ok){
  console.log('\n  page errors:\n' + (pageErrors.join('\n') || '  (none)'));
  process.exit(1);
}
check('a useful number of entries are askable', Number(loaded.value) > 1000, `${loaded.value}`);

// ---- cluster tree ---------------------------------------------------------

const tree = await evaluate(app, `
  (() => {
    const rows = [...document.querySelectorAll('[onclick^="quizPick"]')];
    return { n: rows.length, first: rows[0]?.textContent.trim().replace(/\\s+/g,' ') };
  })()`);
check('cluster tree renders', tree.n >= 2, `${tree.n} rows, root "${tree.first}"`);

// Expand the root and pick its first child, then confirm the pool actually
// narrowed — a picker that renders but does not filter is the failure to catch.
const narrowed = await evaluate(app, `
  (async () => {
    const before = Number(document.querySelector('#app').textContent.match(/(\\d+) entries can be asked about/)[1]);
    const kids = [...document.querySelectorAll('[onclick^="quizPick"]')];
    const child = kids[1];
    const id = Number(child.getAttribute('onclick').match(/\\d+/)[0]);
    child.click();
    await new Promise(r => setTimeout(r, 200));
    const after = Number(document.querySelector('#app').textContent.match(/(\\d+) entries can be asked about/)[1]);
    return { before, after, id };
  })()`);
check('picking a cluster narrows the pool', narrowed.after < narrowed.before && narrowed.after > 0,
  `${narrowed.before} -> ${narrowed.after} on node ${narrowed.id}`);

// The text filter shares the atlas's query language, so `ds:` must work here too.
const filtered = await evaluate(app, `
  (async () => {
    const pool = () => Number(document.querySelector('#app').textContent.match(/(\\d+) entries can be asked about/)[1]);
    window.quizPick(0);
    await new Promise(r => setTimeout(r, 150));
    const all = pool();
    const box = document.querySelector('#quizQuery');
    box.value = 'ds:film';
    box.dispatchEvent(new Event('input'));
    box.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const film = pool();
    document.querySelector('#quizQuery').value = '';
    document.querySelector('#quizQuery').dispatchEvent(new Event('input'));
    document.querySelector('#quizQuery').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return { all, film, restored: pool() };
  })()`);
check('the text filter narrows the pool', filtered.film > 0 && filtered.film < filtered.all,
  `ds:film -> ${filtered.film} of ${filtered.all}`);
check('clearing the filter restores it', filtered.restored === filtered.all,
  `${filtered.restored} vs ${filtered.all}`);

// Back to everything, so the run below draws from the whole corpus.
await evaluate(app, `window.quizPick(0)`, { awaitPromise: false });
await sleep(200);

// ---- a question -----------------------------------------------------------

await evaluate(app, `window.quizStart()`, { awaitPromise: false });
const q = await until(app, `
  (() => {
    const f = [...document.querySelectorAll('#quizFields input')];
    if(!f.length) return null;
    return {
      fields: f.map(x => x.id),
      labels: [...document.querySelectorAll('#quizFields label')].map(x => x.textContent.trim()),
      hasImage: !!document.querySelector('#app img'),
      text: (document.querySelector('#app').textContent || '').slice(0, 400),
    };
  })()`, { label: 'a question appears' });

check('a question renders', q.ok, JSON.stringify(q.value?.labels));
check('the question asks something', (q.value?.fields?.length || 0) >= 1,
  JSON.stringify(q.value?.fields));
check('no excerpt field is ever asked',
  !(q.value?.fields || []).some((id) => /excerpt/i.test(id)),
  JSON.stringify(q.value?.fields));

/*
 * The rule that the old quiz broke, asserted over a real sample rather than one
 * entry: an entry with no picture must not be asked its own title, because the
 * title is the only thing on screen identifying it.
 */
const titleRule = await evaluate(app, `
  (async () => {
    // Over the WHOLE corpus, not the 20-question default run. The first version
    // of this check sampled 19 entries and reported "0 of 19", which proves
    // almost nothing about a rule that has to hold for 4,126.
    document.querySelector('#quizCount').value = '0';
    document.querySelector('#quizCount').dispatchEvent(new Event('change'));
    window.quizStart();
    await new Promise(r => setTimeout(r, 300));
    let checked = 0, bad = 0, excerpt = 0, tooFew = 0;
    for(let k = 0; k < 4200; k++){
      window.quizNext();
      const fields = [...document.querySelectorAll('#quizFields input')].map(x => x.id);
      if(!fields.length) break;
      // Asking the title is only fair when the image IS the work, which the UI
      // signals by showing no title block. A stock photograph of a village leaves
      // the title on screen, and must not also be asking for it.
      const titleShown = !!document.querySelector('#app .text-3xl');
      checked++;
      if(titleShown && fields.includes('qf-title')) bad++;
      if(fields.some(f => /excerpt/i.test(f))) excerpt++;
      if(fields.includes('qf-topic')) topic++;
      // Every entry must ask something AND show something to ask it about.
      const identified = !!document.querySelector('#app .text-3xl') || !!document.querySelector('#app img');
      if(!fields.length || !identified) tooFew++;
    }
    return { checked, bad, excerpt, topic, tooFew };
  })()`.replace('let checked = 0,', 'let topic = 0, checked = 0,'));
check('the sample really covers the corpus', titleRule.checked > 1000, `${titleRule.checked} entries walked`);
check('title is only asked when the image is the work', titleRule.bad === 0,
  `${titleRule.bad} of ${titleRule.checked} entries had the title both shown and asked`);
check('no excerpt asked across the sample', titleRule.excerpt === 0,
  `${titleRule.excerpt} of ${titleRule.checked}`);
check('the topic question is gone', titleRule.topic === 0,
  `${titleRule.topic} of ${titleRule.checked} still asked a topic`);
check('every entry asks something and identifies itself', titleRule.tooFew === 0,
  `${titleRule.tooFew} of ${titleRule.checked}`);

// ---- grading --------------------------------------------------------------

const graded = await evaluate(app, `
  (async () => {
    window.quizStart();
    await new Promise(r => setTimeout(r, 150));
    // Answer every field correctly by reading the answers the module holds, so
    // this tests the GRADER rather than the tester's knowledge of art history.
    const inputs = [...document.querySelectorAll('#quizFields input')];
    if(!inputs.length) return { skip: true };
    const before = document.querySelector('#app').textContent;
    inputs.forEach(i => { i.value = 'zzzz-definitely-wrong'; });
    window.quizSubmit();
    await new Promise(r => setTimeout(r, 150));
    const after = document.querySelector('#app').textContent;
    const n = inputs.length;
    return {
      // The score reads "0/4", and every box must have gone disabled and kept
      // what was typed rather than re-rendering empty.
      showedResult: new RegExp('\\\\b0/' + n + '\\\\b').test(after),
      allWrong: new RegExp('\\\\b0/' + n + '\\\\b').test(after),
      kept: [...document.querySelectorAll('#quizFields input')]
        .every(i => i.disabled && i.value === 'zzzz-definitely-wrong'),
      hasNext: !!document.querySelector('[onclick^="quizNext"]'),
      n, after: after.replace(/\\s+/g,' ').slice(0,120),
    };
  })()`);
/*
 * The excerpt must be absent before grading and present after it.
 *
 * Both halves matter: showing it early hands over every answer in the first
 * sentence, and never showing it wastes the only prose in the entry. Driven over
 * several entries because not every entry has one.
 */
const reveal = await evaluate(app, `
  (async () => {
    window.quizStart();
    await new Promise(r => setTimeout(r, 200));
    let tried = 0, leaked = 0, revealed = 0;
    const seen = () => !!document.querySelector('#app .border-l-4');
    for(let k = 0; k < 40; k++){
      if(!document.querySelector('#quizFields input')) break;
      tried++;
      if(seen()) leaked++;
      window.quizSubmit();
      await new Promise(r => setTimeout(r, 80));
      if(seen()) revealed++;
      window.quizNext();
      await new Promise(r => setTimeout(r, 40));
    }
    return { tried, leaked, revealed };
  })()`);
check('the excerpt is hidden before grading', reveal.leaked === 0,
  `${reveal.leaked} of ${reveal.tried} entries showed it early`);
check('the excerpt is revealed after grading', reveal.revealed > reveal.tried * 0.6,
  `${reveal.revealed} of ${reveal.tried} entries revealed one`);

check('submitting shows a result', graded.showedResult === true, JSON.stringify(graded).slice(0, 200));
check('wrong answers score zero', graded.allWrong === true, JSON.stringify(graded).slice(0, 200));
check('answers stay in their boxes, disabled', graded.kept === true,
  'they used to re-render empty and editable');
check('a Next button appears after submit', graded.hasNext === true);

/*
 * The grader, exercised directly.
 *
 * "Wrong answers score zero" passes just as happily if the grader rejects
 * EVERYTHING, so the positive cases have to be asserted too — and they cannot be
 * driven through the UI, because reading the right answer off the screen consumes
 * the entry that would be used to test it. Importing the module in the page tests
 * the real function with no such circularity.
 */
const grader = await evaluate(app, `
  (async () => {
    const m = await import('/project/features/quiz/questions.js');
    const e = { x0: 1897, x1: 1897, isSpan: false };
    const F = (k, answer, any) => ({ key: k, label: k, answer, any });
    const g = (f, v, ent) => m.gradeField(f, v, ent || e).ok;
    return {
      exact:      g(F('facet:artist', 'Edgar Degas'), 'Edgar Degas'),
      surname:    g(F('facet:artist', 'pierre-auguste renoir'), 'renoir'),
      reordered:  g(F('facet:artist', 'Edgar Degas'), 'degas edgar'),
      accents:    g(F('facet:artist', 'Józef Chełmoński'), 'Jozef Chelmonski'),
      alternates: g(F('facet:movement', 'rococo / neoclassicism'), 'neoclassicism'),
      // The bug in the old grader: 'a'.length === 1 and every answer contains an
      // 'a', so a single letter scored on almost everything.
      singleChar: g(F('facet:artist', 'Edgar Degas'), 'a'),
      shortSub:   g(F('facet:country', 'France'), 'ran'),
      wrong:      g(F('facet:artist', 'Edgar Degas'), 'Claude Monet'),
      empty:      g(F('facet:artist', 'Edgar Degas'), '   '),
      yearExact:  g(F('year'), '1897'),
      yearNear:   g(F('year'), '1899'),
      yearFar:    g(F('year'), '1850'),
      yearBC:     g(F('year'), '44 BC', { x0: -44, x1: -44, isSpan: false }),
      deepTime:   g(F('year'), '4500000000', { x0: -4570000000, x1: -4570000000, isSpan: false }),
      spanOk:     g(F('span'), '1837-1901', { x0: 1837, x1: 1901, isSpan: true }),
      spanBad:    g(F('span'), '1837-1850', { x0: 1837, x1: 1901, isSpan: true }),
    };
  })()`);

check('exact answer grades correct', grader.exact === true);
check('a surname alone grades correct', grader.surname === true, 'renoir <- pierre-auguste renoir');
check('word order does not matter', grader.reordered === true);
check('accents do not matter', grader.accents === true, 'Jozef Chelmonski <- Józef Chełmoński');
check('either alternative grades correct', grader.alternates === true, 'rococo / neoclassicism');
check('a single letter is NOT correct', grader.singleChar === false, 'the old grader accepted this');
check('a substring that is not a word is NOT correct', grader.shortSub === false, '"ran" vs France');
check('a wrong name is not correct', grader.wrong === false);
check('an empty answer is not correct', grader.empty === false);
check('exact year grades correct', grader.yearExact === true);
check('a year within tolerance grades correct', grader.yearNear === true, '1899 vs 1897');
check('a year far out does not', grader.yearFar === false, '1850 vs 1897');
check('BC years are read as negative', grader.yearBC === true, '"44 BC" vs -44');
check('deep time uses a relative tolerance', grader.deepTime === true, '4.5e9 vs 4.57e9');
check('both ends of a span must be right', grader.spanOk === true && grader.spanBad === false);

// ---- back home ------------------------------------------------------------

await evaluate(app, `window.quizHome()`, { awaitPromise: false });
const back = await until(app, `
  document.querySelectorAll('#app button').length === 2 ? 'yes' : null`,
  { label: 'home again' });
check('Home returns to the two doors', back.ok, String(back.value));

if(SHOT){
  await evaluate(app, `window.openQuiz()`, { awaitPromise: false, userGesture: true });
  await until(app, `/entries can be asked about/.test(document.querySelector('#app').textContent)`);
  await evaluate(app, `window.quizStart()`, { awaitPromise: false });
  await sleep(600);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, app);
  fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
  console.log(`\n  wrote ${SHOT}`);
}

const bad = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n  ${results.length - bad}/${results.length} checks pass`);
if(pageErrors.length){
  console.log(`\n  page console errors (${pageErrors.length}):`);
  for(const e of pageErrors.slice(0, 6)) console.log(`    ${String(e).split('\n')[0]}`);
}
if(!process.argv.includes('--keep')) await send('Target.closeTarget', { targetId }).catch(() => {});
process.exit(bad ? 1 : 0);
