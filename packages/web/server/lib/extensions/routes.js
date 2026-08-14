import {
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from '@piarium/extension-host';
import { renderExtensionRecoveryPage } from './recovery-page.js';

const catalogError = (error) => ({
  supported: true,
  status: 'error',
  error: {
    code: error instanceof ExtensionCatalogStorageError ? error.code : 'catalog_read_failed',
    message: error instanceof ExtensionCatalogStorageError
      ? error.message
      : 'Failed to read Piarium extension catalog',
    retryable: error instanceof ExtensionCatalogStorageError ? error.retryable : true,
  },
});

const expectedRevision = (body) => {
  const value = body?.expectedRevision;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const sendMutationError = (res, error) => {
  if (error instanceof ExtensionCatalogRevisionConflictError) {
    return res.status(409).json({
      error: {
        code: 'revision_conflict',
        message: error.message,
        retryable: true,
        actualRevision: error.actualRevision,
        expectedRevision: error.expectedRevision,
      },
    });
  }
  if (error instanceof ExtensionCatalogStorageError) {
    return res.status(500).json({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('not installed') ? 404 : 500;
  if (status === 500) console.error('[Piarium Extensions] Failed to mutate extension catalog:', error);
  return res.status(status).json({
    error: {
      code: status === 404 ? 'extension_not_found' : 'mutation_failed',
      message: status === 404 ? message : 'Failed to update Piarium extension catalog',
      retryable: false,
    },
  });
};

export const registerExtensionRoutes = (app, { extensionCatalog, uiAuthController }) => {
  app.get('/extensions/recovery', uiAuthController.requireSessionAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderExtensionRecoveryPage());
  });

  app.get('/api/piarium/extensions/v1/catalog', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ supported: true, status: 'ready', snapshot: await extensionCatalog.snapshot() });
    } catch (error) {
      console.error('[Piarium Extensions] Failed to read extension catalog:', error);
      res.status(500).json(catalogError(error));
    }
  });

  app.patch(
    '/api/piarium/extensions/v1/extensions/:extensionId/enabled',
    uiAuthController.requireSessionAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null || typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'enabled and expectedRevision are required', retryable: false } });
      }
      try {
        const snapshot = await extensionCatalog.setEnabled(req.params.extensionId, req.body.enabled, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/disable-all',
    uiAuthController.requireSessionAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null) {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'expectedRevision is required', retryable: false } });
      }
      try {
        const snapshot = await extensionCatalog.setAllEnabled(false, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );
};
