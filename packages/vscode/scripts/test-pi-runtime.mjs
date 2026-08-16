import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiHostClient } from '../../runtime-broker/dist/index.js';
import { PIARIUM_PROTOCOL_VERSION } from '../../protocol/dist/index.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostEntry = path.join(
  packageRoot,
  'dist',
  'pi-runtime',
  'node_modules',
  '@piarium',
  'pi-host',
  'dist',
  'host-bootstrap.js',
);
await access(hostEntry);

const assertPiDependencyVersion = async (packageName, minimum) => {
  const manifest = JSON.parse(await readFile(path.join(
    packageRoot,
    'dist',
    'pi-runtime',
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'node_modules',
    packageName,
    'package.json',
  ), 'utf8'));
  const actual = String(manifest.version || '0.0.0')
    .split('-', 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  let safe = true;
  for (let index = 0; index < minimum.length; index += 1) {
    const value = actual[index] ?? 0;
    if (value > minimum[index]) break;
    if (value < minimum[index]) {
      safe = false;
      break;
    }
  }
  if (!safe) {
    throw new Error(`Unsafe staged ${packageName} version ${manifest.version}`);
  }
};

await Promise.all([
  assertPiDependencyVersion('brace-expansion', [5, 0, 9]),
  assertPiDependencyVersion('undici', [8, 9, 0]),
]);

const client = new PiHostClient({
  handshake: {
    clientName: 'piarium-vscode-package-smoke',
    clientVersion: '0.1.0',
    mode: 'vscode',
  },
  hostEntry,
  startupTimeoutMs: 30_000,
});
try {
  const handshake = await client.start();
  if (handshake.protocolVersion !== PIARIUM_PROTOCOL_VERSION) {
    throw new Error(`Unexpected Piarium protocol ${handshake.protocolVersion}`);
  }
  console.log(
    `[piarium-vscode] runtime smoke passed: Pi ${handshake.runtime.piVersion}, Node ${handshake.runtime.nodeVersion}`,
  );
} finally {
  await client.dispose();
}
