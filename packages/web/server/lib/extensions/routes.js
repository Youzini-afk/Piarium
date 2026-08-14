import {
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from '@piarium/extension-host';
import {
  parsePiariumExtensionActualState,
  parsePiariumExtensionCandidateCapabilityReviewRequest,
  parsePiariumExtensionHostStateWaitRequest,
  parsePiariumExtensionPackageSource,
} from '@piarium/extension-contract';
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

export const registerExtensionRoutes = (app, {
  extensionCatalog,
  extensionPackages,
  extensionRuntime,
  uiAuthController,
}) => {
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

  app.get('/api/piarium/extensions/v1/host-state', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime.state());
    } catch (error) {
      return res.status(500).json(catalogError(error));
    }
  });

  app.post(
    '/api/piarium/extensions/v1/host-state/wait',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('Extension host-state client disconnected')); };
      res.once('close', abort);
      try {
        return res.json(await extensionRuntime.waitForState(parsePiariumExtensionHostStateWaitRequest(req.body), controller.signal));
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        return res.status(400).json({ error: { code: 'host_state_wait_failed', message: error instanceof Error ? error.message : String(error), retryable: true } });
      } finally {
        res.off('close', abort);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/extensions/:extensionId/activate',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        await extensionRuntime.activateExtension(req.params.extensionId);
        return res.status(204).end();
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/assets/read',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        return res.json(await extensionPackages.readAsset(req.body));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('not installed') || message.includes('does not contain') ? 404 : 400;
        return res.status(status).json({ error: { code: 'asset_unavailable', message, retryable: false } });
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/entrypoints/read',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        return res.json(await extensionPackages.readManagedEntrypoint(req.body));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('not installed') || message.includes('not present') ? 404 : 400;
        return res.status(status).json({ error: { code: 'entrypoint_unavailable', message, retryable: false } });
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/candidates/prepare',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const integrity = typeof req.body?.candidateIntegrity === 'string' ? req.body.candidateIntegrity : '';
        if (!extensionId || !integrity) throw new Error('extensionId and candidateIntegrity are required');
        return res.json(await extensionRuntime.prepareCandidate(extensionId, integrity));
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/candidates/discard-prepared',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const integrity = typeof req.body?.candidateIntegrity === 'string' ? req.body.candidateIntegrity : '';
        if (!extensionId || !integrity) throw new Error('extensionId and candidateIntegrity are required');
        await extensionRuntime.discardPreparedCandidate(extensionId, integrity);
        return res.status(204).end();
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/candidates/review-capabilities',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parsePiariumExtensionCandidateCapabilityReviewRequest(req.body);
        return res.json({ snapshot: await (extensionRuntime
          ? extensionRuntime.reviewCandidateCapabilities(request)
          : extensionCatalog.reviewCandidateCapabilities(request)) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/candidates/select',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        return res.json({ snapshot: await (extensionRuntime
          ? extensionRuntime.selectCandidate(req.body)
          : extensionPackages.selectCandidate(req.body)) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/actual',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId : '';
        const state = parsePiariumExtensionActualState(req.body?.state);
        await (extensionRuntime
          ? extensionRuntime.reportActualState(extensionId, state)
          : extensionPackages.reportActualState(extensionId, state));
        return res.status(204).end();
      } catch (error) {
        return res.status(409).json({
          error: {
            code: 'actual_state_rejected',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        });
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/install',
    uiAuthController.requireAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null) {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'expectedRevision is required', retryable: false } });
      }
      try {
        const source = parsePiariumExtensionPackageSource(req.body?.source);
        const snapshot = extensionRuntime
          ? await extensionRuntime.installOrStage({ expectedRevision: revision, source }, req.signal)
          : await extensionPackages.installOrStage(source, revision, req.signal);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/services/invoke',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('Host service client disconnected')); };
      res.once('close', abort);
      try {
        return res.json({ result: await extensionRuntime.invokeService(req.body, controller.signal) });
      } catch (error) {
        return res.status(400).json({
          error: {
            code: 'service_invocation_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        });
      } finally {
        res.off('close', abort);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/services/select',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json(await extensionRuntime.setServiceSelection(req.body));
      } catch (error) {
        return res.status(400).json({ error: { code: 'service_selection_failed', message: error instanceof Error ? error.message : String(error), retryable: false } });
      }
    },
  );

  app.patch(
    '/api/piarium/extensions/v1/extensions/:extensionId/enabled',
    uiAuthController.requireAuth,
    async (req, res) => {
      const revision = expectedRevision(req.body);
      if (revision === null || typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: { code: 'invalid_request', message: 'enabled and expectedRevision are required', retryable: false } });
      }
      try {
        const snapshot = extensionRuntime
          ? await extensionRuntime.setEnabled(req.params.extensionId, req.body.enabled, revision)
          : await extensionCatalog.setEnabled(req.params.extensionId, req.body.enabled, revision);
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
        const snapshot = extensionRuntime
          ? await extensionRuntime.setAllEnabled(false, revision)
          : await extensionCatalog.setAllEnabled(false, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );
};
