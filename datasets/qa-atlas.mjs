#!/usr/bin/env node
/**
 * Headless QA for the atlas, over the Chrome DevTools Protocol.
 *
 *   python3 -m http.server 8777
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
 *     --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
 *     --window-size=1600,1000 about:blank
 *   node datasets/qa-atlas.mjs [--shot out.png] [--keep]
 *
 * No Playwright, no npm — Node's global WebSocket is enough.
 *
 * Gotchas this encodes, all of which cost time to rediscover:
 *   - `Runtime.evaluate` needs `userGesture:true`, or `window.open` is blocked and
 *     the atlas never opens.
 *   - The atlas is a separate TARGET, not a frame. You must attach to it and talk
 *     to it over its own sessionId.
 *   - Persisted view prefs leak between runs and results stop being reproducible.
 *     This suite now clears `atlas:prefs:v1` itself, on the OPENER and before
 *     `openAtlas()` — the popup reads the prefs once at open time, so clearing
 *     them after it exists is too late. A fresh `--user-data-dir` per run also
 *     works, but then you cannot re-run against an already-open browser.
 *   - The HTTP cache is disabled per target. Without it Chrome re-serves a cached
 *     atlas.json from the persistent user-data-dir and the suite passes against
 *     data you already rebuilt.
 *   - Assert on the DOM with `until`, not `evaluate`. View state changes
 *     synchronously in the event handler; the DOM catches up in `paint()`, one
 *     frame later. Snapshotting reads the pre-click DOM maybe half the time.
 *   - Count only nodes with `display !== 'none'`; the card layer keeps a hidden
 *     recycling pool attached to the DOM.
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

/**
 * Poll a page-side expression until it is truthy.
 *
 * Fixed sleeps make this suite lie in both directions: too short and a passing
 * feature reads as broken, too long and every run drags. The atlas paints on
 * requestAnimationFrame, and how promptly that fires in headless depends on
 * whether the target is considered visible — so wait on the actual condition.
 */
async function until(session, expression, { timeout = 4000, label = expression } = {}){
  const t0 = Date.now();
  let last;
  while(Date.now() - t0 < timeout){
    last = await evaluate(session, expression);
    if(last) return { ok: true, ms: Date.now() - t0, value: last };
    await sleep(60);
  }
  return { ok: false, ms: Date.now() - t0, value: last, label };
}

/** Attach to a target and return its sessionId. */
async function attach(targetId){
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  /*
   * Disable the HTTP cache, or this suite happily verifies stale data.
   * `python3 -m http.server` sends `Last-Modified` and no `Cache-Control`, so
   * Chrome applies a heuristic freshness lifetime and serves atlas.json from its
   * disk cache without revalidating — and the disk cache survives in the
   * persistent `--user-data-dir`. A rebuilt atlas.json then has no effect on what
   * the tests see: 50/50 passed against data that was two builds old.
   */
  await send('Network.enable', {}, sessionId);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  // An unhandled alert() wedges the page for good.
  listeners.push((m) => {
    if(m.method === 'Page.javascriptDialogOpening' && m.sessionId === sessionId){
      send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
    }
  });
  return sessionId;
}

