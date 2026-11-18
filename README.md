# Vector Volley

A first-to-five paddle game for two players sharing one keyboard, played on a
glowing wireframe court. The ball travels along the court floor and an elevated
camera shows its depth while both paddles stay on screen.

## Controls

| Action | Keys |
| --- | --- |
| Move the near paddle (P1) | `A` / `D` |
| Move the far paddle (P2) | `←` / `→` |
| Serve / resume / replay | `Space` |
| Restart a fresh match | `R` or the **Restart** button |

Both players can move on the same frame. Opposite keys on one paddle cancel.
Switching tabs clears held keys and pauses; `Space` resumes.

## Match rules

The first serve leaves center toward the near player at a slight angle. A miss
awards a point to the other player, resets both paddles and the ball, and waits
for `Space` to serve toward the player who missed. A center paddle hit returns
the ball straight; an edge hit deflects up to 45°. At five points the winner and
final score stay on screen until replay or restart.

## Run

Open `index.html` directly in a browser, or serve the folder locally:

```sh
make serve      # http://localhost:8000
```

No build step, dependencies, or network access are required. `game.js` is loaded
as a classic deferred script so `file://` launches work.

## GitHub Pages

Live game: <https://nawodyaishan.github.io/vector-volley/>

The repository includes a Pages workflow that stages the three game files into
`site/` and deploys them on every push to `main`. Set **Settings → Pages →
Source: GitHub Actions** once; later pushes deploy automatically. The published
site is byte-for-byte the same three files used for a local launch.

Run `make site` to produce the same staging folder locally. The page carries
Open Graph and Twitter card metadata plus a 1200 × 630 `preview.png`, so shared
links render a rich preview in WhatsApp, Telegram, and social apps.

## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Canvas, scoreboard, status region, control legend |
| `style.css` | Responsive layout, high-contrast colors, system fonts |
| `game.js` | Input, match state, simulation, camera projection, drawing |
| `tests/` | Dependency-free black-box test suite |
| `docs/` | Technical spec, amendment, and implementation plan |

The three game files are kept under 50 KB combined.

## Development

```sh
make help       # list all targets
make check      # syntax-check game.js
make size       # check the 50 KB budget
make test       # run the test suite
make verify     # check + size + test
make clean      # remove local artifacts
```

Full requirements live in [`docs/vector-volley.md`](docs/vector-volley.md) and
[`docs/vector-volley-amendment.md`](docs/vector-volley-amendment.md).

## Credits

This project was created entirely using the `hy4-flash-free` model in OpenCode.
