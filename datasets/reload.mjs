#!/usr/bin/env node
/**
 * Reload the app in a Chrome you are actually looking at, from the terminal.
 *
 *   node datasets/reload.mjs                  # hard-reload localhost:8777
 *   node datasets/reload.mjs --atlas          # also reopen the atlas popup
 *   node datasets/reload.mjs --url /quiz.html # a specific path
 *   CDP_PORT=9333 node datasets/reload.mjs    # a different browser
 *
 * Requires a Chrome started with `--remote-debugging-port`. For a browser you can
 * see, drop `--headless=new`:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
 *     --disable-popup-blocking http://localhost:8777/
 *
 * Why not AppleScript? `osascript -e 'tell application "Google Chrome" to reload
 * active tab of front window'` works on your everyday Chrome, but it needs
 * Automation permission granted in System Settings › Privacy & Security, and it
 * cannot bypass the HTTP cache. This can, which matters here — see below.
 *
 * Reloads with `ignoreCache`. `python3 -m http.server` sends `Last-Modified` and no
 * `Cache-Control`, so Chrome applies a heuristic freshness lifetime and will serve
 * a stale `atlas.json` from its disk cache after you have rebuilt it. That is not
 * hypothetical: it made qa-atlas.mjs report 50/50 against two-build-old data.
 */

const PORT = Number(process.env.CDP_PORT || 9334);
const ORIGIN = process.env.QA_ORIGIN || 'http://localhost:8777';
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const PATH_ = arg('--url') || '/';
const WANT_ATLAS = argv.includes('--atlas');
const URL_ = PATH_.startsWith('http') ? PATH_ : ORIGIN + PATH_;

let list;
try {
  list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
} catch {
  console.error(`  No CDP on :${PORT}. Start Chrome with --remote-debugging-port=${PORT},`);
  console.error(`  or set CDP_PORT. See the header of this file for the full command.`);
  process.exit(1);
}

// Is the static server even up? A reload that 404s looks like a code bug.
try {
  const r = await fetch(URL_, { method: 'HEAD' });
  if(!r.ok) console.error(`  warn  ${URL_} -> HTTP ${r.status}`);
} catch {
  console.error(`  ${ORIGIN} is not answering. Start it:  python3 -m http.server 8777`);
  process.exit(1);
}

const send = (ws, id, method, params = {}) =>
  ws.send(JSON.stringify({ id, method, params }));

/** Open one WebSocket, run `fn`, close. */
async function withTarget(t, fn){
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await fn(ws);
  // Give the command a moment to be written before the socket drops, otherwise
  // Chrome can close it before the reload is dispatched.
  await new Promise((res) => setTimeout(res, 250));
  ws.close();
}

const pages = list.filter((t) => t.type === 'page');
// The atlas popup is same-origin too; reloading it alone would leave it orphaned
// from its opener, so target the app page and let it reopen the popup.
const appPage = pages.find((t) => t.url.startsWith(ORIGIN) && !/atlas/i.test(t.title || ''));

if(appPage){
  // Navigate only if the path actually changed. Doing both navigate and reload
  // fetches the page twice.
  const samePage = appPage.url.replace(/#.*$/, '') === URL_.replace(/#.*$/, '');
  await withTarget(appPage, (ws) => {
    send(ws, 1, 'Page.enable');
    if(samePage) send(ws, 2, 'Page.reload', { ignoreCache: true });
    else send(ws, 2, 'Page.navigate', { url: URL_ });
  });
  console.log(`  ${samePage ? 'reloaded ' : 'navigated'}  ${URL_}`);
} else {
  const r = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(URL_)}`,
    { method: 'PUT' });
  if(!r.ok){ console.error(`  could not open a tab: HTTP ${r.status}`); process.exit(1); }
  console.log(`  opened    ${URL_}`);
}

if(WANT_ATLAS){
  // Re-list: the tab above may have only just appeared.
  await new Promise((res) => setTimeout(res, 700));
  const fresh = (await (await fetch(`http://localhost:${PORT}/json/list`)).json())
    .filter((t) => t.type === 'page');
  const opener = fresh.find((t) => t.url.startsWith(ORIGIN) && !/atlas/i.test(t.title || ''));
  if(!opener){ console.error('  no app page to open the atlas from'); process.exit(1); }
  await withTarget(opener, (ws) => {
    send(ws, 1, 'Runtime.enable');
    // Clear prefs first, same reason qa-atlas.mjs does: openAtlas() reads them once.
    send(ws, 2, 'Runtime.evaluate', {
      expression: `localStorage.removeItem('atlas:prefs:v1'); window.openAtlas && window.openAtlas()`,
      userGesture: true,
    });
  });
  console.log('  opened    the atlas (view prefs cleared)');
}
