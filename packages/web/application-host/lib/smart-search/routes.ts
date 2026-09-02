import { createSmartSearchRuntime } from './runtime.js';
import type { Express, Response } from 'express';

type RuntimeDependencies = NonNullable<Parameters<typeof createSmartSearchRuntime>[0]>;
type SmartSearchRuntime = ReturnType<typeof createSmartSearchRuntime>;
type SmartSearchRouteDependencies = RuntimeDependencies & { runtime?: SmartSearchRuntime };

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const sendError = (res: Response, error: unknown): void => {
  const record = errorRecord(error);
  const status = typeof record.status === 'number' && Number.isInteger(record.status) ? record.status : 500;
  res.status(status).json({
    ok: false,
    error: typeof record.message === 'string' ? record.message : 'Smart Search request failed.',
    details: record.details,
  });
};

export const registerSmartSearchRoutes = (app: Express, dependencies: SmartSearchRouteDependencies): void => {
  const runtime = dependencies.runtime || createSmartSearchRuntime(dependencies);

  app.get('/api/smart-search/status', async (_req, res) => {
    try {
      res.json(await runtime.getStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/smart-search/config', async (_req, res) => {
    try {
      res.json(await runtime.loadConfig());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/smart-search/config', async (req, res) => {
    try {
      res.json(await runtime.patchConfig(req.body));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/smart-search/doctor', async (_req, res) => {
    try {
      res.json(await runtime.runDoctor());
    } catch (error) {
      sendError(res, error);
    }
  });
};
