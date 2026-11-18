#!/usr/bin/env node
/**
 * Headless QA for the atlas, over the Chrome DevTools Protocol.
 *
 *   python3 -m http.server 8777
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
 *     --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
 *     --window-size=1600,1000 about:blank
 *   node datasets/qa/qa-atlas.mjs [--shot out.png] [--keep]
 *
 * No Playwright, no npm — Node's global WebSocket is enough.
 *
 * Gotchas this encodes, all of which cost time to rediscover:
 *   - `Runtime.evaluate` needs `userGesture:true`, or `window.open` is blocked and
 *     the atlas never opens.
 *   - The atlas is a separate TARGET, not a frame. You must attach to it and talk
 *     to it over its own sessionId.
 *   - Persisted view prefs leak between runs and results stop being reproducible.
 *     This suite now clears `atlas:prefs:v2` itself, on the OPENER and before
 *     `openAtlas()` — the popup reads the prefs once at open time, so clearing
 *     them after it exists is too late. A fresh `--user-data-dir` per run also
 *     works, but then you cannot re-run against an already-open browser.
 *   - The HTTP cache is disabled per target. Without it Chrome re-serves a cached
 *     atlas.json from the persistent user-data-dir and the suite passes against
 *     data you already rebuilt.
 *   - Assert on the DOM with `until`, not `evaluate`. View state changes
 *     synchronously in the event handler; the DOM catches up in `paint()`, one
 *     frame later. Snapshotting reads the pre-click DOM maybe half the time.
 *
 * What it checks (the lanes atlas, docs/ATLAS.md): sections and lanes from the
 * topic tree, kinds in the timeline's order, no two labels overlapping in a row,
 * round portraits, bold = famous, the timeline's own CSS, zoom adding rows,
 * panning not re-packing, era bands, pins, folds, "more", search, the detail
 * panel, the three time ranges, the folding toolbar, buckets loading as you
 * zoom, the phone layout, and opening at a topic's lane.
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
await evaluate(app, `localStorage.removeItem('atlas:prefs:v2')`);

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

const ev = (expr) => evaluate(atlas, expr);
const gesture = (expr) => evaluate(atlas, expr, { userGesture: true });
const settle = () => sleep(250);

// ---- structure ---------------------------------------------------------
const st = await ev(`(()=>{const a=window.__atlas, L=a.layout; return {
  secs: L.sections.length, lanes: L.lanes.length, marks: L.marks.length, bars: L.bars.length,
  domSecs: document.querySelectorAll('.al-sec').length, domLanes: document.querySelectorAll('.al-lane').length,
  domMarks: document.querySelectorAll('#world .tp-ln').length, domEras: document.querySelectorAll('#world .tp-era').length,
  rail: !!document.querySelector('.rail'), canvas: document.querySelectorAll('canvas').length,
  metaLanes: a.A.meta.lanes.length }})()`);
check('sections and lanes laid out', st.secs >= 6 && st.lanes >= 40, `${st.secs} sections, ${st.lanes} lanes of ${st.metaLanes}`);
check('entries drawn as Lanes (events, lives, era bars)', st.domMarks >= 80 && st.domEras >= 5, `${st.domMarks} marks, ${st.domEras} era bars in the DOM; ${st.marks + st.bars} laid out`);
check('section headers and lane names in the DOM', st.domSecs >= 2 && st.domLanes >= 5, `${st.domSecs} sections, ${st.domLanes} lanes rendered near the scroll`);
check('no sidebar, no scatter canvas', !st.rail && st.canvas === 0, `rail ${st.rail}, canvases ${st.canvas}`);

const order = await ev(`(()=>{const L=window.__atlas.layout; const K=['spans','events','people','more']; const top={};
  for(const b of L.bars){const t=top[b.lane]||(top[b.lane]={}); t.spans=Math.min(t.spans??1e9,b.y);}
  for(const m of L.marks){const t=top[m.lane]||(top[m.lane]={}); t[m.kind]=Math.min(t[m.kind]??1e9,m.y);}
  let bad=0, n=0; for(const t of Object.values(top)){ const ys=K.filter(k=>t[k]!=null).map(k=>t[k]); n++; for(let i=1;i<ys.length;i++) if(ys[i]<=ys[i-1]) bad++; }
  return {bad, n}})()`);
check('inside a lane: eras, then events, people, works and places', order.bad === 0, `${order.n} lanes, ${order.bad} out of order`);

const overlap = await ev(`(()=>{const L=window.__atlas.layout; const rows=new Map(); let bad=0, ex='';
  for(const m of L.marks){ const k=m.lane+'|'+m.kind+'|'+m.y; (rows.get(k)||rows.set(k,[]).get(k)).push(m); }
  for(const ms of rows.values()){ ms.sort((a,b)=>a.l-b.l); for(let i=1;i<ms.length;i++) if(ms[i].l < ms[i-1].r){ bad++; ex=ms[i-1].e.t+' / '+ms[i].e.t; } }
  return {bad, rows: rows.size, ex}})()`);
check('no two labels overlap in a row', overlap.bad === 0, `${overlap.rows} rows${overlap.bad ? `, ${overlap.bad} overlaps e.g. ${overlap.ex}` : ''}`);

const look = await ev(`(()=>{const q=(s)=>document.querySelector(s); const cs=(n,p)=>n?getComputedStyle(n)[p]:null;
  const av=q('#world .tp-ln .av'); const key=q('#world .tp-ln.key .lb'); const ln=q('#world .tp-ln .lb'); const era=q('#world .tp-era'); const bar=q('#world .tp-ln.lasted .bar');
  const keys=[...document.querySelectorAll('#world .tp-ln.key')].map(n=>window.__atlas.A.byId.get(n.dataset.id)).filter(Boolean);
  return { avRadius: cs(av,'borderRadius'), avW: av?av.getBoundingClientRect().width:0, keyW: cs(key,'fontWeight'), lnSize: cs(ln,'fontSize'),
    eraH: cs(era,'height'), barTop: cs(bar,'top'), barH: cs(bar,'height'),
    keysFamous: keys.every(e=>e.f>=60||e.k), keys: keys.length }})()`);
check('portraits are small and round', look.avRadius === '50%' && look.avW > 10 && look.avW < 20, `radius ${look.avRadius}, ${look.avW}px`);
check('fame shown by weight: bold labels are famous or essential', look.keyW === '700' && look.keysFamous && look.keys > 0, `${look.keys} bold, weight ${look.keyW}`);
check('the timeline\'s own CSS: 11.5px labels, 15px era bars, 3px duration line under the title', look.lnSize === '11.5px' && look.eraH === '15px' && look.barTop === '17px' && look.barH === '3px',
  `label ${look.lnSize}, era ${look.eraH}, line at ${look.barTop} ${look.barH}`);

// ---- zoom, pan, eras --------------------------------------------------------
const z0 = await ev(`window.__atlas.layout.marks.length + window.__atlas.layout.bars.length`);
const loaded0 = await ev(`window.__atlas.A.byId.size`);
await gesture(`window.__atlas.fitYears(1200, 1300)`);
const zoomed = await until(atlas, `window.__atlas.A.byId.size > ${loaded0} && window.__atlas.layout.marks.length > 0`, { timeout: 8000 });
check('zooming in loads that stretch\'s buckets', zoomed.ok, `${loaded0} -> ${await ev('window.__atlas.A.byId.size')} entries loaded`);
const z1 = await ev(`(()=>{const L=window.__atlas.layout; const vis=L.marks.filter(m=>m.x0>=window.__atlas.V.W && m.x0<=2*window.__atlas.V.W).length; return vis})()`);
check('zooming in shows more rows of detail per stretch of time', z1 > 0, `fit: ${z0} in all of history; 1200-1300: ${z1} on screen`);

const x0Before = await ev(`(()=>{window.__L0 = window.__atlas.layout; return window.__atlas.V.x0})()`);
await gesture(`window.__atlas.panBy(60)`);
await settle();
const pan = await ev(`({same: window.__L0 === window.__atlas.layout, x0: window.__atlas.V.x0, tf: document.getElementById('world').style.transform})`);
check('panning inside the window moves, does not re-pack', pan.same && pan.x0 > x0Before && /translateX/.test(pan.tf), `x0 ${x0Before.toFixed(1)} -> ${pan.x0.toFixed(1)}, ${pan.tf}`);

await gesture(`window.__atlas.fitYears(-3000, 2026)`);
await settle();
const band = await ev(`(()=>{const b=[...document.querySelectorAll('#bands .tp-band')].find(n=>/500:1500/.test(n.dataset.fit)); if(!b) return null; b.click(); return b.dataset.fit})()`);
await settle();
const fitted = await ev(`(()=>{const V=window.__atlas.V; return {x0:V.x0, x1:V.x0+V.W/V.ppy}})()`);
check('clicking an era band fits it', band && Math.abs(fitted.x0 - 500) < 60 && Math.abs(fitted.x1 - 1500) < 60, `${band}: view ${fitted.x0.toFixed(0)}..${fitted.x1.toFixed(0)}`);
const win = await ev(`parseFloat(document.getElementById('win').style.left)`);
check('the overview strip outlines the view', win > 40 && win < 75, `box at ${win}%`);

// ---- pin, fold, more ---------------------------------------------------------
const pinKey = await ev(`(()=>{const l=document.querySelector('#labs .tp-lanelab[data-pin]'); if(!l) return null; l.click(); return l.dataset.pin})()`);
const pinned = await until(atlas, `document.getElementById('pins').classList.contains('on') && document.querySelectorAll('#pworld .tp-ln, #pworld .tp-era').length > 0`);
check('clicking a lane name pins it under the header', pinKey && pinned.ok, `${pinKey}`);
const saved = await ev(`JSON.parse(localStorage.getItem('atlas:prefs:v2')||'{}').pinned||[]`);
check('pins are remembered', saved.includes(pinKey), JSON.stringify(saved));
await ev(`document.querySelector('#plabs .tp-lanelab[data-pin]').click()`);
const unpinned = await until(atlas, `!document.getElementById('pins').classList.contains('on')`);
check('clicking it again unpins it', unpinned.ok);

const fold = await ev(`(()=>{const s=document.querySelector('.al-sec[data-sec="europe"]'); const n=window.__atlas.layout.lanes.filter(l=>l.section==='europe').length; s && s.click(); return n})()`);
const folded = await until(atlas, `window.__atlas.layout.lanes.filter(l=>l.section==='europe').length === 0`);
check('clicking a section folds it away', fold > 3 && folded.ok, `Europe: ${fold} lanes -> 0`);
await ev(`window.__atlas.V.folded.clear(), window.__atlas.update({layout:true})`);
await settle();

const more = await ev(`(()=>{const L=window.__atlas.layout; const l=L.lanes.find(x=>x.left>5); if(!l) return null; window.__mk=l.key; window.__mp=l.placed; window.__atlas.V.more.add(l.key); window.__atlas.update({layout:true}); return {key:l.key, placed:l.placed, left:l.left}})()`);
await settle();
const more2 = more ? await ev(`window.__atlas.layout.lanes.find(x=>x.key===window.__mk).placed`) : 0;
check('"more" gives a lane more rows', more && more2 > more.placed, more ? `${more.key}: ${more.placed} -> ${more2}` : 'no lane with more to show');
await ev(`window.__atlas.V.more.clear()`);

// ---- search ------------------------------------------------------------------
await ev(`window.__atlas.setQuery('napoleon')`);
const found = await until(atlas, `(()=>{const a=window.__atlas; return a.V.matches && a.layout.marks.length > 0 && a.layout.marks.every(m=>a.V.matches.has(m.e.id))})()`, { timeout: 6000 });
const s1 = await ev(`(()=>{const a=window.__atlas, L=a.layout; const all=[...L.marks.map(m=>m.e), ...L.bars.map(b=>b.e)]; return {n:a.V.matches.size, shown:all.length, onlyMatches: all.every(e=>a.V.matches.has(e.id)), lanes:L.lanes.length, noEmpty: L.lanes.every(l=>l.placed+l.left>0), hasNap: all.some(e=>/Napoleon/.test(e.t))}})()`);
check('search shows only the matches, by lane', found.ok && s1.onlyMatches && s1.noEmpty && s1.hasNap, `${s1.n} matches, ${s1.shown} shown in ${s1.lanes} lanes`);
await ev(`window.__atlas.setQuery('1750-1800')`);
await settle();
const yr = await ev(`(()=>{const V=window.__atlas.V; return {x0:V.x0, x1:V.x0+V.W/V.ppy, m:V.matches}})()`);
check('a year range goes there', Math.abs(yr.x0 - 1750) < 10 && Math.abs(yr.x1 - 1800) < 10 && !yr.m, `${yr.x0.toFixed(0)}..${yr.x1.toFixed(0)}`);
await ev(`window.__atlas.setQuery('')`);

// ---- the detail panel --------------------------------------------------------
await settle();
const picked = await ev(`(()=>{const B=document.getElementById('body').getBoundingClientRect(); const ok=(n)=>{const r=n.querySelector('.lb').getBoundingClientRect(); return r.left>20 && r.right<innerWidth-20 && r.top>B.top+10 && r.bottom<B.bottom-10};
  const all=[...document.querySelectorAll('#world .tp-ln')]; const n=all.find(n=>n.classList.contains('key')&&ok(n)) || all.find(ok); if(!n) return null; n.querySelector('.lb').click(); return window.__atlas.A.byId.get(n.dataset.id).t})()`);
const opened = await until(atlas, `document.getElementById('detail').classList.contains('open') && !/Loading/.test(document.getElementById('dex')?.textContent||'Loading')`, { timeout: 6000 });
const dt = await ev(`({h: document.querySelector('#detail h2')?.textContent, ex: (document.getElementById('dex')?.textContent||'').length, sel: document.querySelectorAll('#world .sel').length})`);
check('clicking an entry opens it, with its summary', picked && opened.ok && dt.h === picked && dt.ex > 20, `${picked}: ${dt.ex} chars, highlighted ${dt.sel}`);
const s0 = await ev(`window.__atlas.V.selected`);
await ev(`document.querySelector('#detail [data-step="1"]')?.click()`);
const stepped = await until(atlas, `window.__atlas.V.selected && window.__atlas.V.selected !== ${JSON.stringify(s0)}`);
check('› steps to the next entry in its lane', stepped.ok);
await evaluate(atlas, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
const closed = await until(atlas, `!document.getElementById('detail').classList.contains('open')`);
check('Esc closes it', closed.ok);

// ---- time ranges -----------------------------------------------------------
await gesture(`window.__atlas.setMode('earth')`);
await ev(`document.getElementById('fitBtn').click()`);
await settle();
const earth = await ev(`({first: window.__atlas.layout.sections[0]?.key, dom: window.__atlas.V.domain[0], bands: document.querySelectorAll('#bands .tp-band').length})`);
check('Earth: deep time first, the eons as era bands', earth.first === 'earth' && earth.dom <= -4.54e9 && earth.bands >= 3, JSON.stringify(earth));
await gesture(`window.__atlas.setMode('civ')`);
await settle();
const civ = await ev(`({first: window.__atlas.layout.sections[0]?.key, last: window.__atlas.layout.sections.at(-1)?.key})`);
check('Civilization: history first, deep time last', civ.first !== 'earth' && civ.last === 'earth', JSON.stringify(civ));

// ---- toolbar ---------------------------------------------------------------
await ev(`document.getElementById('foldBar').click()`);
const fb = await until(atlas, `getComputedStyle(document.getElementById('bar')).display === 'none' && getComputedStyle(document.getElementById('unfoldBar')).display !== 'none'`);
check('the toolbar folds away', fb.ok);
await ev(`document.getElementById('unfoldBar').click()`);
const ub = await until(atlas, `getComputedStyle(document.getElementById('bar')).display !== 'none'`);
check('and comes back', ub.ok);
const barH = await ev(`document.getElementById('bar').getBoundingClientRect().height`);
check('the toolbar is one compact row', barH <= 46, `${barH}px`);

check('no uncaught exceptions', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean');

// ---- phone, and opening at a topic's lane -------------------------------------
// The popup is reused by name (window.open('', 'atlas')), so emulate it, not just the opener.
for(const sess of [app, atlas]) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sess);
await evaluate(app, `(localStorage.removeItem('atlas:prefs:v2'), localStorage.setItem('atlas:course','france'))`);
await evaluate(app, `window.openAtlas()`, { userGesture: true, awaitPromise: false });
await sleep(400);
let phoneOk = false;
for(let i = 0; i < 80 && !phoneOk; i++){
  await sleep(150);
  phoneOk = await evaluate(atlas, `!!window.__atlas && document.getElementById('boot').classList.contains('gone')`).catch(() => false);
}
check('reopens (phone width)', phoneOk);
if(phoneOk){
  await sleep(1200);
  const ph = await ev(`(()=>{const b=document.getElementById('bar'); const last=b.querySelector('#foldBar').getBoundingClientRect();
    const fr=window.__atlas.layout.lanes.find(l=>l.key==='france'); const top=document.getElementById('body').scrollTop;
    return {w: innerWidth, fits: last.right <= innerWidth + 1, france: fr ? Math.abs(fr.y - top) : -1}})()`);
  check('phone: the toolbar fits on one row', ph.fits && ph.w < 500, `${ph.w}px wide`);
  check('opened from a topic page: at that topic\'s lane', ph.france >= 0 && ph.france < 60, `France lane ${ph.france}px from the top`);
  const e = await ev(`(()=>{const n=document.querySelector('#world .tp-ln'); n.querySelector('.lb').click(); return true})()`);
  const sheet = await until(atlas, `document.getElementById('detail').classList.contains('open')`);
  const sw = await ev(`(()=>{const r=document.getElementById('detail').getBoundingClientRect(); return {w:r.width, h:r.height, H:innerHeight}})()`);
  check('phone: the entry opens as a bottom sheet', sheet.ok && sw.w >= 380 && sw.w <= 400 && sw.h < sw.H * 0.75, `${sw.w}x${sw.h} of ${sw.H}`);
}
for(const sess of [app, atlas]) await send('Emulation.clearDeviceMetricsOverride', {}, sess).catch(() => {});

// ---- screenshot -------------------------------------------------------
if(SHOT){
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
