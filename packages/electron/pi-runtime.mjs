import path from 'node:path';
import {
  assertExternalPiHostEntry,
  isExternalPiHostEntry,
  PiHostEntryUnavailableError,
  PiRuntimeBroker,
  resolveBundledPiHostEntry,
} from '@piarium/runtime-broker';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@piarium/protocol';

const PI_HOST_PACKAGE_ENTRY = path.join(
  'node_modules',
  '@piarium',
  'pi-host',
  'dist',
  'host-bootstrap.js',
);

const uniquePaths = (entries) => [...new Set(entries.filter(Boolean).map((entry) => path.resolve(entry)))];

const unpackedEntryFromAsar = (entry) => {
  const normalized = path.resolve(entry);
  const marker = `${path.sep}app.asar${path.sep}`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex === -1) return null;
  return `${normalized.slice(0, markerIndex)}${path.sep}app.asar.unpacked${path.sep}${normalized.slice(markerIndex + marker.length)}`;
};

export const electronPiHostEntryCandidates = ({
  packaged,
  resourcesPath,
  resolvedEntry = resolveBundledPiHostEntry(),
}) => {
  const normalizedEntry = path.resolve(resolvedEntry);
  const unpackedFromResolved = unpackedEntryFromAsar(normalizedEntry);
  const packagedCandidate = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', PI_HOST_PACKAGE_ENTRY)
    : null;
  if (!packaged && !unpackedFromResolved) return [normalizedEntry];
  return uniquePaths([
    unpackedFromResolved,
    packagedCandidate,
    ...(unpackedFromResolved ? [] : [normalizedEntry]),
  ]);
};

export const resolveElectronPiHostEntry = (options) => {
  const candidates = electronPiHostEntryCandidates(options);
  const candidate = candidates.find(isExternalPiHostEntry);
  if (!candidate) {
    if (!options.packaged && candidates.length === 1 && !unpackedEntryFromAsar(candidates[0])) {
      throw new Error(
        `Pi host build is missing at ${candidates[0]}; run bun run --cwd packages/runtime-broker build`,
      );
    }
    throw new PiHostEntryUnavailableError(candidates);
  }
  return candidate;
};

export const createDesktopPiRuntimeBroker = ({
  agentDir,
  clientVersion,
  emit,
  foundationalPackages = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations,
  hostEntry,
  nodePath,
  packaged,
  packageRoot,
  resourcesPath,
  runtimeSource,
}) => {
  const resolvedHostEntry = hostEntry
    ? assertExternalPiHostEntry(hostEntry)
    : resolveElectronPiHostEntry({ packaged, resourcesPath });
  return new PiRuntimeBroker({
    ...(agentDir ? { agentDir } : {}),
    client: {
      clientName: 'piarium-electron',
      clientVersion,
      mode: 'desktop',
    },
    emit,
    foundationalPackages,
    hostEntry: resolvedHostEntry,
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  });
};
