import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { DEFAULT_PORT, findClosestMatch, generateCompletionScript, showTunnelHelp } from './cli-args.js';
import { requestJson, fetchSystemInfoFromPort, waitForServerHealth } from './cli-http.js';
import {
  discoverRunningInstances,
  getLatestInstance,
  inspectTunnelAttachability,
  isDesktopRuntimeForPort,
  resolveDoctorPortStatuses,
  resolveTunnelProviders,
} from './cli-lifecycle.js';
import {
  normalizeProfileProvider,
  normalizeProfileMode,
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileToken,
  suggestProfileNameFromHostname,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  formatProfileTokenStatus,
  writeTunnelProfilesToDisk,
  writeManagedRemotePairsToDiskFromProfiles,
  resolveProfileByName,
} from './cli-tunnel-profiles.js';
import {
  buildTunnelProfileAddCommand,
  buildTunnelStartReplayCommand,
  resolveTunnelTtlOverrides,
} from './cli-tunnel-utils.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './cli-tunnel-capabilities.js';
import type { TunnelModeDescriptor, TunnelProviderCapabilities } from '../../server/lib/tunnels/types.js';
import { assertSafeBrowserPort, buildLocalUrl, isUnsafeBrowserPort } from './cli-network.js';
import {
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
} from './cli-paths.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  box as clackBox,
  confirm as clackConfirm,
  select as clackSelect,
  text as clackText,
  password as clackPassword,
  cancel as clackCancel,
  isCancel as clackIsCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  logStatus,
  formatProviderWithIcon as clackFormatProviderWithIcon,
} from '../cli-output.js';
import type { CliInstance } from './cli-lifecycle.js';
import type { TunnelProfile, TunnelProfilesData } from './cli-tunnel-profiles.js';
import {
  errorMessage,
  recordOf,
  type CancelCleanup,
  type CliOptions,
  type ServeCommand,
  type StopCommand,
} from './cli-types.js';

const TUNNEL_PROFILES_VERSION = 1;

interface TunnelDoctorCheck {
  detail?: string | undefined;
  id?: string | undefined;
  label: string;
  status: string;
}

interface TunnelDoctorMode {
  blockers?: unknown[] | undefined;
  checks?: TunnelDoctorCheck[] | undefined;
  mode: string;
  ready?: boolean | undefined;
  summary?: { ready: boolean } | undefined;
}

interface TunnelDoctorResponse extends Record<string, unknown> {
  modes: TunnelDoctorMode[];
  ok: true;
  provider?: string | undefined;
  providerChecks: TunnelDoctorCheck[];
}

interface TunnelCommandDependencies {
  boldText(text: string): string;
  ensureTunnelProfilesMigrated(): TunnelProfilesData;
  serveCommand: ServeCommand;
  setCancelCleanup(handler: CancelCleanup | null): void;
  stopCommand: StopCommand;
}

interface TunnelOperationResult {
  error?: string | undefined;
  port: number;
  result?: Record<string, unknown> | undefined;
  status?: Record<string, unknown> | undefined;
}

interface TroubleshootingHint {
  code: string;
  key: string;
  lines: string[];
}

const textValue = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.length > 0 ? value : fallback
);

function getDefaultCloudflaredConfigPath(): string {
  return path.join(os.homedir(), '.cloudflared', 'config.yml');
}

