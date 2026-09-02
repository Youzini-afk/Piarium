import type { spawn as spawnFunction } from 'node:child_process';
import type cryptoModule from 'node:crypto';
import type fsPromisesModule from 'node:fs/promises';
import type osModule from 'node:os';
import type pathModule from 'node:path';

import type { Express, Response } from 'express';

import type { DocumentAuthority } from '../documents/authority.js';
import { registerExternalAccessRoutes } from '../external-access/routes.js';
import { registerExtensionRoutes } from '../extensions/routes.js';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerPiariumEventRoutes, registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSmartSearchRoutes } from '../smart-search/routes.js';
import { registerWorkspaceRoutes } from '../workspace/workspace-routes.js';
import { registerDocumentRoutes } from '../documents/routes.js';
import { registerWorkspaceSearchRoutes } from '../search/routes.js';
import { registerLanguageRoutes } from '../lsp/routes.js';
import { registerRunRoutes } from '../run/routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerPiRuntimeHttpRoute } from './pi-runtime-http-route.js';
import { registerRuntimeManagerRoutes } from './runtime-manager-routes.js';

type ExtensionRouteDependencies = Parameters<typeof registerExtensionRoutes>[1];
type ProjectIconDependencies = Parameters<typeof registerProjectIconRoutes>[1];
type ScheduledTaskDependencies = Parameters<typeof registerScheduledTaskRoutes>[1];
type PiariumEventDependencies = Parameters<typeof registerPiariumEventRoutes>[1];
type PiRuntimeDependencies = Parameters<typeof registerPiRuntimeHttpRoute>[1];
type RuntimeManagerDependencies = Parameters<typeof registerRuntimeManagerRoutes>[1];
type FsRouteDependencies = Parameters<typeof registerFsRoutes>[1];
type LanguageRouteDependencies = Parameters<typeof registerLanguageRoutes>[1];
type RunRouteDependencies = Parameters<typeof registerRunRoutes>[1];
type NormalizationRuntime = ReturnType<typeof import('./settings-normalization-runtime.js').createSettingsNormalizationRuntime>;
type SettingsHelpers = ReturnType<typeof import('./settings-helpers.js').createSettingsHelpers>;
type SettingsRuntime = ReturnType<typeof import('./settings-runtime.js').createSettingsRuntime>;
type ProjectDirectoryRuntime = ReturnType<typeof import('./project-directory-runtime.js').createProjectDirectoryRuntime>;
type EnvironmentRuntime = ReturnType<typeof import('./environment-runtime.js').createPlatformEnvironmentRuntime>;
type ProjectConfigRuntime = ReturnType<typeof import('../projects/project-config.js').createProjectConfigRuntime>;
type ScheduledTasksRuntime = ReturnType<typeof import('../scheduled-tasks/runtime.js').createScheduledTasksRuntime>;
type ScheduledTaskService = NonNullable<ScheduledTaskDependencies['scheduledTaskService']>;
type SmartSearchDependencies = Parameters<typeof registerSmartSearchRoutes>[1];
type SmartSearchSpawn = NonNullable<SmartSearchDependencies['spawn']>;

