# Vector Volley — implementation plan

Greenfield build. Two source docs are authoritative:

- `docs/vector-volley.md` — base spec (controls, rules, 3D projection, file layout, sim step, size budget, acceptance checks 1–4).
- `docs/vector-volley-amendment.md` — graphics/scoreboard/restart additions, DPR scaling, interpolation, reduced motion, acceptance checks 1–4.

Deliverable: three offline files at repo root — `index.html`, `style.css`, `game.js` — under 50 KB combined, no external requests, opens via `file://` (classic deferred script).

## Shared DOM contract (authoritative — both work streams must match)

HTML structure used by `game.js` (IDs and classes are fixed):

```html
<div id="scoreboard" class="scoreboard">
  <div class="player player--near">
    <span class="player__label">P1 · Near · A/D</span>
    <span class="stripes" aria-hidden="true"><i></i></span>
    <span id="score-near" class="score">0</span>
  </div>
  <button id="restart" type="button">Restart</button>
  <div class="player player--far">
    <span id="score-far" class="score">0</span>
    <span class="stripes stripes--double" aria-hidden="true"><i></i><i></i></span>
    <span class="player__label">P2 · Far · ←/→</span>
  </div>
</div>
<p id="status" class="status" role="status" aria-live="polite">New match. Space to serve.</p>
<p class="legend">First to 5 · Space: serve / resume / replay · R: restart · A/D and ←/→: move</p>
<canvas id="court" tabindex="0" aria-label="Vector Volley court"></canvas>
```

- IDs consumed by JS: `score-near`, `score-far`, `restart`, `status`, `court`.
- JS toggles class `score--pulse` on a score span for the goal highlight; CSS provides the keyframes and disables them under reduced motion.
- JS reads `canvas.clientWidth`/`canvas.clientHeight` for CSS pixel size and sets the backing buffer to `size * min(devicePixelRatio, 2)`.
- JS reads `matchMedia('(prefers-reduced-motion: reduce)').matches` at runtime (no page reload needed).
- The Restart button is a native `<button>` with a visible `:focus-visible` ring. On activation JS returns focus to the canvas.
- All handled keys (`a`, `d`, arrows, space, `r`) are `preventDefault()`ed by JS when the game has focus so the page does not scroll.

## Work streams

### Stream A — `index.html` + `style.css` (one sub agent)

- Build the exact DOM contract above. Deferred classic script: `<script src="game.js" defer></script>`; link `style.css`. No external URLs, fonts, CDNs, or images.
- High-contrast dark theme, system font stack, cyan (near) and amber (far) accents, fixed-width tabular score digits.
- Layout: scoreboard + status + legend above the canvas; canvas fills remaining viewport. Restart sits beside the scores on wide screens and wraps below on narrow ones. Responsive from wide to square windows; scoreboard, status and both paddle renderings must stay visible.
- Stripes rendered in CSS (one bar for near, two for far) beside the scoreboard labels.
- Visible focus ring on the button; reduced-motion media query disables score pulse/transitions.

### Stream B — `game.js` (one sub agent, full implementation all sections)

Implement in this order; all geometry generated in code with Canvas 2D only:

1. **Constants & state.** Court 12 wide × 20 long; paddle 3 wide, clamped inside side walls; paddle speed 9 u/s; ball speed 8 u/s; fixed `SIM_STEP = 1/120`; first-to-5; max deflection 45°. Modes: `ready`, `rally`, `between`, `paused`, `over`. State holds scores, winner, serve direction, ball & paddle `prev`/`curr` world positions, ball velocity, accumulator, last timestamp, effects (trail samples, contact rings), paused-from mode, reduced-motion flag.
2. **Input.** Track held keys in a `Set` so both players move on one frame; opposite keys on one paddle cancel. Ignore `e.repeat` for Space and R. `blur`/`visibilitychange` clears held keys and pauses; Space resumes from saved positions. Space: serve in `ready`/`between`, resume when `paused`, replay (reset + immediate serve) when `over`. R: restart any time. Button and R route through one `resetMatch()`.
3. **Camera & projection.** X = left/right, Y = height, Z = depth. Camera centered behind near paddle, raised and tilted toward midcourt. Transform world vertex → camera space → perspective divide → canvas coordinates. Near paddle must appear wider than the identically sized far paddle. At every resize compute projected bounds of the four court corners and derive scale/offset (with margin) so all corners fit in both wide and square windows. Cache the projected grid path; rebuild only on resize.
4. **Geometry.** Court as rectangular grid (faint lines fading toward far end, brighter perimeter); paddles as low wireframe boxes (near = single stripe, far = double stripe; near cyan, far amber); ball as wireframe octahedron (bright white outline) with a dim floor shadow ellipse.
5. **Simulation.** `requestAnimationFrame` with accumulator and fixed 1/120 steps; clamp frame delta to avoid a jump after tab switches. Ball travels along the floor; bounce off X side walls. When the ball crosses a paddle's front face, test horizontal overlap at the crossing point allowing for ball radius, and test only the paddle being approached so a hit registers once. Center hit → straight back; edge hit → deflection up to 45°; constant speed preserved. Miss → award a point, update DOM score immediately, pulse the scorer, set status (`P1 scores. 2–1. Space to serve.`), reset paddles/ball, wait for Space aimed at the player who missed. Fifth point → winner + final score in status until replay/restart; scoring stops.
6. **Interpolation & render.** Store prev/current world positions; each frame lerp by `accumulator / SIM_STEP` then project. Scale context once after each resize so line widths are in CSS pixels. Draw order: floor grid → perimeter → shadow → contact rings → paddles → trail → ball (ball above rings). Trail = up to four fading outlines sampled from the last 80 ms; at serve/reset set both interpolation positions to spawn and empty the trail. Contact ring expands/fades over 120 ms at confirmed hits. Freeze effect timers while paused. Reduced motion omits trails, rings and score pulses.
7. **Reset/replay.** Single `resetMatch()`: zero scores, clear winner/serve direction/velocity/input/interpolation history/accumulator/effects, center both paddles and ball, update scoreboard, status `New match. Space to serve.`, return focus to canvas. Reuse the existing animation loop. Replay from `over` resets then serves immediately.
8. **Self-check.** `node --check game.js`, then confirm no external URLs and that logic matches both docs.

## Integration & verification (main agent, after both streams land)

- Combined size of the three files < 50 KB (`wc -c`).
- `node --check game.js`; HTML sanity (IDs/canvas/defer present).
- Headless browser smoke test if a browser is available: render wide + square, no external requests, start a rally, score, restart, pause/resume, reduced motion.
- Cross-check acceptance checks in both docs.

## Execution order

1. Launch Stream A and Stream B sub agents in parallel (disjoint files, shared DOM contract above).
2. Integrate, run verification, fix any contract mismatch or defect.
3. Report result with file sizes and verification evidence.
