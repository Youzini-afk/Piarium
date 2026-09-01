// @ts-nocheck
import express from 'express';
import { PiRuntimeNotReadyError } from '@piarium/runtime-broker';

const json = express.json({ limit: '32kb' });

const snapshotBody = (lifecycle) => lifecycle.snapshot;

const handleAction = async (res, work) => {
  try {
    const snapshot = await work();
    return res.json(snapshot);
  } catch (error) {
    if (error instanceof PiRuntimeNotReadyError) {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : 'Pi runtime manager request failed';
    return res.status(400).json({ error: message });
  }
};

export const registerRuntimeManagerRoutes = (app, {
  lifecycle,
  pickPiPackageRoot,
  openFilesystemPath,
}) => {
  app.get('/api/piarium/runtime-manager', (_req, res) => {
    res.json(snapshotBody(lifecycle));
  });

  app.get('/api/piarium/runtime-manager/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (snapshot) => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    send(lifecycle.snapshot);
    const unsubscribe = lifecycle.subscribe(send);
    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });

  app.post('/api/piarium/runtime-manager/refresh', json, (_req, res) => (
    handleAction(res, () => lifecycle.refresh())
  ));
  app.post('/api/piarium/runtime-manager/install', json, (_req, res) => (
    handleAction(res, () => lifecycle.install())
  ));
  app.post('/api/piarium/runtime-manager/upgrade', json, (_req, res) => (
    handleAction(res, () => lifecycle.upgrade())
  ));
  app.post('/api/piarium/runtime-manager/activate', json, (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    if (!id) return res.status(400).json({ error: 'id is required' });
    return handleAction(res, () => lifecycle.activate(id));
  });
  app.post('/api/piarium/runtime-manager/activate-custom', json, (req, res) => {
    const packageRoot = typeof req.body?.packageRoot === 'string' ? req.body.packageRoot.trim() : '';
    const nodePath = typeof req.body?.nodePath === 'string' ? req.body.nodePath.trim() : undefined;
    if (!packageRoot) return res.status(400).json({ error: 'packageRoot is required' });
    return handleAction(res, () => lifecycle.activateCustom(packageRoot, nodePath));
  });
  app.post('/api/piarium/runtime-manager/pick', json, async (_req, res) => {
    if (typeof pickPiPackageRoot !== 'function') {
      return res.status(501).json({ error: 'Choosing a Pi package root is not available on this surface' });
    }
    try {
      const packageRoot = await pickPiPackageRoot();
      return res.json({ packageRoot: packageRoot || null });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to choose a Pi package root' });
    }
  });
  app.post('/api/piarium/runtime-manager/open-location', json, async (req, res) => {
    const target = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!target) return res.status(400).json({ error: 'path is required' });
    if (typeof openFilesystemPath !== 'function') {
      return res.status(501).json({ error: 'Opening a filesystem location is not available on this surface' });
    }
    try {
      await openFilesystemPath(target);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to open location' });
    }
  });
};