function isReadableRegularFile(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function displayTunnelQrCode(url: string): Promise<void> {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${errorMessage(error)}`);
  }
}

function isTruthyEnv(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function shouldDisplayTunnelQr(options: CliOptions): boolean {
  if (options?.json) return false;
  if (options?.quiet) return false;
  if (options?.explicitQr === true) return options.qr === true;
  if (!process.stdout?.isTTY) return false;
  return !isTruthyEnv(process.env.CI);
}


function isValidTunnelDoctorResponse(body: unknown): body is TunnelDoctorResponse {
  const value = recordOf(body);
  if (value.ok !== true || !Array.isArray(value.providerChecks) || !Array.isArray(value.modes)) return false;
  const validCheck = (candidate: unknown): candidate is TunnelDoctorCheck => {
    const check = recordOf(candidate);
    return typeof check.label === 'string' && typeof check.status === 'string';
  };
  if (!value.providerChecks.every(validCheck)) return false;
  return value.modes.every((candidate) => {
    const entry = recordOf(candidate);
    if (typeof entry.mode !== 'string') return false;
    // Accept new shape: { ready: boolean, blockers: [] }
    if (typeof entry.ready === 'boolean' && Array.isArray(entry.blockers)) return true;
    // Accept server shape: { checks: [], summary: { ready: boolean } }
    if (Array.isArray(entry.checks) && entry.checks.every(validCheck) && typeof recordOf(entry.summary).ready === 'boolean') return true;
    return false;
  });
}

async function resolveTargetInstance({
  options,
  serveCommand,
  allowAutoStart,
  requireAll,
  rejectDesktopRuntime,
}: {
  allowAutoStart: boolean;
  options: CliOptions;
  rejectDesktopRuntime?: boolean;
  requireAll: true;
  serveCommand: ServeCommand;
}): Promise<CliInstance[]>;
async function resolveTargetInstance({
  options,
  serveCommand,
  allowAutoStart,
  requireAll,
  rejectDesktopRuntime,
}: {
  allowAutoStart: boolean;
  options: CliOptions;
  rejectDesktopRuntime?: boolean;
  requireAll?: false;
  serveCommand: ServeCommand;
}): Promise<CliInstance>;
async function resolveTargetInstance({
  options,
  serveCommand,
  allowAutoStart,
  requireAll = false,
  rejectDesktopRuntime = false,
}: {
  allowAutoStart: boolean;
  options: CliOptions;
  rejectDesktopRuntime?: boolean;
  requireAll?: boolean;
  serveCommand: ServeCommand;
}): Promise<CliInstance | CliInstance[]> {
  let running = await discoverRunningInstances();

  if (options.all && requireAll) {
    if (running.length === 0) {
      throw new Error('No running Piarium instance found. Start one with `piarium serve`.');
    }
    return running;
  }

  if (options.explicitPort) {
    const requestedPort = typeof options.port === 'number' ? options.port : DEFAULT_PORT;
    const found = running.find((entry) => entry.port === requestedPort);
    if (found) {
      if (rejectDesktopRuntime) {
        const attachability = await inspectTunnelAttachability(found.port, { requireHealthy: true });
        if (!attachability.attachable) {
          if (attachability.reason === 'desktop') {
            throw new Error(
              `Port ${requestedPort} is used by Piarium Desktop app. Tunnel attach requires a CLI instance from \`piarium serve\`.`
            );
          }
          throw new Error(
            `Port ${requestedPort} is not an attachable Piarium tunnel instance. Ensure it is healthy and running Piarium CLI runtime.`
          );
        }
      }
      return found;
    }

    if (rejectDesktopRuntime) {
      const systemInfo = await fetchSystemInfoFromPort(requestedPort, globalThis.fetch, options.host);
      if (isDesktopRuntimeForPort(systemInfo, requestedPort)) {
        throw new Error(
          `Port ${requestedPort} is used by Piarium Desktop app. Tunnel attach requires a CLI instance from \`piarium serve\`.`
        );
      }
    }

    if (allowAutoStart) {
      await serveCommand({
        port: requestedPort,
        explicitPort: true,
        host: options.host,
        uiPassword: options.uiPassword,
        apiOnly: options.apiOnly,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === requestedPort);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error(`No running Piarium instance found on port ${requestedPort}.`);
  }

  if (rejectDesktopRuntime) {
    const attachableEntries: CliInstance[] = [];
    let sawDesktop = false;
    for (const entry of running) {
      const attachability = await inspectTunnelAttachability(entry.port, { requireHealthy: true });
      if (attachability.reason === 'desktop') {
        sawDesktop = true;
      }
      if (attachability.attachable) {
        attachableEntries.push(entry);
      }
    }

    if (attachableEntries.length === 1) {
      return attachableEntries[0]!;
    }

    if (attachableEntries.length > 1) {
      const ports = attachableEntries.map((entry) => entry.port).join(', ');
      throw new Error(`Multiple attachable Piarium instances found: ${ports}. Use --port <port> or --all.`);
    }

    if (allowAutoStart) {
      const startedPort = await serveCommand({
        ...options,
        explicitPort: false,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      running = await discoverRunningInstances();
      const started = (typeof startedPort === 'number' ? running.find((entry) => entry.port === startedPort) : null) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }

    if (sawDesktop) {
      throw new Error('Only Piarium Desktop instance(s) detected. Tunnel attach requires a CLI instance from `piarium serve`.');
    }

    throw new Error('No attachable Piarium instance found. Start one with `piarium serve`.');
  }

  if (running.length === 1) {
    return running[0]!;
  }

  if (running.length === 0) {
    if (allowAutoStart) {
      const startedPort = await serveCommand({
        ...options,
        explicitPort: false,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
      });
      running = await discoverRunningInstances();
      const started = (typeof startedPort === 'number' ? running.find((entry) => entry.port === startedPort) : null) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error('No running Piarium instance found. Start one with `piarium serve`.');
  }

  const ports = running.map((entry) => entry.port).join(', ');
  throw new Error(`Multiple Piarium instances found: ${ports}. Use --port <port> or --all.`);
}

async function resolveTunnelReadEntries(options: CliOptions): Promise<CliInstance[]> {
  const running = await discoverRunningInstances();

  if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (!found) {
      throw new Error(`No running Piarium instance found on port ${options.port}.`);
    }
    return [found];
  }

  if (running.length === 0) {
    throw new Error('No running Piarium instance found. Start one with `piarium serve`.');
  }

  return running;
}

function formatTunnelStatusLine(statusBody: unknown, port: number): {
  detail: string;
  line: string;
  status: 'neutral' | 'success';
} {
  const value = recordOf(statusBody);
  const active = Boolean(value.active);
  const provider = typeof value.provider === 'string' ? value.provider : 'unknown';
  const mode = typeof value.mode === 'string' ? value.mode : 'unknown';
  const url = typeof value.url === 'string' ? value.url : 'n/a';
  return {
    status: active ? 'success' : 'neutral',
    line: `port ${port} ${active ? 'active' : 'inactive'} (${clackFormatProviderWithIcon(provider)}/${mode})`,
    detail: url,
  };
}

function formatModeRequirements(mode: Partial<TunnelModeDescriptor> | undefined): string {
  const requires = Array.isArray(mode?.requires) ? mode.requires.filter(Boolean) : [];
  if ((mode?.key || '') === 'managed-local') {
    return 'config-path (or default cloudflared config)';
  }
  if (requires.length === 0) {
    return 'none';
  }
  return requires.join(', ');
}

function annotateTunnelProvidersForOutput(providers: TunnelProviderCapabilities[]): Array<Record<string, unknown>> {
  if (!Array.isArray(providers)) return providers;
  return providers.map((provider) => {
    const modes = Array.isArray(provider?.modes) ? provider.modes : [];
    return {
      ...provider,
      modes: modes.map((mode) => ({
        ...mode,
        displayRequires: formatModeRequirements(mode),
      })),
    };
  });
}

async function handleTunnelProfileSubcommand(
  options: CliOptions,
  action: string | null | undefined,
  { boldText, ensureTunnelProfilesMigrated }: Pick<TunnelCommandDependencies, 'boldText' | 'ensureTunnelProfilesMigrated'>,
): Promise<void> {
  const sub = typeof action === 'string' ? action.trim().toLowerCase() : '';
  const store = ensureTunnelProfilesMigrated();

  if (!sub) {
    if (isJsonMode(options)) {
      printJson({
        command: 'tunnel profile',
        subcommands: ['list', 'show', 'add', 'remove'],
      });
      return;
    }

    if (!isQuietMode(options)) {
      clackIntro('Tunnel Profile');
      logStatus('info', 'Available subcommands', 'list, show, add, remove');
      clackLog.step('List profiles: `piarium tunnel profile list`');
      clackLog.step('Show one profile: `piarium tunnel profile show --name <name>`');
      clackLog.step('Add profile: `piarium tunnel profile add --provider cloudflare --mode managed-remote --name <name> --hostname <host> --token <token>`');
      clackLog.step('Remove profile: `piarium tunnel profile remove --name <name>`');
      clackOutro('Choose a subcommand');
    }
    return;
  }

  if (sub === 'list') {
    const providerFilter = normalizeProfileProvider(options.provider);
    const profiles = providerFilter
      ? store.profiles.filter((entry) => entry.provider === providerFilter)
      : store.profiles;
    if (isJsonMode(options)) {
      printJson({ profiles: redactProfilesForOutput(profiles, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      for (const profile of profiles) {
        process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname}\n`);
      }
      return;
    }

    clackIntro('Tunnel Profiles');
    for (const profile of profiles) {
      logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}`);
    }
    clackOutro(`${profiles.length} profile(s)`);
    return;
  }

  if (sub === 'show') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile show` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, options.provider);
    if (!profile) {
      throw new Error(error || `Tunnel profile not found: ${name}`);
    }
    if (isJsonMode(options)) {
      printJson({ profile: redactProfileForOutput(profile, options.showSecrets) });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}\n`);
      return;
    }
    clackIntro('Tunnel Profile');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}`);
    clackOutro('show complete');
    return;
  }

  if (sub === 'add') {
    let provider = normalizeProfileProvider(options.provider);
    let mode = normalizeProfileMode(options.mode);
    let name = normalizeProfileName(options.name);
    let hostname = normalizeProfileHostname(options.hostname);
    const resolvedTokenValue = resolveToken(options);
    let token = normalizeProfileToken(resolvedTokenValue);

    if (canPrompt(options)) {
      if (!provider) {
        const providerResult = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        const providerOptions = (Array.isArray(providerResult.providers) ? providerResult.providers : [])
          .map((entry) => normalizeProfileProvider(entry?.provider))
          .filter(Boolean)
          .map((providerId) => ({ value: providerId, label: clackFormatProviderWithIcon(providerId) }));

        if (providerOptions.length === 1) {
          provider = providerOptions[0]!.value;
        } else if (providerOptions.length > 1) {
          const selectedProvider = await clackSelect({
            message: 'Select tunnel provider',
            options: providerOptions,
          });
          if (clackIsCancel(selectedProvider)) {
            clackCancel('Profile add cancelled.');
            return;
          }
          provider = normalizeProfileProvider(selectedProvider);
        }
      }

      if (!mode) {
        mode = 'managed-remote';
      }

      if (!name) {
        const enteredName = await clackText({
          message: 'Profile name (Enter to accept/edit)',
          placeholder: 'prod-main',
          initialValue: 'prod-main',
          validate(value) {
            return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
          },
        });
        if (clackIsCancel(enteredName)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        name = normalizeProfileName(enteredName);
      }

      const existingProfile = provider && name
        ? store.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase())
        : null;

      if (!hostname) {
        const enteredHostname = await clackText({
          message: 'Tunnel hostname (Enter to accept/edit)',
          placeholder: existingProfile?.hostname || 'app.example.com',
          initialValue: existingProfile?.hostname || 'app.example.com',
          validate(value) {
            return normalizeProfileHostname(value).length > 0 ? undefined : 'Hostname is required.';
          },
        });
        if (clackIsCancel(enteredHostname)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        hostname = normalizeProfileHostname(enteredHostname);
      }

      if (!token && existingProfile?.token) {
        const useExistingToken = await clackConfirm({
          message: `Reuse saved token for profile '${existingProfile.name}'?`,
          initialValue: true,
        });
        if (clackIsCancel(useExistingToken)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        if (useExistingToken) {
          token = existingProfile.token;
        }
      }
    }

    if (!provider || !mode || !name || !hostname) {
      throw new Error('`tunnel profile add` requires --provider, --mode managed-remote, --name, and --hostname.');
    }

    if (!token) {
      if (canPrompt(options)) {
        const entered = await clackPassword({
          message: `Enter tunnel token for profile '${name}'`,
        });
        if (clackIsCancel(entered) || !entered || !entered.trim()) {
          clackCancel('Profile add cancelled.');
          return;
        }
        token = normalizeProfileToken(entered.trim());
      }
      if (!token) {
        throw new Error('`tunnel profile add` requires a token (--token, --token-file, or --token-stdin).');
      }
    }
    if (mode !== 'managed-remote') {
      throw new Error('`tunnel profile add` currently supports only --mode managed-remote.');
    }

    const existingIndex = store.profiles.findIndex(
      (entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex >= 0 && !options.force && !options.dryRun) {
      if (canPrompt(options)) {
        const shouldOverwrite = await clackConfirm({
          message: `Profile '${name}' already exists for provider '${provider}'. Overwrite?`,
        });
        if (clackIsCancel(shouldOverwrite) || !shouldOverwrite) {
          clackCancel('Profile add cancelled.');
          return;
        }
      } else {
        throw new Error(`Profile '${name}' already exists for provider '${provider}'. Use --force to overwrite.`);
      }
    }

    if (options.dryRun) {
      const dryRunResult = {
        ok: true,
        dryRun: true,
        action: existingIndex >= 0 ? 'overwrite' : 'create',
        profile: redactProfileForOutput({ name, provider, mode, hostname, token }, options.showSecrets),
      };
      if (isJsonMode(options)) {
        printJson(dryRunResult);
      } else if (!isQuietMode(options)) {
        clackIntro('Tunnel Profile Add (dry-run)');
        logStatus('info', `Would ${existingIndex >= 0 ? 'overwrite' : 'create'}: ${name} (${provider}/${mode})`, `${hostname} ${formatProfileTokenStatus({ token }, options.showSecrets)}`);
        clackOutro('dry-run complete (no changes applied)');
      }
      return;
    }

    const next = [...store.profiles];
    const now = Date.now();
    if (existingIndex >= 0) {
      const current = next[existingIndex]!;
      next[existingIndex] = {
        ...current,
        mode,
        hostname,
        token,
        updatedAt: now,
      };
    } else {
      next.push({
        id: crypto.randomUUID(),
        name,
        provider,
        mode,
        hostname,
        token,
        createdAt: now,
        updatedAt: now,
      });
    }

    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    writeTunnelProfilesToDisk(persisted);
    writeManagedRemotePairsToDiskFromProfiles(persisted);
    const added = persisted.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase());
    if (!added) throw new Error(`Saved tunnel profile could not be reloaded: ${name}`);

    if (isJsonMode(options)) {
      printJson({ ok: true, profile: redactProfileForOutput(added, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`saved ${added.name} ${added.provider}/${added.mode} ${added.hostname}\n`);
      return;
    }

    console.log('');
    clackIntro(boldText('Tunnel Profile Saved'));
    logStatus('success', `${added.name} (${added.provider}/${added.mode})`, `${added.hostname} ${formatProfileTokenStatus(added, options.showSecrets)}`);
    clackOutro('save complete');
    logStatus('info', '[START_PROFILE]', `piarium tunnel start --profile ${added.name}`);
    clackOutro('');
    return;
  }

  if (sub === 'remove') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile remove` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, options.provider);
    if (!profile) {
      throw new Error(error || `Tunnel profile not found: ${name}`);
    }

    const next = store.profiles.filter((entry) => entry.id !== profile.id);
    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    writeTunnelProfilesToDisk(persisted);
    writeManagedRemotePairsToDiskFromProfiles(persisted);

    if (isJsonMode(options)) {
      printJson({ ok: true, removed: redactProfileForOutput(profile, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`removed ${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname}\n`);
      return;
    }

    clackIntro('Tunnel Profile Removed');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, profile.hostname);
    clackOutro('remove complete');
    return;
  }

  const knownProfileActions = ['list', 'show', 'add', 'remove'];
  const suggestion = findClosestMatch(sub, knownProfileActions);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  throw new TunnelCliError(
    `Unknown tunnel profile subcommand '${sub}'.${hint} Use 'piarium tunnel help'.`,
    EXIT_CODE.USAGE_ERROR
  );
}