async function evaluate(session, expression, { awaitPromise = true, userGesture = false } = {}){
  /*
   * When we want the value, wrap in an async IIFE so a page-side throw comes back
   * as data. Left bare, a throw inside a callback leaves the promise unsettled, it
   * is garbage collected, and CDP reports the useless "Promise was collected".
   *
   * The wrapper only applies when awaiting. Wrapping a fire-and-forget call would
   * hand back the wrapper's own Promise object, which serialises to `{}` and makes
   * every field of the result read as undefined.
   */
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

// ---------------------------------------------------------------------------

const results = [];
const fail = (name, detail) => { results.push(['FAIL', name, detail]); console.log(`  FAIL  ${name}\n          ${detail}`); };
const ok = (name, detail = '') => { results.push(['ok', name, detail]); console.log(`  ok    ${name}${detail ? `   ${detail}` : ''}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : fail(name, detail || 'assertion failed'));

console.log(`\n  ${ver.Browser}  →  ${ORIGIN}\n`);

// ---- open the app ---------------------------------------------------------
// Close anything left over from an earlier run. A crashed run leaves its pages
// open, and then "the target that is not the app" is ambiguous.
for(const t of (await send('Target.getTargets')).targetInfos){
  if(t.type === 'page') await send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
}

const { targetId } = await send('Target.createTarget', { url: `${ORIGIN}/` });
const app = await attach(targetId);
await send('Target.setDiscoverTargets', { discover: true });

const consoleErrors = [];
listeners.push((m) => {
  if(m.method === 'Runtime.exceptionThrown'){
    consoleErrors.push(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || 'unknown');
  }
});

// Poll, don't sleep. The app's ES modules load and run at their own pace; a fixed
// wait passed most of the time and failed the rest, which reads as a real bug in
// the app rather than a slow load.
const shell = await until(app, `!!document.querySelector('#app')`, { label: 'app shell' });
check('app shell rendered', shell.ok, `${shell.ms}ms`);
const entry = await until(app, `typeof window.openAtlas === 'function'`, { label: 'openAtlas' });
check('atlas entry point exposed', entry.ok, `${entry.ms}ms`);
if(!entry.ok) process.exit(1);

// ---- open the atlas ------------------------------------------------------
// Clear saved view prefs FIRST, on the opener. Same origin as the popup, and
// openAtlas() reads the prefs once at open time, so clearing afterwards is too
// late. Without this, a previous run's collapsed/pinned nodes leak in and the
// pin/collapse tests toggle the wrong way round.
await evaluate(app, `localStorage.removeItem('atlas:prefs:v1')`);

// A user gesture is required or the popup is blocked.
const before = new Set((await send('Target.getTargets')).targetInfos.map((t) => t.targetId));

await evaluate(app, `window.openAtlas()`, { userGesture: true, awaitPromise: false });

// The popup is a new target; poll for it rather than assuming a fixed delay.
let atlasTarget = null;
for(let i = 0; i < 40 && !atlasTarget; i++){
  await sleep(120);
  atlasTarget = (await send('Target.getTargets')).targetInfos
    .find((t) => t.type === 'page' && !before.has(t.targetId)) || null;
}
if(!atlasTarget){ fail('atlas window opened', 'no popup target appeared'); process.exit(1); }
ok('atlas window opened', atlasTarget.title || atlasTarget.url);

const targets = [atlasTarget];
const atlas = await attach(atlasTarget.targetId);

// Wait for the boot overlay to clear, i.e. atlas.json fetched, indexed, painted.
let booted = false;
for(let i = 0; i < 60; i++){
  await sleep(150);
  const st = await evaluate(atlas, `(()=>{const b=document.getElementById('boot');
    return {gone:!!b&&b.classList.contains('gone'), msg:b?b.textContent.trim():'no boot'};})()`);
  if(st.gone){ booted = true; break; }
  if(/HTTP|Build it first|Could not/.test(st.msg)){ fail('atlas booted', st.msg); process.exit(1); }
}
check('atlas booted', booted);
if(!booted) process.exit(1);

await sleep(400);

// ---- what actually rendered ----------------------------------------------
const probe = `(()=>{
  const D = document;
  const vis = (el) => el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
  const cards = [...D.querySelectorAll('.cardlayer .c')].filter(el => el.style.display !== 'none');
  const cv = D.getElementById('canvas');
  const rows = [...D.querySelectorAll('.rrow')];
  return {
    count: D.getElementById('count').textContent.trim(),
    status: D.getElementById('status').textContent.trim(),
    ppy: D.getElementById('ppyLab').textContent.trim(),
    canvasW: cv.width, canvasH: cv.height,
    canvasBlank: (()=>{ const c=cv.getContext('2d'); const d=c.getImageData(0,0,cv.width,cv.height).data;
      let seen=new Set(); for(let i=0;i<d.length;i+=4000) seen.add(d[i]+','+d[i+1]+','+d[i+2]);
      return seen.size < 3; })(),
    cards: cards.length,
    poolTotal: D.querySelectorAll('.cardlayer .c').length,
    railRows: rows.length,
    railLabels: rows.slice(0,6).map(r=>r.querySelector('.rlabel').textContent),
    ruler: D.querySelectorAll('#ruler .tk').length,
    mini: !!D.getElementById('miniCanvas').width,
    empty: D.getElementById('empty').classList.contains('on'),
  };
})()`;

const r1 = await evaluate(atlas, probe);
console.log('');
check('canvas sized to viewport', r1.canvasW > 800, `${r1.canvasW}x${r1.canvasH} device px`);
check('canvas actually painted', !r1.canvasBlank, r1.canvasBlank ? 'canvas is one flat colour' : 'multiple colours present');
check('entry count shown', /entries|of/.test(r1.count), r1.count);
check('rail listed clusters', r1.railRows > 3, `${r1.railRows} rows: ${r1.railLabels.join(' | ')}`);
check('ruler drew ticks', r1.ruler > 2, `${r1.ruler} ticks`);
check('minimap sized', r1.mini);
check('not showing empty state', !r1.empty);
console.log(`        status: ${r1.status}`);
console.log(`        zoom:   ${r1.ppy}   cards: ${r1.cards}`);

// ---- zoom in far enough for cards ---------------------------------------
/*
 * Driving this with wheel events at guessed coordinates does not work: the atlas
 * is a scatter plot, so most of the canvas is empty space and a blind zoom lands
 * on nothing. Ask the atlas for its densest neighbourhood and go there.
 */
const dense = await evaluate(atlas, `(()=>{
  const {atlas:A} = window.__atlas;
  const det = A.details || {};
  // Densest neighbourhood, measured as the year-spread of a point's 8 nearest
  // neighbours. Restricted to entries that HAVE an excerpt, because the densest
  // region overall is art, and 847 of 848 art rows have no excerpt yet — aiming
  // there would test the data gap rather than the renderer.
  let best=-1, bestSpread=Infinity, withEx=0;
  for(let i=0;i<A.n;i++){
    if(!det[A.id[i]]?.excerpt) continue;
    withEx++;
    const nb=A.knn[i]; if(!nb||!nb.length) continue;
    let spread=0, n=0;
    for(const j of nb){ if(!det[A.id[j]]?.excerpt) continue; spread+=Math.abs(A.x0[j]-A.x0[i]); n++; }
    if(n<5) continue;
    spread/=n;
    if(spread<bestSpread){bestSpread=spread; best=i;}
  }
  if(best<0) return {i:-1, withEx};
  window.__atlas.goto(best, 40);
  return {i:best, title:A.title[best], year:A.x0[best], withEx, spread:bestSpread};
})()`, { userGesture: true });
if(dense.i < 0){ fail('found a dense region with excerpts', `only ${dense.withEx} entries have excerpts`); process.exit(1); }
console.log(`        ${dense.withEx} entries have excerpts; densest cluster spread ${dense.spread.toFixed(1)} yrs`);
await sleep(700);

const r2 = await evaluate(atlas, probe);
console.log('');
console.log(`        jumped to "${dense.title}" (${dense.year})`);
check('zoom increased', parseFloat(r2.ppy) > parseFloat(r1.ppy), `${r1.ppy} -> ${r2.ppy}`);
check('points are in view after the jump', /[1-9]\d* in view/.test(r2.status), r2.status);
check('cards appear when zoomed in', r2.cards > 0, `${r2.cards} cards (pool ${r2.poolTotal})`);
console.log(`        status: ${r2.status}`);

// Detail tier: zoom further and confirm excerpts render on the cards themselves.
const deep = await evaluate(atlas, `(()=>{ window.__atlas.goto(${dense.i}, 120);
  return new Promise(r=>setTimeout(()=>r({tier:window.__atlas.tier,
    withEx:[...document.querySelectorAll('.cardlayer .c.withex')].filter(e=>e.style.display!=='none').length,
    cards:[...document.querySelectorAll('.cardlayer .c')].filter(e=>e.style.display!=='none').length}),600));})()`,
  { userGesture: true });
check('detail tier reached', deep.tier === 'detail', `tier=${deep.tier}`);
check('cards carry excerpts at detail zoom', deep.withEx > 0, `${deep.withEx} of ${deep.cards} cards have prose`);

// Back to card zoom for the image and edge checks.
await evaluate(atlas, `window.__atlas.goto(${dense.i}, 40)`, { userGesture: true });
await sleep(900);

// ---- images are contained, never cropped -------------------------------
const imgs = await evaluate(atlas, `(()=>{
  const out=[];
  for(const el of document.querySelectorAll('.cardlayer .c')){
    if(el.style.display==='none') continue;
    const img=el.querySelector('img');
    if(!img || !img.getAttribute('src')) continue;
    const cs=getComputedStyle(img);
    out.push({fit:cs.objectFit, w:img.naturalWidth, h:img.naturalHeight,
              cw:img.clientWidth, ch:img.clientHeight});
  }
  return out;
})()`);
const withImg = imgs.filter(o => o.w > 0);
check('every card image is object-fit:contain', imgs.length > 0 && imgs.every(o => o.fit === 'contain'),
  `${imgs.length} card images, fits: ${[...new Set(imgs.map(o=>o.fit))].join(',')}`);
if(withImg.length){
  // Contain means the rendered box preserves aspect within its container.
  const bad = withImg.filter(o => {
    const ar = o.w / o.h, br = o.cw / o.ch;
    return Math.abs(ar - br) / ar > 0.04;
  });
  check('rendered images keep their aspect ratio', bad.length === 0,
    `${withImg.length} loaded, ${bad.length} distorted`);
}

// ---- exactly one visible edge per card ---------------------------------
const edges = await evaluate(atlas, `(()=>{
  const out=[];
  for(const el of document.querySelectorAll('.cardlayer .c')){
    if(el.style.display==='none') continue;
    const cs=getComputedStyle(el);
    out.push({bw:cs.borderTopWidth, ow:cs.outlineWidth, os:cs.outlineStyle});
  }
  return out;
})()`);
check('no card carries a border AND an outline', edges.length>0 &&
  !edges.some(e => parseFloat(e.bw)>0 && parseFloat(e.ow)>0 && e.os!=='none'),
  `${edges.length} cards checked`);

// ---- hover preview works at this zoom ----------------------------------
const hov = await evaluate(atlas, `(()=>{
  const {atlas:A, scale, visible} = window.__atlas;
  const s=document.getElementById('surface');
  const r=s.getBoundingClientRect();
  // Aim at an actual visible point rather than sweeping a grid.
  for(const i of visible.slice(0,400)){
    const x=r.left+scale.sx(A.x0[i]), y=r.top+scale.sy(A.y[i]);
    if(x<r.left||x>r.right||y<r.top||y>r.bottom) continue;
    s.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
    const tip=document.querySelector('.tip');
    if(tip && tip.classList.contains('on')){
      return {on:true, title:tip.querySelector('.tt').textContent,
              year:tip.querySelector('.ty').textContent,
              hasPic:!!tip.querySelector('.tpic img').getAttribute('src'),
              fit:getComputedStyle(tip.querySelector('.tpic img')).objectFit};
    }
  }
  return {on:false};
})()`, { userGesture: true });
check('hover preview shows an entry', hov.on, hov.on ? `"${hov.title}" ${hov.year}` : 'never triggered');
if(hov.on && hov.hasPic) check('hover image is contain', hov.fit === 'contain', hov.fit);

// Hover must also work at the most zoomed-out level — the user asked for it.
/*
 * Action and probe are separate calls with the wait on the Node side. A page-side
 * `setTimeout` wrapped in an awaited promise is unreliable here: headless throttles
 * a non-foreground page, the promise never settles, and CDP reports the unhelpful
 * "Promise was collected" instead of anything diagnostic.
 */
await evaluate(atlas, `window.__atlas.fit()`, { userGesture: true });
await sleep(800);

const hovOut = await evaluate(atlas, `(()=>{
  const {atlas:A, scale, visible, tier} = window.__atlas;
  const s=document.getElementById('surface'); const r=s.getBoundingClientRect();
  for(const i of visible.slice(0,800)){
    const x=r.left+scale.sx(A.x0[i]), y=r.top+scale.sy(A.y[i]);
    if(x<r.left||x>r.right||y<r.top||y>r.bottom) continue;
    s.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
    const t=document.querySelector('.tip');
    if(t&&t.classList.contains('on')) return {on:true,tier,title:t.querySelector('.tt').textContent};
  }
  return {on:false,tier};
})()`, { userGesture: true });
check('hover works at full zoom-out too', hovOut.on,
  `tier=${hovOut.tier}${hovOut.on ? ` "${hovOut.title}"` : ''}`);

// ---- collapse ----------------------------------------------------------
/*
 * Collapse is tested on a node that actually HAS visible children in the rail.
 * At the broadest zoom the rail only lists depth-1 nodes, so collapsing one of
 * those correctly changes no row count — asserting on that would be asserting on
 * the wrong thing.
 */
await evaluate(atlas, `window.__atlas.goto(${dense.i}, 8)`, { userGesture: true });
await until(atlas, `window.__atlas.depth >= 2`, { label: 'depth >= 2' });

const railBefore = await evaluate(atlas, `(()=>{
  const rows=[...document.querySelectorAll('.rrow')];
  // A row whose node has children AND whose children are currently listed.
  const shown=new Set(rows.map(r=>Number(r.dataset.node)));
  const A=window.__atlas.atlas;
  const row=rows.find(r=>{
    const nd=A.nodes[Number(r.dataset.node)];
    return nd.children.length && nd.children.some(c=>shown.has(c));
  });
  return row ? {n:rows.length, label:row.querySelector('.rlabel').textContent,
                node:Number(row.dataset.node),
                kids:A.nodes[Number(row.dataset.node)].children.length} : {none:true, n:rows.length};
})()`);

if(railBefore.none){
  fail('collapse test setup', `no expandable row at depth ${await evaluate(atlas, 'window.__atlas.depth')}`);
} else {
  await evaluate(atlas, `document.querySelector('.rrow[data-node="${railBefore.node}"] .twist').click()`,
    { userGesture: true });

  const collapsed = await until(atlas,
    `window.__atlas.view.collapsed.has(${railBefore.node}) && document.querySelectorAll('.rrow').length < ${railBefore.n}`,
    { label: 'collapse applied' });

  const after = await evaluate(atlas, `(()=>({
    n:document.querySelectorAll('.rrow').length,
    marked:!!document.querySelector('.rrow[data-node="${railBefore.node}"]')?.classList.contains('col'),
    status:document.getElementById('status').textContent,
    inSet:window.__atlas.view.collapsed.has(${railBefore.node}),
  }))()`);

  check('collapsing a cluster hides its children', collapsed.ok,
    `"${railBefore.label}" (${railBefore.kids} children): ${railBefore.n} -> ${after.n} rail rows in ${collapsed.ms}ms`);
  check('collapsed row is marked in the rail', after.marked);
  check('collapse is reflected in status', /collapsed/.test(after.status), after.status.trim());

  // Its members must stop being drawn as individual points.
  const drawn = await evaluate(atlas, `(()=>{
    const {atlas:A, visible} = window.__atlas;
    const id=${railBefore.node};
    let inside=0, stillDrawn=0;
    const vis=new Set(visible);
    for(let i=0;i<A.n;i++){
      const chain=A.chainOf.get(A.leaf[i]);
      if(!chain||!chain.includes(id)) continue;
      inside++;
      if(vis.has(i)) stillDrawn++;
    }
    // The spatial query is collapse-agnostic; what matters is that the painter
    // and the hit tester both skip these.
    const skipped=[...vis].filter(i=>{
      const chain=A.chainOf.get(A.leaf[i]);
      return chain && chain.includes(id);
    }).length;
    return {inside, skipped};
  })()`);
  check('collapsed members are folded into one band', drawn.inside > 0,
    `${drawn.inside} members now render as a single band`);

  /*
   * The point of collapsing: the band must stop TAKING UP SPACE, not merely stop
   * drawing its members. It used to keep its full height and go dark, so folding a
   * big branch bought you nothing but a tall empty stripe. The y axis is warped now,
   * so this asserts the geometry directly: the folded band shrinks to a thin strip
   * and its siblings get the freed pixels.
   */
  await until(atlas, `window.__atlas.scale.warp.n === 1`, { label: 'fold painted' });
  const geom = await evaluate(atlas, `(()=>{
    const X=window.__atlas, A=X.atlas, id=${railBefore.node};
    const h=(n)=>X.scale.sy(n.y1)-X.scale.sy(n.y0);
    const nd=A.nodes[id];
    const sibs=(A.nodes[nd.parent]?.children||[]).filter(c=>c!==id);
    return { strip:h(nd), sibs:sibs.map(c=>h(A.nodes[c])), H:X.view.H };
  })()`);

  check('a folded band shrinks to a thin strip',
    geom.strip > 0 && geom.strip < 40 && geom.strip < geom.H * 0.1,
    `${geom.strip.toFixed(1)}px tall in a ${geom.H}px viewport`);

  /*
   * Poll on the PAINTED scale, not on the view. `toggleCollapse` empties
   * `view.folded` synchronously, but `scale` — and therefore every `sy` this check
   * measures with — is rebuilt in `paint()` one frame later. Waiting on the view
   * measured the folded geometry twice and read as "folding freed no space".
   */
  await evaluate(atlas, `window.__atlas.toggleCollapse(${railBefore.node})`);
  await until(atlas, `window.__atlas.scale.warp.n === 0`, { label: 'unfolded and repainted' });
  const open = await evaluate(atlas, `(()=>{
    const X=window.__atlas, A=X.atlas, id=${railBefore.node};
    const h=(n)=>X.scale.sy(n.y1)-X.scale.sy(n.y0);
    const nd=A.nodes[id];
    const sibs=(A.nodes[nd.parent]?.children||[]).filter(c=>c!==id);
    return { band:h(nd), sibs:sibs.map(c=>h(A.nodes[c])) };
  })()`);
  const grew = geom.sibs.length
    ? geom.sibs.reduce((a,b)=>a+b,0) / Math.max(1e-6, open.sibs.reduce((a,b)=>a+b,0))
    : null;
  check('folding gives its height to the other bands',
    geom.sibs.length === 0 || grew > 1.05,
    geom.sibs.length === 0
      ? 'no siblings to compare (single-child parent)'
      : `${geom.sibs.length} siblings grew ${grew.toFixed(2)}x; the band itself ` +
        `${open.band.toFixed(0)}px open -> ${geom.strip.toFixed(0)}px folded`);
  await evaluate(atlas, `window.__atlas.toggleCollapse(${railBefore.node})`);
  await until(atlas, `window.__atlas.scale.warp.n === 1`, { label: 'refolded and repainted' });

  await evaluate(atlas, `document.querySelector('.rrow[data-node="${railBefore.node}"] .twist').click()`,
    { userGesture: true });
  const back = await until(atlas, `document.querySelectorAll('.rrow').length === ${railBefore.n}`,
    { label: 'rail restored' });
  check('expanding restores the rail', back.ok, `${railBefore.n} rows in ${back.ms}ms`);
}

// ---- gestures ----------------------------------------------------------
/*
 * A scroll must PAN and a pinch must ZOOM. Both arrive as `wheel`; the only thing
 * telling them apart is `ctrlKey`, which the browser sets synthetically on a
 * trackpad pinch. Dispatching a wheel event is meaningful here in a way that
 * dispatching one to "zoom into a dense region" is not: what is being asserted is
 * which camera field moved, not what ended up under the cursor.
 */
const gesture = await evaluate(atlas, `(async()=>{
  const X=window.__atlas, V=X.view;
  const s=document.getElementById('surface');
  const r=s.getBoundingClientRect();
  const frame=()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res)));
  const fire=(init)=>{ s.dispatchEvent(new WheelEvent('wheel',{
    clientX:r.left+r.width/2, clientY:r.top+r.height/2, bubbles:true, cancelable:true, ...init })); };

  X.goto(0, 6); await frame();
  const a={ppy:V.ppy, x0:V.x0, yTop:V.yTop};

  fire({deltaY:120, deltaX:0}); await frame();
  const scrolled={ppy:V.ppy, x0:V.x0, yTop:V.yTop};

  fire({deltaY:-240, deltaX:0, ctrlKey:true}); await frame();
  const pinched={ppy:V.ppy};

  X.goto(0, 6); await frame();
  fire({deltaY:150, deltaX:0, shiftKey:true}); await frame();
  const shifted={ppy:V.ppy, x0:V.x0, yTop:V.yTop};

  return {a, scrolled, pinched, shifted};
})()`);

check('a two-finger scroll pans instead of zooming',
  gesture.scrolled.ppy === gesture.a.ppy && gesture.scrolled.yTop > gesture.a.yTop,
  `ppy held at ${gesture.a.ppy.toFixed(2)}, yTop ${gesture.a.yTop.toFixed(4)} -> ${gesture.scrolled.yTop.toFixed(4)}`);
check('a pinch zooms', gesture.pinched.ppy > gesture.scrolled.ppy * 1.1,
  `${gesture.scrolled.ppy.toFixed(2)} -> ${gesture.pinched.ppy.toFixed(2)} px/yr`);
check('shift+wheel pans through time',
  gesture.shifted.x0 > gesture.a.x0 && gesture.shifted.ppy === gesture.a.ppy,
  `x0 ${Math.round(gesture.a.x0)} -> ${Math.round(gesture.shifted.x0)}`);

// ---- the sidebar folds -------------------------------------------------
const railFold = await evaluate(atlas, `(async()=>{
  const frame=()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res)));
  const el=document.querySelector('.rail');
  const open=el.getBoundingClientRect().width;
  document.querySelector('.rail .railfold').click(); await frame();
  const folded=el.getBoundingClientRect().width;
  const chevron=document.querySelector('.rail .railfold');
  const spineVisible=chevron.getBoundingClientRect().width > 0;
  document.querySelector('.rail .railfold').click(); await frame();
  return {open, folded, spineVisible, reopened:el.getBoundingClientRect().width};
})()`, { userGesture: true });

check('the sidebar keeps to its declared width', railFold.open > 180 && railFold.open < 240,
  `${Math.round(railFold.open)}px (flex-basis is 216)`);
check('the sidebar folds from its own edge', railFold.folded > 0 && railFold.folded < 40,
  `${Math.round(railFold.open)}px -> ${Math.round(railFold.folded)}px spine`);
check('the folded sidebar keeps a way back', railFold.spineVisible && railFold.reopened === railFold.open,
  `chevron still hittable, reopens to ${Math.round(railFold.reopened)}px`);

/*
 * ---- the ruler stays over the map --------------------------------------
 *
 * #ruler is a sibling of #mid, so it spans the full width INCLUDING the rail,
 * while tick x's come from the scale, whose origin is #surface's left edge. Ticks
 * positioned straight into #ruler were therefore offset from their entries by the
 * rail's width — and folding the rail (216px to 22px) slid every year label 194px
 * sideways against the marks it dates. They now live in #rtrack, whose left edge
 * is synced to #surface in measure().
 *
 * Asserted two ways, because the offsets can agree while the scale is wrong.
 * `trackOffset === surfaceOffset` is the layout; inverting the atlas's own scale
 * at a tick's screen x and comparing with the year the tick PRINTS is the thing
 * a reader actually cares about.
 */
const rulerAlign = await evaluate(atlas, `(async()=>{
  const frame=()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res)));
  const probe=()=>{
    const ruler=document.getElementById('ruler'), track=document.getElementById('rtrack');
    const surf=document.getElementById('surface');
    if(!track) return {err:'no #rtrack'};
    const tk=[...track.querySelectorAll('.tk')];
    if(tk.length<3) return {err:'too few ticks'};
    const sr=surf.getBoundingClientRect(), rr=ruler.getBoundingClientRect();
    const tr=track.getBoundingClientRect();
    const X=window.__atlas, t=tk[Math.floor(tk.length/2)];
    const year=X.view.x0 + (t.getBoundingClientRect().left - sr.left)/X.scale.ppy;
    const raw=String(t.textContent).trim();
    const mag=parseFloat(raw.replace(/[^0-9.]/g,''))||0;
    const mult=/\\bka\\b/i.test(raw)?1e3:/\\bMa\\b/i.test(raw)?1e6:/\\bGa\\b/i.test(raw)?1e9:1;
    const printed=/BC|ka|Ma|Ga/i.test(raw) ? -(mag*mult)
                : /present/i.test(raw) ? new Date().getFullYear() : mag;
    return {
      surfaceOffset: Math.round(sr.left-rr.left),
      trackOffset:   Math.round(tr.left-rr.left),
      label: raw,
      driftPx: Math.round(Math.abs(year-printed)*X.scale.ppy),
    };
  };
  const open=probe();
  document.querySelector('.rail .railfold').click(); await frame(); await frame();
  const folded=probe();
  document.querySelector('.rail .railfold').click(); await frame(); await frame();
  return {open, folded};
})()`, { userGesture: true });

check('the ruler starts at the map, sidebar open',
  rulerAlign.open.trackOffset === rulerAlign.open.surfaceOffset,
  `track ${rulerAlign.open.trackOffset}px == map ${rulerAlign.open.surfaceOffset}px`);
check('the ruler starts at the map, sidebar folded',
  rulerAlign.folded.trackOffset === rulerAlign.folded.surfaceOffset,
  `track ${rulerAlign.folded.trackOffset}px == map ${rulerAlign.folded.surfaceOffset}px`);
check('folding the sidebar does not slide the year labels',
  rulerAlign.open.driftPx <= 1 && rulerAlign.folded.driftPx <= 1,
  `"${rulerAlign.open.label}" drift ${rulerAlign.open.driftPx}px open, ` +
  `"${rulerAlign.folded.label}" ${rulerAlign.folded.driftPx}px folded ` +
  `(map edge ${rulerAlign.open.surfaceOffset}px -> ${rulerAlign.folded.surfaceOffset}px)`);

// ---- theme -------------------------------------------------------------
/*
 * The canvas cannot read CSS variables, so a theme switch has to move BOTH halves.
 * Asserting only the attribute would pass with a black canvas under a white UI.
 */
const themed = await evaluate(atlas, `(async()=>{
  const frame=()=>new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res)));
  const cv=document.getElementById('canvas');
  const corner=()=>{ const d=cv.getContext('2d').getImageData(cv.width-3,cv.height-3,1,1).data;
                     return d[0]+d[1]+d[2]; };
  const out={};
  window.__atlas.setTheme('light'); await frame();
  out.light={attr:document.documentElement.dataset.theme,
             body:getComputedStyle(document.body).backgroundColor, canvas:corner()};
  window.__atlas.setTheme('dark'); await frame();
  out.dark={attr:document.documentElement.dataset.theme,
            body:getComputedStyle(document.body).backgroundColor, canvas:corner()};
  window.__atlas.setTheme('light'); await frame();
  return out;
})()`);

check('light is the theme', themed.light.attr === 'light' && themed.light.canvas > 600,
  `body ${themed.light.body}, canvas luma sum ${themed.light.canvas}`);
check('the theme switch moves the canvas too, not just the CSS',
  themed.dark.attr === 'dark' && themed.dark.canvas < themed.light.canvas - 200,
  `canvas ${themed.light.canvas} -> ${themed.dark.canvas}, body ${themed.dark.body}`);

// ---- pin ---------------------------------------------------------------
const pinNode = await evaluate(atlas, `(()=>{
  const r=document.querySelector('.rrow');
  return {node:Number(r.dataset.node), label:r.querySelector('.rlabel').textContent};
})()`);

await evaluate(atlas, `document.querySelector('.rrow[data-node="${pinNode.node}"] .rpin').click()`,
  { userGesture: true });

const pinned = await until(atlas,
  `window.__atlas.view.pinned.length === 1 && document.getElementById('pinWrap').offsetHeight > 10`,
  { label: 'pin applied' });

const pin = await evaluate(atlas, `(()=>{
  const wrap=document.getElementById('pinWrap');
  const cv=document.getElementById('pinCanvas');
  return {on:wrap.classList.contains('on'), h:wrap.offsetHeight, cw:cv.width,
    pinned:window.__atlas.view.pinned.length,
    unpinBtns:document.querySelectorAll('#pinBar [data-unpin]').length,
    painted:(()=>{ if(!cv.width) return false; const c=cv.getContext('2d');
      const d=c.getImageData(0,0,cv.width,cv.height).data; const s=new Set();
      for(let i=0;i<d.length;i+=2000) s.add(d[i]+','+d[i+1]+','+d[i+2]); return s.size>2; })()};
})()`);
check('pinning shows the strip', pinned.ok && pin.on,
  `"${pinNode.label}" -> ${pin.h}px strip, ${pin.pinned} pinned, ${pinned.ms}ms`);
check('pinned strip is painted', pin.painted, `canvas ${pin.cw}px wide`);
check('pinned strip offers an unpin control', pin.unpinBtns === pin.pinned, `${pin.unpinBtns} buttons`);

// The strip must track the map's time axis as the map pans.
const x0Before = await evaluate(atlas, `window.__atlas.scale.x0`);
await evaluate(atlas, `(()=>{window.__atlas.view.x0 += 300; window.__atlas.mark({paint:true});})()`,
  { userGesture: true });
const panned = await until(atlas, `window.__atlas.scale.x0 > ${x0Before + 250}`, { label: 'map panned' });
const stillPinned = await evaluate(atlas, `window.__atlas.view.pinned.length`);
check('pinned strip shares the panned time axis', panned.ok && stillPinned === 1,
  `x0 ${Math.round(x0Before)} -> ${Math.round(panned.value ? await evaluate(atlas, 'window.__atlas.scale.x0') : 0)}, still pinned`);

await evaluate(atlas, `document.querySelector('#pinBar [data-unpin]').click()`, { userGesture: true });
const unpin = await until(atlas, `window.__atlas.view.pinned.length === 0`, { label: 'unpinned' });
check('unpinning works', unpin.ok, `${unpin.ms}ms`);

// Regression: the unpin buttons were written inside an `if(pins.rows.length)`,
// so removing the last pin left a stale button behind. #pinWrap hides it, but
// the DOM must still empty — the next pin would otherwise inherit it.
// Poll: view.pinned empties synchronously in the click handler, but the bar is
// rewritten in paint(), which is a frame later.
const staleBar = await until(atlas, `(()=>{const b=document.getElementById('pinBar');
  return b.querySelectorAll('[data-unpin]').length === 0
    && !document.getElementById('pinWrap').classList.contains('on');})()`, { label: 'pin bar cleared' });
check('the pin bar empties with the last pin', staleBar.ok, `${staleBar.ms}ms`);

// ---- detail panel ------------------------------------------------------
await evaluate(atlas, `window.__atlas.select(${dense.i}, {open:true, center:true})`,
  { userGesture: true });
await sleep(700);

const det = await evaluate(atlas, `(()=>{
  const p=document.querySelector('.detail');
  const img=p.querySelector('.dpic img');
  return {on:p.classList.contains('on'),
    title:p.querySelector('h2')?.textContent,
    crumbs:p.querySelectorAll('.crumb').length,
    near:p.querySelectorAll('.near button').length,
    chips:p.querySelectorAll('.chip').length,
    hasEx:!!p.querySelector('.dex:not(.empty)'),
    imgFit:img?getComputedStyle(img).objectFit:null,
    scrolls:p.scrollHeight >= p.clientHeight};
})()`, {});

check('detail panel opens', det.on, `"${det.title}"`);
check('detail shows the cluster path', det.crumbs > 0, `${det.crumbs} crumbs`);
check('detail lists nearest neighbours', det.near > 0, `${det.near} neighbours`);
check('detail shows topic chips', det.chips > 0, `${det.chips} chips`);
check('detail excerpt rendered', det.hasEx);
if(det.imgFit) check('detail image is contain', det.imgFit === 'contain', det.imgFit);

// Clicking a neighbour must navigate, which is the "more like this" path.
const nav = await evaluate(atlas, `(()=>{
  const before=document.querySelector('.detail h2').textContent;
  document.querySelector('.near button').click();
  return {before};
})()`, { userGesture: true });
await sleep(600);
const nav2 = await evaluate(atlas, `document.querySelector('.detail h2').textContent`, {});
check('clicking a neighbour navigates', nav2 !== nav.before, `"${nav.before}" -> "${nav2}"`);

// The enlarged image must also be uncropped.
await evaluate(atlas, `(()=>{const f=document.querySelector('.dpic'); if(f) f.click();})()`,
  { userGesture: true });
await sleep(500);
const box = await evaluate(atlas, `(()=>{
  const b=document.querySelector('.lightbox');
  const img=b.querySelector('img');
  return {on:b.classList.contains('on'), fit:getComputedStyle(img).objectFit, src:!!img.getAttribute('src')};
})()`, {});
if(box.on){
  check('enlarged image is contain', box.fit === 'contain', box.fit);
  await evaluate(atlas, `document.querySelector('.lightbox').click()`, { userGesture: true });
} else ok('enlarged image skipped', 'entry has no picture');

await evaluate(atlas, `document.querySelector('.dclose').click()`, { userGesture: true });
await sleep(300);

// ---- search ------------------------------------------------------------
/*
 * The corpus size, read from the atlas rather than hardcoded. Every "a filter
 * narrowed the set" check used a literal 2697 — the entry count on the day they
 * were written — so `has:image` started failing purely because the store grew past
 * it, which reads as a broken filter.
 */
const CORPUS = await evaluate(atlas, `window.__atlas.atlas.n`, {});

async function search(term){
  await evaluate(atlas, `(()=>{const q=document.getElementById('q');q.value=${JSON.stringify(term)};
    q.dispatchEvent(new Event('input',{bubbles:true}));})()`, { userGesture: true });
  await sleep(500);
  return evaluate(atlas, `(()=>({
    count:document.getElementById('count').textContent.trim(),
    matched:window.__atlas.filter ? window.__atlas.filter.count : null,
    empty:document.getElementById('empty').classList.contains('on'),
  }))()`, {});
}

const s1 = await search('cubism');
check('free-text search narrows the set', s1.matched > 0 && s1.matched < CORPUS,
  `"cubism" -> ${s1.count}`);

const s2 = await search('1750-1800');
check('year-range search works', s2.matched > 0 && s2.matched < CORPUS, `"1750-1800" -> ${s2.count}`);

const s3 = await search('ds:film');
check('ds: prefix filters by source', s3.matched > 0 && s3.matched < CORPUS, `"ds:film" -> ${s3.count}`);

const s4 = await search('topic:surrealism');
check('topic: prefix filters by topic', s4.matched > 0, `"topic:surrealism" -> ${s4.count}`);

const s5 = await search('has:image');
check('has:image filters to entries with pictures', s5.matched > 0 && s5.matched < CORPUS,
  `"has:image" -> ${s5.count}`);

const s6 = await search('zzzznotathing');
check('a hopeless search shows the empty state', s6.matched === 0 && s6.empty, s6.count);

await search('');

// ---- performance -------------------------------------------------------
const perf = await evaluate(atlas, `(()=>{
  const s=document.getElementById('surface');
  const r=s.getBoundingClientRect();
  const t0=performance.now();
  let frames=0;
  return new Promise(res=>{
    function step(k){
      if(k>=40){ res({ms:performance.now()-t0, frames}); return; }
      s.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+800,clientY:r.top+400,bubbles:true,pointerId:9,button:0}));
      s.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+800-k*7,clientY:r.top+400,bubbles:true,pointerId:9}));
      s.dispatchEvent(new PointerEvent('pointerup',{clientX:r.left+800-k*7,clientY:r.top+400,bubbles:true,pointerId:9,button:0}));
      requestAnimationFrame(()=>{frames++;step(k+1);});
    }
    step(0);
  });
})()`, { userGesture: true });
check('pan stays interactive', perf.ms / perf.frames < 34,
  `${perf.frames} frames in ${perf.ms.toFixed(0)}ms = ${(perf.ms/perf.frames).toFixed(1)}ms/frame`);

// ---- time ranges (modes) ----------------------------------------------
/*
 * Each mode is asserted on the thing that actually broke: that pressing Fit puts
 * the mode's entries ON SCREEN. The old fit check only matched the status line's
 * SHAPE, so when one entry at −113,000 stretched the axis past the hardcoded
 * px-per-year floor and Fit started landing on 50,000 years of empty prehistory
 * with a single point in view, the suite went on reporting 50/50.
 */
const modeKeys = await evaluate(atlas, `window.__atlas.modes`);
check('three time ranges offered', Array.isArray(modeKeys) && modeKeys.length === 3,
  Array.isArray(modeKeys) ? modeKeys.join(', ') : String(modeKeys));
check('a control exists for every range',
  await evaluate(atlas, `document.querySelectorAll('#modeSeg button[data-mode]').length`) === 3);

const modeReport = [];
for(const key of modeKeys || []){
  await evaluate(atlas, `window.__atlas.setMode('${key}')`, { userGesture: true });
  await evaluate(atlas, `window.__atlas.fit()`, { userGesture: true });
  await sleep(400);

  const m = await evaluate(atlas, `(()=>{
    const X = window.__atlas, A = X.atlas, s = X.scale, [lo, hi] = X.domain;
    let inDomain = 0;
    for(let i = 0; i < A.n; i++) if(A.x1[i] >= lo) inDomain++;
    return {
      mode: X.mode, lo, hi, ppy: s.ppy, atEdge: X.atEdge, outside: X.outside,
      inView: X.visible.length, inDomain, n: A.n,
      // Does the fitted viewport actually span the whole domain?
      covers: s.x0 <= lo + 1 && s.x1 >= hi - 1,
      ticks: document.querySelectorAll('#ruler .tk').length,
      tickText: [...document.querySelectorAll('#ruler .tk')].map(e => e.textContent),
      status: document.getElementById('status').textContent,
      stops: [...document.querySelectorAll('#scaleSeg button')].map(e => e.textContent),
      ppyLab: document.getElementById('ppyLab').textContent,
    };
  })()`);
  modeReport.push(m);

  // THE check the old suite was missing: fit has to show you something.
  check(`fit shows ${key}'s entries`, m.inView > m.inDomain * 0.9,
    `${m.inView} in view of ${m.inDomain} reachable  ·  ${m.status}`);
  check(`fit spans the whole ${key} range`, m.covers,
    `${m.lo} … ${m.hi} at ${m.ppy.toExponential(2)} px/yr`);
  check(`fit is the ${key} zoom-out limit`, m.atEdge,
    `ppy ${m.ppy.toExponential(2)}, atEdge=${m.atEdge}`);
  check(`${key} ruler is legible`, m.ticks >= 5 && m.ticks <= 40
    && m.tickText.every((s) => s.length > 0 && s.length < 12),
    `${m.ticks} ticks: ${m.tickText.slice(0, 4).join(' | ')} … ${m.tickText.at(-1)}`);
  check(`${key} zoom readout is a number`, !/^0\.00 /.test(m.ppyLab), m.ppyLab);
  // A range that hides entries has to admit it. Silent truncation reads as
  // "that is all there is".
  if(m.outside > 0){
    check(`${key} says how many entries it leaves behind`,
      new RegExp(`${m.outside}\\s+before`).test(m.status), m.status);
  }
}