export interface PlatformRouteDependencies {
  __dirname: string;
  buildAugmentedPath: EnvironmentRuntime['buildAugmentedPath'];
  createFsSearchRuntime: ProjectIconDependencies['createFsSearchRuntime'];
  crypto: typeof cryptoModule;
  documents?: DocumentAuthority;
  extensionCatalog: ExtensionRouteDependencies['extensionCatalog'];
  extensionPackages: ExtensionRouteDependencies['extensionPackages'];
  extensionRuntime: ExtensionRouteDependencies['extensionRuntime'];
  formatSettingsResponse: SettingsHelpers['formatSettingsResponse'];
  fsPromises: typeof fsPromisesModule;
  getPiRuntimeBroker?: PiRuntimeDependencies['getPiRuntimeBroker'];
  getPiariumEventClients: PiariumEventDependencies['getPiariumEventClients'];
  languageSupervisor?: LanguageRouteDependencies['language'];
  normalizeDirectoryPath: NormalizationRuntime['normalizeDirectoryPath'];
  openFilesystemPath?: RuntimeManagerDependencies['openFilesystemPath'];
  os: typeof osModule;
  path: typeof pathModule;
  persistSettings: SettingsRuntime['persistSettings'];
  piariumDataDir: string;
  piariumUserConfigRoot: string;
  piariumVersion: string;
  pickPiPackageRoot?: RuntimeManagerDependencies['pickPiPackageRoot'];
  piRuntimeBroker: PiRuntimeDependencies['piRuntimeBroker'];
  piRuntimeLifecycle?: RuntimeManagerDependencies['lifecycle'];
  process: NodeJS.Process;
  projectConfigRuntime: ProjectConfigRuntime;
  readCustomThemesFromDisk: () => Promise<unknown>;
  readSettingsFromDisk: SettingsRuntime['readSettingsFromDisk'];
  reloadRuntimeConfiguration?: () => Promise<void>;
  remoteClientAuthRuntime: NonNullable<Parameters<typeof registerExternalAccessRoutes>[1]['remoteClientAuthRuntime']>;
  resolveGitBinaryForSpawn: FsRouteDependencies['resolveGitBinaryForSpawn'];
  resolveProjectDirectory: ProjectDirectoryRuntime['resolveProjectDirectory'];
  runRuntime?: {
    debug: RunRouteDependencies['debug'];
    tasks: RunRouteDependencies['tasks'];
    tests: RunRouteDependencies['tests'];
  };
  runtimeName: string;
  sanitizeProjects: NormalizationRuntime['sanitizeProjects'];
  scheduledTaskService: ScheduledTaskService;
  scheduledTasksRuntime: ScheduledTasksRuntime;
  serverStartedAt: string;
  spawn: typeof spawnFunction;
  uiAuthController: ExtensionRouteDependencies['uiAuthController'];
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
}

