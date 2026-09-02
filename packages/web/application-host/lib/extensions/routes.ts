import {
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
  ExtensionStorageRevisionConflictError,
  ExtensionStorageError,
} from '@piarium/extension-host';
import type {
  ApplicationExtensionCatalog,
  ApplicationExtensionRuntime,
  ExtensionPackageManager,
} from '@piarium/extension-host';
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  PiariumExtensionContractError,
  parsePiariumExtensionActualState,
  parsePiariumExtensionCandidateCapabilityReviewRequest,
  parsePiariumExtensionCapabilityReviewRequest,
  parsePiariumExtensionHostStateWaitRequest,
  parsePiariumExtensionLocalSourceReloadRequest,
  parsePiariumExtensionPackageSource,
  parsePiariumExtensionRemoveRequest,
} from '@piarium/extension-contract';
import { renderExtensionRecoveryPage } from './recovery-page.js';

interface ExtensionRouteDependencies {
  extensionCatalog: ApplicationExtensionCatalog;
  extensionPackages: ExtensionPackageManager;
  extensionRuntime?: ApplicationExtensionRuntime | null;
  uiAuthController: {
    requireAuth: RequestHandler;
    requireSessionAuth: RequestHandler;
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const catalogError = (error: unknown) => ({
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

const expectedRevision = (body: unknown): number | null => {
  const value = asRecord(body)?.expectedRevision;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const routeParam = (value: string | string[] | undefined): string => (
  typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : ''
);

const withRequestSignal = async <Result>(
  req: Request,
  res: Response,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error('Extension request disconnected'));
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    return await operation(controller.signal);
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
};

const sendMutationError = (res: Response, error: unknown) => {
  if (error instanceof ExtensionCatalogRevisionConflictError || error instanceof ExtensionStorageRevisionConflictError) {
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
  if (error instanceof ExtensionStorageError) {
    return res.status(500).json({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  }
  if (error instanceof PiariumExtensionContractError) {
    return res.status(400).json({
      error: { code: 'invalid_request', details: error.issues, message: error.message, retryable: false },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const notLocalSource = message.includes('not installed from a local source');
  const localDependenciesMissing = message.includes('Local Piarium extension dependencies are not installed');
  const notInstalled = !notLocalSource && message.includes('not installed');
  const managedByDistribution = message.includes('managed by the distribution');
  const mustDisable = message.includes('before removing it');
  const capabilityReviewRequired = message.includes('capabilities require review before activation');
  const status = notInstalled
    ? 404
    : managedByDistribution || mustDisable || capabilityReviewRequired || notLocalSource || localDependenciesMissing
      ? 409
      : 500;
  let code = 'mutation_failed';
  if (notInstalled) code = 'extension_not_found';
  else if (managedByDistribution) code = 'extension_managed_by_distribution';
  else if (mustDisable) code = 'extension_must_be_disabled';
  else if (capabilityReviewRequired) code = 'extension_capability_review_required';
  else if (notLocalSource) code = 'extension_not_local_source';
  else if (localDependenciesMissing) code = 'extension_local_dependencies_missing';
  if (status === 500) console.error('[Piarium Extensions] Failed to mutate extension catalog:', error);
  return res.status(status).json({
    error: {
      code,
      message: notInstalled || managedByDistribution || mustDisable || capabilityReviewRequired || notLocalSource || localDependenciesMissing
        ? message
        : 'Failed to update Piarium extension catalog',
      retryable: false,
    },
  });
};

export const registerExtensionRoutes = (app: Express, {
  extensionCatalog,
  extensionPackages,
  extensionRuntime,
  uiAuthController,
}: ExtensionRouteDependencies): void => {
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
        await extensionRuntime.activateExtension(routeParam(req.params.extensionId));
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
    '/api/piarium/extensions/v1/candidates/discard',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.discardCandidate(req.body) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/review-capabilities',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parsePiariumExtensionCapabilityReviewRequest(req.body);
        return res.json({ snapshot: await (extensionRuntime
          ? extensionRuntime.reviewCapabilities(request)
          : extensionCatalog.reviewCapabilities(request)) });
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
    '/api/piarium/extensions/v1/candidates/request-application',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.requestCandidateApplication(req.body) });
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
        const snapshot = await withRequestSignal(req, res, (signal) => extensionRuntime
          ? extensionRuntime.installOrStage({ expectedRevision: revision, source }, signal)
          : extensionPackages.installOrStage(source, revision, signal));
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.post(
    '/api/piarium/extensions/v1/extensions/:extensionId/reload-local-source',
    uiAuthController.requireAuth,
    async (req, res) => {
      try {
        const request = parsePiariumExtensionLocalSourceReloadRequest({
          ...req.body,
          extensionId: routeParam(req.params.extensionId),
        });
        const result = await withRequestSignal(req, res, (signal) => extensionRuntime
          ? extensionRuntime.reloadLocalSource(request, signal)
          : extensionPackages.reloadLocalSource(request, signal));
        return res.json(result);
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

  const serviceRoutingMutation = (
    method: 'removeServiceRoutingRule' | 'upsertServiceRoutingRule',
  ): RequestHandler => async (req, res) => {
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime[method](req.body));
    } catch (error) {
      return sendMutationError(res, error);
    }
  };

  app.put(
    '/api/piarium/extensions/v1/services/routing',
    uiAuthController.requireAuth,
    serviceRoutingMutation('upsertServiceRoutingRule'),
  );

  app.post(
    '/api/piarium/extensions/v1/services/routing/remove',
    uiAuthController.requireAuth,
    serviceRoutingMutation('removeServiceRoutingRule'),
  );

  const workbenchMutation = (
    method: 'removeWorkbenchProfile' | 'selectWorkbenchProfile' | 'updateWorkbenchLayout' | 'upsertWorkbenchProfile',
  ): RequestHandler => async (req, res) => {
    if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
    try {
      return res.json(await extensionRuntime[method](req.body));
    } catch (error) {
      return sendMutationError(res, error);
    }
  };

  app.patch(
    '/api/piarium/extensions/v1/workbench/layout',
    uiAuthController.requireAuth,
    workbenchMutation('updateWorkbenchLayout'),
  );

  app.patch(
    '/api/piarium/extensions/v1/workbench/profile/select',
    uiAuthController.requireAuth,
    workbenchMutation('selectWorkbenchProfile'),
  );

  app.post(
    '/api/piarium/extensions/v1/workbench/profiles/apply',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        return res.json({ snapshot: await extensionRuntime.applyWorkbenchProfile(req.body) });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.put(
    '/api/piarium/extensions/v1/workbench/profiles',
    uiAuthController.requireAuth,
    workbenchMutation('upsertWorkbenchProfile'),
  );

  app.post(
    '/api/piarium/extensions/v1/workbench/profiles/remove',
    uiAuthController.requireAuth,
    workbenchMutation('removeWorkbenchProfile'),
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
          ? await extensionRuntime.setEnabled(routeParam(req.params.extensionId), req.body.enabled, revision)
          : await extensionCatalog.setEnabled(routeParam(req.params.extensionId), req.body.enabled, revision);
        return res.json({ snapshot });
      } catch (error) {
        return sendMutationError(res, error);
      }
    },
  );

  app.delete(
    '/api/piarium/extensions/v1/extensions/:extensionId',
    uiAuthController.requireAuth,
    async (req, res) => {
      if (!extensionRuntime) return res.status(501).json({ error: { code: 'host_runtime_unavailable', retryable: true } });
      try {
        const request = parsePiariumExtensionRemoveRequest({
          ...req.body,
          extensionId: routeParam(req.params.extensionId),
        });
        return res.json({ snapshot: await extensionRuntime.removeExtension(request) });
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
