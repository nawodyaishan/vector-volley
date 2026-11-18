# Vector Volley test suite

Dependency-free, black-box tests for the three-file browser game at the repo root.

## Run

```sh
node tests/run.mjs
```

Requires Node 24 (uses the built-in global `WebSocket`). No `npm install`, no
puppeteer/playwright. Exits non-zero only when a real check fails; environment
problems produce `SKIP` lines.

You can point the suite at another build with `VECTOR_VOLLEY_ROOT=/path/to/build`.

## What is covered

### Static checks (`index.html`, `style.css`, `game.js`)

- All three deliverable files exist; combined byte size is under 50 KB.
- `node --check game.js` passes.
- `index.html` links `style.css` and loads `game.js` with a classic `defer`
  script (not a module).
- The DOM contract is present: IDs `score-near`, `score-far`, `restart`,
  `status`, `court`; classes `stripes` (HTML) and `score--pulse` (JS/CSS).
- `<canvas>` has `tabindex` and `aria-label`; `#status` has `role="status"`
  and `aria-live="polite"`.
- No external URLs, CDNs, fonts, `@import`, protocol-relative URLs, or other
  network references in any of the three files.

### Browser checks (Chrome DevTools Protocol)

Chrome for Testing is discovered under `~/.cache/puppeteer/chrome/`. If it is
missing, or headless Chrome / CDP cannot start, this whole section reports
`SKIP` and the static section still runs.

Chrome is launched with `--headless=new --no-sandbox --disable-gpu
--remote-debugging-port=0` and a temporary profile. The port is read from the
profile's `DevToolsActivePort` file, then the page target's
`webSocketDebuggerUrl` is used to enable `Runtime`, `Page`, `Network`, and
`Log`. All page interaction uses `Runtime.evaluate` (with `awaitPromise` and
`returnByValue`) and `Input.dispatchKeyEvent`. The Chrome process is killed and
its temp profile removed on exit.

Assertions:

- No uncaught JS exceptions or console errors on load (favicon 404s ignored).
- No non-`file://` network requests.
- Initial score digits are `0` / `0` and status is
  `New match. Space to serve.`.
- Canvas backing buffer equals CSS size × `min(devicePixelRatio, 2)`.
- `Space` starts a rally (status text or a hash of canvas pixels changes).
- A rally produces a point; `R` then resets to `0–0` and the ready status.
- A second point followed by a `#restart` click also resets to `0–0`.
- `A` and `ArrowLeft` can be held at the same time (`rawKeyDown`/`keyUp`)
  without errors.
- With `prefers-reduced-motion: reduce` emulated, the page reloads cleanly and
  scoring and restart still work without errors or external requests.

## Files

- `tests/run.mjs` — test runner, reporter, static and browser assertions.
- `tests/cdp.mjs` — minimal CDP client and Chrome lifecycle helpers.
- `tests/README.md` — this file.
