import fs from 'node:fs';
import path from 'node:path';
import { PiRuntimeBroker, resolveBundledPiHostEntry } from '@piarium/runtime-broker';

const PI_HOST_PACKAGE_ENTRY = path.join(
  'node_modules',
  '@piarium',
  'pi-host',
  'dist',
  'host-bootstrap.js',
);

export const resolveElectronPiHostEntry = ({
  packaged,
  resourcesPath,
  resolvedEntry = resolveBundledPiHostEntry(),
}) => {
  const normalizedEntry = path.resolve(resolvedEntry);
  if (!packaged) {
    if (!fs.existsSync(normalizedEntry)) {
      throw new Error(
        `Pi host build is missing at ${normalizedEntry}; run bun run --cwd packages/runtime-broker build`,
      );
    }
    return normalizedEntry;
  }

  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const unpackedFromResolved = normalizedEntry.includes(asarSegment)
    ? normalizedEntry.replace(
        asarSegment,
        `${path.sep}app.asar.unpacked${path.sep}`,
      )
    : null;
  const packagedCandidate = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', PI_HOST_PACKAGE_ENTRY)
    : null;
  const candidate = [unpackedFromResolved, packagedCandidate, normalizedEntry]
    .find((entry) => entry && fs.existsSync(entry));
  if (!candidate) {
    throw new Error(
      `Packaged Pi host is missing; checked ${[unpackedFromResolved, packagedCandidate, normalizedEntry]
        .filter(Boolean)
        .join(', ')}`,
    );
  }
  return candidate;
};

export const createDesktopPiRuntimeBroker = ({
  agentDir,
  clientVersion,
  emit,
  nodePath,
  packaged,
  packageRoot,
  resolvedEntry,
  resourcesPath,
  runtimeSource,
}) => new PiRuntimeBroker({
  ...(agentDir ? { agentDir } : {}),
  client: {
    clientName: 'piarium-electron',
    clientVersion,
    mode: 'desktop',
  },
  emit,
  hostEntry: resolveElectronPiHostEntry({
    packaged,
    resourcesPath,
    ...(resolvedEntry ? { resolvedEntry } : {}),
  }),
  ...(nodePath ? { nodePath } : {}),
  ...(packageRoot ? { packageRoot } : {}),
  ...(runtimeSource ? { runtimeSource } : {}),
});
