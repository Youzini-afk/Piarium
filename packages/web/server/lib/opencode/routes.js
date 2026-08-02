import { createProjectIdFromPath } from '../projects/project-id.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROVIDER_OPTIONS = Object.freeze([
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'groq', name: 'Groq' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'xai', name: 'xAI' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'cohere', name: 'Cohere' },
  { id: 'together', name: 'Together AI' },
  { id: 'perplexity', name: 'Perplexity' },
  { id: 'fireworks', name: 'Fireworks' },
  { id: 'huggingface', name: 'Hugging Face' },
  { id: 'azure', name: 'Azure OpenAI' },
  { id: 'amazon-bedrock', name: 'Amazon Bedrock' },
  { id: 'cloudflare', name: 'Cloudflare Workers AI' },
]);

const API_KEY_AUTH_METHOD = Object.freeze({
  type: 'api',
  name: 'api',
  label: 'API key',
});

const OAUTH_AUTH_METHOD = Object.freeze({
  type: 'oauth',
  name: 'oauth',
  label: 'OAuth',
});

const PROVIDER_AUTH_METHODS = Object.freeze(
  Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [
    provider.id,
    provider.id === 'github-copilot'
      ? [OAUTH_AUTH_METHOD, API_KEY_AUTH_METHOD]
      : [API_KEY_AUTH_METHOD],
  ])),
);

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
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
  } = dependencies;

  let authLibrary = null;
  const pendingMcpAuthContextByState = new Map();
  const PENDING_MCP_AUTH_TTL_MS = 30 * 60 * 1000;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const normalizePendingString = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
  };

  const readProviderAuthKey = (body) => (
    normalizePendingString(body?.key) ||
    normalizePendingString(body?.apiKey) ||
    normalizePendingString(body?.token)
  );

  const fetchLatestOpenCodeVersion = async () => {
    try {
      const { getNpmInfo } = await import('./npm-registry.js');
      const result = await getNpmInfo('opencode-ai');
      return result.ok ? result.latest : null;
    } catch {
      return null;
    }
  };
  const readOpenCodeCurrentVersion = async () => {
    const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    });
    const health = await healthResponse.json().catch(() => null);
    if (!healthResponse.ok) {
      return { ok: false, status: healthResponse.status, error: health?.error || healthResponse.statusText };
    }
    const currentVersion = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
    return { ok: true, currentVersion };
  };

  const parseVersionForComparison = (value) => {
    const normalized = String(value || '').replace(/^v/, '').split('+')[0];
    const prereleaseIndex = normalized.indexOf('-');
    const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });

    return { parts, prerelease: prereleaseIndex >= 0 };
  };

  const compareVersions = (left, right) => {
    const a = parseVersionForComparison(left);
    const b = parseVersionForComparison(right);
    const length = Math.max(a.parts.length, b.parts.length);

    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff !== 0) return diff;
    }

    if (a.prerelease !== b.prerelease) {
      return a.prerelease ? -1 : 1;
    }

    return 0;
  };

  const pruneExpiredPendingMcpAuthContexts = () => {
    const now = Date.now();
    for (const [state, entry] of pendingMcpAuthContextByState.entries()) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
        pendingMcpAuthContextByState.delete(state);
      }
    }
  };

  app.get('/api/config/settings', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  let openCodeUpgradePromise = null;

  app.post('/api/opencode/upgrade', async (req, res) => {
    if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') {
      return res.status(503).json({ success: false, error: 'OpenCode upgrade is unavailable' });
    }

    try {
      const capability = getOpenCodeUpgradeCapability();
      if (!capability.supported) {
        return res.status(409).json({
          success: false,
          code: capability.reason === 'bundled'
            ? 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER'
            : 'OPENCODE_UPGRADE_UNSUPPORTED',
          error: capability.reason === 'bundled'
            ? 'OpenCode is bundled with Piarium Desktop and updates with the app.'
            : 'This OpenCode runtime cannot be upgraded by OpenChamber.',
        });
      }
      if (openCodeUpgradePromise) {
        return res.status(409).json({
          success: false,
          code: 'OPENCODE_UPGRADE_IN_PROGRESS',
          error: 'An OpenCode upgrade is already in progress.',
        });
      }

      const target = typeof req.body?.target === 'string' && req.body.target.trim().length > 0
        ? req.body.target.trim()
        : undefined;
      const upgradeOperation = (async () => {
        const response = await fetch(buildOpenCodeUrl('/global/upgrade', ''), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          body: JSON.stringify(target ? { target } : {}),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          return {
            status: response.status,
            body: {
              success: false,
              error: payload?.error || response.statusText || 'Failed to upgrade OpenCode',
            },
          };
        }

        try {
          await refreshOpenCodeAfterConfigChange('OpenCode upgrade');
        } catch (restartError) {
          return {
            status: 500,
            body: {
              success: false,
              upgraded: true,
              error: restartError instanceof Error
                ? `OpenCode upgraded, but restart failed: ${restartError.message}`
                : 'OpenCode upgraded, but restart failed',
            },
          };
        }

        return {
          status: 200,
          body: { ...(payload ?? { success: true }), restarted: true },
        };
      })();
      openCodeUpgradePromise = upgradeOperation;

      try {
        const result = await upgradeOperation;
        return res.status(result.status).json(result.body);
      } finally {
        if (openCodeUpgradePromise === upgradeOperation) {
          openCodeUpgradePromise = null;
        }
      }
    } catch (error) {
      console.error('Failed to upgrade OpenCode:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upgrade OpenCode',
      });
    }
  });

  app.get('/api/opencode/upgrade-status', async (_req, res) => {
    if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') {
      return res.status(503).json({ available: null, error: 'OpenCode upgrade status is unavailable' });
    }

    try {
      const capability = getOpenCodeUpgradeCapability();
      if (!capability.supported) {
        const current = await readOpenCodeCurrentVersion().catch(() => ({ ok: false, currentVersion: null }));
        return res.json({
          available: false,
          currentVersion: current.ok ? current.currentVersion : null,
          latestVersion: null,
          upgrade: capability,
        });
      }

      const [healthResponse, latestVersion] = await Promise.all([
        fetch(buildOpenCodeUrl('/global/health', ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        }),
        fetchLatestOpenCodeVersion(),
      ]);
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          available: null,
          error: health?.error || healthResponse.statusText || 'Failed to read OpenCode version',
        });
      }
      const currentVersion = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
      if (!currentVersion || !latestVersion) {
        return res.json({ available: null, currentVersion, latestVersion: latestVersion || null });
      }
      const available = compareVersions(latestVersion, currentVersion) > 0;
      return res.json({
        available,
        currentVersion,
        latestVersion,
        upgrade: capability,
      });
    } catch (error) {
      return res.status(500).json({
        available: null,
        error: error instanceof Error ? error.message : 'Failed to check OpenCode upgrade status',
      });
    }
  });

  app.get('/api/opencode/health', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          healthy: false,
          error: health?.error || healthResponse.statusText || 'OpenCode health check failed',
        });
      }
      return res.json({ healthy: health?.healthy === true });
    } catch (error) {
      return res.status(503).json({
        healthy: false,
        error: error instanceof Error ? error.message : 'OpenCode health check failed',
      });
    }
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          version: null,
          error: health?.error || healthResponse.statusText || 'Failed to read OpenCode version',
        });
      }
      const version = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
      return res.json({ version });
    } catch (error) {
      return res.status(500).json({
        version: null,
        error: error instanceof Error ? error.message : 'Failed to read OpenCode version',
      });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const updated = await persistSettings(req.body ?? {});
      if (req.body?.serverPermissionAutoAcceptEnabled === true && typeof autoReplyPendingPermissionsForServerSetting === 'function') {
        const scanDirectories = Array.from(new Set([
          ...(Array.isArray(updated?.projects)
            ? updated.projects
                .map((project) => (typeof project?.path === 'string' ? project.path.trim() : ''))
                .filter(Boolean)
            : []),
          typeof updated?.lastDirectory === 'string' ? updated.lastDirectory.trim() : '',
          typeof updated?.homeDirectory === 'string' ? updated.homeDirectory.trim() : '',
        ].filter(Boolean)));
        void autoReplyPendingPermissionsForServerSetting(scanDirectories).catch((error) => {
          console.warn('[API:PUT /api/config/settings] Server permission auto-accept scan failed:', error?.message ?? error);
        });
      }
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.get('/api/provider', (_req, res) => {
    return res.json({
      providers: PROVIDER_OPTIONS,
      all: PROVIDER_OPTIONS,
    });
  });

  app.get('/api/provider/auth', (_req, res) => {
    return res.json(PROVIDER_AUTH_METHODS);
  });

  app.put('/api/auth/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const key = readProviderAuthKey(req.body);
      if (!key) {
        return res.status(400).json({ error: 'API key is required' });
      }

      const type = normalizePendingString(req.body?.type) || 'api';
      const { saveProviderAuth } = await getAuthLibrary();
      saveProviderAuth(providerId, { type, key });
      await refreshOpenCodeAfterConfigChange(`provider ${providerId} auth saved`);

      return res.json({
        success: true,
        providerId,
        requiresReload: true,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to save provider auth:', error);
      return res.status(500).json({ error: error.message || 'Failed to save provider auth' });
    }
  });

  app.post('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(req.body?.state);
      if (!state) {
        return res.json({ success: true, context: null });
      }

      const name = normalizePendingString(req.body?.name);
      if (!name) {
        return res.status(400).json({ error: 'MCP server name is required' });
      }

      const entry = {
        name,
        directory: normalizePendingString(req.body?.directory),
        expiresAt: Date.now() + PENDING_MCP_AUTH_TTL_MS,
      };
      pendingMcpAuthContextByState.set(state, entry);

      return res.json({
        success: true,
        context: {
          name: entry.name,
          directory: entry.directory,
        },
      });
    } catch (error) {
      console.error('Failed to store pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to store pending MCP auth context' });
    }
  });

  app.get('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json(null);
      }

      const pendingMcpAuthContext = pendingMcpAuthContextByState.get(state) ?? null;
      if (!pendingMcpAuthContext) {
        return res.status(404).json({ error: 'No pending MCP auth context' });
      }

      return res.json(pendingMcpAuthContext);
    } catch (error) {
      console.error('Failed to read pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to read pending MCP auth context' });
    }
  });

  app.delete('/api/mcp/auth/pending', async (req, res) => {
    try {
      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json({ success: true });
      }

      pendingMcpAuthContextByState.delete(state);
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to clear pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear pending MCP auth context' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = Boolean(auth);

      return res.json({
        providerId,
        sources: sources.sources,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.get('/api/provider/:providerId/config', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const config = getProviderConfig(providerId, directory);
      if (!config) {
        return res.status(404).json({ error: 'Provider configuration not found' });
      }

      return res.json({
        providerId,
        config,
      });
    } catch (error) {
      console.error('Failed to get provider config:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider config' });
    }
  });

  app.post('/api/provider/custom', async (req, res) => {
    try {
      const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'user';
      const requestedProjectScope = scope === 'project';
      const requestedCustomScope = scope === 'custom';
      let directory = null;

      if (requestedProjectScope) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error || 'Working directory is required for project scope' });
        }
        directory = resolved.directory;
      }

      const resolvedScope = requestedCustomScope ? 'custom' : requestedProjectScope ? 'project' : 'user';
      const result = upsertProviderConfig(req.body ?? {}, directory, resolvedScope);

      const apiKey = readProviderAuthKey(req.body);
      if (apiKey) {
        const { saveProviderAuth } = await getAuthLibrary();
        saveProviderAuth(result.providerId, { type: 'api', key: apiKey });
      }

      await refreshOpenCodeAfterConfigChange(`custom provider ${result.providerId} saved (${result.scope})`);

      return res.json({
        success: true,
        providerId: result.providerId,
        scope: result.scope,
        path: result.path,
        requiresReload: true,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to save custom provider:', error);
      return res.status(400).json({ error: error.message || 'Failed to save custom provider' });
    }
  });

  app.post('/api/provider/custom/models', async (req, res) => {
    try {
      if (typeof fetchProviderModels !== 'function') {
        return res.status(500).json({ error: 'Provider model discovery is not available' });
      }

      const result = await fetchProviderModels(req.body ?? {});

      return res.json({
        success: true,
        type: result.type,
        baseURL: result.baseURL,
        models: result.models,
      });
    } catch (error) {
      console.error('Failed to fetch custom provider models:', error);
      return res.status(400).json({ error: error.message || 'Failed to fetch custom provider models' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        const { removeProviderAuth } = await getAuthLibrary();
        removed = removeProviderAuth(providerId);
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const { removeProviderAuth } = await getAuthLibrary();
        const authRemoved = removeProviderAuth(providerId);
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = authRemoved || userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        await refreshOpenCodeAfterConfigChange(`provider ${providerId} disconnected (${scope})`);
      }

      return res.json({
        success: true,
        removed,
        requiresReload: removed,
        message: removed ? 'Provider disconnected successfully' : 'Provider was not connected',
        reloadDelayMs: removed ? clientReloadDelayMs : undefined,
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        await fs.promises.access(AGENTS_MD_PATH);
      } catch {
        return res.json({ content: '', exists: false });
      }
      const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
      return res.json({ content, exists: true });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      // Refresh OpenCode so it picks up the new AGENTS.md without a full restart
      try {
        await refreshOpenCodeAfterConfigChange('global behavior (AGENTS.md) updated');
      } catch {
        // Non-fatal: file was written successfully
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
