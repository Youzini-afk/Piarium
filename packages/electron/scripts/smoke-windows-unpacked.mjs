#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const electronDir = path.resolve(__dirname, '..');
const appPath = path.resolve(process.argv[2] ?? path.join(electronDir, 'dist', 'win-unpacked', 'Piarium.exe'));

if (process.platform !== 'win32') {
  throw new Error('The unpacked Windows smoke test must run on Windows.');
}
if (!existsSync(appPath)) {
  throw new Error(`Missing unpacked Piarium executable at ${appPath}`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEVTOOLS_REQUEST_TIMEOUT_MS = 5_000;
const LAYOUT_TOLERANCE_PX = 1;
const MAX_COMPOSER_FRAME_WIDTH_PX = 48 * 16;

const assertNear = (actual, expected, label) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > LAYOUT_TOLERANCE_PX) {
    throw new Error(`${label} expected ${expected}px, received ${actual}px.`);
  }
};

const connectDevTools = (webSocketDebuggerUrl) => new Promise((resolve, reject) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const connectionTimer = setTimeout(() => {
    socket.close();
    reject(new Error('Timed out connecting to the packaged renderer.'));
  }, DEVTOOLS_REQUEST_TIMEOUT_MS);
  const rejectConnection = () => {
    clearTimeout(connectionTimer);
    reject(new Error('Unable to connect to the packaged renderer.'));
  };

  socket.addEventListener('error', rejectConnection, { once: true });
  socket.addEventListener('open', () => {
    clearTimeout(connectionTimer);
    socket.removeEventListener('error', rejectConnection);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) request.reject(new Error('Packaged renderer disconnected.'));
      pending.clear();
    });

    resolve({
      close: () => socket.close(),
      evaluate: (expression) => new Promise((evaluateResolve, evaluateReject) => {
        const id = nextId;
        nextId += 1;
        const requestTimer = setTimeout(() => {
          pending.delete(id);
          evaluateReject(new Error('Timed out evaluating the packaged renderer.'));
        }, DEVTOOLS_REQUEST_TIMEOUT_MS);
        pending.set(id, {
          reject: (error) => {
            clearTimeout(requestTimer);
            evaluateReject(error);
          },
          resolve: (value) => {
            clearTimeout(requestTimer);
            evaluateResolve(value);
          },
        });
        try {
          socket.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { awaitPromise: true, expression, returnByValue: true },
          }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(requestTimer);
          evaluateReject(error);
        }
      }),
    });
  }, { once: true });
});

const waitForRenderer = async (userDataDir) => {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  let debugPort;
  for (let attempt = 0; attempt < 80 && debugPort === undefined; attempt += 1) {
    await delay(250);
    const activePort = await fsp.readFile(activePortPath, 'utf8').catch(() => '');
    const candidate = Number(activePort.split(/\r?\n/, 1)[0]);
    if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65_535) debugPort = candidate;
  }
  if (debugPort === undefined) throw new Error('Packaged renderer did not publish its DevTools port.');

  let target;
  for (let attempt = 0; attempt < 80 && target === undefined; attempt += 1) {
    await delay(250);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    }).then((response) => response.json()).catch(() => []);
    target = targets.find((candidate) => (
      candidate?.type === 'page'
      && typeof candidate.url === 'string'
      && candidate.url.startsWith('piarium-ui://app')
      && typeof candidate.webSocketDebuggerUrl === 'string'
    ));
  }
  if (!target) throw new Error('Packaged renderer did not expose a DevTools target.');

  const devTools = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    let lastState;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const evaluation = await devTools.evaluate(`(() => {
        const readElement = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return null;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
            borderTopWidth: Number.parseFloat(style.borderTopWidth) || 0,
          };
        };
        return {
          bodyText: document.body?.innerText?.slice(0, 4000) ?? '',
          href: window.location.href,
          layout: {
            closeControl: readElement('[data-window-control="close"]'),
            composerFrame: readElement('[data-pi-composer-input-frame="true"]'),
            composerShell: readElement('[data-pi-composer-shell="true"]'),
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            pendingDraft: document.querySelector('[data-pi-pending-draft="true"]') !== null,
          },
          ready: window.__piariumAppReady === true,
        };
      })()`);
      if (evaluation?.exceptionDetails) {
        throw new Error(`Packaged renderer evaluation failed: ${evaluation.exceptionDetails.text}`);
      }
      lastState = evaluation?.result?.value;
      if (lastState?.ready === true) {
        const layoutReady = lastState.layout?.closeControl && lastState.layout?.composerShell && lastState.layout?.composerFrame;
        if (layoutReady) return lastState;
      }
      if (/Minified React error|Maximum update depth|发生错误|Something went wrong/i.test(lastState?.bodyText ?? '')) {
        throw new Error(`Packaged renderer entered its error boundary.\n${lastState.bodyText}`);
      }
      await delay(250);
    }
    if (lastState?.ready === true) {
      throw new Error(`Packaged renderer became ready without the expected window and composer layout.\n${JSON.stringify(lastState, null, 2)}`);
    }
    throw new Error(`Packaged renderer did not become app-ready.\n${JSON.stringify(lastState, null, 2)}`);
  } finally {
    devTools.close();
  }
};

