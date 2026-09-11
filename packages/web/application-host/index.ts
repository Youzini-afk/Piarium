import 'reflect-metadata';
import compression from 'compression';
import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
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
import { createDocumentAuthority, type DocumentAuthority, type DocumentMutationObservation } from './lib/documents/authority.js';
import { registerBuiltinWorkbenchLayoutService } from './lib/extensions/workbench-layout-service.js';
import { toJsonValue } from './lib/extensions/json-value.js';
import { createDocumentsCapabilityHandler } from './lib/documents/capability.js';
import {
  createWorkspaceRecoveryEngine,
  type RecoverySessionNavigation,
  type WorkspaceRecoveryEngine,
} from './lib/recovery/engine.js';
import { createWorkspaceRecoveryCapabilityHandler } from './lib/recovery/capability.js';
import { RecoveryPrimitiveError } from './lib/recovery/errors.js';
import { createPiWorkspaceWriterTracker } from './lib/recovery/pi-writer-tracker.js';
import { createRecoveryTurnCoordinator } from './lib/recovery/turn-coordinator.js';
import { createLanguageSupervisor, SURFACE_LANGUAGE_VIEW } from './lib/lsp/supervisor.js';
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

import { createHarnessRouter, buildHarnessRespondParams } from './lib/harness/router.js';
import { createHarnessServiceHost, deriveHarnessCapabilities } from './lib/harness/service-host.js';
import { discoverShells } from './lib/harness/shell-discovery.js';
import { createHarnessSessionRegistration } from './lib/harness/session-registration.js';
import { registerHarnessServices } from './lib/harness/harness-services.js';
import { openWorkspaceKnowledge, type BlockChange, type KnowledgeStore } from './lib/knowledge/store.js';
import { createKnowledgeContextRuntime } from './lib/knowledge/context-runtime.js';
import { createGitStatusObserver } from './lib/knowledge/git-status-runtime.js';
import { createSymbolGraphRuntime } from './lib/knowledge/symbol-runtime.js';
import { createLocalMinilmEmbedder } from './lib/knowledge/semantic/minilm.js';
import { workspaceScope } from './lib/knowledge/semantic/identity.js';
import { createSemanticIndexRuntime } from './lib/knowledge/semantic/runtime.js';
import { createSemanticBackend } from './lib/knowledge/semantic/backend.js';
import { createEmbedScheduler } from './lib/knowledge/semantic/embed-scheduler.js';
import { createVectorCache } from './lib/knowledge/semantic/vector-cache.js';
import { createKnowledgeVectorRuntime, recallWorkspaceAndUser } from './lib/knowledge/vectors/index.js';
import type { KnowledgeVectorRuntime } from './lib/knowledge/vectors/index.js';
import { requestWorkspaceInference, resolveInferenceBinding } from './lib/knowledge/semantic/workspace-inference.js';
import { pinSemanticQueryView } from './lib/knowledge/semantic/query-view.js';
import {
  type HarnessEmbedParams,
  type HarnessInferenceBindingSnapshot,
  type HarnessRerankParams,
  type HarnessResolvedRerankBinding,
  type PiSettingsSnapshot,
} from '@piarium/protocol';
import { createDecisionSuggestionRuntime } from './lib/knowledge/decision-suggestions.js';
import { DEFAULT_MEMORY_AGENT_SETTINGS } from './lib/harness/memory-agent.js';

import { DEFAULT_COMPACTION_SETTINGS, collectCompactionFacts, createKeeperCoverageStore, type CompactionHandlerDeps } from './lib/harness/compaction.js';
import { type TodoToolDeps } from './lib/harness/todo-tool.js';
import { openUserKnowledgeStore, type RecallToolDeps } from './lib/harness/recall-tool.js';
import { createThreadRegistry } from './lib/harness/thread-registry.js';
import { createOnThreadDequeued } from './lib/harness/thread-dequeue.js';
import { createThreadTranscriptReader } from './lib/harness/thread-transcript.js';
import { createHarnessPathAuthority } from './lib/harness/path-authority.js';
import { createExploreFileReader } from './lib/harness/explore-file-reader.js';
import { createThreadWorktreeRuntime } from './lib/harness/thread-worktree.js';
import { createThreadRuntime } from './lib/harness/thread-runtime.js';
import { createWorktreeReclaimGuard } from './lib/harness/worktree-reclaim-guard.js';
import { resolveThreadWorktreeSettings } from './lib/harness/thread-worktree-settings.js';
import { createWorkspaceWorkingStateAccess } from './lib/harness/working-state/working-state-store.js';
import { ThreadExecutionViewRegistry } from './lib/harness/working-state/execution-view.js';
import { createWorkingBranchLookups } from './lib/harness/working-state/working-branch-lookups.js';
import { createWorkingBranchWriteServices } from './lib/harness/working-state/working-branch-writes.js';
import { acquireVirtualWriteTicket, VirtualWriteGate } from './lib/harness/working-state/virtual-write-gate.js';
import { IntegrationCoordinator } from './lib/harness/working-state/integration-coordinator.js';
import { DEFAULT_HARNESS_SETTINGS, mergeHarnessSettings, resolveRoles } from '@piarium/protocol';
import { createVerificationCoordinator } from './lib/harness/verification-coordinator.js';
import { registerHarnessThreadRoutes } from './lib/harness/thread-routes.js';
import { registerHarnessContextRoutes } from './lib/harness/context-routes.js';
import { registerHarnessKnowledgeCatalogRoutes } from './lib/harness/knowledge-catalog-routes.js';
import { DEFAULT_SUGGESTIONS_SETTINGS, suggestionSettingsFromSnapshot } from './lib/harness/knowledge-suggestions.js';
import { createLanguageSupervisorDiagnosticsProvider } from './lib/harness/diagnostics-adapter.js';
import { createLspNavigationServices } from './lib/harness/lsp-nav.js';
import { createLspStructureProvider } from './lib/structure/lsp-provider.js';
import { createStructureSource } from './lib/structure/source.js';
import { createTreeSitterStructureProvider } from './lib/structure/tree-sitter-provider.js';
import { createGrammarAbiInspector, GRAMMAR_MAX_ABI, GRAMMAR_MIN_ABI } from './lib/structure/grammar-abi.js';
import { createGrammarInstaller } from './lib/structure/grammar-installer.js';
import { EMPTY_GRAMMAR_PACK_MANIFEST, loadCommittedGrammarPackManifest } from './lib/structure/grammar-manifest.js';
import { createGrammarStore } from './lib/structure/grammar-store.js';
import { resolveStructureRuntimeFile } from './lib/structure/runtime-path.js';
import { createLanguageSupportRuntime } from './lib/language-support/runtime.js';
import { createWebFetch, type SsrfPolicy, type DomainPolicy } from './lib/harness/web-fetch.js';
import { createWebSearchService, resolveConfiguredSearchProvider, type SearchProvider } from './lib/harness/web-search.js';
import { registerWebSearchCredentialRoutes } from './lib/harness/web-search-routes.js';
import { checkSsrf, isSameHost } from './lib/harness/ssrf-policy.js';
import { readPiAuthFile, readPiConfigLayers } from './lib/pi-config/storage.js';

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
  type TunnelController,
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
import { mintOutsideFileGrant } from './lib/fs/routes.js';
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
import { clearAppImageArgv0FromProcessEnv } from './lib/platform/inherited-env.js';
import { pathLooksUserConfigured, mergePathValues } from './lib/platform/path-utils.js';
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
import type {
  DesktopNotificationPayload,
  HostPiRuntimeBrokerFactoryOptions,
  StartWebUiServerOptions,
  WebUiServerController,
} from './public-contract.js';
export type * from './public-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CLIENT_RELOAD_DELAY_MS = 800;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const DESKTOP_NOTIFY_PREFIX = '[PiariumDesktopNotify] ';
const MAX_THEME_JSON_BYTES = 512 * 1024;

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);
const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const isEnvFlagEnabled = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '1' || value.trim().toLowerCase() === 'true';
};

const isEnvFlagDisabled = (value: unknown): boolean => {
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
    throw new Error(`Unable to resolve the Piarium Web application version: ${errorMessage(error)}`);
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

const shouldSkipApiCompression = (): boolean => {
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

const shouldSkipCompression = (req: Request, res: Response): boolean => {
  if (process.env.PIARIUM_RUNTIME === 'desktop') return true;
  const acceptsSse = (value: unknown): boolean => Array.isArray(value)
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
const {
  normalizeDirectoryPath,
  normalizePathForPersistence,
  normalizeSettingsPaths,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
} = settingsNormalizationRuntime;

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
const {
  readManagedRemoteTunnelConfigFromDisk,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
} = managedTunnelConfigRuntime;

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
const {
  normalizePwaAppName,
  normalizePwaOrientation,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  formatSettingsResponse,
} = settingsHelpers;

type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
let readSettingsFromDisk: SettingsRuntime['readSettingsFromDisk'] = async () => ({});
const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  readSettingsFromDisk,
  getReadSettingsFromDisk: () => readSettingsFromDisk,
  sanitizeProjects,
});
const { resolveProjectDirectory } = projectDirectoryRuntime;

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
readSettingsFromDisk = settingsRuntime.readSettingsFromDisk;
const { updateSettingsOnDisk, persistSettings } = settingsRuntime;

const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: PIARIUM_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});
const { readCustomThemesFromDisk } = themeRuntime;

const requestSecurityRuntime = createRequestSecurityRuntime({ readSettingsFromDisk });
const {
  getUiSessionTokenFromRequest,
  rejectWebSocketUpgrade,
  isRequestOriginAllowed,
} = requestSecurityRuntime;

const pushRuntime = createPushRuntime({
  webPush,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const {
  getOrCreateVapidKeys,
  addOrUpdatePushSubscription,
  removePushSubscription,
  sendPushToAllUiSessions,
  isAnyInteractiveClientVisible,
  isUiVisible,
  ensurePushInitialized,
  setPushInitialized,
  updateUiVisibility,
} = pushRuntime;

const mobileDeviceStore = createMobileDeviceStore({
  crypto,
  mobileDevicesFilePath: MOBILE_DEVICES_FILE_PATH,
});
const mobilePushRuntime = createMobilePushRuntime({ deviceStore: mobileDeviceStore });
const { sendMobilePushToAllDevices } = mobilePushRuntime;
const mobilePairingRuntime = createMobilePairingRuntime({ crypto, deviceStore: mobileDeviceStore });
const apnsRuntime = createApnsRuntime({
  fsPromises,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDisk,
  updateSettingsOnDisk,
});
const {
  addOrUpdateApnsToken,
  removeApnsToken,
  sendApnsToAllUiSessions,
} = apnsRuntime;

const uiNotificationClients = new Set<Response>();
const uiPiariumEventClients = new Set<Response>();
const desktopNotifyEnabled = process.env.PIARIUM_DESKTOP_NOTIFY === 'true'
  || process.env.PIARIUM_RUNTIME === 'desktop';
let broadcastGlobalUiEvent: ReturnType<typeof createGlobalUiEventBroadcaster> | null = null;
const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => desktopNotifyEnabled,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});
const {
  writeSseEvent,
  emitDesktopNotification,
  broadcastUiNotification,
} = notificationEmitterRuntime;
broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  writeSseEvent,
});
const sessionRuntime = createPiSessionRuntime({ broadcastEvent: broadcastGlobalUiEvent });

