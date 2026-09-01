import { dispatchRuntimeRequest, PiRuntimeNotReadyError, RuntimeDispatchError } from '@piarium/runtime-broker';
import express from 'express';
import path from 'node:path';

const pathKey = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const trustProjectRequestsFor = (piRuntimeBroker, cwd) => {
  const expectedCwd = pathKey(cwd);
  if (!expectedCwd || typeof piRuntimeBroker?.subscribe !== 'function' || typeof piRuntimeBroker?.respondToProjectTrust !== 'function') {
    return () => {};
  }
  return piRuntimeBroker.subscribe((event) => {
    if (event?.kind !== 'host' || event.envelope?.event !== 'project.trust.request') return;
    const request = event.envelope.data;
    if (pathKey(request?.cwd) !== expectedCwd) return;
    void piRuntimeBroker.respondToProjectTrust(event.workerId, request.id, {
      remember: false,
      trusted: true,
    }).catch((error) => {
      console.error('[PiRuntime] Failed to accept CLI project trust request:', error);
    });
  });
};

export const registerPiRuntimeHttpRoute = (app, { piRuntimeBroker, getPiRuntimeBroker }) => {
  const resolveBroker = () => (typeof getPiRuntimeBroker === 'function' ? getPiRuntimeBroker() : piRuntimeBroker);
  app.post('/api/piarium/runtime/request', express.json({ limit: '2mb' }), async (req, res) => {
    const method = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
    if (!method) return res.status(400).json({ error: 'method is required' });
    const broker = resolveBroker();
    if (!broker) {
      return res.status(503).json({ error: 'Pi runtime is not ready', code: 'runtime_not_ready' });
    }
    const params = req.body?.params ?? {};
    const unsubscribeTrust = req.body?.trustProject === true
      ? trustProjectRequestsFor(broker, params?.cwd)
      : () => {};
    try {
      const result = await dispatchRuntimeRequest(broker, method, params);
      return res.json({ result });
    } catch (error) {
      if (error instanceof PiRuntimeNotReadyError) {
        return res.status(503).json({ error: error.message, code: error.code });
      }
      if (error instanceof RuntimeDispatchError) {
        return res.status(400).json({ error: error.message, code: error.code, retryable: error.retryable });
      }
      console.error('[PiRuntime] HTTP request failed:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Pi runtime request failed' });
    } finally {
      unsubscribeTrust();
    }
  });
};

export { trustProjectRequestsFor };
