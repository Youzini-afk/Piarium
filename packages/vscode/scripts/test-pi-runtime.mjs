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
  'main.js',
);
await access(hostEntry);

const braceExpansionManifest = JSON.parse(await readFile(path.join(
  packageRoot,
  'dist',
  'pi-runtime',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'node_modules',
  'brace-expansion',
  'package.json',
), 'utf8'));
const braceVersion = String(braceExpansionManifest.version || '0.0.0')
  .split('-', 1)[0]
  .split('.')
  .map((part) => Number.parseInt(part, 10));
if (
  (braceVersion[0] ?? 0) < 5
  || ((braceVersion[0] ?? 0) === 5 && (braceVersion[1] ?? 0) === 0 && (braceVersion[2] ?? 0) < 8)
) {
  throw new Error(`Unsafe staged brace-expansion version ${braceExpansionManifest.version}`);
}

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