const projectConfigRuntime = createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: PIARIUM_PROJECTS_CONFIG_DIR,
});
const scheduledTasksRuntime = createScheduledTasksRuntime({
  projectConfigRuntime,
  listProjects: async () => sanitizeProjects((await readSettingsFromDisk()).projects || []) ?? [],
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

type UiAuthController = ReturnType<typeof createUiAuth>;
type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

let server: http.Server | null = null;
let uiAuthController: UiAuthController | null = null;
let activeTunnelController: TunnelController | null = null;
let terminalRuntime: TerminalRuntime | null = null;
let activeDocumentsAuthority: DocumentAuthority | null = null;
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
const gracefulShutdown = gracefulShutdownRuntime.gracefulShutdown;
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

const requestReachedLanAddress = (req: Request): string | null => {
  const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) && !address.startsWith('127.') ? address : null;
};

const extractAssistantText = (messages: unknown): string => {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== 'assistant' || !Array.isArray(candidate.content)) continue;
    const text = candidate.content
      .filter((part: unknown): part is { text: string; type: 'text' } => (
        Boolean(part)
        && typeof part === 'object'
        && !Array.isArray(part)
        && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string'
      ))
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text.slice(0, 240);
  }
  return '';
};

async function main(options: StartWebUiServerOptions = {}): Promise<WebUiServerController> {
  if (server?.listening) throw new Error('Piarium server is already running');
  isShuttingDown = false;
  const port = typeof options.port === 'number' && Number.isFinite(options.port) && options.port >= 0
    ? Math.trunc(options.port)
    : DEFAULT_PORT;
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
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : undefined;
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
      ? normalizeTunnelStartRequest({
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          token: '',
        })
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
  type PiRuntimeHandshake = Awaited<ReturnType<PiRuntimeLifecycle['start']>> | null;
  type RelayService = ReturnType<typeof createRelayService>;
  type TunnelRuntimeContext = ReturnType<ReturnType<typeof createTunnelWiringRuntime>['initialize']>;
  let piRuntimeHandshake: PiRuntimeHandshake = null;
  let piRuntimeLifecycle: PiRuntimeLifecycle | null = null;
  let relayServiceInstance: RelayService | null = null;
  let tunnelRuntimeContext: TunnelRuntimeContext | null = null;
  let realtimeProxyRuntime: Pick<ReturnType<typeof attachRealtimeProxy>, 'stop'> = { stop: () => {} };
  let dictationRuntime: ReturnType<typeof createDictationRuntime> | null = null;
  const currentPiRuntimeHandshake = () => (
    piRuntimeLifecycle ? piRuntimeLifecycle.handshake : piRuntimeHandshake
  );

  const activePort = () => tunnelRuntimeContext?.getActivePort() || port;
  const resolvePairingTransports = (req: Request) => {
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
  const resolveDirectLanUrls = (req: Request): string[] => {
    const urls: string[] = [];
    const add = (address: string | null): void => {
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
    getRelayPairingCandidate: async (pairingOptions) => relayServiceInstance
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
  type PiWriterTracker = ReturnType<typeof createPiWorkspaceWriterTracker>;
  type RecoveryTurnCoordinator = ReturnType<typeof createRecoveryTurnCoordinator>;
  type PiAdmissionRequest = Parameters<NonNullable<HostPiRuntimeBrokerFactoryOptions['admitSessionExecution']>>[0];
  let piWriterTracker: PiWriterTracker | null = null;
  let recoveryTurnCoordinator: RecoveryTurnCoordinator | null = null;
  let configuredWebSearchProvider: SearchProvider | null = null;
  try {
    const userConfig = readPiConfigLayers(process.cwd()).userConfig;
    const searchSettings = recordOf(recordOf(userConfig.harness).web).search;
    const resolvedSearch = resolveConfiguredSearchProvider({
      settings: searchSettings,
      auth: readPiAuthFile(),
    });
    if ('unavailable' in resolvedSearch) {
      if (searchSettings !== undefined) {
        console.warn(`[HarnessWebSearch] ${resolvedSearch.hint}`);
      }
    } else {
      configuredWebSearchProvider = resolvedSearch;
    }
  } catch (error) {
    console.warn(`[HarnessWebSearch] Unable to load provider configuration: ${errorMessage(error)}`);
  }
  const admitPiSessionExecution = (request: PiAdmissionRequest) => {
    if (!piWriterTracker) {
      throw new PiRuntimeBrokerError(
        'runtime_not_ready',
        'Pi workspace writer admission is not ready',
        { retryable: true },
      );
    }
    return recoveryTurnCoordinator?.admit(request) ?? piWriterTracker.admit(request);
  };
  const piRuntimeBrokerFactory = options.createPiRuntimeBroker || ((brokerOptions: HostPiRuntimeBrokerFactoryOptions) => createWebPiRuntimeBroker({
    agentDir: process.env.PIARIUM_AGENT_DIR,
    clientVersion: PIARIUM_VERSION,
    cwd: process.cwd(),
    // The official Host always provides SSRF-guarded web.fetch. Reader-model
    // execution stays inside pi-host so it uses the session's credential and
    // model authority rather than creating a second model stack in the Host.
    harnessDocumentRead: true,
    harnessDocumentPathOverlay: true,
    harnessWebRead: true,
    harnessWebSearch: configuredWebSearchProvider !== null,
    ...brokerOptions,
  }));
  const createPiRuntimeBroker = (brokerOptions: HostPiRuntimeBrokerFactoryOptions) => attachPiSessionExecutionAdmission(
    piRuntimeBrokerFactory({
      ...brokerOptions,
      admitSessionExecution: admitPiSessionExecution,
    }),
    admitPiSessionExecution,
  );
  const standalonePayloadDir = options.standalonePayloadDir || process.env.PIARIUM_PI_STANDALONE_PAYLOAD;
  piRuntimeLifecycle = options.piRuntimeLifecycle || new PiRuntimeLifecycle({
    dataDir: PIARIUM_DATA_DIR,
    createBroker: (brokerOptions) => createPiRuntimeBroker(brokerOptions),
    ...(options.hostEntry ? { hostEntry: options.hostEntry } : {}),
    ...(standalonePayloadDir
      ? {
          installer: {
            standalonePayloadDir,
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
      console.warn('[PiRuntime] Deferred runtime start:', errorMessage(error));
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
  const configuredDirtyBarrierTimeout = process.env.PIARIUM_DIRTY_BARRIER_TIMEOUT_MS?.trim() ?? '';
  const dirtyBarrierTimeoutMs = /^\d+$/.test(configuredDirtyBarrierTimeout)
    ? Number(configuredDirtyBarrierTimeout)
    : undefined;
  let observeKnowledgeDocumentMutation = (_event: DocumentMutationObservation): void => {};
  let observeKnowledgeBlockChange = (_workspaceId: string, _sessionId: string, _change: BlockChange): void => {};
  let observeThreadIntegrationParentChange = (_workspaceId: string, _resourceIds?: readonly string[]): void => {};
  const documentsAuthority = createDocumentAuthority({
    hostId: extensionRuntime.services.hostId,
    dataDir: PIARIUM_DATA_DIR,
    maxReadBytes: workspaceConfig.maxReadBytes,
    isAllowedRoot: workspaceRootGuard,
    onMutation: (event) => observeKnowledgeDocumentMutation(event),
    onIntegrationParentChanged: (workspaceId, resourceIds) => observeThreadIntegrationParentChange(workspaceId, resourceIds),
    ...(dirtyBarrierTimeoutMs !== undefined ? { dirtyBarrierTimeoutMs } : {}),
  });
  activeDocumentsAuthority = documentsAuthority;
  const harnessPathAuthority = createHarnessPathAuthority({
    authorityId: extensionRuntime.services.hostId,
    documents: documentsAuthority,
    fsPromises,
    pathModule: path,
  });
  piWriterTracker = createPiWorkspaceWriterTracker({ documents: documentsAuthority });
  const workspaceRecoveryEngines = new Map<string, WorkspaceRecoveryEngine>();
  const assertRecoverySessionWorkspace = async (sessionId: string, workspaceId: string): Promise<void> => {
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
  const recoverySessionNavigation: RecoverySessionNavigation = {
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
          targetId: input.entryId,
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
        { sessionId: input.sessionId, targetId: input.entryId },
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
  const resolveDirectoryApplyContext = async (directory: string) => {
    const resolved = await documentsAuthority.resolveWorkspace({ path: directory });
    return {
      workspaceId: resolved.workspaceId,
      resourceOperationGate: {
        run: <Result>(resources: Parameters<DocumentAuthority['runResourceOperation']>[1], operation: () => Promise<Result>) => (
          documentsAuthority.runResourceOperation(resolved.workspaceId, resources, operation)
        ),
      },
    };
  };
  const recoveryEngineForOwner = (context: {
    owner?: { extensionId?: string | undefined } | undefined;
  }): WorkspaceRecoveryEngine => {
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
        sessionNavigation: recoverySessionNavigation,
        resolveDirectoryApplyContext,
        storageOwnerId,
      });
      workspaceRecoveryEngines.set(storageOwnerId, engine);
    }
    return engine;
  };
  const foundationalRecoveryEngine = recoveryEngineForOwner({
    owner: { extensionId: 'piarium.builtin.recovery' },
  });
  let fencedRecoveryOperations = [];
  try {
    fencedRecoveryOperations = await foundationalRecoveryEngine.fenceUnfinishedOperations();
    await foundationalRecoveryEngine.resumeWorkspaceOperations();
  } catch (error) {
    console.error('[WorkspaceRecovery] Startup workspace recovery requires attention:', errorMessage(error));
  }
  const piRuntimeStartup = startPiRuntime();
  if (requirePiRuntime || fencedRecoveryOperations.length > 0) await piRuntimeStartup;
  else void piRuntimeStartup;
  const combinedRecoveryStartup = piRuntimeStartup.then(() => (
    foundationalRecoveryEngine.resumeCombinedOperations()
  )).catch((error) => {
    console.error('[WorkspaceRecovery] Startup combined recovery requires attention:', errorMessage(error));
  });
  if (fencedRecoveryOperations.length > 0) await combinedRecoveryStartup;
  else void combinedRecoveryStartup;
  extensionRuntime.workbench.setWorkspaceScopeResolver((scopeId: unknown) => documentsAuthority.resolveScopeId(scopeId));
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
  // ── Harness service host ──────────────────────────────────────────
  // Global services (output store, path locks, search, diagnostics) plus
  // per-session shell supervisors. Registered with the harness router
  // and wired into the broker event stream alongside the recovery turn
  // coordinator.

  // Web fetch service — SSRF-guarded, domain policy from workspace config
  const ssrfPolicy: SsrfPolicy = { check: checkSsrf, isSameHost };
  const webFetchService = createWebFetch({
    ssrf: ssrfPolicy,
    domainPolicy: (_workspaceId: string): DomainPolicy => {
      // Domain policy from workspace config — empty by default (no restrictions)
      return { allow: [], block: [] };
    },
    // Renderer is wired by desktop host (1b.4); web/cloud host has no renderer
  });
  const webSearchService = configuredWebSearchProvider
    ? createWebSearchService(async () => configuredWebSearchProvider!)
    : null;
  const harnessDiagnosticsProvider = createLanguageSupervisorDiagnosticsProvider(languageSupervisor, {
    documents: documentsAuthority,
    resolveWorkspaceId: async (workspaceRoot) => {
      try {
        const workspace = await documentsAuthority.inspectWorkspace(workspaceRoot);
        return workspace.workspaceId;
      } catch {
        return null;
      }
    },
  });

  // ── Phase 2: Knowledge store, memory agent, observers ────────────
  // Knowledge stores are opened lazily per workspace and cached.
  const knowledgeStores = new Map<string, KnowledgeStore>();
  const knowledgeStoreLoads = new Map<string, Promise<KnowledgeStore>>();
  let userKnowledgeStore: KnowledgeStore | null = null;
  let userKnowledgeStoreLoad: Promise<KnowledgeStore> | null = null;
  let knowledgeVectors: KnowledgeVectorRuntime | null = null;
  const hostId = extensionRuntime.services.hostId;
  let threadRuntime: ReturnType<typeof createThreadRuntime> | null = null;
  let bindThreadKnowledgeSession = (_sessionId: string, _workspaceId: string): void => undefined;
  const harnessShellActivity = {
    hasActiveCommandAtDirectory: (_directory: string): boolean => false,
    closeSessionShell: async (_sessionId: string): Promise<void> => {},
  };
  const threadRegistry = createThreadRegistry({
    dataDir: PIARIUM_DATA_DIR,
    hostId,
    onObserverError: (error) => {
      console.error('[HarnessThreads] Observer failed:', errorMessage(error));
    },
    onThreadChanged: (workspaceId, parent, thread, activeRun) => {
      broadcastGlobalUiEvent?.({
        type: 'piarium:harness-thread-changed',
        properties: { workspaceId, parent, thread, activeRun },
      });
    },
    onThreadDone: (workspaceId, parent, threadId, report) => {
      broadcastGlobalUiEvent?.({
        type: 'piarium:harness-thread-done',
        properties: { workspaceId, parent, threadId, report },
      });
    },
    onThreadDequeued: createOnThreadDequeued({
      getRegistry: () => threadRegistry,
      getRuntime: () => threadRuntime,
      formatError: errorMessage,
      onEndRunFailure: (_error, endError) => {
        console.error('[HarnessThreads] Failed to record dequeued thread failure:', errorMessage(endError));
      },
    }),
  });
  const threadRegistryStartup = await threadRegistry.reconcileAfterHostRestart();
  for (const failure of threadRegistryStartup.failures) {
    console.error(`[HarnessThreads] Startup reconciliation failed (${failure.code}) for ${failure.path}: ${failure.message}`);
  }
  const threadTranscriptReader = createThreadTranscriptReader({
    readSessionEntries: (sessionId) => piRuntimeBroker.previewSessionEntries(sessionId, undefined, 'all'),
  });
  const threadWorktreeRuntime = createThreadWorktreeRuntime({
    createWorktree: async (directory, input) => {
      const git = await import('./lib/git/service.js');
      return git.createWorktree(directory, input, {
        documents: documentsAuthority,
        writerOwner: { kind: 'harness-thread', id: `create:${String(input.worktreeName ?? 'thread')}` },
      });
    },
    getWorktreeBootstrapStatus: async (directory) => {
      const git = await import('./lib/git/service.js');
      return git.getWorktreeBootstrapStatus(directory);
    },
    gitBinary: platformEnvironmentRuntime.resolveGitBinaryForSpawn(),
    env: {
      ...process.env,
      PATH: platformEnvironmentRuntime.buildAugmentedPath(),
    },
  });
  const branchEntryIdsForSession = async (sessionId: string): Promise<string[]> => {
    const branch = await piRuntimeBroker.requestForSession(sessionId, 'session.entries', {
      sessionId,
      scope: 'branch',
    });
    return branch.entries.map((entry) => entry.id);
  };
  const knowledgeSuggestionSettingsForSession = async (sessionId: string) => {
    try {
      const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {});
      return suggestionSettingsFromSnapshot(snapshot);
    } catch (error) {
      console.error(`[HarnessKnowledge] Unable to read suggestion settings for ${sessionId}:`, errorMessage(error));
      return DEFAULT_SUGGESTIONS_SETTINGS;
    }
  };
  const harnessWorkingStates = createWorkspaceWorkingStateAccess(foundationalRecoveryEngine);
  const threadExecutionViews = new ThreadExecutionViewRegistry();
  const virtualWriteGate = new VirtualWriteGate();
  const workingBranchLookups = createWorkingBranchLookups({
    views: threadExecutionViews,
    workingStates: harnessWorkingStates,
  });
  const workingBranchWrites = createWorkingBranchWriteServices({
    views: threadExecutionViews,
    workingStates: harnessWorkingStates,
    writeGate: virtualWriteGate,
  });
  const verificationCoordinator = createVerificationCoordinator({
    workingStates: harnessWorkingStates,
    captureParentIdentity: async (workspaceId, parentRoot) => {
      const inspected = await threadWorktreeRuntime.inspectWorkspaceIdentity(parentRoot);
      if (inspected.status !== 'ready') return { treeHash: null, reason: inspected.reason };
      const treeHash = await harnessWorkingStates.withStore(
        workspaceId,
        'parent-command-input-identity',
        (store) => store.captureSeededPathIdentity(parentRoot, inspected.changedFiles, inspected.baseRef),
        'shared',
      );
      return { treeHash };
    },
    loadParentWindows: async (workspaceId, parentSessionId) => {
      const binding = await threadRegistry.getSessionBinding(parentSessionId);
      const owningWorkspaceId = binding?.owningWorkspaceId ?? workspaceId;
      const parent = binding
        ? { kind: 'thread' as const, id: binding.threadId }
        : { kind: 'session' as const, id: parentSessionId };
      const children = await threadRegistry.listThreads(owningWorkspaceId, parent, true);
      return harnessWorkingStates.withStore(
        owningWorkspaceId,
        'parent-verification-window-restore',
        (store) => children.flatMap((thread) => store.listParentVerifications(thread.id).map((bundle) => ({
          parent,
          threadId: thread.id,
          bundle,
        }))),
        'shared',
      );
    },
    onProjection: (workspaceId, threadId, projection) => threadRegistry.setVerification(workspaceId, threadId, projection).then(() => undefined),
  });
  const threadIntegrationCoordinator = new IntegrationCoordinator({
    workingStates: harnessWorkingStates,
    inspectDirtyBuffers: (workspaceId) => documentsAuthority.inspectDirtyBuffers(workspaceId),
    beginDirtyStateBarrier: (workspaceId, paths) => documentsAuthority.beginDirtyStateBarrier(workspaceId, paths),
    requestSurfaceOperation: (request, options) => documentsAuthority.requestSurfaceOperation(request, options),
    resolveDirectoryApplyContext,
    holdParentVirtualWrite: async (sessionId, signal) => {
      const ticket = await acquireVirtualWriteTicket(
        virtualWriteGate,
        sessionId,
        () => {
          const view = threadExecutionViews.get(sessionId);
          return !!view && view.mode === 'virtual';
        },
        signal,
      );
      return ticket === 'disk'
        ? { status: 'disk' as const }
        : { status: 'virtual' as const, release: () => ticket.finish() };
    },
    resolveParentSessionId: (workspaceId, branchId) => (
      threadExecutionViews.findByBranch(workspaceId, branchId)?.sessionId
    ),
    commitParentVirtualWrites: async (input) => {
      const result = await input.store.commitVirtualWrites(
        input.branchId,
        input.expectedWriteRevision,
        input.files,
      );
      const sessionId = input.sessionId
        ?? threadExecutionViews.findByBranch(input.workspaceId, input.branchId)?.sessionId;
      if (result.status === 'committed' && sessionId) {
        const live = threadExecutionViews.get(sessionId);
        if (live?.mode === 'virtual') {
          threadExecutionViews.bind({ ...live, writeRevision: result.writeRevision });
        }
      }
      return result;
    },
  });
  threadRuntime = createThreadRuntime({
    registry: threadRegistry,
    onThreadSessionBound: (sessionId, owningWorkspaceId) => bindThreadKnowledgeSession(sessionId, owningWorkspaceId),
    worktrees: threadWorktreeRuntime,
    workingStates: harnessWorkingStates,
    executionViews: threadExecutionViews,
    virtualWriteGate,
    cloneAgentInputSnapshot: (sessionId, context) => documentsAuthority.cloneAgentInputSnapshot(sessionId, context),
    resolveIntegrationCoordinator: () => threadIntegrationCoordinator,
    canReclaimWorktree: createWorktreeReclaimGuard(documentsAuthority),
    hasActiveCommands: (directory) => harnessShellActivity.hasActiveCommandAtDirectory(directory),
    verification: verificationCoordinator,
    worktreeSettings: DEFAULT_HARNESS_SETTINGS.worktree,
    resolveWorktreeSettings: async (workspaceId, parent) => {
      const sessionId = parent.kind === 'session'
        ? parent.id
        : (await threadRegistry.getActiveRun(workspaceId, parent.id))?.sessionId;
      if (!sessionId) throw new Error('Parent thread has no Pi session for worktree settings');
      return resolveThreadWorktreeSettings(await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {}));
    },
    resolveReviewSettings: async (workspaceId, parent) => {
      const sessionId = parent.kind === 'session'
        ? parent.id
        : (await threadRegistry.getActiveRun(workspaceId, parent.id))?.sessionId;
      if (!sessionId) return { enabled: true, gate: false };
      try {
        const snapshot = await piRuntimeBroker.requestForSession(sessionId, 'settings.get', {});
        const global = recordOf(recordOf(snapshot).global).harness;
        return mergeHarnessSettings(
          global && typeof global === 'object' && !Array.isArray(global) ? global : {},
          {},
        ).review;
      } catch {
        return { enabled: true, gate: false };
      }
    },
    resolveReviewRole: async (workspaceId, parent) => {
      const sessionId = parent.kind === 'session'
        ? parent.id
        : (await threadRegistry.getActiveRun(workspaceId, parent.id))?.sessionId;
      if (!sessionId) return null;
      const [settingsSnapshot, sessionSnapshot] = await Promise.all([
        piRuntimeBroker.requestForSession(sessionId, 'settings.get', {}).catch(() => null),
        piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }).catch(() => null),
      ]);
      const global = settingsSnapshot ? recordOf(recordOf(settingsSnapshot).global).harness : undefined;
      const merged = mergeHarnessSettings(
        global && typeof global === 'object' && !Array.isArray(global) ? global : {},
        {},
      );
      const model = recordOf(sessionSnapshot).model;
      const main = model && typeof recordOf(model).provider === 'string' && typeof recordOf(model).id === 'string'
        ? { providerId: recordOf(model).provider as string, modelId: recordOf(model).id as string }
        : null;
      return resolveRoles(merged.models, main).find((role) => role.id === 'review') ?? null;
    },
    recallProjectKnowledge: async (workspaceId, query) => {
      const store = await getKnowledgeStoreForWorkspace(workspaceId);
      const hits = await store.recall(query, 5);
      return hits.map((hit) => {
        const payload = hit.node.payload;
        const title = typeof payload.title === 'string' ? payload.title
          : typeof payload.trigger === 'string' ? payload.trigger
            : String(hit.node.id);
        const content = typeof payload.content === 'string' ? payload.content : '';
        return `#${hit.node.id} ${title}${content ? `\n${content}` : ''}`;
      }).join('\n\n');
    },
    resolveWorkspaceRoot: async (workspaceId) => (await documentsAuthority.inspectWorkspace(workspaceId)).root,
    resolveRuntimeWorkspaceId: async (cwd) => (await documentsAuthority.resolveWorkspace({ path: cwd })).workspaceId,
    beginBaselineCapture: (workspaceId) => documentsAuthority.beginCapture(workspaceId),
    completeBaselineCapture: async (capture) => {
      const completed = await documentsAuthority.completeCapture(capture);
      return { stable: completed.stable, reasons: completed.reasons };
    },
    beginDirtyStateBarrier: (workspaceId, paths) => documentsAuthority.beginDirtyStateBarrier(workspaceId, paths),
    inspectBaselineWriters: async (workspaceId, root) => {
      const writersOf = async (id: string) => {
        const inspected = await documentsAuthority.inspectWorkspace(id) as {
          activeWriters?: Array<{ writerId?: string; id?: string; purpose?: string }>;
        };
        return Array.isArray(inspected.activeWriters) ? inspected.activeWriters : [];
      };
      const writers = [...await writersOf(workspaceId)];
      try {
        const resolved = await documentsAuthority.resolveWorkspace({ path: root });
        if (resolved.workspaceId !== workspaceId) writers.push(...await writersOf(resolved.workspaceId));
      } catch {
        // Scratch and unregistered roots have no Documents writers of their own.
      }
      return writers.map((writer) => ({
        id: writer.writerId ?? writer.id ?? "writer",
        ...(writer.purpose === undefined ? {} : { purpose: writer.purpose }),
      }));
    },
    readBlocks: async (sessionId) => {
      const store = await getKnowledgeStoreForSession(sessionId);
      if (!store) return null;
      return (await store.getBlocks(sessionId, await branchEntryIdsForSession(sessionId)))
        .map((block) => ({ label: block.label, content: block.content }));
    },
    withMergeWriter: async (workspaceId, threadId, operation) => {
      const writer = await documentsAuthority.registerWriterForScope(
        workspaceId,
        { kind: 'harness-thread', id: `merge:${threadId}` },
        { mode: 'process', purpose: 'harness-thread-merge' },
      );
      if (!writer) throw new Error('Thread integration has no workspace writer authority');
      const outcome = await Promise.resolve().then(operation).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const applied = outcome.ok ? recordOf(outcome.value).appliedPaths : undefined;
      const changed = !outcome.ok || (Array.isArray(applied) && applied.length > 0);
      const cleanupErrors: unknown[] = [];
      try { if (changed) await writer.markMutated(); }
      catch (error) { cleanupErrors.push(error); }
      try { await writer.close(); }
      catch (error) { cleanupErrors.push(error); }
      if (!outcome.ok) {
        for (const error of cleanupErrors) console.error('[HarnessThreads] Merge writer cleanup failed:', errorMessage(error));
        throw outcome.error;
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Failed to finalize the merge writer');
      return outcome.value;
    },
    sessions: {
      create: (input) => piRuntimeBroker.createSession(
        input.cwd,
        input.name,
        input.parentSession,
        { authorityId: input.workspaceId, id: input.workspaceId, kind: 'workspace' },
        {
          ...(input.model ? { model: input.model } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
          ...(input.scope?.length ? { scope: input.scope } : {}),
          tools: input.tools,
        },
      ),
      open: (input) => piRuntimeBroker.openSession({
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.permissions ? { permissions: input.permissions } : {}),
        ...(input.scope?.length ? { scope: input.scope } : {}),
        sessionId: input.sessionId,
        workspace: { authorityId: input.workspaceId, id: input.workspaceId, kind: 'workspace' },
        tools: input.tools,
      }),
      prompt: async (sessionId, text, instructions) => {
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.prompt', {
          sessionId,
          text,
          ...(instructions ? { instructions } : {}),
        });
        if (!result.accepted) throw new Error(`Pi child session rejected its initial prompt: ${sessionId}`);
      },
      send: async (sessionId, text) => {
        const result = await piRuntimeBroker.requestForSession(sessionId, 'agent.followUp', { sessionId, text });
        if (!result.accepted) throw new Error(`Pi child session rejected follow-up input: ${sessionId}`);
      },
      abort: async (sessionId) => { await piRuntimeBroker.requestForSession(sessionId, 'agent.abort', { sessionId }); },
      close: async (sessionId) => {
        await harnessShellActivity.closeSessionShell(sessionId);
        await piRuntimeBroker.closeSession(sessionId);
      },
      snapshot: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.snapshot', { sessionId }),
      summary: async (sessionId) => {
        try {
          return await piRuntimeBroker.requestForSession(sessionId, 'session.summary', { sessionId });
        } catch (activeError) {
          const summary = (await piRuntimeBroker.listSessions()).find((candidate) => candidate.id === sessionId);
          if (summary) return summary;
          throw activeError;
        }
      },
      stats: (sessionId) => piRuntimeBroker.requestForSession(sessionId, 'session.stats', { sessionId }),
      entries: (sessionId, scope = 'branch') => piRuntimeBroker.requestForSession(sessionId, 'session.entries', { sessionId, scope }),
    },
    onError: (error) => {
      console.error('[HarnessThreads] Runtime failed:', errorMessage(error));
    },
  });
  observeThreadIntegrationParentChange = (workspaceId, resourceIds) => {
    void threadRuntime!.invalidateIntegrationPreviews(workspaceId, resourceIds).catch((error: unknown) => {
      console.error('[HarnessThreads] Integration preview invalidation failed:', errorMessage(error));
    });
  };
  registerHarnessThreadRoutes(app, {
    registry: threadRegistry,
    runtime: threadRuntime,
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerHarnessContextRoutes(app, {
    getStore: getKnowledgeStoreForSession,
    getBranchEntryIds: branchEntryIdsForSession,
    getUserStore: getUserKnowledgeStore,
    getSuggestionSettings: knowledgeSuggestionSettingsForSession,
    onKnowledgeChanged: (sessionId, scope) => {
      broadcastGlobalUiEvent?.({
        type: 'piarium:harness-knowledge-changed',
        properties: { sessionId, scope },
      });
    },
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerHarnessKnowledgeCatalogRoutes(app, {
    resolveWorkspace: async ({ workspaceId }) => documentsAuthority.resolveWorkspace({ workspaceId }),
    getWorkspaceStore: getKnowledgeStoreForWorkspace,
    getUserStore: getUserKnowledgeStore,
    onKnowledgeChanged: ({ scope, workspaceId }) => {
      broadcastGlobalUiEvent?.({
        type: 'piarium:harness-knowledge-changed',
        properties: { scope, ...(workspaceId ? { workspaceId } : {}) },
      });
    },
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  registerWebSearchCredentialRoutes(app, {
    ...(uiAuthController ? { requireAuth: uiAuthController.requireAuth } : {}),
  });
  piRuntimeBroker.setSessionDeleteCoordinator(async ({ sessionId, summary }) => {
    await threadRegistry.archiveThreadsForDeletedSessionAcrossWorkspaces(sessionId);
    if (summary.workspace?.kind !== 'workspace') return;
    const workspaceId = summary.workspace.authorityId ?? summary.workspace.id;
    await threadRegistry.cancelAllForParent(
      workspaceId,
      { kind: 'session', id: sessionId },
      async (thread) => { await threadRuntime!.kill(thread.id, false, workspaceId); },
    );
  });

  const catalogScan = {
    start(_workspaceId: string): void {},
  };
  async function getKnowledgeStoreForWorkspace(workspaceId: string): Promise<KnowledgeStore> {
    const existing = knowledgeStores.get(workspaceId);
    if (existing) return existing;
    const pending = knowledgeStoreLoads.get(workspaceId);
    if (pending) return pending;
    const loading = openWorkspaceKnowledge({
      dataDir: PIARIUM_DATA_DIR,
      hostId,
      workspaceId,
      embedding: null, // Authority .tdb stays placeholder-dim; knowledge vectors are derived (D-196)
      onKnowledgeChanged: (ids) => {
        const store = knowledgeStores.get(workspaceId);
        if (!store || !knowledgeVectors) return;
        knowledgeVectors.notify(store, 'workspace', workspaceId, workspaceId, ids);
      },
      onBlocksChanged: (sessionId, change) => {
        observeKnowledgeBlockChange(workspaceId, sessionId, change);
        broadcastGlobalUiEvent?.({
          type: 'piarium:harness-blocks-changed',
          properties: { workspaceId, sessionId },
        });
      },
    }).then((store) => {
      knowledgeStores.set(workspaceId, store);
      catalogScan.start(workspaceId);
      knowledgeVectors?.scheduleReconcile(store, 'workspace', workspaceId, workspaceId);
      if (userKnowledgeStore) knowledgeVectors?.scheduleReconcile(userKnowledgeStore, 'user', 'user', workspaceId);
      return store;
    });
    knowledgeStoreLoads.set(workspaceId, loading);
    try {
      return await loading;
    } finally {
      knowledgeStoreLoads.delete(workspaceId);
    }
  }

  function snapshotKnowledgeWorkspaceId(sessionId: string): string | null {
    const workspace = recordOf(sessionSnapshots.get(sessionId)?.workspace);
    if (workspace.kind !== 'workspace') return null;
    if (typeof workspace.authorityId === 'string') return workspace.authorityId;
    return typeof workspace.id === 'string' ? workspace.id : null;
  }

  async function owningKnowledgeWorkspaceIdForSession(
    sessionId: string,
    fallback: string | null = null,
  ): Promise<string | null> {
    const binding = await threadRegistry.getSessionBinding(sessionId);
    if (binding) return binding.owningWorkspaceId;
    return fallback ?? snapshotKnowledgeWorkspaceId(sessionId);
  }

  async function getKnowledgeStoreForSession(sessionId: string): Promise<KnowledgeStore | null> {
    const workspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId);
    return workspaceId ? getKnowledgeStoreForWorkspace(workspaceId) : null;
  }

  async function getUserKnowledgeStore(): Promise<KnowledgeStore> {
    if (userKnowledgeStore) return userKnowledgeStore;
    if (!userKnowledgeStoreLoad) {
      userKnowledgeStoreLoad = openUserKnowledgeStore({
        dataDir: PIARIUM_DATA_DIR,
        hostId,
        embedding: null,
        onKnowledgeChanged: (ids) => {
          if (!userKnowledgeStore || !knowledgeVectors) return;
          knowledgeVectors.notify(userKnowledgeStore, 'user', 'user', undefined, ids);
        },
      }).then((store) => {
        userKnowledgeStore = store;
        for (const workspaceId of knowledgeStores.keys()) {
          knowledgeVectors?.scheduleReconcile(store, 'user', 'user', workspaceId);
        }
        return store;
      });
    }
    try {
      return await userKnowledgeStoreLoad;
    } finally {
      userKnowledgeStoreLoad = null;
    }
  }

  const knowledgeContextRuntime = createKnowledgeContextRuntime({
    getStore: getKnowledgeStoreForWorkspace,
    recall: async (workspaceId, store, query, signal) => {
      if (!knowledgeVectors) return store.recall(query, 5);
      const { results } = await recallWorkspaceAndUser({
        workspaceStore: store,
        userStore: await getUserKnowledgeStore(),
        workspaceId,
        query,
        k: 5,
        vectors: knowledgeVectors,
        ...(signal ? { signal } : {}),
      });
      return results;
    },
    onError: (error) => console.error('[HarnessKnowledge] Observer failed:', errorMessage(error)),
  });
  const decisionSuggestionRuntime = createDecisionSuggestionRuntime({
    getStore: getKnowledgeStoreForWorkspace,
    getSettings: knowledgeSuggestionSettingsForSession,
    onChanged: (sessionId) => {
      broadcastGlobalUiEvent?.({
        type: 'piarium:harness-knowledge-changed',
        properties: { sessionId, scope: 'workspace' },
      });
    },
    onError: (error) => console.error('[HarnessKnowledge] Decision suggestion failed:', errorMessage(error)),
  });
  observeKnowledgeBlockChange = decisionSuggestionRuntime.observeBlockChange;
  const catalogFileSearch = createFsSearchRuntimeFactory({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn: platformEnvironmentRuntime.resolveGitBinaryForSpawn,
  });
  // A grammar catalog must not be able to stop the Host from starting: an
  // unreadable manifest means "nothing is installable", not "no server".
  let grammarManifest = EMPTY_GRAMMAR_PACK_MANIFEST;
  try {
    grammarManifest = loadCommittedGrammarPackManifest();
  } catch (error) {
    console.error('[LanguageSupport] Grammar pack manifest is unusable:', errorMessage(error));
  }
  const grammarStore = createGrammarStore(PIARIUM_DATA_DIR);
  const grammarInstaller = createGrammarInstaller({
    store: grammarStore,
    manifest: grammarManifest,
    minAbi: GRAMMAR_MIN_ABI,
    maxAbi: GRAMMAR_MAX_ABI,
    inspectAbi: createGrammarAbiInspector((fileName) => resolveStructureRuntimeFile(fileName)),
  });
  const languageSupportRuntime = createLanguageSupportRuntime({
    searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
    inspectWorkspace: async (workspaceId) => documentsAuthority.inspectWorkspace(workspaceId),
    manifest: grammarManifest,
    store: grammarStore,
    installer: grammarInstaller,
  });
  const structureSource = createStructureSource([
    createTreeSitterStructureProvider({
      onLanguageRequest: (languageId, workspaceId) => languageSupportRuntime.noteRequest(languageId, workspaceId),
      resolveInstalled: (fileName) => grammarStore.pathForGrammarFile(fileName),
      resolveInstalledLanguage: (languageId) => languageSupportRuntime.installedStructureSpec(languageId),
    }),
    createLspStructureProvider({
      documents: documentsAuthority,
      supervisor: languageSupervisor,
    }),
  ]);
  const symbolGraphRuntime = createSymbolGraphRuntime({
    getStore: getKnowledgeStoreForWorkspace,
    documents: documentsAuthority,
    supervisor: languageSupervisor,
    structureSource,
    searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
    onError: (error) => console.error('[HarnessKnowledge] Symbol graph observer failed:', errorMessage(error)),
  });
  const localEmbedder = createLocalMinilmEmbedder({ dataDir: PIARIUM_DATA_DIR });
  const semanticScheduler = createEmbedScheduler();
  const semanticVectorCache = createVectorCache();
  type SemanticWorkspaceState = {
    backend: ReturnType<typeof createSemanticBackend>;
    binding: HarnessInferenceBindingSnapshot;
    bindingKey: string;
    cwd: string;
    runtime: ReturnType<typeof createSemanticIndexRuntime>;
    snapshot: PiSettingsSnapshot | null;
    needsRefresh: boolean;
    refreshTail: Promise<void>;
    watchIds: string[];
    watching: Promise<void> | null;
    workspaceId: string;
  };
  const semanticWorkspaceStates = new Map<string, SemanticWorkspaceState>();
  const semanticWorkspaceLoads = new Map<string, Promise<SemanticWorkspaceState>>();
  const inferenceWatchWorkspaces = new Map<string, string>();
  let inferenceWatchEpoch = 0;

  const bindingKeyOf = (binding: HarnessInferenceBindingSnapshot): string => JSON.stringify(binding.embedding);

  const refreshSemanticWorkspaceNow = async (
    state: SemanticWorkspaceState,
    scanWhenChanged = false,
  ): Promise<SemanticWorkspaceState> => {
    const retrying = state.needsRefresh;
    const epoch = inferenceWatchEpoch;
    const broker = getReadyPiRuntimeBroker();
    if (!broker) {
      state.binding = { embedding: { status: 'unavailable' }, rerank: { status: 'unavailable' } };
      state.backend.unavailable(new Error('Pi workspace binding is unavailable'));
      state.runtime.cancelScans();
      state.needsRefresh = true;
      return state;
    }
    const [settingsResult, bindingResult] = await Promise.allSettled([
      broker.requestForWorkspace(state.cwd, 'settings.get', {}),
      broker.requestForWorkspace(state.cwd, 'harness.inference.describe', {}),
    ]);
    state.snapshot = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
    state.needsRefresh = settingsResult.status !== 'fulfilled' || bindingResult.status !== 'fulfilled' || epoch !== inferenceWatchEpoch;
    const nextBinding = resolveInferenceBinding(settingsResult, bindingResult);
    const nextKey = bindingKeyOf(nextBinding);
    const changed = nextKey !== state.bindingKey;
    state.binding = nextBinding;
    state.bindingKey = nextKey;
    if (changed) state.runtime.cancelScans();
    if (nextBinding.embedding.status === 'ready') state.backend.bind(nextBinding.embedding.binding);
    else if (nextBinding.embedding.status === 'unconfigured') state.backend.bind(undefined);
    else state.backend.unavailable(new Error(nextBinding.embedding.message ?? 'Embedding binding is unavailable'));
    if (changed) queueMicrotask(() => knowledgeVectors?.refreshWorkspace(state.workspaceId));
    if (scanWhenChanged && (changed || retrying)) {
      queueMicrotask(() => void state.runtime.scanWorkspace(state.workspaceId));
    }
    return state;
  };

  const refreshSemanticWorkspace = (state: SemanticWorkspaceState, scanWhenChanged = false): Promise<SemanticWorkspaceState> => {
    const refresh = state.refreshTail.then(() => refreshSemanticWorkspaceNow(state, scanWhenChanged));
    state.refreshTail = refresh.then(() => undefined, () => undefined);
    return refresh;
  };

  const watchSemanticWorkspace = async (state: SemanticWorkspaceState): Promise<void> => {
    if (state.watching) return state.watching;
    if (state.watchIds.length > 0) return;
    const broker = getReadyPiRuntimeBroker();
    if (!broker) return;
    const epoch = inferenceWatchEpoch;
    state.watching = (async () => {
      const watches = await Promise.allSettled([
        broker.watchConfig({ cwd: state.cwd }, { kind: 'settings', scope: 'global' }),
        broker.watchConfig({ cwd: state.cwd }, { kind: 'document', path: 'models.json', scope: 'global' }),
      ]);
      for (const result of watches) {
        if (result.status !== 'fulfilled') continue;
        if (epoch !== inferenceWatchEpoch) {
          void broker.unwatchConfig(result.value.watchId).catch(() => undefined);
          continue;
        }
        state.watchIds.push(result.value.watchId);
        inferenceWatchWorkspaces.set(result.value.watchId, state.workspaceId);
      }
      // A failed watch is retried with the next explicit use of this workspace.
      if (state.watchIds.length !== watches.length) {
        state.needsRefresh = true;
        for (const watchId of state.watchIds.splice(0)) {
          inferenceWatchWorkspaces.delete(watchId);
          void broker.unwatchConfig(watchId).catch(() => undefined);
        }
      }
    })();
    try { await state.watching; } finally { state.watching = null; }
  };

  const getSemanticWorkspace = async (workspaceId: string): Promise<SemanticWorkspaceState> => {
    const pending = semanticWorkspaceLoads.get(workspaceId);
    if (pending) return pending;
    const existing = semanticWorkspaceStates.get(workspaceId);
    if (existing) {
      if (existing.needsRefresh) await refreshSemanticWorkspace(existing, true);
      await watchSemanticWorkspace(existing);
      return existing;
    }
    const loading = (async () => {
      const cwd = (await documentsAuthority.inspectWorkspace(workspaceId)).root;
      const backend = createSemanticBackend({
        local: localEmbedder,
        embedClient: {
          embed: async (params) => {
            const request: HarnessEmbedParams = {
              purpose: params.purpose,
              providerId: params.providerId,
              modelId: params.modelId,
              protocol: 'openai-compatible',
              configurationId: params.configurationId,
              items: params.items,
              batchId: params.batchId,
              ...(params.dimensions === undefined ? {} : { dimensions: params.dimensions }),
              maxTokens: params.maxTokens,
            };
            const broker = getReadyPiRuntimeBroker();
            if (!broker) throw new Error('Pi workspace binding is unavailable');
            return requestWorkspaceInference(broker, cwd, 'harness.embed', request, params.signal);
          },
        },
      });
      const runtime = createSemanticIndexRuntime({
        dataDir: PIARIUM_DATA_DIR,
        hostId,
        documents: documentsAuthority,
        structureSource,
        searchFilesystemFiles: catalogFileSearch.searchFilesystemFiles,
        isIndexablePath: async (id, resourceId, signal) => catalogFileSearch.isSearchableFile(
          (await documentsAuthority.inspectWorkspace(id)).root, resourceId, signal,
        ),
        embedder: localEmbedder,
        getEmbedder: () => backend.embedder,
        vectorCache: semanticVectorCache,
        scheduler: semanticScheduler,
        onError: (error) => console.error(`[HarnessKnowledge] Semantic index failed (${workspaceId}):`, errorMessage(error)),
      });
      const state: SemanticWorkspaceState = {
        backend,
        binding: { embedding: { status: 'unconfigured' }, rerank: { status: 'unconfigured' } },
        bindingKey: '',
        cwd,
        runtime,
        snapshot: null,
        needsRefresh: true,
        refreshTail: Promise.resolve(),
        watchIds: [],
        watching: null,
        workspaceId,
      };
      semanticWorkspaceStates.set(workspaceId, state);
      await refreshSemanticWorkspace(state);
      queueMicrotask(() => void state.runtime.scanWorkspace(workspaceId));
      await watchSemanticWorkspace(state);
      return state;
    })();
    semanticWorkspaceLoads.set(workspaceId, loading);
    try { return await loading; } finally { semanticWorkspaceLoads.delete(workspaceId); }
  };
  knowledgeVectors = createKnowledgeVectorRuntime({
    dataDir: PIARIUM_DATA_DIR,
    hostId,
    scheduler: semanticScheduler,
    cache: semanticVectorCache,
    resolveEmbedder: async (workspaceId) => {
      const state = await getSemanticWorkspace(workspaceId);
      if (state.binding.embedding.status === 'ready') {
        return { status: 'ready', embedder: state.backend.embedder };
      }
      if (state.binding.embedding.status === 'unconfigured') return { status: 'unconfigured' };
      return {
        status: state.binding.embedding.status === 'invalid' ? 'invalid' : 'unavailable',
        ...(state.binding.embedding.message === undefined ? {} : { message: state.binding.embedding.message }),
      };
    },
  });
  catalogScan.start = (workspaceId: string): void => {
    queueMicrotask(() => {
      void symbolGraphRuntime.scanWorkspace(workspaceId).catch((error) => {
        console.error('[HarnessKnowledge] Catalog scan failed:', errorMessage(error));
      });
      void getSemanticWorkspace(workspaceId)
        .then((state) => state.runtime.scanWorkspace(workspaceId))
        .catch((error) => {
          console.error('[HarnessKnowledge] Semantic scan failed:', errorMessage(error));
        });
    });
  };
  for (const [workspaceId, store] of knowledgeStores) {
    catalogScan.start(workspaceId);
    knowledgeVectors.scheduleReconcile(store, 'workspace', workspaceId, workspaceId);
    if (userKnowledgeStore) knowledgeVectors.scheduleReconcile(userKnowledgeStore, 'user', 'user', workspaceId);
  }
  const observeKnowledgeGitStatus = createGitStatusObserver({
    resolveWorkspaceId: (scope) => documentsAuthority.resolveScopeId(scope),
    observe: (event) => knowledgeContextRuntime.observeGitStatus(event),
    onError: (error) => console.error('[HarnessKnowledge] Git status observer failed:', errorMessage(error)),
  });
  observeKnowledgeDocumentMutation = (event) => {
    knowledgeContextRuntime.observeDocumentMutation(event);
    symbolGraphRuntime.observeDocumentMutation(event);
    void getSemanticWorkspace(event.workspaceId).then((state) => {
      state.runtime.observeDocumentMutation(event);
    }).catch((error) => {
      console.error('[HarnessKnowledge] Semantic bind failed:', errorMessage(error));
    });
  };
  const knowledgeLanguageSubscriptions = new Map<string, { close(): void }>();
  const bindKnowledgeSession = (sessionId: string, workspaceId: string): void => {
    knowledgeContextRuntime.bindSession(sessionId, workspaceId);
    if (knowledgeLanguageSubscriptions.has(workspaceId)) return;
    knowledgeLanguageSubscriptions.set(workspaceId, languageSupervisor.subscribe(workspaceId, (value) => {
      const event = recordOf(value);
      if (event.kind !== 'diagnostics' || typeof event.resourceId !== 'string') return;
      // Zone 2 reports diagnostics that follow a user edit, so only the editor
      // view qualifies; the agent view's answers are the agent's own feedback.
      if (event.view !== SURFACE_LANGUAGE_VIEW) return;
      const diagnostics = Array.isArray(event.items)
        ? event.items.map(recordOf).filter((item) => item.severity === 'error' || item.severity === 'warning')
        : [];
      if (diagnostics.length === 0) return;
      knowledgeContextRuntime.observeDiagnostics({
        workspaceId,
        sessionId: 'lsp',
        path: event.resourceId,
        count: diagnostics.length,
        worst: diagnostics.some((item) => item.severity === 'error') ? 'error' : 'warning',
      });
    }));
  };
  bindThreadKnowledgeSession = bindKnowledgeSession;

  // Zone 2 provider — assembles material from the knowledge store
  async function zone2Provider(request: Parameters<typeof knowledgeContextRuntime.zone2Material>[0]) {
    return knowledgeContextRuntime.zone2Material(request);
  }

  // Compaction deps provider — uses Pi's preparation (firstKeptEntryId /
  // tokensBefore) passed directly through the service params, no broker
  // round-trip for entry ID resolution.
  // Keeper coverage store — shared between the compaction deps provider
  // (which checks coverage before takeover) and the service host (which
  // clears it on compaction.after and session drop).
  const keeperCoverageStore = createKeeperCoverageStore();

  async function compactionDepsProvider(sessionId: string): Promise<CompactionHandlerDeps> {
    const store = await getKnowledgeStoreForSession(sessionId);
    if (!store) throw new Error('No knowledge store for session');
    return {
      store,
      settings: DEFAULT_COMPACTION_SETTINGS,
      coverageStore: keeperCoverageStore,
      getFacts: () => collectCompactionFacts(store, sessionId),
    };
  }

  async function memoryDepsProvider(sessionId: string) {
    const store = await getKnowledgeStoreForSession(sessionId);
    if (!store) throw new Error('No knowledge store for session');
    return { store, settings: DEFAULT_MEMORY_AGENT_SETTINGS };
  }

  // Todo deps provider
  async function todoDepsProvider(sessionId: string): Promise<TodoToolDeps> {
    const store = await getKnowledgeStoreForSession(sessionId);
    if (!store) throw new Error('No knowledge store for session');
    return {
      store,
      sessionId,
    };
  }

  // Recall deps provider
  async function recallDepsProvider(sessionId: string, workspaceId: string | null): Promise<RecallToolDeps> {
    const owningWorkspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId, workspaceId);
    if (!owningWorkspaceId) throw new Error('No knowledge workspace for session');
    const workspaceStore = await getKnowledgeStoreForWorkspace(owningWorkspaceId);
    return {
      workspaceStore,
      userStore: await getUserKnowledgeStore(),
      workspaceId: owningWorkspaceId,
      ...(knowledgeVectors ? { vectors: knowledgeVectors } : {}),
    };
  }

  const discoveredShells = discoverShells();
  const harnessServiceHost = createHarnessServiceHost({
    discoveredShells,
    verification: verificationCoordinator,
    readExploreFile: createExploreFileReader(
      documentsAuthority,
      harnessPathAuthority,
      (sessionId, resourceId) => workingBranchLookups.exploreFile(sessionId, resourceId),
    ),
    branchCorpus: (sessionId) => workingBranchLookups.searchCorpus(sessionId),
    pinWorkingBranchQuery: (sessionId, pinOptions) => workingBranchLookups.pinQuery(sessionId, pinOptions),
    agentInputDraftPaths: (sessionId, context) => documentsAuthority.agentInputDraftPaths(sessionId, context),
    documentReadSource: async (sessionId, context, resourceId) => {
      const branch = await workingBranchLookups.readSource(sessionId, resourceId);
      if (branch) return branch;
      return documentsAuthority.readAgentInputSnapshot(sessionId, context, resourceId);
    },
    documentPathOverlay: async (sessionId, context, resourceId) => {
      const branch = await workingBranchLookups.pathOverlay(sessionId, resourceId);
      if (branch) return branch;
      return documentsAuthority.overlayAgentInputSnapshot(sessionId, context, resourceId);
    },
    documentWriteGuard: (sessionId, context, resourceId) => documentsAuthority.inspectAgentWriteTarget(
      sessionId,
      context,
      resourceId,
    ),
    documentBranchWrite: (sessionId, changes, expectedRevision, signal) => workingBranchWrites.branchWrite(
      sessionId,
      changes,
      expectedRevision,
      signal,
    ),
    workingBranchEnsureMaterialized: (sessionId, signal) => {
      if (!threadRuntime) {
        return Promise.resolve({ status: "failed" as const, message: "Thread runtime is unavailable for materialization" });
      }
      return threadRuntime.materializeExecutionView(sessionId, signal);
    },
    commitAgentInputContext: (sessionId, context) => documentsAuthority.commitAgentInputSnapshot(sessionId, context),
    releaseAgentInputContext: (sessionId, context) => documentsAuthority.releaseAgentInputSnapshot(sessionId, context),
    dropAgentInputContexts: (sessionId) => documentsAuthority.dropAgentInputSnapshots(sessionId),
    search: async (request, options) => workspaceContentSearch.searchContent({
      query: request.query,
      workspaceId: request.workspaceId,
      maxResults: request.maxResults,
      ...(request.paths === undefined ? {} : { paths: request.paths }),
      ...(request.glob === undefined ? {} : { glob: request.glob }),
      ...(request.excludeResourceIds === undefined ? {} : { excludeResourceIds: request.excludeResourceIds }),
      ...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
      ...(request.fixedStrings === undefined ? {} : { fixedStrings: request.fixedStrings }),
    }, options),
    resolveWorkspaceRoot: async (workspaceId) => {
      try {
        const workspace = await documentsAuthority.inspectWorkspace(workspaceId);
        return workspace.root;
      } catch {
        return null;
      }
    },
    createTerminalSession: async (input) => {
      const runtime = terminalRuntime;
      if (!runtime?.createTerminalSession) {
        throw new Error("Terminal runtime is not available");
      }
      return runtime.createTerminalSession(input);
    },
    registerWriter: async (sessionId, workspaceRoot) => {
      const writer = await documentsAuthority.registerWriterForScope(
        workspaceRoot,
        { kind: 'harness-bash', id: sessionId },
        { mode: 'process', purpose: 'harness-bash' },
      );
      if (!writer) throw new Error('Harness shell has no workspace writer authority');
      return { close: async () => { await writer.close(); } };
    },
    ...(harnessDiagnosticsProvider ? { diagnosticsProvider: harnessDiagnosticsProvider } : {}),
    lspNavigationServices: createLspNavigationServices({
      documents: documentsAuthority,
      supervisor: languageSupervisor,
    }),
    structureSource,
    // Reading relations must not open a database or start a catalog scan, so
    // this consults an already-open store and reports "not answered" otherwise.
    // The session's own knowledge work opens it (D-112).
    graphRecall: (workspaceId) => knowledgeStores.get(workspaceId) ?? null,
    semanticRecall: async (workspaceId, question, limit, searchOptions) => {
      const semanticState = await getSemanticWorkspace(workspaceId);
      const sessionId = searchOptions?.sessionId;
      // Isolated child sessions are registered against their materialized cwd's
      // own Documents workspace. Query that live scope directly. Treating the
      // parent's WorkingState object table as an overlay both misses live child
      // writes and can expose copyIgnored execution inputs to remote inference.
      // A still-virtual Run is the opposite case: its authoritative files live
      // only in the pinned WorkingState view, so this query overlays that view.
      const inputContext = searchOptions?.inputContext ?? { source: 'disk' as const };
      const execution = sessionId ? threadExecutionViews.get(sessionId) : undefined;
      const pinnedDocuments = searchOptions?.threadDocuments;
      const threadDocuments = pinnedDocuments
        ? pinnedDocuments
        : execution?.mode === 'virtual' && sessionId
        ? (await workingBranchLookups.pinQuery(sessionId, {
          ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
          ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
        }))?.files.map((file) => ({
          path: file.path,
          content: file.text,
          revision: file.revision,
        }))
        : undefined;
      const draftPaths = sessionId
        ? documentsAuthority.agentInputDraftPaths(sessionId, inputContext)
        : inputContext.source === 'surface' ? inputContext.dirtyPaths : undefined;
      const view = await pinSemanticQueryView({
        inputContext,
        ...(draftPaths === undefined ? {} : { draftPaths }),
        ...(threadDocuments
          ? {
            threadDocuments: threadDocuments.map((file) => ({
              path: file.path,
              content: file.content,
              revision: file.revision,
            })),
          }
          : sessionId
          ? {
            readDraft: (resourceId: string) => {
              const snapshot = documentsAuthority.readAgentInputSnapshot(sessionId, inputContext, resourceId);
              if (snapshot.status === 'ready') {
                return { status: 'ready', content: snapshot.content, revision: snapshot.revision };
              }
              if (snapshot.status === 'unavailable') return { status: 'unavailable' };
              if (snapshot.status === 'disk' && snapshot.superseded) return { status: 'disk', superseded: true };
              return { status: 'disk' };
            },
          }
          : {}),
      });
      const result = await semanticState.runtime.search(
        workspaceScope(workspaceId),
        question,
        limit,
        {
          ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
          ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
          overlays: view.overlays,
          view: view.view,
        },
      );
      return {
        status: result.status.status,
        coverage: result.status.coverage,
        ...(result.status.generation ? { generation: result.status.generation } : {}),
        ...(result.status.spaceId ? { spaceId: result.status.spaceId } : {}),
        scope: result.status.scope,
        lifecycle: result.status.lifecycle,
        hits: result.hits,
        ...(result.gaps.length > 0 ? { gaps: result.gaps } : {}),
      };
    },
    harnessSettings: async (workspaceId) => (
      (await getSemanticWorkspace(workspaceId)).snapshot
    ),
    rerankExploreViews: async (input) => {
      const broker = getReadyPiRuntimeBroker();
      if (!broker) throw new Error('Pi workspace binding is unavailable');
      const state = semanticWorkspaceStates.get(input.workspaceId)
        ?? await getSemanticWorkspace(input.workspaceId);
      const configured: HarnessResolvedRerankBinding | undefined = state.binding.rerank.status === 'ready'
        ? state.binding.rerank.binding
        : undefined;
      if (!configured) throw new Error('Rerank is not configured');
      if (
        configured.protocol !== input.settings.protocol
        || configured.providerId !== input.settings.providerId
        || configured.modelId !== input.settings.modelId
        || configured.endpoint !== input.settings.endpoint
        || configured.maxDocumentTokens !== input.settings.maxDocumentTokens
      ) throw new Error('Rerank settings changed after the query view was frozen');
      const batchId = crypto.randomUUID();
      const request: HarnessRerankParams = {
        providerId: configured.providerId,
        modelId: configured.modelId,
        protocol: 'http-rerank',
        configurationId: configured.configurationId,
        query: input.query,
        documents: input.documents,
        batchId,
        ...(configured.endpoint ? { endpoint: configured.endpoint } : {}),
        ...(configured.maxDocumentTokens ? { maxDocumentTokens: configured.maxDocumentTokens } : {}),
      };
      const result = await requestWorkspaceInference(broker, state.cwd, 'harness.rerank', request, input.signal);
      if (
        result.batchId !== batchId
        || result.providerId !== configured.providerId
        || result.modelId !== configured.modelId
      ) throw new Error('Rerank response does not match the submitted batch binding');
      const seen = new Set<number>();
      for (const score of result.scores) {
        if (
          !Number.isInteger(score.index)
          || score.index < 0
          || score.index >= input.documents.length
          || seen.has(score.index)
          || score.id !== input.documents[score.index]?.id
          || !Number.isFinite(score.score)
        ) throw new Error('Rerank response contains an invalid score identity');
        seen.add(score.index);
      }
      if (seen.size === 0) throw new Error('Rerank response did not score any submitted document');
      return result;
    },
    fileRelations: async (workspaceId, resourceId) => {
      const store = knowledgeStores.get(workspaceId);
      if (!store) throw new Error(`knowledge store is not open for workspace ${workspaceId}`);
      const relations = await store.getFileRelations(resourceId);
      if (!relations) return null;
      if (relations.imports.length === 0 && relations.connections.length === 0 && relations.associations.length === 0) {
        return null;
      }
      return {
        path: relations.path,
        documentRevision: relations.documentRevision,
        incomplete: relations.linksIncomplete,
        imports: relations.imports.map(({ specifier, line }) => ({ specifier, line })),
        connections: relations.connections.map(({ callee, literal, line }) => ({ callee, literal, line })),
        associations: relations.associations.map(({ callee, literal, line }) => ({ callee, literal, line })),
      };
    },
    // Web services — fetch is always available (SSRF-guarded); read and search
    // depend on reader model / search provider configuration, wired later.
    webFetchService,
    ...(webSearchService ? { webSearchService } : {}),
    // Phase 2: knowledge, memory, zone2, compaction, todo, recall
    zone2Provider,
    onSessionCompacted: (sessionId) => knowledgeContextRuntime.resetSessionObservationBaselines(sessionId),
    memoryDepsProvider,
    compactionDepsProvider,
    keeperCoverageStore,
    todoDepsProvider,
    recallDepsProvider,
    knowledgeSuggestDepsProvider: async (sessionId, workspaceId) => {
      const owningWorkspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId, workspaceId);
      const store = owningWorkspaceId && owningWorkspaceId !== 'user'
        ? await getKnowledgeStoreForWorkspace(owningWorkspaceId)
        : null;
      if (!store) return null;
      return {
        store,
        settings: await knowledgeSuggestionSettingsForSession(sessionId),
        onChanged: () => {
          broadcastGlobalUiEvent?.({
            type: 'piarium:harness-knowledge-changed',
            properties: { sessionId, scope: 'workspace', ...(owningWorkspaceId ? { workspaceId: owningWorkspaceId } : {}) },
          });
        },
      };
    },
    threadRegistry,
    threadCaptureDraftBaseline: (sessionId, workspaceId, context) => threadRuntime!.captureDraftBaseline(sessionId, workspaceId, context),
    threadPrepareIsolatedBranch: (input) => threadRuntime!.prepareIsolatedBranch(input),
    agentInputSurfaceOwner: documentsAuthority.agentInputSurfaceOwner,
    threadTranscriptReader,
    threadSpawnSession: (input) => threadRuntime!.spawn(input),
    threadKillSession: (threadId: string, keepWorktree?: boolean, workspaceId?: string) => (
      threadRuntime!.kill(threadId, keepWorktree, workspaceId)
    ),
    requireThreadMergeJournal: true,
    threadApplyWorktreeDiff: (workspaceId, parent, threadId, resultRevision, executionId, extras) => (
      threadRuntime!.merge(workspaceId, parent, threadId, resultRevision, executionId, extras)
    ),
    threadSendToSession: (sessionId, message, from) => threadRuntime!.send(sessionId, message, from),
  });
  harnessShellActivity.hasActiveCommandAtDirectory = (directory) => (
    harnessServiceHost.hasActiveCommandAtDirectory(directory)
  );
  harnessShellActivity.closeSessionShell = harnessServiceHost.closeSessionShell;
  const harnessSessionRegistration = createHarnessSessionRegistration({
    host: harnessServiceHost,
    readSettings: async ({ actor }) => {
      const broker = getReadyPiRuntimeBroker();
      if (!broker) throw new Error('Pi settings are unavailable');
      return broker.requestForSession(actor.sessionId, 'settings.get', {});
    },
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
    if (target.kind === 'catalog') result = await piRuntimeBroker.requestCatalogDynamic(hostMethod, params);
    else if (target.kind === 'workspace' && typeof target.cwd === 'string') {
      result = await piRuntimeBroker.requestForWorkspaceDynamic(target.cwd, hostMethod, params);
    } else if (target.kind === 'session' && typeof target.sessionId === 'string') {
      result = await piRuntimeBroker.requestForSessionDynamic(target.sessionId, hostMethod, params);
    } else throw new Error('The pi-runtime capability target is invalid');
    return toJsonValue(result ?? null);
  });
  await extensionRuntime.start().catch((error) => {
    console.warn('[Piarium Extensions] Host reconciliation failed:', error?.message || error);
  });
  const unregisterWorkbenchLayoutService = await registerBuiltinWorkbenchLayoutService(extensionRuntime);
  scheduledTasksRuntime.setExecutor(createPiScheduledTaskExecutor({ broker: piRuntimeBroker }));
  const sessionNames = new Map<string, string>();
  const sessionSnapshots = new Map<string, Record<string, unknown>>();
  recoveryTurnCoordinator = createRecoveryTurnCoordinator({
    documents: documentsAuthority,
    getSessionSnapshot: (sessionId) => sessionSnapshots.get(sessionId) ?? null,
    invokeService: (request) => extensionRuntime.invokeService(request),
    respondMutation: async (request, accepted) => {
      await piRuntimeBroker.requestForSession(
        request.sessionId,
        'workspace.mutation.respond',
        { accepted, requestId: request.requestId, sessionId: request.sessionId },
      );
    },
    observeToolWrite: (workspaceId, absolutePath) => (
      documentsAuthority.observeAgentWrite(workspaceId, absolutePath)
    ),
    writerTracker: piWriterTracker,
  });
  // ── Harness router ─────────────────────────────────────────────────
  // Consumes harness.request events from the broker stream (same
  // subscription as recovery turn coordinator) and dispatches to the
  // registered harness services.
  const harnessRouter = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      await piRuntimeBroker.requestForSession(sessionId, 'harness.respond', buildHarnessRespondParams(sessionId, requestId, outcome));
    },
    resolveActor: (identity, signal) => harnessSessionRegistration.resolveActor(identity, signal),
    authorizeWorkspacePath: (actor, candidate, options) => harnessPathAuthority.resolve(actor, candidate, options),
    cancelExploreQuery: (actor, queryId) => harnessServiceHost.exploreQueryStore.cancel(actor, queryId),
  });
  registerHarnessServices(harnessRouter, harnessServiceHost);
  interface SessionNotificationRequest extends DesktopNotificationPayload {
    body: string;
    kind: 'completion' | 'error';
    sessionId: string;
    tag: string;
    title: string;
  }
  const sendPiSessionNotification = async ({
    body,
    kind,
    sessionId,
    tag,
    title,
  }: SessionNotificationRequest): Promise<void> => {
    const settings = await readSettingsFromDisk().catch(() => null);
    if (settings?.notifyOnCompletion === false) return;
    const payload = { body, kind, sessionId, tag, title };
    const desktopDelivered = getIsWindowFocused() && settings?.notificationMode !== 'always'
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
    if (event.kind === 'host' && event.envelope.event === 'config.changed') {
      const workspaceId = inferenceWatchWorkspaces.get(event.envelope.data.watchId);
      const state = workspaceId ? semanticWorkspaceStates.get(workspaceId) : undefined;
      if (state) void refreshSemanticWorkspace(state, true).catch((error) => {
        console.error(`[HarnessKnowledge] Inference configuration refresh failed (${workspaceId}):`, errorMessage(error));
      });
    }
    if (event.kind === 'host' && event.envelope.event === 'provider.config.changed') {
      for (const state of semanticWorkspaceStates.values()) {
        void refreshSemanticWorkspace(state, true).catch((error) => {
          console.error(`[HarnessKnowledge] Provider configuration refresh failed (${state.workspaceId}):`, errorMessage(error));
        });
      }
    }
    piSessionAutomation.processBrokerEvent(event);
    sessionRuntime.processBrokerEvent(event);
    void piWriterTracker.processEvent(event);
    void recoveryTurnCoordinator.processEvent(event);
    void harnessRouter.processEvent(event);
    threadRuntime.processEvent(event);
    if (event?.kind === 'worker.exit') {
      if (event.role === 'workspace') {
        inferenceWatchEpoch++;
        for (const state of semanticWorkspaceStates.values()) {
          state.needsRefresh = true;
          for (const watchId of state.watchIds.splice(0)) {
            inferenceWatchWorkspaces.delete(watchId);
            void piRuntimeBroker.unwatchConfig(watchId).catch(() => undefined);
          }
        }
      }
      if (event.sessionId) {
        const ownsRegisteredSession = !event.actor || harnessSessionRegistration.hasActor(event.actor);
        harnessSessionRegistration.dropSession(event.sessionId, event.actor);
        if (ownsRegisteredSession) {
          sessionSnapshots.delete(event.sessionId);
          sessionNames.delete(event.sessionId);
          knowledgeContextRuntime.dropSession(event.sessionId);
        }
      }
      return;
    }
    if (event?.kind !== 'host' || event.envelope?.kind !== 'event') return;
    const envelope = event.envelope;
    const envelopeData = recordOf(envelope.data);
    const sessionId = event.sessionId ?? '';
    if (envelope.event === 'session.closed' && sessionId) {
      const ownsRegisteredSession = !event.actor || harnessSessionRegistration.hasActor(event.actor);
      harnessSessionRegistration.dropSession(sessionId, event.actor);
      if (ownsRegisteredSession) knowledgeContextRuntime.dropSession(sessionId);
      return;
    }
    if (envelope.event === 'session.snapshot' && sessionId) {
      sessionSnapshots.set(sessionId, envelopeData);
      const name = typeof envelopeData.name === 'string' ? envelopeData.name.trim() : '';
      if (name) sessionNames.set(sessionId, name);
      // Register harness session when workspace is bound
      const workspace = recordOf(envelopeData.workspace);
      const harnessWorkspaceId = typeof workspace.authorityId === 'string'
        ? workspace.authorityId
        : typeof workspace.id === 'string'
          ? workspace.id
          : '';
      if (
        event.actor
        && workspace?.kind === 'workspace'
        && harnessWorkspaceId
        && typeof envelopeData.cwd === 'string'
      ) {
        void threadRegistry.getSessionBinding(sessionId).then((binding) => {
          bindKnowledgeSession(sessionId, binding?.owningWorkspaceId ?? harnessWorkspaceId);
        }).catch((error) => {
          console.error('[HarnessKnowledge] Session knowledge bind failed:', errorMessage(error));
        });
        if (!harnessSessionRegistration.hasActor(event.actor)) {
          const activeTools = Array.isArray(envelopeData.activeTools)
            ? envelopeData.activeTools.filter((entry): entry is string => typeof entry === 'string')
            : [];
          void harnessSessionRegistration.register({
            actor: event.actor,
            workspaceId: harnessWorkspaceId,
            workspaceRoot: envelopeData.cwd,
            grantedCapabilities: deriveHarnessCapabilities(activeTools, {
              documentRead: true,
              documentPathOverlay: true,
              threadRuntime: Boolean(harnessServiceHost.threadRegistry && harnessServiceHost.threadSpawnSession),
            }),
          }).catch((error) => {
            console.error('[Harness] Failed to register session shell:', errorMessage(error));
          });
        }
        void (async () => {
          const binding = await threadRegistry.getSessionBinding(sessionId);
          await threadRuntime.resumeLostForParent(
            binding?.owningWorkspaceId ?? harnessWorkspaceId,
            binding
              ? { kind: 'thread', id: binding.threadId }
              : { kind: 'session', id: sessionId },
          );
        })().catch((error) => {
          console.error('[HarnessThreads] Failed to resume child runs:', errorMessage(error));
        });
      }
      return;
    }
    if (envelope.event !== 'agent.event' || !sessionId) return;
    if (threadRuntime.isThreadSession(sessionId)) return;
    const agentEvent = recordOf(envelopeData.event);
    if (agentEvent?.type === 'agent_settled') return;
    if (agentEvent?.type !== 'agent_end' || agentEvent.willRetry === true) return;
    void (async () => {
      const features = recordOf(sessionSnapshots.get(sessionId)?.features);
      const goal = recordOf(features.goal);
      if (goal.status === 'active') return;
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
    readSettingsFromDisk,
    updateSettingsOnDisk,
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
    onGitStatus: observeKnowledgeGitStatus,
    languageSupervisor,
    languageSupport: languageSupportRuntime,
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
    ...(host ? { host } : {}),
    port,
    startupTunnelRequest,
    ...(onTunnelReady ? { onTunnelReady } : {}),
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
    stop: async (shutdownOptions: { exitProcess?: boolean | undefined } = {}) => {
      piSessionAutomation.stop();
      brokerUnsubscribe();
      await harnessSessionRegistration.dispose();
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
      for (const subscription of knowledgeLanguageSubscriptions.values()) subscription.close();
      knowledgeLanguageSubscriptions.clear();
      await languageSupervisor.dispose();
      await runRuntime.dispose();
      await threadRuntime.dispose();
      await piRuntimeGateway.stop();
      await Promise.allSettled([...inferenceWatchWorkspaces.keys()].map((watchId) => (
        piRuntimeBroker.unwatchConfig(watchId)
      )));
      inferenceWatchWorkspaces.clear();
      await knowledgeVectors?.close();
      await Promise.allSettled([...semanticWorkspaceStates.values()].map((state) => state.runtime.dispose()));
      semanticWorkspaceStates.clear();
      if (ownsPiRuntimeBroker) await piRuntimeLifecycle.dispose();
      await recoveryTurnCoordinator.dispose();
      await piWriterTracker.dispose();
      observeKnowledgeDocumentMutation = () => undefined;
      observeKnowledgeBlockChange = () => undefined;
      await symbolGraphRuntime.dispose();
      await decisionSuggestionRuntime.dispose();
      await knowledgeContextRuntime.dispose();
      await Promise.allSettled([...knowledgeStoreLoads.values()]);
      await Promise.allSettled([...knowledgeStores.values()].map((store) => store.close()));
      knowledgeStores.clear();
      if (userKnowledgeStoreLoad) await userKnowledgeStoreLoad.catch(() => null);
      await userKnowledgeStore?.close();
      userKnowledgeStore = null;
      harnessRouter.dispose();
      await harnessServiceHost.dispose();
      await threadRegistry.dispose();
      await Promise.allSettled([...workspaceRecoveryEngines.values()].map((engine) => engine.dispose()));
      workspaceRecoveryEngines.clear();
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
  resolvePiariumDataDir,
  clearAppImageArgv0FromProcessEnv,
  pathLooksUserConfigured,
  mergePathValues,
  mintOutsideFileGrant,
};
