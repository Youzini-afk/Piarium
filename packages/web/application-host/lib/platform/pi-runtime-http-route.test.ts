import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '@piarium/protocol';
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
} from '@piarium/runtime-broker';
import { registerPiRuntimeHttpRoute, trustProjectRequestsFor } from './pi-runtime-http-route.js';

const asBroker = (members: Partial<PiRuntimeBroker>): PiRuntimeBroker => (
  Object.assign(Object.create(PiRuntimeBroker.prototype) as PiRuntimeBroker, members)
);

describe('Pi runtime HTTP route', () => {
  it('dispatches a validated Pi runtime method', async () => {
    const app = express();
    const piRuntimeBroker = asBroker({
      listSessions: vi.fn(async (cwd = '') => [{
        allMessagesText: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        cwd,
        firstMessage: '',
        id: 'ses_1',
        messageCount: 0,
        persisted: true,
        sessionFile: 'session.jsonl',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]),
    });
    registerPiRuntimeHttpRoute(app, { piRuntimeBroker });

    const response = await request(app)
      .post('/api/piarium/runtime/request')
      .send({ method: 'session.list', params: { cwd: 'C:/workspace' } })
      .expect(200);

    expect(response.body.result).toMatchObject([{ id: 'ses_1', cwd: 'C:/workspace' }]);
    expect(piRuntimeBroker.listSessions).toHaveBeenCalledWith('C:/workspace');
  });

  it('rejects invalid and unsupported methods without dispatching arbitrary calls', async () => {
    const app = express();
    registerPiRuntimeHttpRoute(app, { piRuntimeBroker: asBroker({}) });

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

  it('returns 503 when no Pi runtime broker is available', async () => {
    const app = express();
    registerPiRuntimeHttpRoute(app, {
      getPiRuntimeBroker: () => null,
    });

    const response = await request(app)
      .post('/api/piarium/runtime/request')
      .send({ method: 'session.list', params: {} })
      .expect(503);
    expect(response.body.code).toBe('runtime_not_ready');
  });

  it('accepts only the matching CLI workspace trust request', async () => {
    let listener: ((event: PiRuntimeBrokerEvent) => void) | undefined;
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

    if (!listener) throw new Error('Expected project trust listener');
    listener({
      kind: 'host',
      role: 'session',
      runtimeGeneration: 1,
      workerId: 'worker_other',
      envelope: createEvent(1, 'project.trust.request', { id: 'trust_other', cwd: 'C:/other', reason: 'project-resources' }),
    });
    listener({
      kind: 'host',
      role: 'session',
      runtimeGeneration: 1,
      workerId: 'worker_1',
      envelope: createEvent(2, 'project.trust.request', { id: 'trust_1', cwd: 'C:/workspace', reason: 'project-resources' }),
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
