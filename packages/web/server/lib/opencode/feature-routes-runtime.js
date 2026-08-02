import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerWorkspaceRoutes } from '../workspace/workspace-routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerExternalAccessRoutes } from '../external-access/routes.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { getNpmInfo, clearCache as clearNpmCache } from './npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerOpenAgentRoutes } from './openagent-routes.js';
import { registerAgentOrchestrationRoutes } from './agent-orchestration-routes.js';
import { registerMagicContextRoutes } from './magic-context-routes.js';
import { registerSmartSearchRoutes } from '../smart-search/routes.js';
import { getProviderSources, getProviderConfig, upsertProviderConfig, removeProviderConfig, fetchProviderModels } from './providers.js';
import { getAgentSources, getAgentConfig, createAgent, updateAgent, deleteAgent } from './agents.js';
import { getCommandSources, createCommand, updateCommand, deleteCommand } from './commands.js';
import { listMcpConfigs, getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } from './mcp.js';
import { listSnippets, getSnippet, createSnippet, updateSnippet, deleteSnippet, expandSnippets } from './snippets.js';
import {
  listPluginEntries,
  getPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId,
} from './plugins.js';
import { SKILL_DIR, SKILL_SCOPE, readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile } from './shared.js';
import { getSkillSources, discoverSkills, mergeDiscoveredSkills, createSkill, updateSkill, deleteSkill } from './skills.js';
import { getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import { getCacheKey, getCachedScan, setCachedScan } from '../skills-catalog/cache.js';
import { isClawdHubSource, parseSkillRepoSource } from '../skills-catalog/source.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { scanClawdHubPage } from '../skills-catalog/clawdhub/scan.js';
import { installSkillsFromClawdHub } from '../skills-catalog/clawdhub/install.js';
import { readOpenAgentConfig, saveOpenAgentConfig, setOpenAgentPluginEnabled } from './openagent-config.js';
import { readAgentOrchestrationConfig, setAgentOrchestrationMode } from './agent-orchestration-config.js';
import { readSlimConfig, saveSlimConfig } from './slim-config.js';
import { readMagicContextConfig, saveMagicContextConfig } from './magic-context-config.js';

export const createFeatureRoutesRuntime = (dependencies) => {
  const {
    clientReloadDelayMs,
  } = dependencies;

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  let smallModelService = null;
  const getSmallModelService = async () => {
    if (!smallModelService) {
      smallModelService = await import('../small-model/index.js');
    }
    return smallModelService;
  };

  const registerRoutes = async (app, routeDependencies) => {
    const {
      crypto,
      fs,
      os,
      path,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      openchamberDataDir,
      openchamberUserConfigRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      getOpenCodeResolutionSnapshot,
      getOpenCodeUpgradeCapability,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      autoReplyPendingPermissionsForServerSetting,
      buildAugmentedPath,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      remoteClientAuthRuntime,
      projectConfigRuntime,
      scheduledTasksRuntime,
      scheduledTaskService,
      openChamberSessionService,
      openChamberControlService,
      waitForOpenCodeReady,
      getOpenChamberEventClients,
      writeSseEvent,
      __dirname,
      emitSessionCreatedEvent,
    } = routeDependencies;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
    });

    registerOpenCodeRoutes(app, {
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      getOpenCodeUpgradeCapability,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      validateDirectoryPath,
      resolveProjectDirectory,
      getProviderSources,
      getProviderConfig,
      upsertProviderConfig,
      removeProviderConfig,
      fetchProviderModels,
      refreshOpenCodeAfterConfigChange,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      autoReplyPendingPermissionsForServerSetting,
    });

    registerOpenAgentRoutes(app, {
      clientReloadDelayMs,
      readOpenAgentConfig,
      saveOpenAgentConfig,
      setOpenAgentPluginEnabled,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory,
    });

    registerAgentOrchestrationRoutes(app, {
      clientReloadDelayMs,
      readAgentOrchestrationConfig,
      setAgentOrchestrationMode,
      readSlimConfig,
      saveSlimConfig,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory,
    });

    registerMagicContextRoutes(app, {
      clientReloadDelayMs,
      readMagicContextConfig,
      saveMagicContextConfig,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory,
    });

    registerSmartSearchRoutes(app, {
      fsPromises,
      path,
      spawn,
      env: process.env,
    });

    registerExternalAccessRoutes(app, {
      fsPromises,
      path,
      os,
      process,
      spawn,
      buildAugmentedPath,
      openchamberDataDir,
      openchamberVersion,
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
      openchamberDataDir,
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
      getOpenChamberEventClients,
      writeSseEvent,
    });

    registerOpenChamberSessionRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      waitForOpenCodeReady,
      emitSessionCreatedEvent,
      sessionService: openChamberSessionService,
    });

    registerOpenChamberControlRoutes(app, { controlService: openChamberControlService });

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      getAgentSources,
      getAgentConfig,
      createAgent,
      updateAgent,
      deleteAgent,
      getCommandSources,
      createCommand,
      updateCommand,
      deleteCommand,
      listMcpConfigs,
      getMcpConfig,
      createMcpConfig,
      updateMcpConfig,
      deleteMcpConfig,
      listSnippets,
      getSnippet,
      createSnippet,
      updateSnippet,
      deleteSnippet,
      expandSnippets,
    });

    registerPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      listPluginEntries,
      getPluginEntry,
      createPluginEntry,
      updatePluginEntry,
      deletePluginEntry,
      listPluginDirFiles,
      readPluginDirFile,
      writePluginDirFile,
      deletePluginDirFile,
      encodePluginId,
      decodePluginId,
      getNpmInfo,
      parseNpmSpec,
      parsePathSpec,
      isExactSemver,
    });

    const { getProfiles, getProfile } = await import('../git/index.js');

    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      readSettingsFromDisk,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      getSkillSources,
      discoverSkills,
      mergeDiscoveredSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile,
      SKILL_SCOPE,
      SKILL_DIR,
      getCuratedSkillsSources,
      getCacheKey,
      getCachedScan,
      setCachedScan,
      parseSkillRepoSource,
      scanSkillsRepository,
      installSkillsFromRepository,
      scanClawdHubPage,
      installSkillsFromClawdHub,
      isClawdHubSource,
      getProfiles,
      getProfile,
    });

    registerQuotaRoutes(app, { getQuotaProviders });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerSessionGoalRoutes(app);
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
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
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
      openchamberUserConfigRoot,
    });
  };

  return {
    registerRoutes,
  };
};
