import 'reflect-metadata';
import compression from 'compression';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import http2 from 'node:http2';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import webPush from 'web-push';
import {
  ApplicationExtensionCatalog,
  ApplicationExtensionRuntime,
  ExtensionPackageManager,
} from '@piarium/extension-host';
import { createDocumentAuthority } from './lib/documents/authority.js';
import { registerBuiltinWorkbenchLayoutService } from './lib/extensions/workbench-layout-service.js';
import { createDocumentsCapabilityHandler } from './lib/documents/capability.js';
import { createWorkspaceRecoveryEngine } from './lib/recovery/engine.js';
import { createWorkspaceRecoveryCapabilityHandler } from './lib/recovery/capability.js';
import { RecoveryPrimitiveError } from './lib/recovery/errors.js';
import { createPiWorkspaceWriterTracker } from './lib/recovery/pi-writer-tracker.js';
import { createRecoveryTurnCoordinator } from './lib/recovery/turn-coordinator.js';
import { createLanguageSupervisor } from './lib/lsp/supervisor.js';
import { createLanguageCapabilityHandler, createWorkspaceSearchCapabilityHandler } from './lib/lsp/capability.js';
import { createRunRuntime } from './lib/run/runtime.js';
import {
  createWorkspaceDebugCapabilityHandler,
  createWorkspaceTasksCapabilityHandler,
  createWorkspaceTestCapabilityHandler,
} from './lib/run/capability.js';
import { createWorkspaceContentSearch } from './lib/search/content.js';
import { createDocumentRootGuard } from './lib/documents/allowed-roots.js';
import { createWorkspaceConfig } from './lib/workspace/workspace-config.js';

import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelMode,
  normalizeTunnelProvider,
  normalizeTunnelStartRequest,
} from './lib/tunnels/types.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import {
  getInvalidBindHostErrorMessage,
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
  normalizeBindHost,
} from './lib/security/bind-host.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import {
  createGlobalUiEventBroadcaster,
  createNotificationEmitterRuntime,
} from './lib/notifications/emitter-runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createPiSessionRuntime } from './lib/notifications/pi-session-runtime.js';
import { createMobileDeviceStore } from './lib/mobile/device-store.js';
import { createMobilePairingRuntime } from './lib/mobile/pairing-runtime.js';
import { createMobilePushRuntime } from './lib/mobile/push-runtime.js';
import { registerMobileRoutes } from './lib/mobile/routes.js';
import { createGracefulShutdownRuntime } from './lib/shutdown-runtime.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { createPreviewProxyRuntime } from './lib/preview/proxy-runtime.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { createRelayService } from './lib/relay/service.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';
import { PiRuntimeBrokerError, PiRuntimeLifecycle } from '@piarium/runtime-broker';
import {
  attachPiSessionExecutionAdmission,
  createWebPiRuntimeBroker,
} from './lib/pi-runtime/broker.js';
import { createPiRuntimeGateway } from './lib/pi-runtime/gateway.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createPiScheduledTaskExecutor } from './lib/scheduled-tasks/pi-executor.js';
import { createPiSessionAutomationRuntime } from './lib/pi-session-automation/runtime.js';
import { createServerBootstrapRuntime } from './lib/platform/bootstrap-runtime.js';
import { parseServeCliOptions } from './lib/platform/cli-options.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/platform/core-routes.js';
import { createPlatformEnvironmentRuntime } from './lib/platform/environment-runtime.js';
import { resolvePiariumDataDir } from './lib/platform/data-paths.js';
import { createProjectDirectoryRuntime } from './lib/platform/project-directory-runtime.js';
import { registerPiariumRoutes } from './lib/platform/piarium-routes.js';
import { createPlatformRoutesRuntime } from './lib/platform/routes-runtime.js';
import { runCliEntryIfMain } from './lib/platform/cli-entry-runtime.js';
import { createServerStartupRuntime } from './lib/platform/server-startup-runtime.js';
import { createSettingsHelpers } from './lib/platform/settings-helpers.js';
import { createSettingsNormalizationRuntime } from './lib/platform/settings-normalization-runtime.js';
import { createSettingsRuntime } from './lib/platform/settings-runtime.js';
import { recordStartupPerformance } from './lib/platform/startup-performance.js';
import { createStaticRoutesRuntime } from './lib/platform/static-routes-runtime.js';
import { createStartupPipelineRuntime } from './lib/platform/startup-pipeline-runtime.js';
import { createThemeRuntime } from './lib/platform/theme-runtime.js';
import { createTunnelAuth } from './lib/platform/tunnel-auth.js';
import { createTunnelWiringRuntime } from './lib/platform/tunnel-wiring-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CLIENT_RELOAD_DELAY_MS = 800;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const DESKTOP_NOTIFY_PREFIX = '[PiariumDesktopNotify] ';
const MAX_THEME_JSON_BYTES = 512 * 1024;

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '1' || value.trim().toLowerCase() === 'true';
};

const isEnvFlagDisabled = (value) => {
  if (value === false || value === 0) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '0' || value.trim().toLowerCase() === 'false';
};

const PIARIUM_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    throw new Error('package.json does not declare a version');
  } catch (error) {
    throw new Error(`Unable to resolve the Piarium Web application version: ${error?.message || error}`);
  }
})();