function createTunnelCommand(deps: TunnelCommandDependencies) {
  return (options: CliOptions, subcommand?: string | null, action?: string | null): Promise<void> => tunnelCommand(options, subcommand, action, deps);
}

async function tunnelCommand(
  options: CliOptions,
  subcommand: string | null | undefined,
  action: string | null | undefined,
  deps: TunnelCommandDependencies,
): Promise<void> {
    const { serveCommand, stopCommand, setCancelCleanup, boldText, ensureTunnelProfilesMigrated } = deps;
    switch (subcommand) {
      case 'help':
        showTunnelHelp();
        return;
      case 'profile':
        await handleTunnelProfileSubcommand(options, action, { boldText, ensureTunnelProfilesMigrated });
        return;
      case 'providers': {
        const result = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        if (isJsonMode(options)) {
          printJson({ providers: annotateTunnelProvidersForOutput(result.providers), source: result.source });
          return;
        }
        if (isQuietMode(options)) {
          for (const provider of result.providers) {
            const modes = Array.isArray(provider?.modes) ? provider.modes : [];
            const providerId = provider?.provider || 'unknown';
            process.stdout.write(`provider ${providerId} modes ${modes.length}\n`);
            for (const mode of modes) {
              const requires = formatModeRequirements(mode).replace(/,\s+/g, ',');
              process.stdout.write(`mode ${mode?.key || 'unknown'} requires ${requires}\n`);
            }
          }
          return;
        }
        clackIntro('Tunnel Providers');
        for (const provider of result.providers) {
          const modes = Array.isArray(provider?.modes) ? provider.modes : [];
          clackLog.success(`${clackFormatProviderWithIcon(provider.provider)} — ${modes.length} mode(s)`);
          for (const mode of modes) {
            const label = mode.label || mode.key;
            const requires = formatModeRequirements(mode);
            clackLog.step(`${mode.key} — ${label}\n  requires: ${requires}`);
          }
        }
        clackOutro(`${result.providers.length} provider(s)`);
        return;
      }
      case 'ready': {
        const entries = await resolveTunnelReadEntries(options);
        const provider = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : 'cloudflare';

        const results: TunnelOperationResult[] = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, `/api/piarium/tunnel/check?provider=${encodeURIComponent(provider)}`);
            if (!response.ok) {
              results.push({ port: entry.port, error: textValue(body?.error, `check ${response.status}`) });
              continue;
            }
            results.push({ port: entry.port, result: body ?? {} });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const providerId = textValue(result.result?.provider, provider);
            if (result.result?.available) {
              process.stdout.write(`port ${result.port} ready ${providerId} ${textValue(result.result?.version, 'unknown')}\n`);
            } else {
              process.stdout.write(`port ${result.port} not-ready ${providerId} ${textValue(result.result?.message, 'not ready')}\n`);
            }
          }
          return;
        }

        clackIntro('Tunnel Ready');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }

          logStatus(
            result.result?.available ? 'success' : 'warning',
            `port ${result.port} provider ${clackFormatProviderWithIcon(textValue(result.result?.provider, provider))}`,
            result.result?.available
              ? `ready (${textValue(result.result?.version, 'unknown version')})`
              : textValue(result.result?.message, 'not ready'),
          );
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'status': {
        const entries = await resolveTunnelReadEntries(options);

        const results: TunnelOperationResult[] = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, '/api/piarium/tunnel/status');
            if (!response.ok) {
              results.push({ port: entry.port, error: textValue(body?.error, `status ${response.status}`) });
              continue;
            }
            results.push({ port: entry.port, status: body ?? {} });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const active = Boolean(result.status?.active);
            const provider = textValue(result.status?.provider, 'unknown');
            const mode = textValue(result.status?.mode, 'unknown');
            const url = textValue(result.status?.url, 'n/a');
            process.stdout.write(`port ${result.port} ${active ? 'active' : 'inactive'} ${provider}/${mode} ${url}\n`);
          }
          return;
        }

        clackIntro('Tunnel Status');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }
          const sl = formatTunnelStatusLine(result.status, result.port);
          logStatus(sl.status, sl.line, sl.detail);
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'doctor': {
        const doctorSpin = createSpinner(options);
        doctorSpin?.start('Running tunnel diagnostics...');

        // Phase 1: Port discovery
        const { statuses: portStatuses, availableEntries } = await resolveDoctorPortStatuses(options);

        // Phase 2: Provider diagnostics via the doctor endpoint
        doctorSpin?.message('Checking provider...');
        let providerOption = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : '';

        let doctorProfile: TunnelProfile | null = null;
        let doctorHostnameOverride = typeof options.hostname === 'string' ? options.hostname.trim() : '';
        const explicitHostnameProvided = doctorHostnameOverride.length > 0;
        const explicitTokenProvided = Boolean(options.tokenStdin)
          || (typeof options.token === 'string' && options.token.trim().length > 0)
          || (typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0);
        let doctorTokenValue = resolveToken(options);
        let hasSavedManagedRemoteProfile = false;
        const normalizedMode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : '';

        if (typeof options.profile === 'string' && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, providerOption || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error || `Tunnel profile not found: ${options.profile}`);
          }
          doctorProfile = resolved.profile;
        } else if (!doctorHostnameOverride && !explicitTokenProvided && (!normalizedMode || normalizedMode === 'managed-remote')) {
          const store = ensureTunnelProfilesMigrated();
          const remoteProfiles = store.profiles.filter((entry) => {
            if (entry.mode !== 'managed-remote') return false;
            if (!providerOption) return true;
            return entry.provider === providerOption;
          });
          hasSavedManagedRemoteProfile = remoteProfiles.some((entry) => {
            const savedHostname = normalizeProfileHostname(entry.hostname);
            const savedToken = normalizeProfileToken(entry.token);
            return Boolean(savedHostname && savedToken);
          });
          if (remoteProfiles.length === 1) {
            doctorProfile = remoteProfiles[0] ?? null;
          }
        }

        if (doctorProfile) {
          providerOption = providerOption || doctorProfile.provider;
          if (!doctorHostnameOverride && typeof doctorProfile.hostname === 'string') {
            doctorHostnameOverride = doctorProfile.hostname.trim();
          }
          if ((!doctorTokenValue || doctorTokenValue.trim().length === 0) && typeof doctorProfile.token === 'string') {
            doctorTokenValue = doctorProfile.token.trim();
          }
        }

        let doctorResult: TunnelDoctorResponse | null = null;
        let doctorError: string | null = null;
        const diagnosticsEntries = [...availableEntries].sort((a, b) => b.mtime - a.mtime);
        if (diagnosticsEntries.length > 0) {
          const query = new URLSearchParams();
          if (providerOption) query.set('provider', providerOption);
          if (typeof options.mode === 'string' && options.mode.trim().length > 0) {
            query.set('mode', options.mode.trim().toLowerCase());
          }
          if (typeof options.configPath === 'string') query.set('configPath', options.configPath);
          if (doctorHostnameOverride.length > 0) {
            query.set('managedRemoteTunnelHostname', doctorHostnameOverride);
          }
          if (hasSavedManagedRemoteProfile) {
            query.set('hasSavedManagedRemoteProfile', '1');
          }
          const doctorBody: Record<string, unknown> = {};
          doctorBody.managedRemoteTunnelTokenProvided = explicitTokenProvided;
          doctorBody.managedRemoteTunnelHostnameProvided = explicitHostnameProvided;
          if (typeof doctorTokenValue === 'string' && doctorTokenValue.trim().length > 0) {
            doctorBody.managedRemoteTunnelToken = doctorTokenValue;
          }

          const failedPorts: string[] = [];
          for (const diagnosticsEntry of diagnosticsEntries) {
            try {
              doctorSpin?.message(`Diagnosing provider on port ${diagnosticsEntry.port}...`);
              const doctorFetchOptions: CliOptions = { timeoutMs: 10000 };
              if (Object.keys(doctorBody).length > 0) {
                doctorFetchOptions.method = 'POST';
                doctorFetchOptions.body = JSON.stringify(doctorBody);
              }
              const { response, body } = await requestJson(
                diagnosticsEntry.port,
                `/api/piarium/tunnel/doctor?${query.toString()}`,
                doctorFetchOptions,
              );
              if (response.ok && body?.ok && isValidTunnelDoctorResponse(body)) {
                doctorResult = body;
                doctorError = null;
                break;
              }

              const looksIncompatible = response.ok && (!body || typeof body !== 'object' || !body.ok);
              const fallbackError = looksIncompatible
                ? `port ${diagnosticsEntry.port}: doctor endpoint unavailable or incompatible (restart this CLI instance)`
                : `port ${diagnosticsEntry.port}: ${body?.error || `doctor ${response.status}`}`;
              failedPorts.push(fallbackError);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failedPorts.push(`port ${diagnosticsEntry.port}: ${message}`);
            }
          }

          if (!doctorResult) {
            doctorError = failedPorts.length > 0
              ? failedPorts[0] ?? 'Tunnel doctor failed'
              : 'No compatible CLI instance found for tunnel doctor.';
          }
        }

        doctorSpin?.clear();

        // JSON output
        if (isJsonMode(options)) {
          const cliPorts = portStatuses
            .filter((s) => s.available)
            .map((s) => ({ port: s.port, type: 'cli', available: true }));
          const desktopPorts = portStatuses
            .filter((s) => !s.available)
            .map((s) => ({ port: s.port, type: 'desktop', available: false }));
          printJson({
            ports: [...cliPorts, ...desktopPorts],
            provider: doctorResult ? {
              id: doctorResult.provider,
              checks: doctorResult.providerChecks || [],
            } : null,
            modes: doctorResult?.modes || [],
            error: doctorError || undefined,
          });
          return;
        }

        if (isQuietMode(options)) {
          const cliPorts = portStatuses.filter((s) => s.available).map((s) => s.port);
          process.stdout.write(`cli-ports ${cliPorts.join(',') || 'none'}\n`);
          if (doctorError) {
            process.stderr.write(`doctor-error ${doctorError}\n`);
            return;
          }
          if (!doctorResult) {
            process.stdout.write('doctor unavailable\n');
            return;
          }

          const providerLabel = doctorResult.provider || providerOption || 'unknown';
          process.stdout.write(`provider ${providerLabel}\n`);
          const modes = Array.isArray(doctorResult.modes) ? doctorResult.modes : [];
          for (const modeEntry of modes) {
            const ready = modeEntry.ready === true || modeEntry.summary?.ready === true;
            if (ready) {
              process.stdout.write(`mode ${modeEntry.mode} ready\n`);
              continue;
            }

            const blockers = Array.isArray(modeEntry.blockers)
              ? modeEntry.blockers
              : (Array.isArray(modeEntry.checks)
                ? modeEntry.checks
                  .filter((c) => c?.status === 'fail' && c?.id !== 'startup_readiness')
                  .map((c) => c.detail || c.label || c.id)
                : []);
            process.stdout.write(`mode ${modeEntry.mode} not-ready ${blockers.length || 0}\n`);
            for (const blocker of blockers) {
              process.stdout.write(`blocker ${modeEntry.mode} ${String(blocker)}\n`);
            }
          }
          return;
        }

        // ── Section 1: Ports ──────────────────────────────────────
        const cliPorts = portStatuses.filter((s) => s.available);
        const unavailablePorts = portStatuses.filter((s) => !s.available);

        clackIntro(boldText('Ports'));
        for (const entry of cliPorts) {
          logStatus('success', `port ${entry.port} — CLI (available)`);
        }
        const desktopUnavailablePorts = [];
        for (const entry of unavailablePorts) {
          const isDesktop = typeof entry?.line === 'string' && entry.line.includes('desktop runtime');
          if (isDesktop) {
            desktopUnavailablePorts.push(entry.port);
            logStatus('error', `port ${entry.port} — Desktop (tunneling not supported)`);
            continue;
          }
          logStatus('error', `port ${entry.port} — No running instance`);
        }
        if (desktopUnavailablePorts.length > 0) {
          clackLog.message('Only CLI instances (piarium serve) support tunneling.');
        }

        if (cliPorts.length === 0 && unavailablePorts.length === 0) {
          logStatus('warning', 'No running instances found', 'Start one with `piarium serve`.');
          clackOutro('No ports available');
          return;
        }
        if (cliPorts.length === 0) {
          logStatus('warning', 'No CLI instances available for tunneling', 'Start one with `piarium serve`.');
          clackOutro('No CLI ports available');
          return;
        }
        clackOutro(`${cliPorts.length} CLI ${cliPorts.length === 1 ? 'port' : 'ports'} available`);
        console.log('');

        if (doctorProfile) {
          logStatus('info', 'Using saved profile for managed-remote checks', `${doctorProfile.name} (${doctorProfile.provider}/${doctorProfile.mode})`);
          console.log('');
        }

        // ── Section 2: Provider ─────────────────────────────────
        if (doctorError) {
          clackIntro(boldText('Provider'));
          logStatus('error', 'Provider diagnostics failed', doctorError);
          clackOutro('Failed');
          return;
        }
        if (!doctorResult) {
          clackIntro(boldText('Provider'));
          logStatus('warning', 'Could not reach a running instance for diagnostics');
          clackOutro('Unavailable');
          return;
        }

        const providerLabel = clackFormatProviderWithIcon(doctorResult.provider || 'unknown');
        clackIntro(boldText(`Provider: ${providerLabel}`));

        let providerPassCount = 0;
        for (const check of (doctorResult.providerChecks || [])) {
          const passed = check.status === 'pass';
          if (passed) {
            providerPassCount++;
            logStatus('success', `${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
          } else {
            logStatus('error', check.label, check.detail || undefined);
          }
        }

        const depCheck = (doctorResult.providerChecks || []).find(
          (c) => c.id === 'dependency' || c.id === 'provider_dependency',
        );
        if (depCheck && depCheck.status !== 'pass') {
          clackOutro('1 blocker — resolve before checking modes');
          return;
        }
        clackOutro(`${providerPassCount} ${providerPassCount === 1 ? 'check' : 'checks'} passed`);
        console.log('');

        // ── Section 3: Modes ────────────────────────────────────
        const DOCTOR_NOISE_CHECK_IDS = new Set(['startup_readiness', 'quick_mode_prerequisites']);
        const modes = doctorResult.modes || [];
        if (modes.length === 0) {
          return;
        }

        clackIntro(boldText('Modes'));
        let totalBlockers = 0;
        const troubleshootingHints: TroubleshootingHint[] = [];
        for (const modeEntry of modes) {
          const isReady = modeEntry.ready === true || modeEntry.summary?.ready === true;
          if (isReady) {
            const passDetail = Array.isArray(modeEntry.checks)
              ? modeEntry.checks.find((check) => check.status === 'pass' && (!check.id || !DOCTOR_NOISE_CHECK_IDS.has(check.id)))?.detail
              : null;
            logStatus('success', `${modeEntry.mode} — Ready${passDetail ? ` (${passDetail})` : ''}`);
          } else {
            const blockers = Array.isArray(modeEntry.blockers)
              ? modeEntry.blockers
              : (Array.isArray(modeEntry.checks)
                ? modeEntry.checks
                  .filter((c) => c?.status === 'fail' && c?.id !== 'startup_readiness')
                  .map((c) => c.detail || c.label || c.id)
                : []);
            totalBlockers += blockers.length;
            const blockerCount = blockers.length;
            const blockerWord = blockerCount === 1 ? 'blocker' : 'blockers';
            logStatus('error', `${modeEntry.mode} — Not ready${blockerCount > 0 ? ` (${blockerCount} ${blockerWord})` : ''}`);
            for (const blocker of blockers) {
              clackLog.message(`  ${String(blocker)}`);
            }

            const normalizedBlockers = blockers.map((blocker) => String(blocker).toLowerCase());
            const isManagedRemote = modeEntry.mode === 'managed-remote';
            const hasTokenIssue = normalizedBlockers.some((line) => line.includes('token')
              || line.includes('unauthorized')
              || line.includes('forbidden')
              || line.includes('authentication')
              || line.includes('auth'));
            const hasPortOrOriginIssue = normalizedBlockers.some((line) => line.includes('port')
              || line.includes('localhost')
              || line.includes('127.0.0.1')
              || line.includes('connection refused')
              || line.includes('dial tcp'));

            if (isManagedRemote && (hasPortOrOriginIssue || hasTokenIssue)) {
              troubleshootingHints.push({
                key: 'managed-remote-port',
                code: '[PORT_MISMATCH]',
                lines: [
                  'Cloudflare target must match the active Piarium CLI port.',
                  'Example: `http://127.0.0.1:<port>`',
                  'If CLI picked a different port, update Cloudflare or run `piarium serve --port <port>`.',
                ],
              });
            }

            if (isManagedRemote && hasTokenIssue) {
              troubleshootingHints.push({
                key: 'managed-remote-token',
                code: '[QR_PREFETCH_TOKEN]',
                lines: [
                  'Some QR readers pre-fetch scanned URLs.',
                  'Pre-fetch can consume one-time bootstrap tokens.',
                  'If validation fails, generate a fresh token/QR and use it immediately in one browser/device.',
                ],
              });
            }
          }
        }
        clackOutro(totalBlockers > 0 ? `Done (${totalBlockers} ${totalBlockers === 1 ? 'issue' : 'issues'})` : 'All modes ready');

        const dedupedHints: TroubleshootingHint[] = [];
        const seenHintKeys = new Set<string>();
        for (const hint of troubleshootingHints) {
          if (!seenHintKeys.has(hint.key)) {
            seenHintKeys.add(hint.key);
            dedupedHints.push(hint);
          }
        }

        if (dedupedHints.length > 0) {
          console.log('');
          clackIntro(boldText('Suggestion notes'));
          for (const hint of dedupedHints) {
            const lines = Array.isArray(hint.lines) ? hint.lines : [];
            const detail = lines.length > 0 ? lines.map((line) => `  ${line}`).join('\n') : undefined;
            logStatus('info', hint.code || '[NOTE]', detail);
          }
          clackOutro(`${dedupedHints.length} ${dedupedHints.length === 1 ? 'suggestion' : 'suggestions'}`);
        }
        return;
      }
      case 'start': {
        let provider = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : '';
        let mode = typeof options.mode === 'string' && options.mode.trim().length > 0
          ? options.mode.trim().toLowerCase()
          : '';
        const resolvedTokenValue = resolveToken(options);
        let token = typeof resolvedTokenValue === 'string' ? resolvedTokenValue : undefined;
        let hostname = typeof options.hostname === 'string' ? options.hostname : undefined;
        let selectedProfile: TunnelProfile | null = null;

        if (options.explicitPort) {
          assertSafeBrowserPort(typeof options.port === 'number' ? options.port : DEFAULT_PORT, { context: 'Tunnel start' });
        }

        if (typeof options.profile === 'string' && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, provider || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error || `Tunnel profile not found: ${options.profile}`);
          }
          selectedProfile = resolved.profile;
          provider = provider || selectedProfile.provider;
          mode = mode || selectedProfile.mode;
          token = (typeof token === 'string' && token.trim().length > 0) ? token : selectedProfile.token;
          hostname = typeof options.hostname === 'string' && options.hostname.trim().length > 0 ? options.hostname : selectedProfile.hostname;
        }

        // Interactive profile selection when no profile/mode specified in TTY
        if (!selectedProfile && !mode && canPrompt(options)) {
          const store = ensureTunnelProfilesMigrated();
          if (store.profiles.length > 0) {
            const profileChoice = await clackSelect({
              message: 'Start from a saved profile or choose a mode?',
              options: [
                { value: '__mode__', label: 'Choose a mode manually' },
                ...store.profiles.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.provider}/${p.mode})`,
                  hint: p.hostname,
                })),
              ],
            });
            if (clackIsCancel(profileChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            if (profileChoice !== '__mode__') {
              selectedProfile = store.profiles.find((p) => p.id === profileChoice) ?? null;
              if (selectedProfile) {
                provider = provider || selectedProfile.provider;
                mode = mode || selectedProfile.mode;
                token = (typeof token === 'string' && token.trim().length > 0) ? token : selectedProfile.token;
                hostname = typeof options.hostname === 'string' && options.hostname.trim().length > 0 ? options.hostname : selectedProfile.hostname;
              }
            }
          }
        }

        provider = provider || 'cloudflare';

        // Interactive mode selection when mode not yet resolved in TTY
        if (!mode && canPrompt(options)) {
          const providerCaps = DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.find(
            (cap) => cap.provider === provider
          );
          const modes = providerCaps?.modes || [];
          if (modes.length > 1) {
            const modeChoice = await clackSelect<string>({
              message: `Select tunnel mode for ${clackFormatProviderWithIcon(provider)}`,
              options: modes.map((m) => ({
                value: m.key,
                label: `${m.key} — ${m.label}`,
                ...(formatModeRequirements(m) !== 'none' ? { hint: `requires: ${formatModeRequirements(m)}` } : {}),
              })),
            });
            if (clackIsCancel(modeChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            mode = String(modeChoice);
          }
        }

        mode = mode || 'quick';
        if (mode === 'managed-remote') {
          if (!(typeof hostname === 'string' && hostname.trim().length > 0)) {
            if (canPrompt(options)) {
              const profilesStore = ensureTunnelProfilesMigrated();
              const lastManagedRemoteProfile = [...profilesStore.profiles]
                .filter((entry) => entry.provider === provider && entry.mode === 'managed-remote')
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
              const suggestedHostname = normalizeProfileHostname(lastManagedRemoteProfile?.hostname) || 'app.example.com';
              const enteredHostname = await clackText({
                message: 'Enter managed-remote tunnel hostname',
                placeholder: suggestedHostname,
                initialValue: suggestedHostname,
                validate(value) {
                  if (typeof value !== 'string' || value.trim().length === 0) {
                    return 'Hostname is required.';
                  }
                  return undefined;
                },
              });
              if (clackIsCancel(enteredHostname)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              hostname = enteredHostname.trim();
            } else {
              throw new Error('Managed-remote mode requires --hostname <hostname>.');
            }
          }

          if (!(typeof token === 'string' && token.trim().length > 0)) {
            if (canPrompt(options)) {
              const entered = await clackPassword({
                message: 'Enter managed-remote tunnel token',
              });
              if (clackIsCancel(entered) || !entered || !entered.trim()) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              token = entered.trim();
            } else {
              throw new Error('Managed-remote mode requires a token (--token, --token-file, or --token-stdin).');
            }
          }

          if (!selectedProfile && canPrompt(options)) {
            const runChoice = await clackSelect({
              message: 'Run once, or save profile and run?',
              options: [
                { value: 'run', label: 'Run once', hint: 'Do not save profile' },
                { value: 'save-run', label: 'Save profile and run', hint: 'Reuse with --profile later' },
              ],
            });
            if (clackIsCancel(runChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }

            if (runChoice === 'save-run') {
              const suggestedName = suggestProfileNameFromHostname(hostname);
              const enteredProfileName = await clackText({
                message: 'Profile name',
                placeholder: suggestedName,
                initialValue: suggestedName,
                validate(value) {
                  return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
                },
              });
              if (clackIsCancel(enteredProfileName)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }

              const desiredName = normalizeProfileName(enteredProfileName);
              const store = ensureTunnelProfilesMigrated();
              const existingIndex = store.profiles.findIndex(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              );

              if (existingIndex >= 0) {
                const shouldOverwrite = await clackConfirm({
                  message: `Profile '${desiredName}' already exists. Overwrite and run?`,
                  initialValue: true,
                });
                if (clackIsCancel(shouldOverwrite) || !shouldOverwrite) {
                  clackCancel('Tunnel start cancelled.');
                  return;
                }
              }

              const now = Date.now();
              const nextProfiles = [...store.profiles];
              if (existingIndex >= 0) {
                const current = nextProfiles[existingIndex]!;
                nextProfiles[existingIndex] = {
                  ...current,
                  mode: 'managed-remote',
                  hostname,
                  token,
                  updatedAt: now,
                };
              } else {
                nextProfiles.push({
                  id: crypto.randomUUID(),
                  name: desiredName,
                  provider,
                  mode: 'managed-remote',
                  hostname,
                  token,
                  createdAt: now,
                  updatedAt: now,
                });
              }

              const persisted: TunnelProfilesData = { version: TUNNEL_PROFILES_VERSION, profiles: nextProfiles };
              writeTunnelProfilesToDisk(persisted);
              writeManagedRemotePairsToDiskFromProfiles(persisted);

              selectedProfile = persisted.profiles.find(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              ) || null;
            }
          }

          if (typeof options.token === 'string' && !options.tokenFile && !options.tokenStdin && canPrompt(options)) {
            clackBox(
              'Token passed via --token is visible in your shell history and process list.\n' +
              'Consider using --token-file or --token-stdin for better security.',
              'Security Warning',
            );
          }
        }

        if (mode === 'managed-local') {
          const hasConfigPath = typeof options.configPath === 'string' && options.configPath.trim().length > 0;
          if (!hasConfigPath && canPrompt(options)) {
            const lastConfigPath = readLastManagedLocalConfigPath();
            const defaultConfigPath = getDefaultCloudflaredConfigPath();
            const suggestedConfigPath = lastConfigPath || defaultConfigPath;
            const suggestedConfigFound = isReadableRegularFile(suggestedConfigPath);
            const defaultConfigFound = isReadableRegularFile(defaultConfigPath);

            if (suggestedConfigFound || defaultConfigFound) {
              const foundPath = suggestedConfigFound ? suggestedConfigPath : defaultConfigPath;
              const configChoice = await clackSelect({
                message: 'Managed-local config',
                options: [
                  {
                    value: 'default',
                    label: 'Use found config',
                    hint: foundPath,
                  },
                  {
                    value: 'custom',
                    label: 'Enter config path',
                  },
                ],
              });
              if (clackIsCancel(configChoice)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              if (configChoice === 'default') {
                options.configPath = foundPath;
              }
            }

            if (!(typeof options.configPath === 'string' && options.configPath.trim().length > 0)) {
              const enteredPath = await clackText({
                message: 'Enter managed-local config path',
                placeholder: suggestedConfigPath,
                initialValue: suggestedConfigPath,
                validate(value) {
                  if (typeof value !== 'string' || value.trim().length === 0) {
                    return 'Config path is required.';
                  }
                  return undefined;
                },
              });
              if (clackIsCancel(enteredPath)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              options.configPath = enteredPath.trim();
            }

            if (typeof options.configPath === 'string' && options.configPath.trim().length > 0) {
              writeLastManagedLocalConfigPath(options.configPath);
            }
          }
        }

        const ttlOverrides = await resolveTunnelTtlOverrides(options);
        if (ttlOverrides === null) {
          return;
        }
        const { connectTtlMs, sessionTtlMs } = ttlOverrides;

        if (options.dryRun) {
          const dryRunResult = {
            ok: true,
            dryRun: true,
            provider,
            mode,
            hostname: hostname || null,
            hasToken: typeof token === 'string' && token.trim().length > 0,
            profile: selectedProfile ? selectedProfile.name : null,
            configPath: options.configPath || null,
            connectTtlMs: connectTtlMs ?? null,
            sessionTtlMs: sessionTtlMs ?? null,
          };
          if (isJsonMode(options)) {
            printJson(dryRunResult);
          } else if (!isQuietMode(options)) {
            clackIntro('Tunnel Start (dry-run)');
            logStatus('info', `Would start ${clackFormatProviderWithIcon(provider)}/${mode}`, hostname || '(ephemeral URL)');
            clackOutro('dry-run complete (no changes applied)');
          }
          return;
        }

        if (!options.explicitPort && canPrompt(options)) {
          const runningInstances = await discoverRunningInstances();
          if (runningInstances.length > 1) {
            const safeInstances = runningInstances.filter((entry) => !isUnsafeBrowserPort(entry.port));
            if (safeInstances.length === 0) {
              throw new TunnelCliError(
                'All discovered Piarium instance ports are browser-unsafe. Start or target a safe port (3000, 5173, 8080, or high ephemeral).',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const attachabilityResults = await Promise.all(
              safeInstances.map(async (entry) => ({
                entry,
                attachability: await inspectTunnelAttachability(entry.port, { requireHealthy: true }),
              }))
            );
            const attachableSafeInstances = attachabilityResults
              .filter((item) => item.attachability.attachable)
              .map((item) => item.entry);

            if (attachableSafeInstances.length === 0) {
              throw new TunnelCliError(
                'No attachable Piarium CLI instances found on safe ports. Start one with `piarium serve --port 3000`.',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const selectedPort = await clackSelect({
              message: 'Select Piarium instance port',
              options: attachableSafeInstances.map((entry) => ({
                value: entry.port,
                label: `port ${entry.port}`,
              })),
            });
            if (clackIsCancel(selectedPort)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            options.port = Number(selectedPort);
            options.explicitPort = true;
          }
        }

        const instance = await resolveTargetInstance({ options, serveCommand, allowAutoStart: true, rejectDesktopRuntime: true });
        if (instance?.autoStarted && shouldRenderHumanOutput(options)) {
          logStatus(
            'info',
            `Using auto-started instance on port ${instance.port}`,
            `logs: piarium logs -p ${instance.port}`,
          );
        }

        if (instance?.autoStarted) {
          setCancelCleanup(async () => {
            try {
              await stopCommand({ explicitPort: true, port: instance.port });
            } catch {
    // Best-effort operation; continue when it is unavailable.
  }
          });
        }

        if (instance?.autoStarted) {
          const healthProgress = await createProgress(options, { max: 60 });
          healthProgress?.start(`Waiting for Piarium on port ${instance.port} to become healthy (up to 60s)...`);
          let progressedSeconds = 0;
          const healthy = await waitForServerHealth(instance.port, {
            timeoutMs: 60000,
            intervalMs: 250,
            onTick({ elapsedMs, complete }) {
              if (!healthProgress) return;
              const elapsedSeconds = Math.min(60, Math.floor(elapsedMs / 1000));
              const delta = elapsedSeconds - progressedSeconds;
              if (delta > 0) {
                healthProgress.advance(delta);
                progressedSeconds = elapsedSeconds;
                healthProgress.message(`Waiting for Piarium health (${progressedSeconds}s / 60s)...`);
              }
              if (complete && progressedSeconds < 60) {
                const remaining = 60 - progressedSeconds;
                if (remaining > 0) {
                  healthProgress.advance(remaining);
                  progressedSeconds = 60;
                }
              }
            },
          });
          if (!healthy) {
            healthProgress?.stop('Piarium is still starting');
            throw new Error(
              `Piarium on port ${instance.port} is still starting after 60s. Startup time can vary by machine performance. ` +
              `Wait another minute, then check health with \`curl -fsS ${buildLocalUrl(instance.port, '/health')}\`. ` +
              `If health is OK, retry tunnel start with \`piarium tunnel start --port ${instance.port}\`. ` +
              `For diagnostics run \`piarium logs -p ${instance.port}\`.`
            );
          }
          healthProgress?.stop(`Instance ${instance.port} is healthy`);
        }

        if (selectedProfile && mode === 'managed-remote') {
          const tokenSyncPayload = {
            presetId: selectedProfile.id,
            presetName: selectedProfile.name,
            managedRemoteTunnelHostname: hostname,
            managedRemoteTunnelToken: token,
          };
          const { response: presetResponse, body: presetBody } = await requestJson(instance.port, '/api/piarium/tunnel/managed-remote-token', {
            method: 'PUT',
            body: JSON.stringify(tokenSyncPayload),
          });
          if (!presetResponse.ok || !presetBody?.ok) {
            throw new Error(textValue(presetBody?.error, `Failed to sync tunnel profile token (${presetResponse.status})`));
          }
        }

        const payload = {
          provider,
          mode,
          ...(typeof connectTtlMs === 'number' ? { connectTtlMs } : {}),
          ...(typeof sessionTtlMs === 'number' ? { sessionTtlMs } : {}),
          ...(options.configPath === null ? { configPath: null } : {}),
          ...(typeof options.configPath === 'string' ? { configPath: options.configPath } : {}),
          ...(typeof token === 'string' ? { token } : {}),
          ...(typeof hostname === 'string' ? { hostname } : {}),
          ...(selectedProfile ? {
            managedRemoteTunnelPresetId: selectedProfile.id,
            managedRemoteTunnelPresetName: selectedProfile.name,
          } : {}),
        };

        const spin = createSpinner(options);
        spin?.start(`Starting ${clackFormatProviderWithIcon(provider)}/${mode} tunnel...`);

        let response: Response;
        let body: Record<string, unknown> | null;
        try {
          ({ response, body } = await requestJson(instance.port, '/api/piarium/tunnel/start', {
            method: 'POST',
            body: JSON.stringify(payload),
            timeoutMs: 60000,
          }));
        } catch (error) {
          if (error instanceof Error && /\/api\/piarium\/tunnel\/start/.test(error.message) && /timed out/.test(error.message)) {
            spin?.error('Tunnel start timed out');
            throw new Error(
              `Tunnel start timed out after 60s. cloudflared may still be starting; check with \`piarium tunnel status --port ${instance.port}\`. Run \`piarium logs -p ${instance.port}\` for details.`
            );
          }
          spin?.error('Tunnel start failed');
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} Run \`piarium logs -p ${instance.port}\` for details.`);
        }

        if (!response.ok || !body?.ok) {
          spin?.error('Tunnel start failed');
          const baseError = textValue(body?.error, `Tunnel start failed (${response.status})`);
          const isCloudflareTimeout = /context deadline exceeded|Client\.Timeout exceeded while awaiting headers|failed to request quick Tunnel/i.test(baseError);
          const userError = isCloudflareTimeout
            ? `Cloudflare quick tunnel request timed out. ${baseError}`
            : baseError;
          throw new Error(`${userError} Run \`piarium logs -p ${instance.port}\` for details.`);
        }

        // Avoid duplicate "Tunnel started" lines: spinner completion is implied by
        // the subsequent structured success section.
        spin?.clear();

        const replayCommand = buildTunnelStartReplayCommand({
          port: instance.port,
          provider,
          mode,
          profileName: selectedProfile?.name,
          configPath: options.configPath,
          hostname,
          connectTtlMs,
          sessionTtlMs,
          qr: options.qr === true,
          noQr: options.noQr === true,
          includeTokenPlaceholder: !selectedProfile && mode === 'managed-remote' && typeof token === 'string' && token.trim().length > 0,
          tokenViaStdin: options.tokenStdin === true,
          tokenFileProvided: typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0,
        });

        if (isJsonMode(options)) {
          printJson({ port: instance.port, replayCommand, ...body });
        } else if (isQuietMode(options)) {
          const quietUrl = textValue(body.connectUrl, textValue(body.url, 'n/a'));
          process.stdout.write(`port ${instance.port} ${quietUrl}\n`);
        } else {
          console.log('');
          clackIntro(boldText('Tunnel Started'));
          logStatus('success', `port ${instance.port} ${clackFormatProviderWithIcon(body.provider)}/${textValue(body.mode, 'unknown')}`);
          logStatus('success', textValue(body.connectUrl, textValue(body.url, 'n/a')));
          if (body.replacedTunnel) {
            const revokedBootstrapCount = typeof body.revokedBootstrapCount === 'number' && Number.isFinite(body.revokedBootstrapCount) ? body.revokedBootstrapCount : 0;
            const invalidatedSessionCount = typeof body.invalidatedSessionCount === 'number' && Number.isFinite(body.invalidatedSessionCount) ? body.invalidatedSessionCount : 0;
            const previousMode = textValue(recordOf(body.replaced).mode, 'unknown');
            logStatus(
              'warning',
              `replaced previous ${previousMode} tunnel`,
              `revoked ${revokedBootstrapCount}, invalidated ${invalidatedSessionCount}`,
            );
          }
          clackOutro('');

          const optionalTips = [
            { line: 'Check status', detail: 'piarium tunnel status' },
            { line: 'Stop tunnel', detail: 'piarium tunnel stop' },
            { line: 'If needed, repeat with same settings', detail: replayCommand },
          ];

          if (!selectedProfile && mode === 'managed-remote' && typeof hostname === 'string' && hostname.trim().length > 0) {
            const profileSaveCommand = buildTunnelProfileAddCommand({ provider, hostname });
            optionalTips.push({ line: 'Optional: save reusable profile (stores hostname + token locally)', detail: profileSaveCommand });
            optionalTips.push({ line: 'Start from saved profile', detail: 'piarium tunnel start --profile <name>' });
          }

          console.log('');
          clackIntro('Optional Tips');
          for (const tip of optionalTips) {
            logStatus('info', tip.line, tip.detail);
          }
          clackOutro('');
        }

        setCancelCleanup(null);

        if (shouldDisplayTunnelQr(options)) {
          const url = body.connectUrl || body.url;
          if (typeof url === 'string' && url.length > 0) {
            await displayTunnelQrCode(url);
          }
        }
        return;
      }
      case 'stop': {
        let entries: CliInstance[];
        if (options.all) {
          entries = await resolveTargetInstance({ options, serveCommand, allowAutoStart: false, requireAll: true });
          if (entries.length > 1 && !options.force && canPrompt(options)) {
            const shouldStop = await clackConfirm({
              message: `Stop tunnels on all ${entries.length} instances?`,
            });
            if (clackIsCancel(shouldStop) || !shouldStop) {
              clackCancel('Tunnel stop cancelled.');
              return;
            }
          }
        } else {
          entries = [await resolveTargetInstance({ options, serveCommand, allowAutoStart: false })];
        }

        const results: TunnelOperationResult[] = [];
        for (const entry of entries) {
          const tunnelStopSpin = shouldRenderHumanOutput(options) ? createSpinner(options) : null;
          tunnelStopSpin?.start(`Stopping tunnel on port ${entry.port}...`);
          try {
            const { response, body } = await requestJson(entry.port, '/api/piarium/tunnel/stop', {
              method: 'POST',
            });
            if (!response.ok) {
              tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
              results.push({ port: entry.port, error: textValue(body?.error, `stop ${response.status}`) });
              continue;
            }
            tunnelStopSpin?.stop(`Stopped tunnel on port ${entry.port}`);
            results.push({ port: entry.port, result: body ?? {} });
          } catch (error) {
            tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            process.stdout.write(`port ${result.port} stopped\n`);
          }
          return;
        }

        clackIntro('Tunnel Stop');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }
          logStatus('success', `port ${result.port} stopped`, `revoked ${result.result?.revokedBootstrapCount || 0}, invalidated ${result.result?.invalidatedSessionCount || 0}`);
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'completion': {
        const shell = action || 'bash';
        const completionScript = generateCompletionScript(shell);
        if (!completionScript) {
          throw new TunnelCliError(
            `Unsupported shell '${shell}'. Supported: bash, zsh, fish.`,
            EXIT_CODE.USAGE_ERROR
          );
        }
        process.stdout.write(completionScript);
        return;
      }
      default: {
        const knownTunnelSubcommands = ['help', 'providers', 'ready', 'doctor', 'status', 'start', 'stop', 'profile', 'completion'];
        const suggestion = findClosestMatch(subcommand, knownTunnelSubcommands);
        const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
        throw new TunnelCliError(
          `Unknown tunnel subcommand '${subcommand}'.${hint} Use 'piarium tunnel help'.`,
          EXIT_CODE.USAGE_ERROR
        );
      }
    }
}

export {
  createTunnelCommand,
  isValidTunnelDoctorResponse,
  shouldDisplayTunnelQr,
};
