// tests/cdp.mjs
// Minimal Chrome DevTools Protocol client built only on Node built-ins.
// Node 24 provides a global WebSocket, so no puppeteer/playwright is needed.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Key descriptors for Input.dispatchKeyEvent. */
export const K = {
  space: { key: ' ', code: 'Space', vk: 32 },
  r: { key: 'r', code: 'KeyR', vk: 82 },
  a: { key: 'a', code: 'KeyA', vk: 65 },
  arrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
};

/**
 * Find the Chrome-for-Testing binary under the puppeteer cache.
 * Returns an absolute path, or null when it cannot be found.
 */
export function findChrome() {
  const base = '/home/nawo-ubuntu1/.cache/puppeteer/chrome';
  if (!existsSync(base)) return null;

  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === 'chrome' || entry.name === 'chrome.exe') {
        try {
          if (statSync(full).isFile()) found.push(full);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(base, 0);
  return found.sort()[0] || null;
}

/** Stop Chrome (and its process group on POSIX) and remove its temp profile. */
export function stopChrome(proc, userDataDir) {
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') proc.kill('SIGTERM');
      else process.kill(-proc.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    if (process.platform !== 'win32') {
      setTimeout(() => {
        try {
          process.kill(-proc.pid, 0); // still alive?
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 500).unref();
    }
  }
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Launch headless Chrome with remote debugging on an ephemeral port.
 * Resolves to { proc, userDataDir, port } or throws (caller reports SKIP).
 */
export async function launchChrome(chromePath) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'vv-cdp-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    'about:blank',
  ];

  // Chrome-for-Testing here keeps its shared libraries outside the system
  // paths; expose them so headless launch works without installing packages.
  const chromeLibDir = path.join(
    homedir(),
    '.local/share/chrome-deps/usr/lib/x86_64-linux-gnu'
  );
  const env = { ...process.env };
  if (existsSync(chromeLibDir)) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${chromeLibDir}:${env.LD_LIBRARY_PATH}`
      : chromeLibDir;
  }

  let proc;
  try {
    proc = spawn(chromePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    });
  } catch (err) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }

  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  proc.stdout?.resume();

  const spawnError = await new Promise((resolve) => {
    const onError = (err) => resolve(err);
    proc.once('error', onError);
    setTimeout(() => {
      proc.removeListener('error', onError);
      resolve(null);
    }, 600);
  });
  if (spawnError) {
    stopChrome(proc, userDataDir);
    throw spawnError;
  }

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !existsSync(portFile)) {
    if (proc.exitCode !== null) {
      stopChrome(proc, userDataDir);
      throw new Error(`Chrome exited early (code ${proc.exitCode}). ${stderr.slice(-800)}`);
    }
    await sleep(100);
  }
  if (!existsSync(portFile)) {
    stopChrome(proc, userDataDir);
    throw new Error(`DevToolsActivePort was not created. ${stderr.slice(-800)}`);
  }

  let port;
  try {
    port = Number.parseInt(readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim(), 10);
  } catch (err) {
    stopChrome(proc, userDataDir);
    throw err;
  }
  if (!Number.isInteger(port) || port <= 0) {
    stopChrome(proc, userDataDir);
    throw new Error(`Invalid debugging port: ${port}. ${stderr.slice(-800)}`);
  }
  return { proc, userDataDir, port };
}

/** id-correlated request/response CDP client with event listeners. */
export class CDPClient {
  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try {
            fn(msg.params);
          } catch {
            /* a listener must never break the client */
          }
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function connectWebSocket(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('WebSocket connect timeout'));
    }, timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${event.message || 'unknown'}`));
      },
      { once: true }
    );
  });
}

/** Poll /json/list until a page target appears, then connect to it. */
export async function connectPage(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  if (!page) {
    throw new Error(`No page target found${lastError ? `: ${lastError.message}` : ''}`);
  }
  const ws = await connectWebSocket(page.webSocketDebuggerUrl);
  return new CDPClient(ws, page);
}

/** Runtime.evaluate with awaitPromise/returnByValue, surfacing page exceptions. */
export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception?.description || details.text || 'unknown';
    throw new Error(`Runtime.evaluate failed: ${description}`);
  }
  return result.result?.value;
}

export async function keyDown(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers: 0,
  });
}

export async function keyUp(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers: 0,
  });
}

export async function press(cdp, key) {
  await keyDown(cdp, key);
  await sleep(40);
  await keyUp(cdp, key);
}