const PIARIUM_DATA_DIR = resolvePiariumDataDir(process);
const PIARIUM_USER_CONFIG_ROOT = PIARIUM_DATA_DIR;
const PIARIUM_USER_THEMES_DIR = path.join(PIARIUM_USER_CONFIG_ROOT, 'themes');
const PIARIUM_PROJECTS_CONFIG_DIR = path.join(PIARIUM_USER_CONFIG_ROOT, 'projects');
const SETTINGS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'push-subscriptions.json');
const MOBILE_DEVICES_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'mobile-devices.json');
const APNS_TOKENS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'apns-tokens.json');
const REMOTE_CLIENTS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'remote-clients.json');
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'client-pairing-sessions.json');
const MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(PIARIUM_DATA_DIR, 'cloudflare-named-tunnels.json');

const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.PIARIUM_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.PIARIUM_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.PIARIUM_COMPRESS_API)) return true;
  return process.env.PIARIUM_RUNTIME === 'desktop';
};

const SSE_PATHS = new Set([
  '/api/notifications/stream',
  '/api/piarium/events',
  '/api/piarium/runtime-manager/events',
  '/api/piarium/realtime-proxy/sse',
]);

const shouldSkipCompression = (req, res) => {
  if (process.env.PIARIUM_RUNTIME === 'desktop') return true;
  const acceptsSse = (value) => Array.isArray(value)
    ? value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'))
    : typeof value === 'string' && value.toLowerCase().includes('text/event-stream');
  if (acceptsSse(req.headers.accept)) return true;
  const pathname = req.path || req.url || '';
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) return true;
  return SSE_PATHS.has(pathname) || acceptsSse(res.getHeader('Content-Type'));
};

const fsPromises = fs.promises;
const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  realpathSync: fs.realpathSync,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});
const normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname = (...args) => settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets = (...args) => settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens = (...args) => settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const sanitizeTypographySizesPartial = (...args) => settingsNormalizationRuntime.sanitizeTypographySizesPartial(...args);
const normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeProjects = (...args) => settingsNormalizationRuntime.sanitizeProjects(...args);

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
  },
});
const readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
});
const normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse = (...args) => settingsHelpers.formatSettingsResponse(...args);

let readSettingsFromDisk = async () => ({});
const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDisk: () => readSettingsFromDisk,
  sanitizeProjects,
});
const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  formatSettingsResponse,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
});
readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const updateSettingsOnDisk = (...args) => settingsRuntime.updateSettingsOnDisk(...args);
const persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: PIARIUM_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});
const readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({ readSettingsFromDisk });
const getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);
const rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);
const isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  webPush,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
const isAnyInteractiveClientVisible = (...args) => pushRuntime.isAnyInteractiveClientVisible(...args);
const isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);
const updateUiVisibility = (...args) => pushRuntime.updateUiVisibility(...args);

const mobileDeviceStore = createMobileDeviceStore({
  fsPromises,
  path,
  crypto,
  mobileDevicesFilePath: MOBILE_DEVICES_FILE_PATH,
});
const mobilePushRuntime = createMobilePushRuntime({ deviceStore: mobileDeviceStore });
const sendMobilePushToAllDevices = (...args) => mobilePushRuntime.sendMobilePushToAllDevices(...args);
const mobilePairingRuntime = createMobilePairingRuntime({ crypto, deviceStore: mobileDeviceStore });
const apnsRuntime = createApnsRuntime({
  fsPromises,
  path,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const addOrUpdateApnsToken = (...args) => apnsRuntime.addOrUpdateApnsToken(...args);
const removeApnsToken = (...args) => apnsRuntime.removeApnsToken(...args);
const sendApnsToAllUiSessions = (...args) => apnsRuntime.sendApnsToAllUiSessions(...args);

const uiNotificationClients = new Set();
const uiPiariumEventClients = new Set();
const desktopNotifyEnabled = process.env.PIARIUM_DESKTOP_NOTIFY === 'true'
  || process.env.PIARIUM_RUNTIME === 'desktop';
let broadcastGlobalUiEvent = null;
const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => desktopNotifyEnabled,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});
const writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  writeSseEvent,
});
const emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);
const sessionRuntime = createPiSessionRuntime({ broadcastEvent: broadcastGlobalUiEvent });

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: PIARIUM_PROJECTS_CONFIG_DIR,
});
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  listProjects: async () => sanitizeProjects((await readSettingsFromDisk())?.projects || []),
  emitTaskRunEvent: (event) => {
    for (const client of uiPiariumEventClients) {
      try {
        writeSseEvent(client, {
          type: 'piarium:scheduled-task-ran',
          properties: {
            projectId: event.projectID,
            taskId: event.taskID,
            ranAt: event.ranAt,
            status: event.status,
            ...(event.sessionID ? { sessionId: event.sessionID } : {}),
          },
        });
      } catch {
        uiPiariumEventClients.delete(client);
      }
    }
  },
  logger: console,
});
const scheduledTaskService = createScheduledTaskService({
  readSettingsFromDisk,
  sanitizeProjects,
  projectConfigRuntime,
  scheduledTasksRuntime,
});

