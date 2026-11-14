# Visual QA without installing anything

Chrome is enough; there is no Playwright/Puppeteer and none is needed.

```
node datasets/serve.mjs
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-popup-blocking \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --window-size=1600,1000 about:blank

node datasets/qa/verify.mjs                      # 31 data invariants, ~1s
node datasets/qa/qa-atlas.mjs                    # 87 browser checks
node datasets/qa/qa-atlas.mjs --shot /tmp/a.png  # + a screenshot
node datasets/qa/qa-atlas.mjs --keep             # leave the windows open

node datasets/qa/qa-quiz.mjs                     # 45 checks: home (topic list) + cross-topic quiz/review + Meanwhile + cluster quiz + grader
node datasets/qa/topic-report.mjs                # what a reader would trip over in each topic (not pass/fail)
node datasets/qa/qa-quiz.mjs --shot /tmp/q.png
node datasets/qa/qa-topic.mjs                    # topic invariants + timeline layout, no browser
```

`window.__atlas` on the atlas window is a deliberate debug handle, exposing
`atlas, view, scale, visible, placements, filter, tier, depth`, the time-range
readouts `mode, modes, domain, ppyRange, atEdge, outside`, and
`select/focusNode/fit/zoom/setQuery/toggleCollapse/togglePin/goto/setMode/gotoStop`.

**Drive the view through that handle, not through synthetic wheel events.** Most of
a scatter plot is empty space, so wheeling at guessed coordinates lands on nothing
and you end up measuring a blank screen. `--shot` used to do exactly that and
produced blank screenshots reading `0 in view` for weeks; it now goes to the densest
entry that has an excerpt and waits for points to be in frame.

Things this cost time to learn:

- **Disable the HTTP cache** (`Network.setCacheDisabled`). Otherwise Chrome serves a
  cached `atlas.json` from the persistent `--user-data-dir` and your suite passes
  against data you already rebuilt.
- **Clear `localStorage` on the opener, before `openAtlas()`.** Prefs are read once at
  open time, so clearing them afterwards is too late. Leaked `collapsed`/`pinned`
  state silently inverts the pin and collapse tests.
- **Assert on the DOM with a poll, not a snapshot.** View state changes synchronously
  in the event handler; the DOM catches up in `paint()`, a frame later. A snapshot
  read passes or fails depending on timing.
- **If everything fails at once, check the server** — `curl -sf localhost:8777/`. A
  dead server surfaces as `ERR_CONNECTION_REFUSED` in the *page's* log, which the
  suite does not print, so it reads as a module error in your own code. The server
  dying between sessions is common; a stale tab then looks like an app that ignored
  your edits.
- `Runtime.evaluate` needs `userGesture: true`, or `window.open` is popup-blocked and
  the atlas never opens.
- The atlas is a separate **target**, not a frame; attach and use its own `sessionId`.
- Handle `Page.javascriptDialogOpening`; an unhandled `alert()` wedges the page.
- `--headless --screenshot --virtual-time-budget` hangs here. Use CDP.
- Count only nodes with `style.display !== 'none'` — the card layer keeps a hidden
  recycling pool attached to the DOM.
- Add `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"` for fast logic
  runs; drop it when you actually want to see the images.

For pure layout logic, a Node harness still beats screenshots: shim `window`,
`localStorage` and `document.createElement`, import the modules directly, and assert
invariants. It runs in about a second.

## Reloading from the terminal

Start the browser with a debug port — drop `--headless=new` when you want to *see* it:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-atlas \
  --disable-popup-blocking http://localhost:8777/ &
```

then:

```
node datasets/qa/reload.mjs                  # hard-reload; opens a tab if none is open
node datasets/qa/reload.mjs --atlas          # reload, then reopen the atlas popup
node datasets/qa/reload.mjs --url /quiz.html
CDP_PORT=9333 node datasets/qa/reload.mjs    # a different browser
```

It reloads with `ignoreCache`, which is **not optional after a rebuild** if you are
serving with Python: that sends `Last-Modified` and no `Cache-Control`, so Chrome
applies a heuristic freshness lifetime and serves a stale `atlas.json` from a disk
cache that survives in the `--user-data-dir`. This is not hypothetical — it is why
`qa-atlas.mjs` once reported 50/50 against data that was two builds old.
`datasets/serve.mjs` removes the cause.

> **`reload.mjs` only reloads a Chrome that has a debug port.** It defaults to
> `CDP_PORT=9334`, which is the throwaway `--user-data-dir=/tmp/chrome-atlas`
> instance the QA recipe launches — **not** the Chrome you have on screen. Running it
> while looking at your everyday browser reloads a window you cannot see and appears
> to do nothing. Either launch your visible Chrome with the flags above, or just hit
> `Cmd+Shift+R`.

For your everyday Chrome instead, AppleScript works but needs Automation permission
granted once in System Settings › Privacy & Security, and cannot bypass the cache:

```
osascript -e 'tell application "Google Chrome" to reload active tab of front window'
```
