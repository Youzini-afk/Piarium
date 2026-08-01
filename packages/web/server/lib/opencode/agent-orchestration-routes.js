import {
  readAgentOrchestrationConfig as defaultReadAgentOrchestrationConfig,
  setAgentOrchestrationMode as defaultSetAgentOrchestrationMode,
  setAgentOrchestrationProvider as defaultSetAgentOrchestrationProvider,
} from './agent-orchestration-config.js';
import {
  readSlimConfig as defaultReadSlimConfig,
  saveSlimConfig as defaultSaveSlimConfig,
} from './slim-config.js';
import {
  getExpectedAgentNameForLegacyMode,
  getLegacyModeForProviderId,
} from './agent-orchestration-providers.js';

function getRequestedDirectory(req) {
  const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
  const queryDirectory = Array.isArray(req.query?.directory)
    ? req.query.directory[0]
    : req.query?.directory;
  return headerDirectory || queryDirectory || null;
}

async function resolveDirectory(req, resolveOptionalProjectDirectory) {
  const requestedDirectory = getRequestedDirectory(req);
  if (!requestedDirectory) {
    return { directory: null, error: null };
  }
  if (typeof resolveOptionalProjectDirectory === 'function') {
    return resolveOptionalProjectDirectory(req);
  }
  return { directory: requestedDirectory, error: null };
}

export const registerAgentOrchestrationRoutes = (app, dependencies = {}) => {
  const {
    clientReloadDelayMs = 800,
    readAgentOrchestrationConfig = defaultReadAgentOrchestrationConfig,
    setAgentOrchestrationMode = defaultSetAgentOrchestrationMode,
    setAgentOrchestrationProvider = defaultSetAgentOrchestrationProvider,
    readSlimConfig = defaultReadSlimConfig,
    saveSlimConfig = defaultSaveSlimConfig,
    refreshOpenCodeAfterConfigChange,
    resolveOptionalProjectDirectory,
  } = dependencies;

  app.get('/api/agent-orchestration/config', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) return res.status(400).json({ error });
      return res.json(readAgentOrchestrationConfig({ directory }));
    } catch (error) {
      console.error('Failed to read agent orchestration config:', error);
      return res.status(500).json({ error: error.message || 'Failed to read agent orchestration config' });
    }
  });

  app.patch('/api/agent-orchestration/mode', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) return res.status(400).json({ error });
      const body = req.body ?? {};
      const config = setAgentOrchestrationMode({
        directory,
        mode: body.mode,
        expectedMtimeMsByPath: body.expectedMtimeMsByPath ?? {},
      });

      if (typeof refreshOpenCodeAfterConfigChange === 'function') {
        await refreshOpenCodeAfterConfigChange('agent orchestration mode updated', {
          agentName: getExpectedAgentNameForLegacyMode(body.mode),
        });
      }

      return res.json({
        success: true,
        requiresReload: true,
        message: 'Agent orchestration mode updated. Refreshing interface...',
        reloadDelayMs: clientReloadDelayMs,
        config,
      });
    } catch (error) {
      const status = error?.code === 'CONFIG_MODIFIED' ? 409 : 400;
      if (status !== 409) {
        console.error('Failed to update agent orchestration mode:', error);
      }
      return res.status(status).json({ error: error.message || 'Failed to update agent orchestration mode' });
    }
  });

  app.patch('/api/agent-orchestration/provider', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) return res.status(400).json({ error });
      const body = req.body ?? {};
      const config = setAgentOrchestrationProvider({
        directory,
        providerId: body.providerId,
        expectedMtimeMsByPath: body.expectedMtimeMsByPath ?? {},
      });

      if (typeof refreshOpenCodeAfterConfigChange === 'function') {
        const mode = body.providerId == null || body.providerId === '' || body.providerId === 'native'
          ? 'native'
          : getLegacyModeForProviderId(body.providerId);
        const expectedAgentName = config.providers?.find?.((provider) => provider.id === body.providerId)?.expectedAgentName
          ?? getExpectedAgentNameForLegacyMode(mode);
        await refreshOpenCodeAfterConfigChange('agent orchestration provider updated', {
          agentName: expectedAgentName,
        });
      }

      return res.json({
        success: true,
        requiresReload: true,
        message: 'Agent orchestration provider updated. Refreshing interface...',
        reloadDelayMs: clientReloadDelayMs,
        config,
      });
    } catch (error) {
      const status = error?.code === 'CONFIG_MODIFIED' ? 409 : 400;
      if (status !== 409 && error?.code !== 'INVALID_PROVIDER') {
        console.error('Failed to update agent orchestration provider:', error);
      }
      return res.status(status).json({ error: error.message || 'Failed to update agent orchestration provider' });
    }
  });

  app.get('/api/agent-orchestration/slim/config', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) return res.status(400).json({ error });
      return res.json(readSlimConfig({ directory }));
    } catch (error) {
      console.error('Failed to read Slim config:', error);
      return res.status(500).json({ error: error.message || 'Failed to read Slim config' });
    }
  });

  app.patch('/api/agent-orchestration/slim/config', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) return res.status(400).json({ error });

      const body = req.body ?? {};
      saveSlimConfig({
        expectedMtimeMs: body.expectedMtimeMs ?? null,
        config: body.config ?? {},
      });

      if (typeof refreshOpenCodeAfterConfigChange === 'function') {
        await refreshOpenCodeAfterConfigChange('oh-my-opencode-slim config updated');
      }

      return res.json({
        success: true,
        requiresReload: true,
        message: 'Oh My OpenCode Slim configuration saved. Refreshing interface...',
        reloadDelayMs: clientReloadDelayMs,
        config: readSlimConfig({ directory }),
      });
    } catch (error) {
      const status = error?.code === 'CONFIG_MODIFIED' ? 409 : 400;
      if (status !== 409) {
        console.error('Failed to save Slim config:', error);
      }
      return res.status(status).json({ error: error.message || 'Failed to save Slim config' });
    }
  });
};