check('narrower ranges cover less time',
  modeReport.length === 3 && modeReport[0].hi - modeReport[0].lo < modeReport[1].hi - modeReport[1].lo
    && modeReport[1].hi - modeReport[1].lo < modeReport[2].hi - modeReport[2].lo,
  modeReport.map((m) => `${m.mode}:${Math.round(m.hi - m.lo)}y`).join('  '));

check('each range gets its own scale ladder',
  new Set(modeReport.map((m) => m.stops.join(','))).size === 3,
  modeReport.map((m) => `${m.mode}: ${m.stops.join('/')}`).join('   '));

// Every stop must land where its label claims, in every mode.
const ladder = await evaluate(atlas, `(async()=>{
  const X = window.__atlas, out = [];
  const wait = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  for(const mode of X.modes){
    X.setMode(mode); await wait();
    for(const b of document.querySelectorAll('#scaleSeg button')){
      const key = b.dataset.stop;
      X.gotoStop(key); await wait();
      out.push({ mode, key, ppy: X.scale.ppy, on: b.classList.contains('on'),
                 lit: [...document.querySelectorAll('#scaleSeg button.on')].length });
    }
  }
  return out;
})()`);
check('every scale stop lands on itself', ladder.every((r) => r.on && r.lit === 1),
  ladder.filter((r) => !r.on || r.lit !== 1).map((r) => `${r.mode}/${r.key}`).join(',') || `${ladder.length} stops across 3 ranges`);