export const createPlatformRoutesRuntime = ({
  clientReloadDelayMs,
}: {
  clientReloadDelayMs: number;
}) => {
  let quotaProviders: typeof import('../quota/index.js') | null = null;
  let smallModelService: typeof import('../small-model/index.js') | null = null;
  let walkthroughService: (
    typeof import('../walkthrough/index.js')
    & { getPullRequestDiff: typeof import('../walkthrough/pull-request.js').getPullRequestDiff }
  ) | null = null;

  const getQuotaProviders = async (): Promise<typeof import('../quota/index.js')> => {
    quotaProviders ??= await import('../quota/index.js');
    return quotaProviders;
  };

  const getSmallModelService = async (): Promise<typeof import('../small-model/index.js')> => {
    smallModelService ??= await import('../small-model/index.js');
    return smallModelService;
  };

  const getWalkthroughService = async (): Promise<NonNullable<typeof walkthroughService>> => {
    if (!walkthroughService) {
      const [service, pullRequest] = await Promise.all([
        import('../walkthrough/index.js'),
        import('../walkthrough/pull-request.js'),
      ]);
      walkthroughService = { ...service, getPullRequestDiff: pullRequest.getPullRequestDiff };
    }
    return walkthroughService;
  };

  const registerRoutes = async (
    app: Express,
    dependencies: PlatformRouteDependencies,
  ): Promise<void> => {
    const {
      crypto,
      os,
      path,
      process,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      piariumDataDir,
      piariumUserConfigRoot,
      piariumVersion,
      runtimeName,
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
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      piRuntimeBroker,
      getPiRuntimeBroker,
      piRuntimeLifecycle,
      pickPiPackageRoot,
      openFilesystemPath,
      getPiariumEventClients,
      writeSseEvent,
      reloadRuntimeConfiguration = async () => {},
      extensionCatalog,
      extensionPackages,
      extensionRuntime,
      uiAuthController,
      documents,
      languageSupervisor,
      runRuntime,
    } = dependencies;

    registerExtensionRoutes(app, {
      extensionCatalog,
      extensionPackages,
      uiAuthController,
      ...(extensionRuntime !== undefined ? { extensionRuntime } : {}),
    });

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      reloadRuntimeConfiguration,
      clientReloadDelayMs,
    });

    registerPiRuntimeHttpRoute(app, {
      piRuntimeBroker,
      ...(typeof getPiRuntimeBroker === 'function' ? { getPiRuntimeBroker } : {}),
    });
    if (piRuntimeLifecycle) {
      registerRuntimeManagerRoutes(app, {
        lifecycle: piRuntimeLifecycle,
        ...(typeof pickPiPackageRoot === 'function' ? { pickPiPackageRoot } : {}),
        ...(typeof openFilesystemPath === 'function' ? { openFilesystemPath } : {}),
      });
    }

    app.get('/api/config/settings', async (_req, res) => {
      try {
        const settings = await readSettingsFromDisk();
        res.json(formatSettingsResponse(settings));
      } catch (error) {
        console.error('Failed to read Piarium settings:', error);
        res.status(500).json({ error: 'Failed to read settings' });
      }
    });

    app.put('/api/config/settings', async (req, res) => {
      try {
        res.json(await persistSettings(req.body ?? {}));
      } catch (error) {
        console.error('Failed to save Piarium settings:', error);
        res.status(500).json({ error: 'Failed to save settings' });
      }
    });

    const smartSearchSpawn: SmartSearchSpawn = (command, args, options) => spawn(command, args, options);
    registerSmartSearchRoutes(app, { fsPromises, path, spawn: smartSearchSpawn, env: process.env });
    registerExternalAccessRoutes(app, {
      fsPromises,
      path,
      os,
      process,
      spawn,
      buildAugmentedPath,
      piariumDataDir,
      piariumVersion,
      runtimeName,
      serverStartedAt,
      remoteClientAuthRuntime,
      resolveProjectDirectory,
      __dirname,
      ...(documents ? { documents } : {}),
    });
    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      piariumDataDir,
      sanitizeProjects,
      readSettingsFromDisk,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });
    registerScheduledTaskRoutes(app, {
      readSettingsFromDisk,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
    });
    registerPiariumEventRoutes(app, { getPiariumEventClients, writeSseEvent });
    registerQuotaRoutes(app, { getQuotaProviders });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerWalkthroughRoutes(app, { getWalkthroughService });
    registerGitHubRoutes(app);
    registerGitRoutes(app, { ...(documents ? { documents } : {}) });
    registerWorkspaceRoutes(app, {
      fsPromises,
      pathModule: path,
      osModule: os,
      env: process.env,
      readSettingsFromDisk,
      persistSettings,
      sanitizeProjects,
      ...(documents ? { documents } : {}),
    });
    registerMagicPromptRoutes(app, { fsPromises, path, piariumDataDir });
    registerSessionFoldersRoutes(app, { fsPromises, path, piariumDataDir });
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      piariumUserConfigRoot,
      ...(documents ? { documents } : {}),
    });
    if (documents) {
      registerDocumentRoutes(app, { documents, uiAuthController });
      registerWorkspaceSearchRoutes(app, {
        documents,
        uiAuthController,
        fsPromises,
        path,
        os,
        spawn,
        resolveGitBinaryForSpawn,
        normalizeDirectoryPath,
        resolveProjectDirectory,
        env: process.env,
      });
    }
    if (languageSupervisor) {
      registerLanguageRoutes(app, { language: languageSupervisor, uiAuthController });
    }
    if (runRuntime) {
      registerRunRoutes(app, {
        tasks: runRuntime.tasks,
        debug: runRuntime.debug,
        tests: runRuntime.tests,
        uiAuthController,
      });
    }
  };

  return { registerRoutes };
};
