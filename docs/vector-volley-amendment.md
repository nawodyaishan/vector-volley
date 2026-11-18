# Vector Volley amendment 01 — graphics, scoreboard, and restart

Companion to `vector-volley.md`. Two players share one keyboard in a first-to-five match. This amendment adds visual feedback, a persistent scoreboard, and a way to start over at any point. Ship the game as three offline files totaling under 50 KB uncompressed.

## 1. Make each rally easier to read

| Element | Implementation |
| --- | --- |
| Court | Use a dark floor with faint grid lines that fade toward the far end. Draw the perimeter brighter than the grid. Cache the projected grid path and rebuild it when the viewport changes. |
| Paddles | Draw cyan and amber wireframes. Repeat the near paddle’s single stripe and the far paddle’s double stripe beside their scoreboard labels. |
| Ball | Give the octahedron a bright white outline. Draw a small, dim ellipse on the floor beneath it to show its position in depth. Draw up to four fading outlines sampled from its last 80 ms of travel. |
| Contact | At each confirmed paddle hit, draw a thin ring at the contact point. Expand and fade it over 120 ms. Keep the ball visible above the ring. |

Size the canvas backing buffer to its CSS dimensions times the device pixel ratio, capped at 2. Scale the drawing context once after each resize so line widths are expressed in CSS pixels. Fit the court to the space below the scoreboard.

Keep physics at 120 updates per second. Store previous and current world positions for the ball and paddles. On each animation frame, interpolate between them using the fraction of the simulation step left in the accumulator, then project to screen coordinates. At a serve or reset, set both positions to the spawn point and empty the trail. Freeze effect timers while paused. When reduced motion is requested, omit trails, rings, and score pulses.

## 2. Display the scoreboard throughout the match

Place a compact HTML scoreboard above the canvas. Show **P1 · Near · A/D**, both scores in large fixed-width digits, **P2 · Far · ←/→**, and **First to 5**. Keep player order fixed throughout the match. Place the Restart button beside the score on wide screens and below it when space is tight.

Read both scores from match state. On a goal, increment the scorer once, immediately update the digits, and briefly highlight that player's score. Use a single polite live status region for messages such as “P1 scores. 2–1. Space to serve.” On the fifth point, show the winner and final score until replay or restart. During an active rally, keep instructions outside the court.

## 3. Restart and replay

| Input | Available when | Result |
| --- | --- | --- |
| Restart button or R | Ready, rally, between points, paused, or match over | Start a fresh match at 0–0 and wait for Space. |
| Space | Ready or between points | Serve according to the base rules. |
| Space | Paused during a rally | Resume from the saved positions. |
| Space | Match over | Replay by resetting the match and serving immediately. |

Route both restart inputs through one reset function. Reset scores, winner, serve direction, velocity, input state, interpolation history, timing accumulator, and effects. Center both paddles and the ball, update the scoreboard, and show “New match. Space to serve.” Reuse the existing animation loop. Ignore key repeats for R and Space. Give the native Restart button a visible focus indicator and return focus to the game after activation so the next Space serves exactly once.

## 4. Build order and acceptance checks

1. **Court and motion.** Add resolution scaling and interpolation first, then the trail and hit ring. In wide and square windows, check that the far ball remains legible, all corners fit, and a new serve leaves no line across the court.
2. **Scoreboard.** Score from both ends. Verify the correct digit changes once per miss, the fifth point ends the match, and resizing keeps the score and both paddles visible.
3. **Restart.** At 3–2, restart once by button and once by R in separate matches. Each time verify 0–0, centered objects, a stationary ball, and exactly one serve on Space. Repeat from pause and match over. Confirm Space replay also works after a win.
4. **Budget and input.** Open index.html offline and check the three-file size. On the development laptop, target 60 fps at 1280 × 720 during a 30-second rally. Check simultaneous A/D and arrow-key movement, then enable reduced motion and verify that scoring and restart still work.

## 5. Tuning

Ball speed is 9 units per second, up from 8 in the base spec. Paddle speed and
all other match rules are unchanged.
