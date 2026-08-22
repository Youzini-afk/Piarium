import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PIARIUM_PROTOCOL_VERSION } from '@piarium/protocol';
import {
  createDesktopPiRuntimeBroker,
  resolveElectronPiHostEntry,
} from './pi-runtime.mjs';

const source = (relativePath) => fs.readFile(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

// The bundled Pi version is declared once, in the host package. Read it here instead of repeating
// the literal, so upgrading the runtime does not mean hunting for copies of the number in tests.
const pinnedPiVersion = () => {
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('../pi-host/package.json', import.meta.url)),
    'utf8',
  ));
  const version = manifest.devDependencies?.['@earendil-works/pi-coding-agent'];
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'pi-host must pin an exact Pi version');
  return version;
};

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
    'host-bootstrap.js',
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
        'host-bootstrap.js',
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
    resolvedEntry: fileURLToPath(new URL('../pi-host/dist/host-bootstrap.js', import.meta.url)),
    resourcesPath: '',
  });
  try {
    const handshake = await broker.warmup();
    assert.equal(handshake.protocolVersion, PIARIUM_PROTOCOL_VERSION);
    assert.equal(handshake.runtime.piVersion, pinnedPiVersion());
  } finally {
    await broker.dispose();
    assert.ok(events.some((event) => event.kind === 'worker.exit' && event.expected));
    await fs.rm(agentDir, { force: true, recursive: true });
  }
});

test('Electron startup and shutdown own the Pi runtime lifecycle', async () => {
  const main = await source('./main.mjs');
  assert.match(main, /requirePiRuntime: false/);
  assert.match(main, /createPiRuntimeBroker:/);
  assert.doesNotMatch(main, /await ensurePiRuntime\(\);[\s\S]*startWebUiServer/);
  assert.match(
    main,
    /await killSidecar\(\);[\s\S]*await shutdownPiRuntime\(\);/,
  );
  assert.match(main, /await shutdownBackgroundServices\(\);[\s\S]*app\.exit\(1\)/);
});
