import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerRuntimeManagerRoutes } from './runtime-manager-routes.js';

const snapshot = {
  installations: [],
  revision: 1,
  status: 'missing',
};

describe('runtime manager routes', () => {
  it('returns the current snapshot and applies manager actions', async () => {
    const app = express();
    const lifecycle = {
      snapshot,
      refresh: vi.fn(async () => ({ ...snapshot, status: 'discovering' })),
      install: vi.fn(async () => ({ ...snapshot, status: 'installing' })),
      upgrade: vi.fn(async () => ({ ...snapshot, status: 'upgrading' })),
      activate: vi.fn(async (id) => ({ ...snapshot, selectedId: id, status: 'ready' })),
      activateCustom: vi.fn(async (packageRoot) => ({
        ...snapshot,
        selectedId: 'custom',
        status: 'ready',
        active: { id: 'custom', packageRoot, source: 'custom', state: 'ready' },
      })),
      subscribe: vi.fn(() => () => {}),
    };
    registerRuntimeManagerRoutes(app, { lifecycle });

    expect((await request(app).get('/api/piarium/runtime-manager').expect(200)).body).toEqual(snapshot);
    expect((await request(app).post('/api/piarium/runtime-manager/refresh').expect(200)).body.status).toBe('discovering');
    expect((await request(app).post('/api/piarium/runtime-manager/install').expect(200)).body.status).toBe('installing');
    expect((await request(app).post('/api/piarium/runtime-manager/upgrade').expect(200)).body.status).toBe('upgrading');
    expect((await request(app).post('/api/piarium/runtime-manager/activate').send({ id: 'system' }).expect(200)).body.selectedId).toBe('system');
    expect((await request(app).post('/api/piarium/runtime-manager/activate-custom').send({ packageRoot: 'D:/pi' }).expect(200)).body.active.packageRoot).toBe('D:/pi');
    await request(app).post('/api/piarium/runtime-manager/activate').send({}).expect(400, { error: 'id is required' });
    await request(app).post('/api/piarium/runtime-manager/pick').expect(501);
  });

  it('opens a picked package root when the desktop dialog is available', async () => {
    const app = express();
    const lifecycle = {
      snapshot,
      subscribe: vi.fn(() => () => {}),
    };
    const pickPiPackageRoot = vi.fn(async () => 'D:/chosen/pi');
    const openFilesystemPath = vi.fn(async () => {});
    registerRuntimeManagerRoutes(app, { lifecycle, pickPiPackageRoot, openFilesystemPath });

    expect((await request(app).post('/api/piarium/runtime-manager/pick').expect(200)).body).toEqual({
      packageRoot: 'D:/chosen/pi',
    });
    await request(app).post('/api/piarium/runtime-manager/open-location').send({ path: 'D:/chosen/pi' }).expect(200, { ok: true });
    expect(openFilesystemPath).toHaveBeenCalledWith('D:/chosen/pi');
  });
});
