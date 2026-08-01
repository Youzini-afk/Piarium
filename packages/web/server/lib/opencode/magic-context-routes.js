import {
  readMagicContextConfig as defaultReadMagicContextConfig,
  saveMagicContextConfig as defaultSaveMagicContextConfig,
} from './magic-context-config.js';

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

export const registerMagicContextRoutes = (app, dependencies = {}) => {
  const {
    clientReloadDelayMs = 800,
    readMagicContextConfig = defaultReadMagicContextConfig,
    saveMagicContextConfig = defaultSaveMagicContextConfig,
    refreshOpenCodeAfterConfigChange,
    resolveOptionalProjectDirectory,
  } = dependencies;

  app.get('/api/magic-context/config', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) {
        return res.status(400).json({ error });
      }

      return res.json(readMagicContextConfig({ directory }));
    } catch (error) {
      console.error('Failed to read magic-context config:', error);
      return res.status(500).json({ error: error.message || 'Failed to read magic-context config' });
    }
  });

  app.patch('/api/magic-context/config', async (req, res) => {
    try {
      const { directory, error } = await resolveDirectory(req, resolveOptionalProjectDirectory);
      if (error) {
        return res.status(400).json({ error });
      }

      const body = req.body ?? {};
      saveMagicContextConfig({
        expectedMtimeMs: body.expectedMtimeMs ?? null,
        sourcePath: body.sourcePath ?? null,
        sourceMtimeMs: body.sourceMtimeMs ?? null,
        directory,
        config: body.config ?? {},
      });

      if (typeof refreshOpenCodeAfterConfigChange === 'function') {
        await refreshOpenCodeAfterConfigChange('magic-context config updated');
      }

      return res.json({
        success: true,
        requiresReload: true,
        message: 'Magic Context configuration saved. Refreshing interface...',
        reloadDelayMs: clientReloadDelayMs,
        config: readMagicContextConfig({ directory }),
      });
    } catch (error) {
      const status = error?.code === 'CONFIG_MODIFIED' ? 409 : 400;
      if (status !== 409) {
        console.error('Failed to save magic-context config:', error);
      }
      return res.status(status).json({ error: error.message || 'Failed to save magic-context config' });
    }
  });
};
