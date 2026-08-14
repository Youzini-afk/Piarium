import { registerExternalAccessRoutes } from '../external-access/routes.js';
import { registerExtensionRoutes } from '../extensions/routes.js';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerWalkthroughRoutes } from '../walkthrough/routes.js';
import { registerSmartSearchRoutes } from '../smart-search/routes.js';
import { registerWorkspaceRoutes } from '../workspace/workspace-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerPiRuntimeHttpRoute } from './pi-runtime-http-route.js';

export const createPlatformRoutesRuntime = ({ clientReloadDelayMs }) => {
  let quotaProviders = null;
  let smallModelService = null;
  let walkthroughService = null;

  const getQuotaProviders = async () => {
    quotaProviders ??= await import('../quota/index.js');
    return quotaProviders;
  };

  const getSmallModelService = async () => {
    smallModelService ??= await import('../small-model/index.js');
    return smallModelService;
  };

  const getWalkthroughService = async () => {
    if (!walkthroughService) {
      const [service, pullRequest] = await Promise.all([
        import('../walkthrough/index.js'),
        import('../walkthrough/pull-request.js'),
      ]);
      walkthroughService = { ...service, getPullRequestDiff: pullRequest.getPullRequestDiff };
    }
    return walkthroughService;
  };

  const registerRoutes = async (app, dependencies) => {
    const {
      crypto,
      fs,
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
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      piRuntimeBroker,
      getPiariumEventClients,
      writeSseEvent,
      reloadRuntimeConfiguration = async () => {},
      extensionCatalog,
      uiAuthController,
    } = dependencies;

    registerExtensionRoutes(app, { extensionCatalog, uiAuthController });

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      reloadRuntimeConfiguration,
      clientReloadDelayMs,
    });

    registerPiRuntimeHttpRoute(app, { piRuntimeBroker });

    app.get('/api/config/settings', async (_req, res) => {
      try {
        const settings = await readSettingsFromDiskMigrated();
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

    registerSmartSearchRoutes(app, { fsPromises, path, spawn, env: process.env });
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
    });
    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      piariumDataDir,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });
    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      getPiariumEventClients,
      writeSseEvent,
    });
    registerQuotaRoutes(app, { getQuotaProviders });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerWalkthroughRoutes(app, { getWalkthroughService });
    registerGitHubRoutes(app);
    registerGitRoutes(app);
    registerWorkspaceRoutes(app, {
      fsPromises,
      pathModule: path,
      osModule: os,
      env: process.env,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
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
    });
  };

  return { registerRoutes };
};