const platformEnvironmentRuntime = createPlatformEnvironmentRuntime();
platformEnvironmentRuntime.applyLoginShellEnvSnapshot();
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});

let server = null;
let uiAuthController = null;
let activeTunnelController = null;
let terminalRuntime = null;
let activeDocumentsAuthority = null;
let exitOnShutdown = true;
let isShuttingDown = false;
let signalsAttached = false;
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';

const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDisk,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => { activeTunnelController = value; },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => { runtimeManagedRemoteTunnelHostname = value; },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => { runtimeManagedRemoteTunnelToken = value; },
});

const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => { isShuttingDown = value; },
  sessionRuntime,
  scheduledTasksRuntime,
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => { terminalRuntime = value; },
  getDocumentsAuthority: () => activeDocumentsAuthority,
  setDocumentsAuthority: (value) => { activeDocumentsAuthority = value; },
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => { uiAuthController = value; },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => { activeTunnelController = value; },
  tunnelAuthController,
});
const gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createDictationRuntime,
  createServerStartupRuntime,
});
const bootstrapRuntime = createServerBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerMobileRoutes,
  registerPiariumRoutes,
  express,
});
const platformRoutesRuntime = createPlatformRoutesRuntime({ clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS });

const requestReachedLanAddress = (req) => {
  const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && !address.startsWith('127.') ? address : null;
};

const extractAssistantText = (messages) => {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text.slice(0, 240);
  }
  return '';
};

