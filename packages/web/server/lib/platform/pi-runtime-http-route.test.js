import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerPiRuntimeHttpRoute, trustProjectRequestsFor } from './pi-runtime-http-route.js';

describe('Pi runtime HTTP route', () => {
  it('dispatches a validated Pi runtime method', async () => {
    const app = express();
    const piRuntimeBroker = {
      listSessions: vi.fn(async (cwd) => [{ id: 'ses_1', cwd }]),
    };
    registerPiRuntimeHttpRoute(app, { piRuntimeBroker });

    const response = await request(app)
      .post('/api/piarium/runtime/request')
      .send({ method: 'session.list', params: { cwd: 'C:/workspace' } })
      .expect(200);

    expect(response.body.result).toEqual([{ id: 'ses_1', cwd: 'C:/workspace' }]);
    expect(piRuntimeBroker.listSessions).toHaveBeenCalledWith('C:/workspace');
  });

  it('rejects invalid and unsupported methods without dispatching arbitrary calls', async () => {
    const app = express();
    registerPiRuntimeHttpRoute(app, { piRuntimeBroker: {} });

    await request(app)
      .post('/api/piarium/runtime/request')
      .send({ params: {} })
      .expect(400, { error: 'method is required' });

    const response = await request(app)
      .post('/api/piarium/runtime/request')
      .send({ method: 'arbitrary.execute', params: {} })
      .expect(400);
    expect(response.body.code).toBe('unsupported_method');
  });

  it('accepts only the matching CLI workspace trust request', async () => {
    let listener;
    const unsubscribe = vi.fn();
    const respondToProjectTrust = vi.fn(async () => ({ accepted: true }));
    const broker = {
      subscribe: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      respondToProjectTrust,
    };
    const stop = trustProjectRequestsFor(broker, 'C:/workspace');

    listener({
      kind: 'host',
      workerId: 'worker_other',
      envelope: { event: 'project.trust.request', data: { id: 'trust_other', cwd: 'C:/other' } },
    });
    listener({
      kind: 'host',
      workerId: 'worker_1',
      envelope: { event: 'project.trust.request', data: { id: 'trust_1', cwd: 'C:/workspace' } },
    });
    await vi.waitFor(() => expect(respondToProjectTrust).toHaveBeenCalledTimes(1));
    expect(respondToProjectTrust).toHaveBeenCalledWith('worker_1', 'trust_1', {
      remember: false,
      trusted: true,
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
