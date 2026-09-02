import {
  dispatchRuntimeRequest,
  PiRuntimeNotReadyError,
  RuntimeDispatchError,
  type PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
  type ProjectTrustDecision,
} from '@piarium/runtime-broker';
import { isRuntimeMethod } from '@piarium/protocol';
import type { Express } from 'express';
import express from 'express';
import path from 'node:path';

const pathKey = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

interface ProjectTrustBroker {
  respondToProjectTrust(workerId: string, requestId: string, decision: ProjectTrustDecision): Promise<unknown>;
  subscribe(listener: (event: PiRuntimeBrokerEvent) => void): () => void;
}

const trustProjectRequestsFor = (piRuntimeBroker: ProjectTrustBroker, cwd: unknown): (() => void) => {
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

export interface PiRuntimeHttpRouteOptions {
  getPiRuntimeBroker?: (() => PiRuntimeBroker | null) | undefined;
  piRuntimeBroker?: PiRuntimeBroker | undefined;
}

export const registerPiRuntimeHttpRoute = (
  app: Express,
  { piRuntimeBroker, getPiRuntimeBroker }: PiRuntimeHttpRouteOptions,
): void => {
  const resolveBroker = () => (typeof getPiRuntimeBroker === 'function' ? getPiRuntimeBroker() : piRuntimeBroker);
  app.post('/api/piarium/runtime/request', express.json({ limit: '2mb' }), async (req, res) => {
    const method = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
    if (!method) return res.status(400).json({ error: 'method is required' });
    if (!isRuntimeMethod(method)) {
      return res.status(400).json({ error: `Unsupported runtime method: ${method}`, code: 'unsupported_method', retryable: false });
    }
    const broker = resolveBroker();
    if (!broker) {
      return res.status(503).json({ error: 'Pi runtime is not ready', code: 'runtime_not_ready' });
    }
    const params: unknown = req.body?.params ?? {};
    const unsubscribeTrust = req.body?.trustProject === true
      ? trustProjectRequestsFor(
          broker,
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as { cwd?: unknown }).cwd
            : undefined,
        )
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