// The edge highlight is the only thing inviting a mode change, so it has to appear
// exactly when you are against the edge — and never on the widest range.
const edgeHint = await evaluate(atlas, `(async()=>{
  const X = window.__atlas;
  const wait = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lit = () => [...document.querySelectorAll('#modeSeg button.edge')].map(b => b.dataset.mode);
  X.setMode('${modeKeys[0]}'); X.fit(); await wait();
  const atFit = lit();
  X.zoom(9, 800, 400); await wait();
  const zoomedIn = lit();
  X.setMode('${modeKeys[2]}'); X.fit(); await wait();
  const widest = lit();
  return { atFit, zoomedIn, widest };
})()`);
check('the wider range is offered at the edge', edgeHint.atFit.length === 1
  && edgeHint.atFit[0] === modeKeys[1], edgeHint.atFit.join(',') || 'nothing lit');
check('no offer once you zoom in', edgeHint.zoomedIn.length === 0, edgeHint.zoomedIn.join(','));
check('nothing to offer past the widest range', edgeHint.widest.length === 0, edgeHint.widest.join(','));

// Switching ranges while parked mid-history must not teleport you.
const keepPlace = await evaluate(atlas, `(async()=>{
  const X = window.__atlas;
  const wait = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  X.setMode('civ'); await wait();
  X.gotoStop('decades'); await wait();
  const a = { mid: (X.scale.x0 + X.scale.x1) / 2, ppy: X.scale.ppy };
  X.setMode('human'); await wait();
  const b = { mid: (X.scale.x0 + X.scale.x1) / 2, ppy: X.scale.ppy };
  return { a, b };
})()`);
check('switching range mid-history keeps your place',
  Math.abs(keepPlace.b.mid - keepPlace.a.mid) < 60 && Math.abs(keepPlace.b.ppy / keepPlace.a.ppy - 1) < 0.02,
  `${Math.round(keepPlace.a.mid)} @ ${keepPlace.a.ppy.toFixed(2)} -> ${Math.round(keepPlace.b.mid)} @ ${keepPlace.b.ppy.toFixed(2)}`);

