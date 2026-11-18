/*
 * Vector Volley — game engine (Stream B).
 *
 * Plain browser JavaScript, classic deferred script, no modules, no builds,
 * no external requests. Owns input, match state, the fixed-step simulation,
 * the perspective camera/projection and all Canvas 2D drawing.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ //
  // 1. Constants                                                        //
  // ------------------------------------------------------------------ //
  const COURT_W = 12;
  const COURT_L = 20;
  const HALF_W = COURT_W / 2;          // 6  — side walls at x = +/-6
  const HALF_L = COURT_L / 2;          // 10 — end lines at z = +/-10

  const PADDLE_W = 3;
  const PADDLE_DEPTH = 0.6;
  const PADDLE_H = 0.5;
  const PADDLE_SPEED = 9;              // units / second
  const MAX_PADDLE_X = HALF_W - PADDLE_W / 2; // 4.5 (clamped inside walls)

  const BALL_SPEED = 9;                // units / second, kept constant
  const BALL_RADIUS = 0.3;
  const BALL_Y = BALL_RADIUS;          // octahedron sits on the floor

  const SIM_STEP = 1 / 120;            // fixed simulation step
  const MAX_FRAME_DELTA = 0.05;        // clamp long tab-switch gaps
  const MAX_STEPS = 8;                 // avoid spiral of death

  const WIN_SCORE = 5;
  const MAX_DEFLECTION = Math.PI / 4;  // 45 degrees
  const SERVE_ANGLE = Math.PI / 9;     // ~20 degrees, a "slight angle"

  // Paddle front faces (toward midcourt). Ball is tested here.
  const NEAR_FACE = -HALF_L + PADDLE_DEPTH; // -9.4
  const FAR_FACE = HALF_L - PADDLE_DEPTH;   //  9.4
  const NEAR_CENTER_Z = (-HALF_L + NEAR_FACE) / 2; // -9.7
  const FAR_CENTER_Z = (FAR_FACE + HALF_L) / 2;    //  9.7

  // Camera: behind the near paddle, raised, tilted toward midcourt.
  const CAM_Y = 9;
  const CAM_BACK = 16;                 // camera at z = -CAM_BACK
  const CAM_LEN = Math.hypot(CAM_Y, CAM_BACK);
  const SIN_PITCH = CAM_Y / CAM_LEN;
  const COS_PITCH = CAM_BACK / CAM_LEN;

  // Floor grid.
  const GRID_X = 12;
  const GRID_Z = 20;
  const FADE_BANDS = 8;
  const GRID_ALPHA_NEAR = 0.32;
  const GRID_ALPHA_FAR = 0.06;

  // Effect lifetimes (seconds of simulation time).
  const TRAIL_LIFE = 0.08;             // 80 ms
  const RING_LIFE = 0.12;              // 120 ms
  const TRAIL_INTERVAL_STEPS = 2;      // ~16.7 ms sampling

  const HANDLED_KEYS = new Set([
    'a', 'd', 'arrowleft', 'arrowright', ' ', 'spacebar', 'r'
  ]);

  // ------------------------------------------------------------------ //
  // 2. DOM + state                                                      //
  // ------------------------------------------------------------------ //
  const canvas = document.getElementById('court');
  const ctx = canvas.getContext('2d');
  const scoreNearEl = document.getElementById('score-near');
  const scoreFarEl = document.getElementById('score-far');
  const restartBtn = document.getElementById('restart');
  const statusEl = document.getElementById('status');

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const heldKeys = new Set();

  function centeredPaddle(z) {
    return {
      prev: { x: 0, y: 0, z: z },
      curr: { x: 0, y: 0, z: z }
    };
  }

  const state = {
    mode: 'ready',                 // ready | rally | between | paused | over
    scores: { near: 0, far: 0 },
    winner: null,                  // 'near' | 'far' | null
    serveTarget: 'near',           // who the next serve travels toward
    serveSide: 1,                  // +1 / -1, alternates the serve angle
    ball: {
      prev: { x: 0, y: BALL_Y, z: 0 },
      curr: { x: 0, y: BALL_Y, z: 0 },
      vx: 0, vz: 0
    },
    paddles: {
      near: centeredPaddle(NEAR_CENTER_Z),
      far: centeredPaddle(FAR_CENTER_Z)
    },
    accumulator: 0,
    lastTimestamp: null,
    simTime: 0,
    trail: [],                     // { x, z, t }
    rings: [],                     // { x, y, z, born }
    trailTick: 0,
    pausedFrom: null,
    reducedMotion: motionQuery.matches,
    // projection cache, rebuilt only on resize
    proj: { scale: 1, ox: 0, oy: 0 },
    gridPaths: [],
    perimeterPath: null,
    cssWidth: 1,
    cssHeight: 1
  };

  // ------------------------------------------------------------------ //
  // Small helpers                                                       //
  // ------------------------------------------------------------------ //
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function label(side) { return side === 'near' ? 'P1' : 'P2'; }

  function setStatus(message) { statusEl.textContent = message; }

  function updateScoreboard() {
    scoreNearEl.textContent = String(state.scores.near);
    scoreFarEl.textContent = String(state.scores.far);
  }

  function pulseScore(side) {
    if (state.reducedMotion) return;
    const el = side === 'near' ? scoreNearEl : scoreFarEl;
    el.classList.remove('score--pulse');
    void el.offsetWidth;           // force reflow so the animation restarts
    el.classList.add('score--pulse');
  }

  function clearPulse() {
    scoreNearEl.classList.remove('score--pulse');
    scoreFarEl.classList.remove('score--pulse');
  }

  // ------------------------------------------------------------------ //
  // 3. Camera & projection                                              //
  // ------------------------------------------------------------------ //
  // World vertex -> camera coordinates -> perspective divide.
  // Focal length is folded into the resize-derived scale.
  function projectRaw(x, y, z) {
    const dy = y - CAM_Y;
    const dz = z + CAM_BACK;       // camera sits at z = -CAM_BACK
    const cx = x;                  // right axis = world +X
    const cy = dy * COS_PITCH + dz * SIN_PITCH; // camera up
    const cz = -dy * SIN_PITCH + dz * COS_PITCH; // forward depth (>0)
    return { sx: cx / cz, sy: -cy / cz };
  }

  function project(x, y, z) {
    const r = projectRaw(x, y, z);
    return {
      x: state.proj.ox + state.proj.scale * r.sx,
      y: state.proj.oy + state.proj.scale * r.sy
    };
  }

  // Fit all four floor corners inside the canvas with a margin. Works for
  // wide and square viewports alike because scale is the min of both axes.
  function computeProjection(w, h) {
    const corners = [
      projectRaw(-HALF_W, 0, -HALF_L),
      projectRaw(HALF_W, 0, -HALF_L),
      projectRaw(-HALF_W, 0, HALF_L),
      projectRaw(HALF_W, 0, HALF_L)
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      if (c.sx < minX) minX = c.sx;
      if (c.sx > maxX) maxX = c.sx;
      if (c.sy < minY) minY = c.sy;
      if (c.sy > maxY) maxY = c.sy;
    }
    const margin = Math.max(12, Math.min(w, h) * 0.05);
    const availW = Math.max(1, w - 2 * margin);
    const availH = Math.max(1, h - 2 * margin);
    const scale = Math.min(availW / (maxX - minX), availH / (maxY - minY));
    state.proj.scale = scale;
    state.proj.ox = w / 2 - scale * (minX + maxX) / 2;
    state.proj.oy = h / 2 - scale * (minY + maxY) / 2;
  }

  // Cache the projected grid (in depth bands for the far-end fade) and the
  // brighter perimeter. Rebuilt only on resize.
  function buildGridPaths() {
    const bands = [];
    for (let i = 0; i < FADE_BANDS; i++) bands.push(new Path2D());

    function addSegment(x1, z1, x2, z2) {
      const z = (z1 + z2) / 2;
      const t = (z + HALF_L) / COURT_L;          // 0 near .. 1 far
      const bi = clamp(Math.floor(t * FADE_BANDS), 0, FADE_BANDS - 1);
      const a = project(x1, 0, z1);
      const b = project(x2, 0, z2);
      bands[bi].moveTo(a.x, a.y);
      bands[bi].lineTo(b.x, b.y);
    }

    // Long lines (along Z), segmented so the fade can vary by depth.
    for (let xi = 0; xi <= GRID_X; xi++) {
      const x = -HALF_W + xi * (COURT_W / GRID_X);
      for (let zi = 0; zi < GRID_Z; zi++) {
        const z1 = -HALF_L + zi * (COURT_L / GRID_Z);
        const z2 = -HALF_L + (zi + 1) * (COURT_L / GRID_Z);
        addSegment(x, z1, x, z2);
      }
    }
    // Cross lines (along X).
    for (let zi = 0; zi <= GRID_Z; zi++) {
      const z = -HALF_L + zi * (COURT_L / GRID_Z);
      addSegment(-HALF_W, z, HALF_W, z);
    }

    state.gridPaths = bands.map(function (path, i) {
      const f = FADE_BANDS > 1 ? i / (FADE_BANDS - 1) : 0;
      return { path: path, alpha: lerp(GRID_ALPHA_NEAR, GRID_ALPHA_FAR, f) };
    });

    const peri = new Path2D();
    const ring = [
      [-HALF_W, -HALF_L], [HALF_W, -HALF_L],
      [HALF_W, HALF_L], [-HALF_W, HALF_L], [-HALF_W, -HALF_L]
    ];
    ring.forEach(function (pt, i) {
      const p = project(pt[0], 0, pt[1]);
      if (i === 0) peri.moveTo(p.x, p.y);
      else peri.lineTo(p.x, p.y);
    });
    state.perimeterPath = peri;
  }

  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    // Scale once so every subsequent line width is in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.cssWidth = w;
    state.cssHeight = h;
    computeProjection(w, h);
    buildGridPaths();
  }

  // ------------------------------------------------------------------ //
  // 4. Simulation                                                       //
  // ------------------------------------------------------------------ //
  function centerObjects() {
    const b = state.ball;
    b.prev.x = b.curr.x = 0;
    b.prev.y = b.curr.y = BALL_Y;
    b.prev.z = b.curr.z = 0;
    b.vx = b.vz = 0;

    const n = state.paddles.near, f = state.paddles.far;
    n.prev.x = n.curr.x = 0;
    n.prev.z = n.curr.z = NEAR_CENTER_Z;
    f.prev.x = f.curr.x = 0;
    f.prev.z = f.curr.z = FAR_CENTER_Z;

    state.trail.length = 0;
    state.rings.length = 0;
    state.trailTick = 0;
  }

  function movePaddle(paddle, dir, dt) {
    paddle.prev.x = paddle.curr.x;
    paddle.prev.z = paddle.curr.z;
    if (dir !== 0) {
      paddle.curr.x = clamp(
        paddle.curr.x + dir * PADDLE_SPEED * dt,
        -MAX_PADDLE_X, MAX_PADDLE_X
      );
    }
  }

  function movePaddles(dt) {
    // Opposite keys cancel because dir = 1 - 1 = 0. Held keys live in a Set,
    // so both players move on the very same frame.
    const nearDir = (heldKeys.has('d') ? 1 : 0) - (heldKeys.has('a') ? 1 : 0);
    const farDir = (heldKeys.has('arrowright') ? 1 : 0) -
                   (heldKeys.has('arrowleft') ? 1 : 0);
    movePaddle(state.paddles.near, nearDir, dt);
    movePaddle(state.paddles.far, farDir, dt);
  }

  function sampleTrail() {
    if (state.reducedMotion) return;
    state.trailTick++;
    if (state.trailTick % TRAIL_INTERVAL_STEPS !== 0) return;
    const b = state.ball;
    state.trail.push({ x: b.curr.x, z: b.curr.z, t: state.simTime });
    while (state.trail.length > 4) state.trail.shift();
    while (state.trail.length && state.simTime - state.trail[0].t > TRAIL_LIFE) {
      state.trail.shift();
    }
  }

  function awardPoint(scorer, missedBy) {
    state.scores[scorer] += 1;
    updateScoreboard();             // digits update immediately
    pulseScore(scorer);

    // Clear motion + effects whether the point ended the match or not.
    state.ball.vx = state.ball.vz = 0;
    state.trail.length = 0;
    state.rings.length = 0;

    if (state.scores[scorer] >= WIN_SCORE) {
      state.winner = scorer;
      state.mode = 'over';
      centerObjects();
      setStatus(label(scorer) + ' wins ' + state.scores.near + '\u2013' +
        state.scores.far + '. Space to replay or R to restart.');
    } else {
      state.mode = 'between';
      state.serveTarget = missedBy; // serve toward the player who missed
      centerObjects();
      setStatus(label(scorer) + ' scores. ' + state.scores.near + '\u2013' +
        state.scores.far + '. Space to serve.');
    }
  }

  function checkPaddleHit(which) {
    const b = state.ball;
    const faceZ = which === 'near' ? NEAR_FACE : FAR_FACE;
    const prevZ = b.prev.z, currZ = b.curr.z;
    const denom = prevZ - currZ;
    const t = denom !== 0 ? clamp((prevZ - faceZ) / denom, 0, 1) : 0;
    const crossX = lerp(b.prev.x, b.curr.x, t);
    const paddleX = state.paddles[which].curr.x;

    // Horizontal overlap at the crossing point, allowing for ball radius.
    const reach = PADDLE_W / 2 + BALL_RADIUS;
    if (Math.abs(crossX - paddleX) > reach) {
      awardPoint(which === 'near' ? 'far' : 'near', which);
      return;
    }

    // Center hit -> straight back. Edge hit -> up to 45 degrees.
    const offset = clamp((crossX - paddleX) / (PADDLE_W / 2), -1, 1);
    const angle = offset * MAX_DEFLECTION;
    const dirZ = which === 'near' ? 1 : -1; // send it away from this paddle
    b.vx = BALL_SPEED * Math.sin(angle);
    b.vz = dirZ * BALL_SPEED * Math.cos(angle); // constant speed
    // Place the ball just past the face in its new direction so the same
    // hit cannot register twice; only the approached paddle was tested.
    b.curr.x = crossX;
    b.curr.z = faceZ + dirZ * 0.001;

    if (!state.reducedMotion) {
      state.rings.push({ x: crossX, y: BALL_Y, z: faceZ, born: state.simTime });
    }
  }

  function moveBall(dt) {
    const b = state.ball;
    b.prev.x = b.curr.x;
    b.prev.z = b.curr.z;
    b.curr.x += b.vx * dt;
    b.curr.z += b.vz * dt;

    // Side-wall bounce (center reflects at wall minus radius).
    const wallX = HALF_W - BALL_RADIUS;
    if (b.curr.x > wallX) {
      b.curr.x = wallX - (b.curr.x - wallX);
      b.vx = -b.vx;
    } else if (b.curr.x < -wallX) {
      b.curr.x = -wallX + (-wallX - b.curr.x);
      b.vx = -b.vx;
    }

    // Test only the paddle the ball is approaching.
    if (b.vz < 0 && b.prev.z > NEAR_FACE && b.curr.z <= NEAR_FACE) {
      checkPaddleHit('near');
    } else if (b.vz > 0 && b.prev.z < FAR_FACE && b.curr.z >= FAR_FACE) {
      checkPaddleHit('far');
    }
  }

  function simulate(dt) {
    state.simTime += dt;
    if (state.mode === 'ready' || state.mode === 'between' ||
        state.mode === 'rally') {
      movePaddles(dt);
    }
    if (state.mode === 'rally') {
      moveBall(dt);
      if (state.mode === 'rally') sampleTrail(); // a miss may have ended it
    }
  }

  // ------------------------------------------------------------------ //
  // 5. Match flow / input                                               //
  // ------------------------------------------------------------------ //
  function rallyStatus() { setStatus('Rally \u2014 A/D \u00b7 \u2190/\u2192 to move.'); }

  function serve() {
    centerObjects();               // both interpolation positions = spawn
    const dirZ = state.serveTarget === 'near' ? -1 : 1;
    const angle = SERVE_ANGLE * state.serveSide;
    state.serveSide *= -1;
    state.ball.vx = BALL_SPEED * Math.sin(angle);
    state.ball.vz = dirZ * BALL_SPEED * Math.cos(angle);
    state.mode = 'rally';
    state.accumulator = 0;
    rallyStatus();
  }

  function resetMatch() {
    state.scores.near = 0;
    state.scores.far = 0;
    state.winner = null;
    state.serveTarget = 'near';
    state.serveSide = 1;
    state.mode = 'ready';
    state.pausedFrom = null;
    state.accumulator = 0;
    state.simTime = 0;
    heldKeys.clear();
    centerObjects();
    updateScoreboard();
    clearPulse();
    setStatus('New match. Space to serve.');
    canvas.focus();                // so the next Space serves exactly once
  }

  function onSpace() {
    switch (state.mode) {
      case 'ready':
      case 'between':
        serve();
        break;
      case 'paused':
        state.mode = state.pausedFrom || 'rally';
        state.pausedFrom = null;
        rallyStatus();
        break;
      case 'over':
        resetMatch();
        serve();                   // replay: reset, then serve immediately
        break;
      case 'rally':
      default:
        break;
    }
  }

  window.addEventListener('keydown', function (e) {
    const key = e.key.toLowerCase();
    if (HANDLED_KEYS.has(key)) e.preventDefault();

    if (key === ' ' || key === 'spacebar') {
      if (e.repeat) return;
      onSpace();
      return;
    }
    if (key === 'r') {
      if (e.repeat) return;
      resetMatch();
      return;
    }
    if (key === 'a' || key === 'd' ||
        key === 'arrowleft' || key === 'arrowright') {
      heldKeys.add(key);
    }
  });

  window.addEventListener('keyup', function (e) {
    const key = e.key.toLowerCase();
    if (HANDLED_KEYS.has(key)) e.preventDefault();
    heldKeys.delete(key);
  });

  function onFocusLost() {
    heldKeys.clear();              // no stuck key after a tab switch
    if (state.mode === 'rally') {
      state.pausedFrom = 'rally';
      state.mode = 'paused';
      setStatus('Paused. Space to resume.');
    }
  }

  window.addEventListener('blur', onFocusLost);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) onFocusLost();
  });

  restartBtn.addEventListener('click', function () {
    resetMatch();                  // button and R share one reset path
    canvas.focus();
  });

  function onMotionChange(e) {
    state.reducedMotion = e.matches;
    if (state.reducedMotion) {
      state.trail.length = 0;
      state.rings.length = 0;
      clearPulse();
    }
  }
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  // ------------------------------------------------------------------ //
  // 6. Drawing                                                          //
  // ------------------------------------------------------------------ //
  function interpPaddle(paddle, alpha) {
    return {
      x: lerp(paddle.prev.x, paddle.curr.x, alpha),
      z: lerp(paddle.prev.z, paddle.curr.z, alpha)
    };
  }

  function interpBall(alpha) {
    const b = state.ball;
    return {
      x: lerp(b.prev.x, b.curr.x, alpha),
      z: lerp(b.prev.z, b.curr.z, alpha)
    };
  }

  function octaPath(cx, cz) {
    const r = BALL_RADIUS;
    const px = project(cx + r, BALL_Y, cz);
    const nx = project(cx - r, BALL_Y, cz);
    const pz = project(cx, BALL_Y, cz + r);
    const nz = project(cx, BALL_Y, cz - r);
    const py = project(cx, BALL_Y + r, cz);
    const ny = project(cx, BALL_Y - r, cz);
    const eq = [px, pz, nx, nz];
    const path = new Path2D();
    for (let i = 0; i < 4; i++) {
      const a = eq[i], b = eq[(i + 1) % 4];
      path.moveTo(a.x, a.y); path.lineTo(b.x, b.y);
      path.moveTo(a.x, a.y); path.lineTo(py.x, py.y);
      path.moveTo(a.x, a.y); path.lineTo(ny.x, ny.y);
    }
    return path;
  }

  function drawShadow(b) {
    const c = project(b.x, 0, b.z);
    const ex = project(b.x + BALL_RADIUS * 1.6, 0, b.z);
    const ez = project(b.x, 0, b.z + BALL_RADIUS * 1.6);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(c.x, c.y,
      Math.max(2, Math.abs(ex.x - c.x)),
      Math.max(1, Math.abs(ez.y - c.y)),
      0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fill();
    ctx.restore();
  }

  function drawRings() {
    if (state.reducedMotion) return;
    for (let i = state.rings.length - 1; i >= 0; i--) {
      const ring = state.rings[i];
      const age = state.simTime - ring.born;
      if (age > RING_LIFE) { state.rings.splice(i, 1); continue; }
      const c = project(ring.x, 0.02, ring.z);
      const edge = project(ring.x + 0.3 + (age / RING_LIFE) * 1.6, 0.02, ring.z);
      const rx = Math.max(2, edge.x - c.x);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, Math.max(1, rx * 0.45), 0, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 220, 130, ' +
        (0.85 * (1 - age / RING_LIFE)).toFixed(3) + ')';
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPaddle(pos, which) {
    const cx = pos.x;
    const z0 = which === 'near' ? -HALF_L : FAR_FACE;
    const z1 = which === 'near' ? NEAR_FACE : HALF_L;
    const hw = PADDLE_W / 2;
    const y0 = 0, y1 = PADDLE_H;
    const V = function (x, y, z) { return project(x, y, z); };
    const b = [V(cx - hw, y0, z0), V(cx + hw, y0, z0),
               V(cx + hw, y0, z1), V(cx - hw, y0, z1)];
    const t = [V(cx - hw, y1, z0), V(cx + hw, y1, z0),
               V(cx + hw, y1, z1), V(cx - hw, y1, z1)];
    const rgb = which === 'near' ? '56, 232, 255' : '255, 182, 72';

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(' + rgb + ', 0.85)';
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      ctx.moveTo(b[i].x, b[i].y); ctx.lineTo(b[j].x, b[j].y); // bottom rim
      ctx.moveTo(t[i].x, t[i].y); ctx.lineTo(t[j].x, t[j].y); // top rim
      ctx.moveTo(b[i].x, b[i].y); ctx.lineTo(t[i].x, t[i].y); // uprights
    }
    ctx.stroke();

    // Identification stripes on the top face: near = one, far = two.
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(' + rgb + ', 1)';
    ctx.beginPath();
    const stripes = which === 'near' ? 1 : 2;
    for (let s = 1; s <= stripes; s++) {
      const z = z0 + (z1 - z0) * (s / (stripes + 1));
      const a = V(cx - hw, y1, z), c = V(cx + hw, y1, z);
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawTrail() {
    if (state.reducedMotion) return;
    for (const s of state.trail) {
      const age = state.simTime - s.t;
      if (age > TRAIL_LIFE) continue;
      const alpha = 0.30 * (1 - age / TRAIL_LIFE);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(190, 235, 255, ' + alpha.toFixed(3) + ')';
      ctx.stroke(octaPath(s.x, s.z));
      ctx.restore();
    }
  }

  function drawBall(b) {
    const center = project(b.x, BALL_Y, b.z);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.stroke(octaPath(b.x, b.z));
    ctx.beginPath();
    ctx.arc(center.x, center.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.restore();
  }

  function render(alpha) {
    const w = state.cssWidth, h = state.cssHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#050b12';
    ctx.fillRect(0, 0, w, h);

    // Floor grid (fading toward the far end), then brighter perimeter.
    ctx.lineWidth = 1;
    for (const band of state.gridPaths) {
      ctx.strokeStyle = 'rgba(90, 170, 200, ' + band.alpha.toFixed(3) + ')';
      ctx.stroke(band.path);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(150, 225, 240, 0.9)';
    ctx.stroke(state.perimeterPath);

    const b = interpBall(alpha);
    const n = interpPaddle(state.paddles.near, alpha);
    const f = interpPaddle(state.paddles.far, alpha);

    drawShadow(b);
    drawRings();
    drawPaddle(n, 'near');
    drawPaddle(f, 'far');
    drawTrail();
    drawBall(b);                   // ball drawn last, above rings/trail
  }

  // ------------------------------------------------------------------ //
  // 7. Animation loop                                                   //
  // ------------------------------------------------------------------ //
  function frame(timestamp) {
    requestAnimationFrame(frame);  // one loop for the life of the page

    if (state.lastTimestamp === null) state.lastTimestamp = timestamp;
    let delta = (timestamp - state.lastTimestamp) / 1000;
    state.lastTimestamp = timestamp;
    if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;
    if (delta < 0) delta = 0;

    // While paused we do not advance simulation or effect timers.
    if (state.mode !== 'paused') {
      state.accumulator += delta;
      let steps = 0;
      while (state.accumulator >= SIM_STEP && steps < MAX_STEPS) {
        simulate(SIM_STEP);
        state.accumulator -= SIM_STEP;
        steps++;
      }
      if (steps >= MAX_STEPS) state.accumulator = 0;
    }

    const alpha = clamp(state.accumulator / SIM_STEP, 0, 1);
    render(alpha);
  }

  // ------------------------------------------------------------------ //
  // 8. Boot                                                             //
  // ------------------------------------------------------------------ //
  resize();
  resetMatch();
  requestAnimationFrame(frame);
})();
