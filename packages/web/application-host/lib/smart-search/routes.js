import { createSmartSearchRuntime } from './runtime.js';

const sendError = (res, error) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({
    ok: false,
    error: error?.message || 'Smart Search request failed.',
    details: error?.details,
  });
};

export const registerSmartSearchRoutes = (app, dependencies) => {
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
