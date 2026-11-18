#!/usr/bin/env node
// tests/run.mjs
// Dependency-free black-box test suite for Vector Volley.
//   node tests/run.mjs
// Optional: VECTOR_VOLLEY_ROOT=/path/to/build node tests/run.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  K,
  connectPage,
  evaluate,
  findChrome,
  keyDown,
  keyUp,
  launchChrome,
  press,
  sleep,
  stopChrome,
} from './cdp.mjs';

const ROOT = process.env.VECTOR_VOLLEY_ROOT
  ? path.resolve(process.env.VECTOR_VOLLEY_ROOT)
  : fileURLToPath(new URL('..', import.meta.url));
const GAME_FILES = ['index.html', 'style.css', 'game.js'];
const FILE_URL = `file://${path.join(ROOT, 'index.html')}`;
const READY_STATUS = 'New match. Space to serve.';

// ---------------------------------------------------------------------------
// Tiny reporter
// ---------------------------------------------------------------------------
let passes = 0;
let failures = 0;
let skips = 0;

const pass = (name, detail = '') => {
  passes++;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail = '') => {
  failures++;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, detail = '') => {
  skips++;
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
};
const check = (name, condition, detail = '') => (condition ? pass(name, detail) : fail(name, detail));

// ---------------------------------------------------------------------------
// 1. STATIC CHECKS
// ---------------------------------------------------------------------------
function runStaticChecks() {
  console.log('=== STATIC CHECKS ===');
  const texts = {};
  let allExist = true;

  for (const file of GAME_FILES) {
    const full = path.join(ROOT, file);
    const ok = existsSync(full) && statSync(full).isFile();
    check(`file exists: ${file}`, ok, full);
    if (!ok) {
      allExist = false;
      continue;
    }
    texts[file] = readFileSync(full, 'utf8');
  }

  if (allExist) {
    const total = GAME_FILES.reduce((sum, file) => sum + statSync(path.join(ROOT, file)).size, 0);
    check('combined size < 50 KB', total < 50 * 1024, `${total} bytes / ${50 * 1024} limit`);
  } else {
    skip('combined size < 50 KB', 'not all three files are present');
  }

  // Syntax check (only meaningful if game.js exists).
  if (existsSync(path.join(ROOT, 'game.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, 'game.js')], {
      encoding: 'utf8',
    });
    check('node --check game.js', result.status === 0, (result.stderr || '').trim() || 'syntax OK');
  } else {
    skip('node --check game.js', 'game.js is missing');
  }

  const html = texts['index.html'];
  if (html === undefined) {
    skip('index.html DOM contract checks', 'index.html is missing');
  } else {
    const linkTags = html.match(/<link\b[^>]*>/gi) || [];
    check(
      'index.html links style.css',
      linkTags.some(
        (tag) =>
          /rel\s*=\s*["']stylesheet["']/i.test(tag) && /href\s*=\s*["']style\.css["']/i.test(tag)
      )
    );

    const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
    const gameScript = scriptTags.find((tag) => /src\s*=\s*["']game\.js["']/i.test(tag));
    check(
      'index.html loads game.js as a classic deferred script',
      !!gameScript && /\bdefer\b/i.test(gameScript) && !/type\s*=\s*["']module["']/i.test(gameScript),
      gameScript || 'no game.js <script> tag'
    );

    const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
    for (const id of ['score-near', 'score-far', 'restart', 'status', 'court']) {
      check(`contract id present: #${id}`, ids.includes(id));
    }

    check('contract class present: stripes (index.html)', /\bstripes\b/.test(html));
    const combined = GAME_FILES.map((file) => texts[file] || '').join('\n');
    check('contract class present: score--pulse', combined.includes('score--pulse'));

    const canvasTag = (html.match(/<canvas\b[^>]*>/i) || [])[0];
    check('canvas has tabindex', !!canvasTag && /\btabindex\s*=/i.test(canvasTag));
    check(
      'canvas has aria-label',
      !!canvasTag && /\baria-label\s*=\s*["'][^"']+["']/i.test(canvasTag)
    );

    const statusTag = (html.match(/<[^>]*\bid\s*=\s*["']status["'][^>]*>/i) || [])[0];
    check('status has role="status"', !!statusTag && /\brole\s*=\s*["']status["']/i.test(statusTag));
    check(
      'status has aria-live="polite"',
      !!statusTag && /\baria-live\s*=\s*["']polite["']/i.test(statusTag)
    );
  }

  // No external URLs / CDNs / fonts / network references in any deliverable.
  // Canonical and link-preview tags contain one self-referential Pages URL;
  // crawlers read it, the browser never fetches it, so allow exactly that URL.
  const PREVIEW_URL = 'https://nawodyaishan.github.io/vector-volley/';
  const externalPatterns = [
    { re: /\bhttps?:\/\//i, label: 'http(s)://' },
    { re: /\bwss?:\/\//i, label: 'ws(s)://' },
    { re: /fonts\.(?:googleapis|gstatic)|cdnjs|jsdelivr|unpkg|googleapis/i, label: 'CDN/font host' },
    { re: /@import\b/i, label: 'CSS @import' },
    { re: /\b(?:src|href)\s*=\s*["']\/\//i, label: 'protocol-relative src/href' },
    { re: /\burl\(\s*["']?\/\//i, label: 'protocol-relative url()' },
  ];
  for (const file of GAME_FILES) {
    if (texts[file] === undefined) continue;
    const scan = file === 'index.html' ? texts[file].split(PREVIEW_URL).join('') : texts[file];
    const hits = [];
    for (const { re, label } of externalPatterns) {
      const match = scan.match(re);
      if (match) hits.push(`${label} (${match[0]})`);
    }
    check(`no external URLs in ${file}`, hits.length === 0, hits.join('; '));
  }

  // Link-preview metadata (WhatsApp, Telegram, Slack, social crawlers).
  const previewHtml = texts['index.html'] || '';
  const previewTags = [
    'og:type', 'og:title', 'og:description', 'og:url', 'og:image',
    'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt',
    'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image',
  ];
  for (const key of previewTags) {
    const attr = key.startsWith('twitter:') ? 'name' : 'property';
    const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["'][^"']+["']`, 'i');
    check(`preview meta ${key} present`, re.test(previewHtml));
  }
  check('preview meta og:image points at preview.png',
    /content=["']https:\/\/nawodyaishan\.github\.io\/vector-volley\/preview\.png["']/i.test(previewHtml));
  check('canonical link points at Pages URL',
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/nawodyaishan\.github\.io\/vector-volley\/["']/i.test(previewHtml));
  check('preview image exists and is 1200x630 PNG',
    existsSync(path.join(ROOT, 'preview.png')) &&
      readFileSync(path.join(ROOT, 'preview.png')).subarray(1, 4).toString() === 'PNG');
}

// ---------------------------------------------------------------------------
// 2. BROWSER CHECKS (Chrome DevTools Protocol, Node built-ins only)
// ---------------------------------------------------------------------------

// Read the whole black-box DOM state in one Runtime.evaluate call.
const READ_STATE = `(() => {
  const byId = (id) => document.getElementById(id);
  const near = byId('score-near');
  const far = byId('score-far');
  const status = byId('status');
  const c = byId('court');
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  let canvasHash = null;
  if (c && typeof c.toDataURL === 'function') {
    try { canvasHash = fnv(c.toDataURL('image/png')); } catch (err) { canvasHash = 'error: ' + err.message; }
  }
  return {
    near: near ? near.textContent.trim() : null,
    far: far ? far.textContent.trim() : null,
    status: status ? status.textContent.trim() : null,
    canvas: c ? {
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
      width: c.width,
      height: c.height,
      dpr: window.devicePixelRatio || 1
    } : null,
    canvasHash: canvasHash,
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null
  };
})()`;

const isBenignError = (text) => /favicon\.ico/i.test(text || '');
const isChromeBackground = (url) =>
  /(?:accounts\.google\.com|clients2\.google\.com|optimizationguide\.googleapis\.com|safebrowsing\.googleapis\.com|update\.googleapis\.com|chrome\.google\.com|edge\.microsoft\.com|browser\.extensions\.google\.com)/i.test(
    url
  );

async function readScores(cdp) {
  return evaluate(
    cdp,
    `({
      near: document.getElementById('score-near')?.textContent.trim() ?? null,
      far: document.getElementById('score-far')?.textContent.trim() ?? null
    })`
  );
}

async function waitForPoint(cdp, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const score = await readScores(cdp);
    if (score && (score.near !== '0' || score.far !== '0')) return score;
    await sleep(120);
  }
  return null;
}

async function focusCanvas(cdp) {
  await evaluate(cdp, `(() => { const c = document.getElementById('court'); if (c && c.focus) c.focus(); return true; })()`);
}

/** Serve, then park the near paddle at the wall so the rally ends in a point. */
async function scoreAPoint(cdp) {
  await focusCanvas(cdp);
  await press(cdp, K.space);
  await keyDown(cdp, K.a);
  await sleep(1300);
  await keyUp(cdp, K.a);
  return waitForPoint(cdp);
}

const isReadyState = (state) =>
  !!state && state.near === '0' && state.far === '0' && state.status === READY_STATUS;

async function runBrowserChecks() {
  console.log('\n=== BROWSER CHECKS (CDP) ===');

  const chromePath = findChrome();
  if (!chromePath) {
    skip('Chrome binary available', 'no Chrome found under ~/.cache/puppeteer/chrome — skipping browser section');
    return;
  }
  pass('Chrome binary available', chromePath);

  let session;
  try {
    session = await launchChrome(chromePath);
  } catch (err) {
    skip('launch headless Chrome / start CDP', err.message);
    return;
  }
  const { proc, userDataDir, port } = session;

  let cdp;
  try {
    cdp = await connectPage(port);
  } catch (err) {
    skip('connect to page target webSocketDebuggerUrl', err.message);
    stopChrome(proc, userDataDir);
    return;
  }
  pass('CDP connected to page target', `port ${port}`);

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const exceptions = [];
    const consoleErrors = [];
    const externalRequests = [];

    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const description = details.exception?.description || '';
      exceptions.push(`${details.text || 'Uncaught exception'}${description ? `: ${description}` : ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      if (!isBenignError(text)) consoleErrors.push(`console.error: ${text}`);
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level !== 'error' || isBenignError(entry.text)) return;
      consoleErrors.push(`log: ${entry.text || ''}${entry.url ? ` @ ${entry.url}` : ''}`);
    });
    cdp.on('Network.requestWillBeSent', (params) => {
      const url = params.request?.url || '';
      if (!/^https?:\/\//i.test(url) && !/^wss?:\/\//i.test(url)) return;
      if (isChromeBackground(url)) return;
      externalRequests.push(url);
    });

    const load = async (reload = false) => {
      const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
      if (reload) await cdp.send('Page.reload', { ignoreCache: true });
      else await cdp.send('Page.navigate', { url: FILE_URL });
      await Promise.race([loaded, sleep(8000)]);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        try {
          if ((await evaluate(cdp, 'document.readyState')) === 'complete') break;
        } catch {
          /* execution context may still be changing */
        }
        await sleep(100);
      }
      await sleep(250); // let the deferred script initialise and paint a frame
    };

    // ---- Initial load -----------------------------------------------------
    await load();

    check('no uncaught JS exceptions on load', exceptions.length === 0, exceptions.join(' | '));
    check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('no external (non-file://) network requests', externalRequests.length === 0, externalRequests.join(' | '));

    const initial = await evaluate(cdp, READ_STATE);
    check('initial score digits are 0 and 0', initial?.near === '0' && initial?.far === '0', `near=${initial?.near}, far=${initial?.far}`);
    check('initial status reads "New match. Space to serve."', initial?.status === READY_STATUS, initial?.status);

    const canvas = initial?.canvas;
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const expectedW = Math.round(canvas.clientWidth * Math.min(canvas.dpr, 2));
      const expectedH = Math.round(canvas.clientHeight * Math.min(canvas.dpr, 2));
      check(
        'canvas backing buffer = CSS size × min(devicePixelRatio, 2)',
        Math.abs(canvas.width - expectedW) <= 1 && Math.abs(canvas.height - expectedH) <= 1,
        `${canvas.width}x${canvas.height} vs ${expectedW}x${expectedH} (CSS ${canvas.clientWidth}x${canvas.clientHeight}, dpr ${canvas.dpr})`
      );
    } else {
      fail('canvas backing buffer = CSS size × min(devicePixelRatio, 2)', 'canvas missing or zero CSS size');
    }

    // ---- Space starts a rally --------------------------------------------
    await focusCanvas(cdp);
    const beforeSpace = await evaluate(cdp, READ_STATE);
    const errorBase = exceptions.length + consoleErrors.length;
    await press(cdp, K.space);
    await sleep(250);
    const afterSpace = await evaluate(cdp, READ_STATE);
    const changed =
      afterSpace?.status !== beforeSpace?.status || afterSpace?.canvasHash !== beforeSpace?.canvasHash;
    check(
      'Space starts a rally (status or canvas output changes)',
      changed,
      `status ${JSON.stringify(beforeSpace?.status)}→${JSON.stringify(afterSpace?.status)}, canvasHash ${beforeSpace?.canvasHash}→${afterSpace?.canvasHash}`
    );
    check('no JS errors while serving', exceptions.length + consoleErrors.length === errorBase);

    // ---- Scoring then R restart ------------------------------------------
    const scored = await scoreAPoint(cdp);
    check('a rally ends with a point', !!scored, scored ? JSON.stringify(scored) : 'no score within timeout');

    await press(cdp, K.r);
    await sleep(150);
    const afterR = await evaluate(cdp, READ_STATE);
    check('R resets digits to 0–0 and restores ready status', isReadyState(afterR), JSON.stringify({ near: afterR?.near, far: afterR?.far, status: afterR?.status }));

    // ---- Scoring then #restart button reset ------------------------------
    const scoredAgain = await scoreAPoint(cdp);
    check('rally produced a point before button restart', !!scoredAgain, scoredAgain ? JSON.stringify(scoredAgain) : 'no score within timeout');
    await evaluate(cdp, `document.getElementById('restart').click(); true`);
    await sleep(150);
    const afterButton = await evaluate(cdp, READ_STATE);
    check('clicking #restart resets digits and ready status', isReadyState(afterButton), JSON.stringify({ near: afterButton?.near, far: afterButton?.far, status: afterButton?.status }));

    // ---- Simultaneous keys ------------------------------------------------
    await focusCanvas(cdp);
    const heldErrorBase = exceptions.length + consoleErrors.length;
    await keyDown(cdp, K.a);
    await keyDown(cdp, K.arrowLeft);
    await sleep(150);
    await keyUp(cdp, K.a);
    await keyUp(cdp, K.arrowLeft);
    await sleep(50);
    check(
      'A + ArrowLeft can be held simultaneously without errors',
      exceptions.length + consoleErrors.length === heldErrorBase,
      `new errors: ${exceptions.length + consoleErrors.length - heldErrorBase}`
    );

    // ---- Reduced motion ---------------------------------------------------
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedBase = exceptions.length + consoleErrors.length;
    await load(true); // reload with reduced motion emulated

    check('reduced motion: page loads without JS errors', exceptions.length + consoleErrors.length === reducedBase, `new errors: ${exceptions.length + consoleErrors.length - reducedBase}`);
    check('reduced motion: no new external requests', externalRequests.length === 0, externalRequests.join(' | '));

    const reducedInitial = await evaluate(cdp, READ_STATE);
    check('reduced motion: starts at 0–0 with ready status', isReadyState(reducedInitial), JSON.stringify({ near: reducedInitial?.near, far: reducedInitial?.far, status: reducedInitial?.status }));

    const reducedScore = await scoreAPoint(cdp);
    check('reduced motion: scoring still works', !!reducedScore, reducedScore ? JSON.stringify(reducedScore) : 'no score within timeout');

    await press(cdp, K.r);
    await sleep(150);
    const reducedRestart = await evaluate(cdp, READ_STATE);
    check('reduced motion: restart still works', isReadyState(reducedRestart), JSON.stringify({ near: reducedRestart?.near, far: reducedRestart?.far, status: reducedRestart?.status }));

    check('reduced motion: no JS errors through scoring and restart', exceptions.length + consoleErrors.length === reducedBase, `new errors: ${exceptions.length + consoleErrors.length - reducedBase}`);
  } catch (err) {
    fail('browser check harness', err.stack || String(err));
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    stopChrome(proc, userDataDir);
  }
}

// ---------------------------------------------------------------------------
runStaticChecks();
await runBrowserChecks();

console.log(`\n=== SUMMARY: ${passes} PASS, ${failures} FAIL, ${skips} SKIP ===`);
process.exit(failures > 0 ? 1 : 0);