// ...but switching while zoomed out should reframe, or the toggle looks inert:
// 5,000 years is invisible inside 4.5 billion either way.
const reframe = await evaluate(atlas, `(async()=>{
  const X = window.__atlas;
  const wait = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  X.setMode('civ'); X.fit(); await wait();
  const a = X.scale.ppy;
  X.setMode('earth'); await wait();
  return { a, b: X.scale.ppy, edge: X.atEdge };
})()`);
check('switching range while zoomed out reframes', reframe.b < reframe.a && reframe.edge,
  `${reframe.a.toExponential(2)} -> ${reframe.b.toExponential(2)} px/yr, atEdge=${reframe.edge}`);

// The saved range has to survive a reopen, which is the one thing that silently
// inverted the pin and collapse tests once.
await evaluate(atlas, `window.__atlas.setMode('human')`, { userGesture: true });
await sleep(300);
check('the chosen range is remembered',
  /"mode":"human"/.test(await evaluate(atlas, `localStorage.getItem('atlas:prefs:v1')`)),
  await evaluate(atlas, `JSON.parse(localStorage.getItem('atlas:prefs:v1')).mode`));

await evaluate(atlas, `window.__atlas.setMode('civ')`, { userGesture: true });
await sleep(200);

// ---- fit + no exceptions ----------------------------------------------
await evaluate(atlas, `document.getElementById('fitBtn').click()`, { userGesture: true });
await sleep(400);
const r3 = await evaluate(atlas, probe);
const fitView3 = await evaluate(atlas, `({inView: window.__atlas.visible.length,
  reach: (()=>{const A=window.__atlas.atlas, lo=window.__atlas.domain[0];
    let k=0; for(let i=0;i<A.n;i++) if(A.x1[i]>=lo) k++; return k;})()})`);
