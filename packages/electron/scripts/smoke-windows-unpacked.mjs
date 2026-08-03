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
const smokeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'piarium-win-smoke-'));
const userDataDir = path.join(smokeRoot, 'user-data');
const logPath = path.join(userDataDir, 'logs', 'main.log');
const child = spawn(appPath, [`--user-data-dir=${userDataDir}`], {
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

  const log = await readLog();
  if (!log.includes('[pi-runtime] ready')) throw new Error(`Pi runtime readiness was not logged.\n${log}`);
  const piVersion = log.match(/piVersion: '([^']+)'/)?.[1] ?? 'unknown';
  console.log(JSON.stringify({
    appPath,
    health: 'ok',
    piVersion,
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
