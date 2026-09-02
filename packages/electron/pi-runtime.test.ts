import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PIARIUM_PROTOCOL_VERSION } from '@piarium/protocol';
import {
  createDesktopPiRuntimeBroker,
  resolveElectronPiHostEntry,
} from './pi-runtime.js';

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
  let error;
  assert.throws(
    () => {
      try {
        resolveElectronPiHostEntry({
          packaged: true,
          resourcesPath: path.join(os.tmpdir(), 'piarium-missing-resources'),
          resolvedEntry: path.join(os.tmpdir(), 'piarium-missing-app.asar', 'main.js'),
        });
      } catch (caught) {
        error = caught;
        throw caught;
      }
    },
    /Piarium installation files required to start Pi are missing/,
  );
  assert.equal(error.code, 'host-entry-unavailable');
});

test('never returns an app.asar entry to an external Node process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-electron-asar-entry-'));
  const asarEntry = path.join(root, 'resources', 'app.asar', 'node_modules', '@piarium', 'pi-host', 'dist', 'host-bootstrap.js');
  await fs.mkdir(path.dirname(asarEntry), { recursive: true });
  await fs.writeFile(asarEntry, 'export {};\n');
  try {
    let error;
    assert.throws(
      () => {
        try {
          resolveElectronPiHostEntry({
            packaged: true,
            resourcesPath: path.join(root, 'resources'),
            resolvedEntry: asarEntry,
          });
        } catch (caught) {
          error = caught;
          throw caught;
        }
      },
      /Piarium installation files required to start Pi are missing/,
    );
    assert.equal(error.code, 'host-entry-unavailable');
    assert.ok(error.candidates.every((candidate) => !candidate.includes(`${path.sep}app.asar${path.sep}`)));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('repairs an ASAR-derived entry even when packaged detection is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-electron-asar-detection-'));
  const resourcesPath = path.join(root, 'resources');
  const unpackedEntry = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@piarium', 'pi-host', 'dist', 'host-bootstrap.js');
  await fs.mkdir(path.dirname(unpackedEntry), { recursive: true });
  await fs.writeFile(unpackedEntry, 'export {};\n');
  try {
    assert.equal(resolveElectronPiHostEntry({
      packaged: false,
      resourcesPath,
      resolvedEntry: path.join(resourcesPath, 'app.asar', 'node_modules', '@piarium', 'pi-host', 'dist', 'host-bootstrap.js'),
    }), unpackedEntry);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test('desktop broker handshakes with the compiled Pi host', async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-electron-broker-'));
  const events = [];
  const broker = createDesktopPiRuntimeBroker({
    agentDir,
    clientVersion: '0.1.0-test',
    emit: (event) => events.push(event),
    foundationalPackages: [],
    hostEntry: fileURLToPath(new URL('../pi-host/dist/host-bootstrap.js', import.meta.url)),
    packaged: false,
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
  const main = await source('./main.ts');
  assert.match(main, /requirePiRuntime: false/);
  assert.match(main, /hostEntry: getDesktopPiHostEntry\(\)/);
  assert.match(main, /const hostEntry = getDesktopPiHostEntry\(\);[\s\S]*hostEntry,/);
  assert.match(main, /createPiRuntimeBroker:/);
  assert.doesNotMatch(main, /await ensurePiRuntime\(\);[\s\S]*startWebUiServer/);
  assert.match(
    main,
    /await killSidecar\(\);[\s\S]*await shutdownPiRuntime\(\);/,
  );
  assert.match(main, /await shutdownBackgroundServices\(\);[\s\S]*app\.exit\(1\)/);
});

test('desktop packaging and Windows smoke execute the external Host boundary', async () => {
  const [afterPack, desktopSmoke, packageScript, services, verifier, windowsSmoke] = await Promise.all([
    source('./scripts/after-pack.cjs'),
    source('./scripts/smoke-desktop-unpacked.mjs'),
    source('./scripts/package.mjs'),
    source('../extension-contract/src/services.ts'),
    source('./scripts/verify-packaged-pi-host.mjs'),
    source('./scripts/smoke-windows-unpacked.mjs'),
  ]);
  const recoveryVersion = services.match(/PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION = (\d+) as const/)?.[1];
  assert.ok(recoveryVersion, 'workspace recovery service version must be declared');
  const recoveryProbe = new RegExp(
    `serviceId: 'piarium\\.workspace-recovery',[\\s\\S]*?version: ${recoveryVersion}`,
  );

  assert.match(afterPack, /verify-packaged-pi-host\.mjs/);
  assert.match(packageScript, /PIARIUM_PACKAGING_NODE = process\.execPath/);
  assert.match(afterPack, /PIARIUM_PACKAGING_NODE \|\| process\.execPath/);
  assert.match(verifier, /await lifecycle\.start\(\)/);
  assert.match(desktopSmoke, recoveryProbe);
  assert.match(windowsSmoke, recoveryProbe);
  assert.match(windowsSmoke, /runtime-selection\.json/);
  assert.match(windowsSmoke, /selectedId: 'custom:selected'/);
  assert.match(windowsSmoke, /runtimeStillWorking/);
  assert.match(windowsSmoke, /did not activate the seeded Pi runtime through its external Host/);
});
