import fs from 'fs';
import path from 'path';
import { DEFAULT_PORT } from './cli-args.js';
import { getRunDir, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { resolveApiHost } from './cli-network.js';
import { fetchTunnelProvidersFromPort, fetchSystemInfoFromPort, isServerHealthReady } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  getPidFilePath,
  getInstanceFilePath,
  readPidFile,
  removePidFile,
  readInstanceOptions,
  removeInstanceFile,
  getPiariumProcessState,
  hasPiariumRuntimeInfo,
} from './cli-process.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './cli-tunnel-capabilities.js';
import type { TunnelProviderCapabilities } from '../../server/lib/tunnels/types.js';
import type { FetchLike, SystemInfo } from './cli-http.js';
import type { CliOptions } from './cli-types.js';
import type { PiariumProcessState } from './cli-process.js';

export interface CliInstance {
  autoStarted?: boolean | undefined;
  host?: string | undefined;
  instanceFilePath: string;
  launchMode: 'daemon' | 'foreground';
  mtime: number;
  pid: number | null;
  pidFilePath: string;
  port: number;
  runtime: string;
  source: 'probe' | 'registry+probe' | 'registry-unconfirmed';
  startedAt: number;
}

export interface DesktopInstance {
  pid: number | null;
  port: number;
  runtime: 'desktop';
}

interface LifecycleDiscoveryOptions extends CliOptions {
  fetchImpl?: FetchLike | undefined;
  getPiariumProcessState?: ((pid: number) => PiariumProcessState) | undefined;
}

interface ProbeHost {
  host: string | undefined;
  requiresPidMatch: boolean;
}

function createLivePortInstance(port: number, info: unknown, host?: unknown): CliInstance | null {
  if (!hasPiariumRuntimeInfo(info)) return null;
  return {
    port,
    pid: typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : null,
    pidFilePath: path.join(getRunDir(), `piarium-${port}.pid`),
    instanceFilePath: path.join(getRunDir(), `piarium-${port}.json`),
    mtime: 0,
    startedAt: 0,
    launchMode: 'daemon',
    runtime: info.runtime,
    source: 'probe',
    host: typeof host === 'string' && host.length > 0 ? host : undefined,
  };
}

function normalizeProbeHost(host: unknown): string | undefined {
  return typeof host === 'string' && host.trim().length > 0 ? host.trim() : undefined;
}