const profileSource = process.env.PIARIUM_SMOKE_PROFILE_SOURCE?.trim();
const profileSourcePath = profileSource ? path.resolve(profileSource) : null;
if (profileSourcePath && !existsSync(profileSourcePath)) {
  throw new Error(`Missing smoke profile source at ${profileSourcePath}`);
}
const smokeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'piarium-win-smoke-'));
const userDataDir = path.join(smokeRoot, 'user-data');
try {
  if (profileSourcePath) {
    await fsp.mkdir(userDataDir, { recursive: true });
    for (const entry of ['Local State', 'Local Storage', 'Preferences', 'Session Storage', 'settings.json']) {
      const source = path.join(profileSourcePath, entry);
      if (!existsSync(source)) continue;
      const destination = path.join(userDataDir, entry);
      const stat = await fsp.stat(source);
      if (stat.isDirectory()) await fsp.cp(source, destination, { recursive: true });
      else await fsp.copyFile(source, destination);
    }
  }
} catch (error) {
  await fsp.rm(smokeRoot, { recursive: true, force: true });
  throw error;
}
const logPath = path.join(userDataDir, 'logs', 'main.log');
const child = spawn(appPath, [
  `--user-data-dir=${userDataDir}`,
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
], {
  cwd: electronDir,
  stdio: 'ignore',
  windowsHide: true,
});
let spawnError;
child.once('error', (error) => {
  spawnError = error;
});

const readLog = async () => fsp.readFile(logPath, 'utf8').catch(() => '');

try {
  let port;
  for (let attempt = 0; attempt < 60 && port === undefined; attempt += 1) {
    await delay(500);
    if (spawnError) throw spawnError;
    const log = await readLog();
    const match = log.match(/server listening on 127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    if (child.exitCode !== null && port === undefined) {
      throw new Error(`Packaged Piarium exited before startup completed (code ${child.exitCode}).\n${log}`);
    }
  }
  if (port === undefined) throw new Error(`Packaged Piarium did not become ready.\n${await readLog()}`);

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthResponse = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!healthResponse.ok) throw new Error(`Packaged health check failed with HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (health?.status !== 'ok') throw new Error(`Packaged health check returned ${JSON.stringify(health)}`);

  const terminalResponse = await fetch(`${baseUrl}/api/terminal/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols: 80, cwd: electronDir, rows: 24 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!terminalResponse.ok) {
    throw new Error(`Packaged terminal create failed with HTTP ${terminalResponse.status}: ${await terminalResponse.text()}`);
  }
  const terminal = await terminalResponse.json();
  if (terminal?.status !== 'running' || typeof terminal.sessionId !== 'string') {
    throw new Error(`Packaged terminal returned ${JSON.stringify(terminal)}`);
  }

  const closeResponse = await fetch(`${baseUrl}/api/terminal/${encodeURIComponent(terminal.sessionId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  });
  if (!closeResponse.ok) throw new Error(`Packaged terminal close failed with HTTP ${closeResponse.status}`);
  const closed = await closeResponse.json();
  if (closed?.success !== true) throw new Error(`Packaged terminal close returned ${JSON.stringify(closed)}`);

  const renderer = await waitForRenderer(userDataDir);
  const layout = renderer.layout;
  if (!layout || !Number.isFinite(layout.innerWidth) || !Number.isFinite(layout.innerHeight)) {
    throw new Error(`Packaged renderer did not report viewport geometry: ${JSON.stringify(layout)}`);
  }
  if (!layout.closeControl) {
    throw new Error('Packaged renderer did not expose the Windows close control.');
  }
  const closeControlIsRight = layout.closeControl.left >= layout.innerWidth / 2;
  if (!profileSourcePath && !closeControlIsRight) {
    throw new Error(`Clean profile placed the Windows close control on the unexpected side: ${JSON.stringify(layout.closeControl)}`);
  }
  if (closeControlIsRight) {
    assertNear(layout.closeControl.right, layout.innerWidth, 'Right-side close control edge');
  }
  if (!layout.composerShell || !layout.composerFrame) {
    throw new Error(`Packaged renderer reported incomplete composer geometry: ${JSON.stringify(layout)}`);
  }
  if (!profileSourcePath && layout.pendingDraft !== true) {
    throw new Error('Clean packaged renderer did not open the pending Pi draft welcome state.');
  }
  assertNear(layout.composerShell.bottom, layout.innerHeight, 'Composer shell bottom edge');
  assertNear(layout.composerShell.borderTopWidth, 0, 'Composer shell top border');
  if (layout.composerFrame.width > MAX_COMPOSER_FRAME_WIDTH_PX + LAYOUT_TOLERANCE_PX) {
    throw new Error(`Composer frame is wider than the fork-derived 48rem column: ${layout.composerFrame.width}px.`);
  }
  const log = await readLog();
  if (!log.includes('[pi-runtime] ready')) throw new Error(`Pi runtime readiness was not logged.\n${log}`);
  const piVersion = log.match(/piVersion: '([^']+)'/)?.[1] ?? 'unknown';
  console.log(JSON.stringify({
    appPath,
    health: 'ok',
    layout,
    piVersion,
    profile: profileSource ? 'seeded' : 'clean',
    renderer: renderer.ready === true ? 'app-ready' : 'not-ready',
    terminal: 'create-close-ok',
  }, null, 2));
} finally {
  if (child.exitCode === null) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  await delay(500);
  await fsp.rm(smokeRoot, { recursive: true, force: true });
}
