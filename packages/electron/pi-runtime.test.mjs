import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDesktopPiRuntimeBroker,
  resolveElectronPiHostEntry,
} from './pi-runtime.mjs';

const source = (relativePath) => fs.readFile(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

test('resolves the unpacked Pi host entry in packaged apps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-electron-host-entry-'));
  const resourcesPath = path.join(root, 'resources');
  const unpackedEntry = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@piarium',
    'pi-host',
    'dist',
    'main.js',
  );
  await fs.mkdir(path.dirname(unpackedEntry), { recursive: true });
  await fs.writeFile(unpackedEntry, 'export {};\n');
  try {
    const resolved = resolveElectronPiHostEntry({
      packaged: true,
      resourcesPath,
      resolvedEntry: path.join(
        resourcesPath,
        'app.asar',
        'node_modules',
        '@piarium',
        'pi-host',
        'dist',
        'main.js',
      ),
    });
    assert.equal(resolved, unpackedEntry);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('fails closed when the packaged Pi host is absent', () => {
  assert.throws(
    () => resolveElectronPiHostEntry({
      packaged: true,
      resourcesPath: path.join(os.tmpdir(), 'piarium-missing-resources'),
      resolvedEntry: path.join(os.tmpdir(), 'piarium-missing-app.asar', 'main.js'),
    }),
    /Packaged Pi host is missing/,
  );
});

test('desktop broker handshakes with the compiled Pi host', async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-electron-broker-'));
  const events = [];
  const broker = createDesktopPiRuntimeBroker({
    agentDir,
    clientVersion: '0.1.0-test',
    emit: (event) => events.push(event),
    packaged: false,
    resolvedEntry: fileURLToPath(new URL('../pi-host/dist/main.js', import.meta.url)),
    resourcesPath: '',
  });
  try {
    const handshake = await broker.warmup();
    assert.equal(handshake.protocolVersion, 1);
    assert.equal(handshake.runtime.piVersion, '0.83.0');
  } finally {
    await broker.dispose();
    assert.ok(events.some((event) => event.kind === 'worker.exit' && event.expected));
    await fs.rm(agentDir, { force: true, recursive: true });
  }
});

test('Electron startup and shutdown own the Pi runtime lifecycle', async () => {
  const main = await source('./main.mjs');
  assert.match(main, /await ensurePiRuntime\(\)/);
  assert.match(
    main,
    /await killSidecar\(\);[\s\S]*await shutdownPiRuntime\(\);/,
  );
  assert.match(main, /await ensurePiRuntime\(\);[\s\S]*piRuntimeBroker: state\.piRuntimeBroker/);
  assert.match(main, /await shutdownBackgroundServices\(\);[\s\S]*app\.exit\(1\)/);
});