function isWildcardProbeHost(host: unknown): boolean {
  const normalized = normalizeProbeHost(host);
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackProbeHost(host: unknown): boolean {
  const normalized = normalizeProbeHost(host);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function isConcreteProbeHost(host: unknown): boolean {
  const normalized = normalizeProbeHost(host);
  return Boolean(normalized && !isWildcardProbeHost(normalized) && !isLoopbackProbeHost(normalized));
}

function getSystemInfoProbeHosts(...hosts: unknown[]): ProbeHost[] {
  const out: ProbeHost[] = [];
  const hasConcreteAuthoritativeHost = hosts.some(isConcreteProbeHost);
  const pushHost = (host: unknown, requiresPidMatch = false): void => {
    const normalized = normalizeProbeHost(host);
    const key = resolveApiHost(normalized);
    if (!out.some((entry) => resolveApiHost(entry.host) === key)) {
      out.push({ host: normalized, requiresPidMatch });
    }
  };

  for (const host of hosts) {
    if (normalizeProbeHost(host)) {
      pushHost(host, false);
    }
  }

  pushHost(undefined, hasConcreteAuthoritativeHost);
  pushHost('127.0.0.1', hasConcreteAuthoritativeHost);
  return out;
}

async function fetchSystemInfoFromPortCandidates(
  port: number,
  fetchImpl: FetchLike,
  hosts: ProbeHost[],
  expectedPid: number,
): Promise<{ host: string | null; info: SystemInfo | null }> {
  for (const { host, requiresPidMatch } of hosts) {
    const info = await fetchSystemInfoFromPort(port, fetchImpl, host);
    if (hasPiariumRuntimeInfo(info)) {
      if (requiresPidMatch && info.pid !== expectedPid) {
        continue;
      }
      return { info, host: host ?? null };
    }
  }
  return { info: null, host: null };
}

async function resolveDoctorPortStatuses(options: CliOptions = {}): Promise<{
  availableEntries: CliInstance[];
  statuses: Array<{
    available: boolean;
    detail: string;
    line: string;
    port: number | null;
    status: 'error' | 'success' | 'warning';
  }>;
}> {
  const runningEntries = await discoverRunningInstances();
  const desktopEntry = await discoverDesktopInstance();
  const statuses: Array<{
    available: boolean;
    detail: string;
    line: string;
    port: number | null;
    status: 'error' | 'success' | 'warning';
  }> = [];

  if (options.explicitPort) {
    const requestedPort = typeof options.port === 'number' ? options.port : DEFAULT_PORT;
    const runningMatch = runningEntries.find((entry) => entry.port === requestedPort);
    if (runningMatch) {
      statuses.push({
        port: requestedPort,
        available: true,
        status: 'success',
        line: `port ${requestedPort} available for tunneling`,
        detail: 'Double-check this same port is configured in your provider dashboard/config.',
      });
      return { statuses, availableEntries: [runningMatch] };
    }

    if (desktopEntry && desktopEntry.port === requestedPort) {
      statuses.push({
        port: requestedPort,
        available: false,
        status: 'warning',
        line: `port ${requestedPort} not available (desktop runtime)`,
        detail: 'Use a CLI instance port from `piarium serve` for tunneling.',
      });
      return { statuses, availableEntries: [] };
    }

    statuses.push({
      port: requestedPort,
      available: false,
      status: 'error',
      line: `port ${requestedPort} not available (no running instance)`,
      detail: `Start one with \`piarium serve --port ${requestedPort}\`.`,
    });
    return { statuses, availableEntries: [] };
  }

  for (const entry of runningEntries) {
    statuses.push({
      port: entry.port,
      available: true,
      status: 'success',
      line: `port ${entry.port} available for tunneling`,
      detail: 'Double-check this same port is configured in your provider dashboard/config.',
    });
  }

  if (desktopEntry && !runningEntries.some((entry) => entry.port === desktopEntry.port)) {
    statuses.push({
      port: desktopEntry.port,
      available: false,
      status: 'warning',
      line: `port ${desktopEntry.port} not available (desktop runtime)`,
      detail: 'Use a CLI instance port from `piarium serve` for tunneling.',
    });
  }

  if (runningEntries.length === 0) {
    statuses.push({
      port: null,
      available: false,
      status: 'warning',
      line: 'no CLI ports available for tunneling',
      detail: 'Start one with `piarium serve`.',
    });
  }

  return { statuses, availableEntries: runningEntries };
}

async function discoverRunningInstances(options: LifecycleDiscoveryOptions = {}): Promise<CliInstance[]> {
  const instances: CliInstance[] = [];
  const runDir = getRunDir();
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const getProcessState = typeof options.getPiariumProcessState === 'function'
    ? options.getPiariumProcessState
    : (pid: number) => getPiariumProcessState(pid);
  try {
    const files = fs.readdirSync(runDir);
    const pidFiles = files.filter((file) => file.startsWith('piarium-') && file.endsWith('.pid'));
    for (const file of pidFiles) {
      const port = parseInt(file.replace('piarium-', '').replace('.pid', ''), 10);
      if (!Number.isFinite(port) || port <= 0) continue;
      const pidFilePath = path.join(runDir, file);
      const pid = readPidFile(pidFilePath);
      if (!pid) {
        removePidFile(pidFilePath);
        removeInstanceFile(path.join(runDir, `piarium-${port}.json`));
        continue;
      }

      const instanceFilePath = path.join(runDir, `piarium-${port}.json`);
      const storedOptions = readInstanceOptions(instanceFilePath);
      const processState = getProcessState(pid);
      if (processState === 'dead') {
        removePidFile(pidFilePath);
        removeInstanceFile(instanceFilePath);
        continue;
      }

      // A live PID-file is only the right instance if the recorded port also
      // confirms Piarium. Cmdline identity alone can match a recycled PID
      // from another Piarium process on a different port. Try all plausible
      // hosts first; if matched/unknown identity still can't be confirmed, keep
      // the registry files but don't claim the instance is running.
      const { info: liveInfo, host: confirmedHost } = await fetchSystemInfoFromPortCandidates(
        port,
        fetchImpl,
        getSystemInfoProbeHosts(storedOptions?.host, options.host),
        pid,
      );
      const livePid = typeof liveInfo?.pid === 'number' && Number.isFinite(liveInfo.pid) ? liveInfo.pid : null;
      if (!hasPiariumRuntimeInfo(liveInfo)) {
        if (processState === 'mismatched') {
          removePidFile(pidFilePath);
          removeInstanceFile(instanceFilePath);
        }
        continue;
      }

      if (liveInfo.runtime === 'desktop') {
        removePidFile(pidFilePath);
        removeInstanceFile(instanceFilePath);
        continue;
      }

      let mtime = 0;
      let startedAt = 0;
      try {
        mtime = fs.statSync(pidFilePath).mtimeMs;
      } catch {
    // Best-effort operation; continue when it is unavailable.
  }
      if (typeof storedOptions?.startedAt === 'number' && Number.isFinite(storedOptions.startedAt)) {
        startedAt = storedOptions.startedAt;
      }
      const launchMode = storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon';
      instances.push({
        port,
        pid: livePid || (processState === 'matched' ? pid : null),
        pidFilePath,
        instanceFilePath,
        mtime,
        startedAt,
        launchMode,
        runtime: liveInfo.runtime,
        source: 'registry+probe',
        host: typeof confirmedHost === 'string' && confirmedHost.length > 0
          ? confirmedHost
          : (typeof storedOptions?.host === 'string' && storedOptions.host.length > 0 ? storedOptions.host : undefined),
      });
    }
  } catch {
    // Best-effort operation; continue when it is unavailable.
  }
  instances.sort((a, b) => a.port - b.port);
  return instances;
}

async function discoverPiariumInstanceOnPort(
  port: number,
  options: LifecycleDiscoveryOptions & { runningInstances?: CliInstance[] } = {},
): Promise<CliInstance | null> {
  if (!Number.isFinite(port) || port <= 0) return null;
  const runningInstances = Array.isArray(options.runningInstances)
    ? options.runningInstances
    : await discoverRunningInstances(options);
  const registryMatch = runningInstances.find((entry) => entry.port === port);
  if (registryMatch) return registryMatch;

  const info = await fetchSystemInfoFromPort(
    port,
    typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch,
    options.host,
  );
  if (info?.runtime === 'desktop' && !isDesktopRuntimeForPort(info, port)) {
    return null;
  }
  return createLivePortInstance(port, info, options.host);
}

async function discoverLifecycleInstances(
  options: CliOptions = {},
  deps: LifecycleDiscoveryOptions = {},
): Promise<CliInstance[]> {
  const runningInstances = await discoverRunningInstances({ ...deps, host: options.host });
  if (!options.explicitPort) {
    return runningInstances;
  }
  const requestedPort = typeof options.port === 'number' ? options.port : DEFAULT_PORT;
  const found = runningInstances.find((entry) => entry.port === requestedPort);
  if (found) return [found];
  const liveInstance = await discoverPiariumInstanceOnPort(requestedPort, {
    ...deps,
    host: options.host,
    runningInstances,
  });
  return liveInstance ? [liveInstance] : [];
}

async function discoverUnconfirmedRegistryInstanceOnPort(
  port: number,
  options: CliOptions = {},
): Promise<CliInstance | null> {
  if (!Number.isFinite(port) || port <= 0) return null;

  const pidFilePath = await getPidFilePath(port);
  const pid = readPidFile(pidFilePath);
  if (!pid) return null;

  const instanceFilePath = await getInstanceFilePath(port);
  const storedOptions = readInstanceOptions(instanceFilePath);
  const processState = getPiariumProcessState(pid);
  if (processState === 'dead') {
    removePidFile(pidFilePath);
    removeInstanceFile(instanceFilePath);
    return null;
  }

  const host = storedOptions?.host || options.host;
  if (await isPortAvailable(port, host)) {
    removePidFile(pidFilePath);
    removeInstanceFile(instanceFilePath);
    return null;
  }

  // Windows cannot cheaply inspect a process command line, so identity is
  // reported as unknown. For an explicit stop, accept that state only when a
  // matching instance metadata file exists; this restores recovery for a hung
  // registered server without trusting a lone stale PID file.
  const hasMatchingInstanceMetadata = storedOptions?.port === port;
  if (processState !== 'matched' && !(processState === 'unknown' && hasMatchingInstanceMetadata)) {
    return null;
  }

  return {
    port,
    pid,
    pidFilePath,
    instanceFilePath,
    mtime: 0,
    startedAt: typeof storedOptions?.startedAt === 'number' && Number.isFinite(storedOptions.startedAt) ? storedOptions.startedAt : 0,
    launchMode: storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon',
    runtime: 'cli',
    source: 'registry-unconfirmed',
    host: typeof host === 'string' && host.length > 0 ? host : undefined,
  };
}

function getLatestInstance(instances: CliInstance[]): CliInstance | null {
  if (!instances.length) return null;
  return [...instances].sort((a, b) => {
    const startedDelta = (b.startedAt || 0) - (a.startedAt || 0);
    if (startedDelta !== 0) return startedDelta;
    const mtimeDelta = (b.mtime || 0) - (a.mtime || 0);
    if (mtimeDelta !== 0) return mtimeDelta;
    return b.port - a.port;
  })[0] ?? null;
}

function isDesktopRuntimeForPort(info: SystemInfo | null, port: number): boolean {
  if (info?.runtime !== 'desktop') {
    return false;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  return !desktopPort || desktopPort === port;
}

async function inspectTunnelAttachability(
  port: number,
  { requireHealthy = true }: { requireHealthy?: boolean } = {},
): Promise<{ attachable: boolean; info?: SystemInfo; reason: 'desktop' | 'ok' | 'unhealthy' | 'unreachable' }> {
  const info = await fetchSystemInfoFromPort(port);
  if (!info || typeof info.runtime !== 'string') {
    return { attachable: false, reason: 'unreachable' };
  }
  if (isDesktopRuntimeForPort(info, port)) {
    return { attachable: false, reason: 'desktop', info };
  }
  if (requireHealthy) {
    const healthy = await isServerHealthReady(port, 1200);
    if (!healthy) {
      return { attachable: false, reason: 'unhealthy', info };
    }
  }
  return { attachable: true, reason: 'ok', info };
}

async function discoverDesktopInstance(fetchImpl: FetchLike = globalThis.fetch): Promise<DesktopInstance | null> {
  const port = readDesktopLocalPortFromSettings();
  if (!port) {
    return null;
  }

  const info = await fetchSystemInfoFromPort(port, fetchImpl);
  if (!info || info.runtime !== 'desktop') {
    return null;
  }

  return {
    port,
    pid: info.pid,
    runtime: info.runtime,
  };
}

async function resolveTunnelProviders(options: CliOptions = {}, deps: {
  fetchImpl?: FetchLike;
  readPorts?: () => number[] | Promise<number[]>;
} = {}): Promise<{ providers: TunnelProviderCapabilities[]; source: string }> {
  const readPorts = typeof deps.readPorts === 'function'
    ? deps.readPorts
    : async () => (await discoverRunningInstances()).map((entry) => entry.port);
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;

  const candidatePorts: number[] = [];
  if (typeof options.port === 'number' && Number.isFinite(options.port) && options.port > 0) {
    candidatePorts.push(options.port);
  }

  if (options.explicitPort !== true) {
    const discoveredPorts = await Promise.resolve(readPorts());
    if (Array.isArray(discoveredPorts)) {
      candidatePorts.push(...discoveredPorts);
    }
    if (!candidatePorts.includes(DEFAULT_PORT)) {
      candidatePorts.push(DEFAULT_PORT);
    }
  }

  for (const port of candidatePorts) {
    const providers = await fetchTunnelProvidersFromPort(port, fetchImpl);
    if (providers) {
      return { providers: providers as TunnelProviderCapabilities[], source: `api:${port}` };
    }
  }

  return { providers: DEFAULT_TUNNEL_PROVIDER_CAPABILITIES, source: 'fallback' };
}


export {
  resolveDoctorPortStatuses,
  discoverRunningInstances,
  discoverPiariumInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  getLatestInstance,
  isDesktopRuntimeForPort,
  inspectTunnelAttachability,
  discoverDesktopInstance,
  resolveTunnelProviders,
};