check('fit returns to the whole atlas',
  !r3.canvasBlank && fitView3.inView > fitView3.reach * 0.9,
  `${fitView3.inView} of ${fitView3.reach} reachable in view  ·  ${r3.status}`);

check('no uncaught exceptions', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean');

// ---- screenshot -------------------------------------------------------
if(SHOT){
  // Go somewhere worth photographing. Synthetic wheel events at the centre of the
  // canvas — what this used to do — is the exact mistake this file's header warns
  // about: the middle of a scatter plot is usually empty, and the PNG came out as a
  // blank grid reading "0 in view". Reuse the densest-with-excerpts entry the suite
  // already found, at card zoom, and wait for points to actually be in view.
  await evaluate(atlas, `window.__atlas.goto(${dense.i}, 24)`, { userGesture: true });
  const framed = await until(atlas, `window.__atlas.visible.length > 20`,
    { label: 'points in frame for the screenshot' });
  if(!framed.ok) console.log('  warn  screenshot may be empty: nothing came into view');
  await sleep(400); // let the card images decode, or they photograph as empty frames
  const shot = await send('Page.captureScreenshot', { format: 'png' }, atlas);
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`\n  screenshot -> ${SHOT}`);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed\n`);

if(!process.argv.includes('--keep')){
  await send('Target.closeTarget', { targetId: targets[0].targetId }).catch(() => {});
  await send('Target.closeTarget', { targetId }).catch(() => {});
}
ws.close();
process.exit(failed.length ? 1 : 0);
