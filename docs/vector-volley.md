# Vector Volley — technical spec and build plan

Two people share a keyboard and play a first-to-five paddle match on a glowing wireframe court. The ball travels along the court floor. An elevated camera shows its depth, with both paddles visible throughout the match.

## Controls and match rules

| Action | Keys |
| --- | --- |
| Move the near paddle left or right | A / D |
| Move the far paddle left or right | Left / Right arrow |
| Start a match, serve after a point, or replay after a win | Space |

Both players move left and right as seen on screen. Holding opposite directions on one paddle stops it. Track held keys in a set so both players can move on the same frame. Ignore repeated Space presses and prevent the game keys from scrolling the page while the game has focus. On focus loss, clear held keys and pause. Space resumes play.

- Start both paddles at the middle of their end lines. The first serve leaves the center toward the near player at a slight angle.
- Bounce the ball off the side walls. A paddle hit near its center sends the ball straight back. A hit near an edge deflects it by up to 45 degrees. Keep the ball speed constant.
- A miss awards one point to the other player. Reset the paddles and ball, then wait for Space to serve toward the player who missed. At five points, show the winner and offer a replay.

## World and animation

Use plain JavaScript and one Canvas 2D element. Define the court, paddles, and ball as 3D vertices joined by line segments. Draw the court as a rectangular grid, each paddle as a low box, and the ball as a small wireframe octahedron. Give the near paddle a single stripe and the far paddle two so players can identify them without relying on color.

Use X for left/right, Y for height, and Z for court depth. Keep the camera centered behind the near paddle, raised and tilted toward midcourt. Transform each vertex into camera coordinates, then project it onto the canvas using perspective division. The near paddle should appear wider than the equally sized far paddle. Resize the projection to keep all four court corners visible.

## Implementation

| File | Responsibility |
| --- | --- |
| index.html | Canvas, score, short control legend, and match status |
| style.css | Responsive court layout, high-contrast colors, and system fonts |
| game.js | Input, match state, simulation, camera projection, and drawing |

Start with a court 12 units wide and 20 units long. Make each paddle 3 units wide and clamp it inside the side walls. Use a fixed 1/120-second simulation step inside requestAnimationFrame. Move the paddles at 9 units per second and the ball at 8. When the ball crosses a paddle's front face, check horizontal overlap at the crossing point, allowing for the ball radius. Only test the paddle the ball is approaching so a hit registers once.

**Size budget.** Keep the three files under 50 KB combined before compression. Generate all geometry in code and use browser APIs throughout. The finished game should run by opening index.html directly or serving the same files from a static host. Use a classic deferred script so local launch works.

## Build plan and acceptance checks

1. **Draw the court.** Project the grid and the three game objects. Resize from a wide window to a square one. All corners and both paddles must remain visible.
2. **Wire up both players.** Hold D and Left together. The paddles must move toward opposite screen edges, and releasing one key must leave the other paddle moving.
3. **Finish a match.** Check a center hit, an edge hit, a wall bounce, and a miss. Play to five, verify that scoring stops, then press Space and confirm the score resets to 0–0.
4. **Check the lightweight build.** Open the game offline, confirm that it makes no external requests, and measure the combined file size. Target smooth 60 fps at 1280 × 720 on the development laptop. Switch tabs mid-rally and confirm play resumes without a jump or stuck key.
