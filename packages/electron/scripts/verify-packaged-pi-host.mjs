#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [brokerEntryArgument, hostEntryArgument, packageRootArgument] = process.argv.slice(2);
if (!brokerEntryArgument || !hostEntryArgument || !packageRootArgument) {
  throw new Error('Usage: verify-packaged-pi-host.mjs <broker-entry> <host-entry> <pi-package-root>');
}

const brokerEntry = path.resolve(brokerEntryArgument);
const hostEntry = path.resolve(hostEntryArgument);
const packageRoot = path.resolve(packageRootArgument);
const agentDir = await mkdtemp(path.join(os.tmpdir(), 'piarium-packaged-host-'));
let lifecycle;

try {
  const runtimeBroker = await import(pathToFileURL(brokerEntry).href);
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const piVersion = packageManifest.version;
  if (typeof piVersion !== 'string' || !piVersion) {
    throw new Error(`Pi package manifest has no version: ${packageRoot}`);
  }
  const createBroker = (options) => new runtimeBroker.PiRuntimeBroker({
    ...options,
    agentDir,
    client: { clientName: 'piarium-package-verifier', clientVersion: '0.1.0', mode: 'test' },
    foundationalPackages: [],
    emit: (event) => {
      if (event.kind !== 'diagnostic') return;
      const writer = event.level === 'error' ? console.error : console.log;
      writer(`[piarium-package:${event.role}] ${event.message}`);
    },
    projectTrustOverride: true,
  });
  lifecycle = new runtimeBroker.PiRuntimeLifecycle({
    createBroker,
    dataDir: agentDir,
    discover: async () => [{
      available: true,
      compatible: true,
      id: 'custom:package-verifier',
      nodePath: process.execPath,
      packageRoot,
      source: 'custom',
      version: piVersion,
    }],
    hostEntry,
    planInstall: () => ({ action: 'none', reason: 'package verification', targetVersion: piVersion }),
    targetVersion: piVersion,
  });
  const handshake = await lifecycle.start();
  if (!handshake) throw new Error('Packaged Pi runtime lifecycle did not activate a Host');
  if (handshake.runtime.source !== 'custom') {
    throw new Error(`Packaged Pi Host reported unexpected source ${handshake.runtime.source}`);
  }
  if (!handshake.runtime.piVersion) {
    throw new Error('Packaged Pi Host handshake did not report a Pi version');
  }
  console.log(`[piarium-package] verified Runtime Manager probe and live external Host ${handshake.hostVersion} with Pi ${handshake.runtime.piVersion}`);
} finally {
  await lifecycle?.dispose().catch(() => {});
  await rm(agentDir, { force: true, recursive: true });
}