async function main(options = {}) {
  if (server?.listening) throw new Error('Piarium server is already running');
  isShuttingDown = false;
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : undefined;
  const configuredBindHost = host || process.env.PIARIUM_HOST?.trim() || '127.0.0.1';
  const effectiveBindHost = normalizeBindHost(configuredBindHost);
  if (!effectiveBindHost) throw new Error(getInvalidBindHostErrorMessage(configuredBindHost));
  const uiPassword = typeof options.uiPassword === 'string'
    ? options.uiPassword
    : typeof process.env.PIARIUM_UI_PASSWORD === 'string'
      ? process.env.PIARIUM_UI_PASSWORD
      : null;
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !(typeof uiPassword === 'string' && uiPassword.trim())
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (typeof options.exitOnShutdown === 'boolean') exitOnShutdown = options.exitOnShutdown;
  if (typeof options.onDesktopNotification === 'function') {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  const getIsWindowFocused = typeof options.getIsWindowFocused === 'function'
    ? options.getIsWindowFocused
    : () => false;
  const getDesktopRuntimeConfig = typeof options.getDesktopRuntimeConfig === 'function'
    ? options.getDesktopRuntimeConfig
    : null;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.PIARIUM_API_ONLY);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  const startupTunnelRequest = (
    typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string'
  )
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : options.tryCfTunnel === true
      ? { provider: TUNNEL_PROVIDER_CLOUDFLARE, mode: TUNNEL_MODE_QUICK, token: '' }
      : null;

  console.log(`Starting Piarium on port ${port === 0 ? 'auto' : port}`);
  const app = express();
  const extensionCatalog = options.extensionCatalog
    || options.extensionRuntime?.catalog
    || new ApplicationExtensionCatalog({ dataDir: PIARIUM_DATA_DIR });
  const extensionPackages = options.extensionPackages
    || options.extensionRuntime?.packages
    || new ExtensionPackageManager({
    catalog: extensionCatalog,
    dataDir: PIARIUM_DATA_DIR,
    piariumVersion: PIARIUM_VERSION,
  });
  let extensionRuntime = options.extensionRuntime || null;
  const ownsExtensionRuntime = !extensionRuntime;
  app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  const packagedClientOrigins = new Set(['piarium-ui://app', 'capacitor://localhost', 'http://localhost', 'https://localhost']);
  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (packagedClientOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-Piarium-Application-Token,X-Piarium-Directory,X-Piarium-Directory-Encoding');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
  app.use(compression({
    filter: (req, res) => shouldSkipCompression(req, res) ? false : compression.filter(req, res),
    threshold: 1024,
  }));
  server = http.createServer(app);
  const serverStartedAt = new Date().toISOString();
  let piRuntimeHandshake = null;
  let piRuntimeLifecycle = null;
  let relayServiceInstance = null;
  let tunnelRuntimeContext = null;
  let realtimeProxyRuntime = { stop: () => {} };
  let dictationRuntime = null;
  const currentPiRuntimeHandshake = () => (
    piRuntimeLifecycle ? piRuntimeLifecycle.handshake : piRuntimeHandshake
  );

  const activePort = () => tunnelRuntimeContext?.getActivePort() || port;
  const resolvePairingTransports = (req) => {
    const local = `http://127.0.0.1:${activePort()}`;
    let lanHost = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      lanHost = requestReachedLanAddress(req);
      if (!lanHost) {
        for (const list of Object.values(os.networkInterfaces())) {
          const entry = (list || []).find((candidate) => candidate.family === 'IPv4' && !candidate.internal);
          if (entry) { lanHost = entry.address; break; }
        }
      }
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(effectiveBindHost.toLowerCase())) {
      lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort()}` : null;
    return { local, lan, relayAvailable: true };
  };
  const resolveDirectLanUrls = (req) => {
    const urls = [];
    const add = (address) => {
      if (!address) return;
      const url = `http://${address.includes(':') ? `[${address}]` : address}:${activePort()}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      add(requestReachedLanAddress(req));
      for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) add(entry.address);
      }
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(effectiveBindHost.toLowerCase())) {
      add(effectiveBindHost);
    }
    return urls;
  };

  const sayTTSCapability = detectSayTtsCapability(process);
  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    process,
    piariumVersion: PIARIUM_VERSION,
    runtimeName: process.env.PIARIUM_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot: () => {
      const handshake = currentPiRuntimeHandshake();
      return {
        apiOnly,
        ...(process.env.PIARIUM_RELEASE_ID?.trim()
          ? { releaseId: process.env.PIARIUM_RELEASE_ID.trim() }
          : {}),
        piRuntime: {
          ready: Boolean(handshake),
          capabilities: handshake?.capabilities ?? null,
          hostVersion: handshake?.hostVersion ?? null,
          nodeVersion: handshake?.runtime?.nodeVersion ?? null,
          piVersion: handshake?.runtime?.piVersion ?? null,
          protocolVersion: handshake?.protocolVersion ?? null,
          source: handshake?.runtime?.source ?? null,
          manager: piRuntimeLifecycle?.snapshot ?? null,
        },
      };
    },
    verboseRequestLogs: isEnvFlagEnabled(process.env.PIARIUM_VERBOSE_REQUEST_LOGS),
    uiPassword,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: (pairingOptions) => relayServiceInstance
      ? pairingOptions?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate()
      : null,
    reconcileRelay: () => relayServiceInstance?.reconcile() ?? Promise.resolve(),
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    getServerId: () => relayServiceInstance?.getServerId() ?? Promise.resolve(null),
    getServerPort: activePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getServerLabel: () => os.hostname()?.trim() || 'Piarium',
    readSettingsFromDisk,
    normalizeTunnelSessionTtlMs,
    sayTTSCapability,
    ensurePushInitialized,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    updateSettingsOnDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => {},
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    sessionRuntime,
    setPushInitialized,
    fs,
    path,
    server,
    __dirname,
    piariumDataDir: PIARIUM_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL_MS,
    mobileDeviceStore,
    mobilePairingRuntime,
    mobilePushRuntime,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  realtimeProxyRuntime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig,
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed,
  });

  const requirePiRuntime = options.requirePiRuntime ?? process.env.PIARIUM_RUNTIME !== 'desktop';
  let piWriterTracker = null;
  let recoveryTurnCoordinator = null;
  const admitPiSessionExecution = (request) => {
    if (!piWriterTracker) {
      throw new PiRuntimeBrokerError(
        'runtime_not_ready',
        'Pi workspace writer admission is not ready',
        { retryable: true },
      );
    }
    return recoveryTurnCoordinator?.admit(request) ?? piWriterTracker.admit(request);
  };
  const piRuntimeBrokerFactory = options.createPiRuntimeBroker || ((brokerOptions) => createWebPiRuntimeBroker({
    agentDir: process.env.PIARIUM_AGENT_DIR,
    clientVersion: PIARIUM_VERSION,
    cwd: process.cwd(),
    ...brokerOptions,
  }));
  const createPiRuntimeBroker = (brokerOptions) => attachPiSessionExecutionAdmission(
    piRuntimeBrokerFactory({
      ...brokerOptions,
      admitSessionExecution: admitPiSessionExecution,
    }),
    admitPiSessionExecution,
  );
  piRuntimeLifecycle = options.piRuntimeLifecycle || new PiRuntimeLifecycle({
    dataDir: PIARIUM_DATA_DIR,
    createBroker: (brokerOptions) => createPiRuntimeBroker(brokerOptions),
    ...(options.hostEntry ? { hostEntry: options.hostEntry } : {}),
    ...(options.standalonePayloadDir || process.env.PIARIUM_PI_STANDALONE_PAYLOAD
      ? {
          installer: {
            standalonePayloadDir: options.standalonePayloadDir || process.env.PIARIUM_PI_STANDALONE_PAYLOAD,
          },
        }
      : {}),
  });
  const ownsPiRuntimeBroker = !options.piRuntimeBroker && !options.piRuntimeLifecycle;
  const piRuntimeBroker = options.piRuntimeBroker || piRuntimeLifecycle.asBroker();
  if (options.piRuntimeBroker) {
    attachPiSessionExecutionAdmission(piRuntimeBroker, admitPiSessionExecution);
  }
  const getReadyPiRuntimeBroker = () => (
    options.piRuntimeBroker
    || (piRuntimeLifecycle?.currentBroker ? piRuntimeBroker : null)
  );
  const startPiRuntime = async () => {
    recordStartupPerformance('pi-runtime.warmup.start');
    try {
      piRuntimeHandshake = await piRuntimeLifecycle.start() ?? null;
      if (piRuntimeHandshake) {
        recordStartupPerformance('pi-runtime.warmup.ready');
        return;
      }
      if (requirePiRuntime) {
        recordStartupPerformance('pi-runtime.warmup.error');
        throw new Error('Pi runtime is not ready');
      }
    } catch (error) {
      recordStartupPerformance('pi-runtime.warmup.error');
      if (requirePiRuntime) throw error;
      console.warn('[PiRuntime] Deferred runtime start:', error?.message || error);
    }
  };
  piRuntimeLifecycle.subscribe((snapshot) => {
    if (snapshot.status === 'ready') piRuntimeHandshake = piRuntimeLifecycle.handshake ?? piRuntimeHandshake;
  });
  if (!extensionRuntime) {
    extensionRuntime = await ApplicationExtensionRuntime.create({
      brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.resolve('@piarium/extension-host'))),
      catalog: extensionCatalog,
      dataDir: PIARIUM_DATA_DIR,
      packages: extensionPackages,
      piariumVersion: PIARIUM_VERSION,
    });
  }
  const workspaceConfig = createWorkspaceConfig({
    env: process.env,
    cwd: process.cwd(),
    pathModule: path,
    osModule: os,
  });
  const workspaceRootGuard = createDocumentRootGuard({
    fsPromises,
    pathModule: path,
    readSettings: readSettingsFromDisk,
    getWorkspaceRoot: () => workspaceConfig.root,
  });
  let scheduleWorkspaceRecoveryBaseline = () => undefined;
  const documentsAuthority = createDocumentAuthority({
    hostId: extensionRuntime.services.hostId,
    dataDir: PIARIUM_DATA_DIR,
    maxReadBytes: workspaceConfig.maxReadBytes,
    isAllowedRoot: workspaceRootGuard,
    onWorkspaceResolved: (workspace) => scheduleWorkspaceRecoveryBaseline(workspace),
  });
  activeDocumentsAuthority = documentsAuthority;
  piWriterTracker = createPiWorkspaceWriterTracker({ documents: documentsAuthority });
  const inspectRecoveryGit = async (workspaceRoot) => {
    const git = await import('./lib/git/service.js');
    if (!await git.isGitRepository(workspaceRoot)) return { available: true, repository: false, staged: false };
    const status = await git.getStatus(workspaceRoot, { mode: 'light' });
    return {
      available: true,
      repository: true,
      staged: status.files.some((file) => {
        const index = String(file.index || '').trim();
        return index && index !== '?';
      }),
      ...(status.mergeInProgress ? { operation: 'merge' }
        : status.rebaseInProgress ? { operation: 'rebase' }
          : {}),
    };
  };
  const workspaceRecoveryEngines = new Map();
  const assertRecoverySessionWorkspace = async (sessionId, workspaceId) => {
    const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId });
    const authorityWorkspaceId = snapshot.workspace?.kind === 'workspace'
      ? snapshot.workspace.authorityId ?? snapshot.workspace.id
      : null;
    if (authorityWorkspaceId !== workspaceId) {
      throw new RecoveryPrimitiveError(
        'navigation-conflict',
        'The Pi session is no longer bound to the workspace selected for recovery',
        { details: { sessionId, workspaceId } },
      );
    }
  };
  const recoverySessionNavigation = {
    async commit(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.commit',
        {
          expectedLeafId: input.expectedLeafId,
          operationId: input.operationId,
          preparedTargetLeafId: input.preparedTargetLeafId,
          sessionId: input.sessionId,
          targetId: input.targetId,
        },
      );
    },
    async commitLeaf(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.commitLeaf',
        {
          expectedLeafId: input.expectedLeafId,
          operationId: input.operationId,
          preparedTargetLeafId: input.preparedTargetLeafId,
          sessionId: input.sessionId,
        },
      );
    },
    async prepare(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.prepare',
        { sessionId: input.sessionId, targetId: input.targetId },
      );
    },
    async prepareLeaf(input) {
      await assertRecoverySessionWorkspace(input.sessionId, input.workspaceId);
      return piRuntimeBroker.requestForSession(
        input.sessionId,
        'session.recovery.navigation.prepareLeaf',
        { sessionId: input.sessionId, targetLeafId: input.targetLeafId },
      );
    },
  };
  const recoveryEngineForOwner = (context) => {
    const storageOwnerId = context?.owner?.extensionId;
    if (typeof storageOwnerId !== 'string' || !storageOwnerId) {
      throw new Error('Workspace recovery capability requires an extension owner');
    }
    let engine = workspaceRecoveryEngines.get(storageOwnerId);
    if (!engine) {
      engine = createWorkspaceRecoveryEngine({
        authorityId: extensionRuntime.services.hostId,
        dataDir: PIARIUM_DATA_DIR,
        defaultRecoveryDir: process.env.PIARIUM_RECOVERY_DIR?.trim() || undefined,
        documents: documentsAuthority,
        gitInspector: inspectRecoveryGit,
        sessionNavigation: recoverySessionNavigation,
        storageOwnerId,
      });
      workspaceRecoveryEngines.set(storageOwnerId, engine);
    }
    return engine;
  };
  const foundationalRecoveryEngine = recoveryEngineForOwner({
    owner: { extensionId: 'piarium.builtin.recovery' },
  });
  const workspaceBaselineTasks = new Map();
  const workspaceBaselineAbortControllers = new Map();
  scheduleWorkspaceRecoveryBaseline = ({ workspaceId }) => {
    if (workspaceBaselineTasks.has(workspaceId)) return;
    const controller = new AbortController();
    workspaceBaselineAbortControllers.set(workspaceId, controller);
    const task = foundationalRecoveryEngine.captureSnapshot({
      reuseIfUnchanged: true,
      signal: controller.signal,
      source: 'baseline',
      workspaceId,
    }).then((result) => {
      if (result.status === 'failed') {
        console.warn(`[WorkspaceRecovery] Background baseline failed for ${workspaceId}: ${result.failure.message}`);
      }
      if (result.status !== 'captured' || result.snapshot.consistency !== 'validated') {
        workspaceBaselineTasks.delete(workspaceId);
      }
    }).catch((error) => {
      workspaceBaselineTasks.delete(workspaceId);
      console.warn(`[WorkspaceRecovery] Background baseline failed for ${workspaceId}: ${error?.message || error}`);
    }).finally(() => {
      workspaceBaselineAbortControllers.delete(workspaceId);
    });
    workspaceBaselineTasks.set(workspaceId, task);
  };
  let fencedRecoveryOperations = [];
  try {
    fencedRecoveryOperations = await foundationalRecoveryEngine.fenceUnfinishedOperations();
    await foundationalRecoveryEngine.resumeWorkspaceOperations();
  } catch (error) {
    console.error('[WorkspaceRecovery] Startup workspace recovery requires attention:', error?.message || error);
  }
  const piRuntimeStartup = startPiRuntime();
  if (requirePiRuntime || fencedRecoveryOperations.length > 0) await piRuntimeStartup;
  else void piRuntimeStartup;
  const combinedRecoveryStartup = piRuntimeStartup.then(() => (
    foundationalRecoveryEngine.resumeCombinedOperations()
  )).catch((error) => {
    console.error('[WorkspaceRecovery] Startup combined recovery requires attention:', error?.message || error);
  });
  if (fencedRecoveryOperations.length > 0) await combinedRecoveryStartup;
  else void combinedRecoveryStartup;
  extensionRuntime.workbench.setWorkspaceScopeResolver((scopeId) => documentsAuthority.resolveScopeId(scopeId));
  const languageSupervisor = createLanguageSupervisor({
    activateProviders: () => extensionRuntime.activateForEvent('workspace-match'),
    documents: documentsAuthority,
    spawn,
    pathModule: path,
    env: process.env,
    // Workspaces become executable only after their canonical root is an
    // explicit Piarium project/directory grant. The same Host guard owns file
    // authority, so renderer or extension input cannot expand this boundary.
    isTrusted: workspaceRootGuard,
  });
  const workspaceContentSearch = createWorkspaceContentSearch({
    documents: documentsAuthority,
    spawn,
    pathModule: path,
    env: process.env,
  });
  const unregisterDocumentsCapability = extensionRuntime.capabilities.register(
    'workspace.documents',
    createDocumentsCapabilityHandler(documentsAuthority),
  );
  const unregisterWorkspaceRecoveryCapability = extensionRuntime.capabilities.register(
    'workspace.recovery-primitives',
    createWorkspaceRecoveryCapabilityHandler(recoveryEngineForOwner),
  );
  const unregisterSearchCapability = extensionRuntime.capabilities.register(
    'workspace.search',
    createWorkspaceSearchCapabilityHandler(workspaceContentSearch),
  );
  const unregisterLanguageCapability = extensionRuntime.capabilities.register(
    'workspace.language',
    createLanguageCapabilityHandler(languageSupervisor),
  );
  const runRuntime = createRunRuntime({
    documents: documentsAuthority,
    spawn,
    pathModule: path,
    env: process.env,
    isTrusted: workspaceRootGuard,
  });
  const unregisterTasksCapability = extensionRuntime.capabilities.register(
    'workspace.tasks',
    createWorkspaceTasksCapabilityHandler(runRuntime.tasks),
  );
  const unregisterDebugCapability = extensionRuntime.capabilities.register(
    'workspace.debug',
    createWorkspaceDebugCapabilityHandler(runRuntime.debug),
  );
  const unregisterTestCapability = extensionRuntime.capabilities.register(
    'workspace.test',
    createWorkspaceTestCapabilityHandler(runRuntime.tests),
  );
  const unregisterPiRuntimeCapability = extensionRuntime.capabilities.register('pi-runtime', async (method, value) => {
    if (method !== 'request' || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('The pi-runtime capability expects a request object');
    }
    const request = value;
    const target = request.target && typeof request.target === 'object' && !Array.isArray(request.target)
      ? request.target
      : {};
    const hostMethod = typeof request.method === 'string' ? request.method : '';
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    let result;
    if (target.kind === 'catalog') result = await piRuntimeBroker.requestCatalog(hostMethod, params);
    else if (target.kind === 'workspace' && typeof target.cwd === 'string') {
      result = await piRuntimeBroker.requestForWorkspace(target.cwd, hostMethod, params);
    } else if (target.kind === 'session' && typeof target.sessionId === 'string') {
      result = await piRuntimeBroker.requestForSession(target.sessionId, hostMethod, params);
    } else throw new Error('The pi-runtime capability target is invalid');
    return result ?? null;
  });
  await extensionRuntime.start().catch((error) => {
    console.warn('[Piarium Extensions] Host reconciliation failed:', error?.message || error);
  });
  const unregisterWorkbenchLayoutService = await registerBuiltinWorkbenchLayoutService(extensionRuntime);
  scheduledTasksRuntime.setExecutor(createPiScheduledTaskExecutor({ broker: piRuntimeBroker }));
  const sessionNames = new Map();
  const sessionSnapshots = new Map();
  recoveryTurnCoordinator = createRecoveryTurnCoordinator({
    documents: documentsAuthority,
    getSessionSnapshot: (sessionId) => sessionSnapshots.get(sessionId),
    invokeService: (request) => extensionRuntime.invokeService(request),
    writerTracker: piWriterTracker,
  });
  const sendPiSessionNotification = async ({ body, kind, sessionId, tag, title }) => {
    const settings = await readSettingsFromDisk().catch(() => ({}));
    if (settings.notifyOnCompletion === false) return;
    const payload = { body, kind, sessionId, tag, title };
    const desktopDelivered = getIsWindowFocused() && settings.notificationMode !== 'always'
      ? false
      : emitDesktopNotification(payload);
    broadcastUiNotification(payload, { desktopNotificationDelivered: desktopDelivered });
    const pushPayload = {
      ...payload,
      data: { type: 'session', sessionId, url: `/?session=${encodeURIComponent(sessionId)}` },
    };
    await Promise.allSettled([
      sendPushToAllUiSessions(pushPayload, { requireNoSse: true }),
      isAnyInteractiveClientVisible() ? Promise.resolve() : sendMobilePushToAllDevices(pushPayload),
      sendApnsToAllUiSessions(pushPayload),
    ]);
  };
  const piSessionAutomation = createPiSessionAutomationRuntime({
    broker: piRuntimeBroker,
    getSmallModelService: () => import('./lib/small-model/index.js'),
    readSettings: readSettingsFromDisk,
    onGoalSettled: async ({ goal, sessionId }) => {
      const complete = goal.status === 'complete';
      const statusLabel = goal.status === 'budgetLimited' ? 'budget reached' : goal.status;
      await sendPiSessionNotification({
        body: goal.note || goal.statusReason || (complete
          ? 'The active goal was completed and independently verified.'
          : `The active goal stopped: ${statusLabel}.`),
        kind: complete ? 'completion' : 'error',
        sessionId,
        tag: `pi-goal-${sessionId}`,
        title: sessionNames.get(sessionId) || (complete ? 'Piarium goal complete' : 'Piarium goal needs attention'),
      });
    },
  });
  const brokerUnsubscribe = piRuntimeBroker.subscribe((event) => {
    piSessionAutomation.processBrokerEvent(event);
    sessionRuntime.processBrokerEvent(event);
    void piWriterTracker.processEvent(event);
    void recoveryTurnCoordinator.processEvent(event);
    if (event?.kind === 'worker.exit') return;
    if (event?.kind !== 'host' || event.envelope?.kind !== 'event') return;
    const envelope = event.envelope;
    const sessionId = event.sessionId || envelope.data?.sessionId;
    if (envelope.event === 'session.snapshot' && sessionId) {
      sessionSnapshots.set(sessionId, envelope.data);
      const name = typeof envelope.data?.name === 'string' ? envelope.data.name.trim() : '';
      if (name) sessionNames.set(sessionId, name);
      return;
    }
    if (envelope.event !== 'agent.event' || !sessionId) return;
    const agentEvent = envelope.data?.event;
    if (agentEvent?.type === 'agent_settled') return;
    if (agentEvent?.type !== 'agent_end' || agentEvent.willRetry === true) return;
    void (async () => {
      if (sessionSnapshots.get(sessionId)?.features?.goal?.status === 'active') return;
      const body = extractAssistantText(agentEvent.messages) || 'Pi finished the current task.';
      const title = sessionNames.get(sessionId) || 'Piarium task complete';
      await sendPiSessionNotification({
        title,
        body,
        tag: `pi-session-${sessionId}`,
        kind: 'completion',
        sessionId,
      });
    })();
  });
  const piRuntimeGateway = createPiRuntimeGateway({
    server,
    broker: piRuntimeBroker,
    getBroker: getReadyPiRuntimeBroker,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  });

  tunnelRuntimeContext = tunnelWiringRuntime.initialize(app, port);
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  const relayService = createRelayService({
    crypto,
    os,
    readSettingsFromDisk,
    updateSettingsOnDisk,
    remoteClientAuthRuntime,
    getLocalPort: () => tunnelRuntimeContext.getActivePort(),
    hostLock: createRelayHostLock({
      lockFilePath: path.join(PIARIUM_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    hasRelayDemand: async () => {
      // A failed store read is unknown demand, not evidence that no device uses
      // the relay. Keep the current lifecycle state until both stores can be
      // read reliably; either affirmative result still wins immediately.
      const [pending, paired] = await Promise.allSettled([
        clientPairingRuntime.hasActiveRelaySession(),
        remoteClientAuthRuntime.hasActiveRelayClients(),
      ]);
      if (pending.status === 'fulfilled' && pending.value) return true;
      if (paired.status === 'fulfilled' && paired.value) return true;
      if (pending.status === 'rejected') throw pending.reason;
      if (paired.status === 'rejected') throw paired.reason;
      return false;
    },
  });
  relayServiceInstance = relayService;
  relayService.registerRoutes(app);

  await platformRoutesRuntime.registerRoutes(app, {
    crypto,
    fs,
    os,
    path,
    process,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn: platformEnvironmentRuntime.resolveGitBinaryForSpawn,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    piariumDataDir: PIARIUM_DATA_DIR,
    piariumUserConfigRoot: PIARIUM_USER_CONFIG_ROOT,
    piariumVersion: PIARIUM_VERSION,
    runtimeName: process.env.PIARIUM_RUNTIME || 'web',
    serverStartedAt,
    remoteClientAuthRuntime,
    __dirname,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    readCustomThemesFromDisk,
    formatSettingsResponse,
    readSettingsFromDisk,
    persistSettings,
    sanitizeProjects,
    buildAugmentedPath: platformEnvironmentRuntime.buildAugmentedPath,
    projectConfigRuntime,
    scheduledTasksRuntime,
    scheduledTaskService,
    piRuntimeBroker,
    getPiRuntimeBroker: getReadyPiRuntimeBroker,
    piRuntimeLifecycle,
    ...(typeof options.pickPiPackageRoot === 'function' ? { pickPiPackageRoot: options.pickPiPackageRoot } : {}),
    ...(typeof options.openFilesystemPath === 'function' ? { openFilesystemPath: options.openFilesystemPath } : {}),
    getPiariumEventClients: () => uiPiariumEventClients,
    writeSseEvent,
    extensionCatalog,
    extensionPackages,
    extensionRuntime,
    uiAuthController,
    documents: documentsAuthority,
    languageSupervisor,
    runRuntime,
    reloadRuntimeConfiguration: async () => { await piRuntimeLifecycle.ensureActiveBroker(); },
  });

  const previewProxyRuntime = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor });
  previewProxyRuntime.attach(app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  });
  const staticRoutesRuntime = createStaticRoutesRuntime({
    fs,
    path,
    process,
    __dirname,
    express,
    listRecentSessions: () => getReadyPiRuntimeBroker()?.listSessions?.() ?? [],
    readSettingsFromDisk,
    normalizePwaAppName,
    normalizePwaOrientation,
  });
  const startupResult = await startupPipelineRuntime.run({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath: platformEnvironmentRuntime.buildAugmentedPath,
    searchPathFor: platformEnvironmentRuntime.searchPathFor,
    isExecutable: platformEnvironmentRuntime.isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    terminalRebindWindowMs: TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    terminalMaxRebindsPerWindow: TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDisk,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => { signalsAttached = value; },
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    host,
    port,
    startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(PIARIUM_USER_CONFIG_ROOT, 'speech-models'),
    documents: documentsAuthority,
  });
  terminalRuntime = startupResult.terminalRuntime;
  dictationRuntime = startupResult.dictationRuntime;
  await scheduledTasksRuntime.start().catch((error) => {
    console.warn('[ScheduledTasks] Failed to start runtime:', error?.message || error);
  });
  void relayService.reconcile();
  const relayReconcileTimer = setInterval(() => void relayService.reconcile(), 60_000);
  relayReconcileTimer.unref?.();

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: () => ({
      tunnel: { active: Boolean(tunnelService.getPublicUrl()) },
      scheduledTasks: scheduledTasksRuntime.getStatus(),
    }),
    isReady: () => Boolean(currentPiRuntimeHandshake()),
    stop: async (shutdownOptions = {}) => {
      scheduleWorkspaceRecoveryBaseline = () => undefined;
      for (const controller of workspaceBaselineAbortControllers.values()) controller.abort();
      await Promise.allSettled(workspaceBaselineTasks.values());
      workspaceBaselineAbortControllers.clear();
      piSessionAutomation.stop();
      brokerUnsubscribe();
      await unregisterWorkbenchLayoutService();
      if (ownsExtensionRuntime) await extensionRuntime.stop();
      unregisterPiRuntimeCapability();
      unregisterDocumentsCapability();
      unregisterWorkspaceRecoveryCapability();
      unregisterSearchCapability();
      unregisterLanguageCapability();
      unregisterTasksCapability();
      unregisterDebugCapability();
      unregisterTestCapability();
      await languageSupervisor.dispose();
      await runRuntime.dispose();
      await piRuntimeGateway.stop();
      if (ownsPiRuntimeBroker) await piRuntimeLifecycle.dispose();
      await recoveryTurnCoordinator.dispose();
      await piWriterTracker.dispose();
      realtimeProxyRuntime.stop();
      clearInterval(relayReconcileTimer);
      relayService.stop();
      dictationRuntime?.stop?.();
      return gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false });
    },
  };
}

runCliEntryIfMain({
  process,
  currentFilename: __filename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => { exitOnShutdown = value; },
  startServer: main,
});

export {
  gracefulShutdown,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
