import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionCatalogRevisionConflictError } from '@piarium/extension-host';
import { registerExtensionRoutes } from './routes.js';

const snapshot = (enabled = true, revision = 1) => ({
  schemaVersion: 1,
  hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
  revision,
  loadedAt: '2026-08-14T00:00:00.000Z',
  authoritative: true,
  storageState: 'ready',
  diagnostics: [],
  extensions: [{
    manifest: { schemaVersion: 1, id: 'dev.example.extension', version: '1.0.0', engines: { piarium: '>=0.1.0' } },
    source: { kind: 'npm', display: 'npm:dev.example.extension' },
    resolvedVersion: '1.0.0',
    selectedVersion: '1.0.0',
    desired: { enabled, revision, updatedAt: '2026-08-14T00:00:00.000Z' },
    actual: [],
    capabilityGrants: [],
    installedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  }],
});

const createApp = (extensionCatalog, extensionPackages = {}, extensionRuntime) => {
  const app = express();
  app.use(express.json());
  registerExtensionRoutes(app, {
    extensionCatalog,
    extensionPackages,
    extensionRuntime,
    uiAuthController: {
      requireAuth: (req, res, next) => req.headers['x-test-session'] === 'yes'
        ? next()
        : res.status(401).json({ error: 'Authentication required' }),
      requireSessionAuth: (req, res, next) => req.headers['x-test-session'] === 'yes'
        ? next()
        : res.status(401).json({ error: 'Session authentication required' }),
    },
  });
  return app;
};

describe('Piarium extension recovery routes', () => {
  it('serves an authenticated renderer-independent recovery page and read-only catalog', async () => {
    const extensionCatalog = { snapshot: vi.fn(async () => snapshot()) };
    const app = createApp(extensionCatalog);

    await request(app).get('/extensions/recovery').expect(401);
    const page = await request(app).get('/extensions/recovery').set('x-test-session', 'yes').expect(200);
    expect(page.text).toContain('Piarium Extension Recovery');
    expect(page.text).toContain('/api/piarium/extensions/v1/disable-all');

    const catalog = await request(app).get('/api/piarium/extensions/v1/catalog').expect(200);
    expect(catalog.body.status).toBe('ready');
    expect(catalog.body.snapshot.extensions).toHaveLength(1);
  });

  it('requires session auth for mutations and reports revision conflicts', async () => {
    const extensionCatalog = {
      snapshot: vi.fn(async () => snapshot()),
      setEnabled: vi.fn(async () => { throw new ExtensionCatalogRevisionConflictError(1, 2); }),
    };
    const app = createApp(extensionCatalog);
    const path = '/api/piarium/extensions/v1/extensions/dev.example.extension/enabled';

    await request(app).patch(path).send({ enabled: false, expectedRevision: 1 }).expect(401);
    const conflict = await request(app)
      .patch(path)
      .set('x-test-session', 'yes')
      .send({ enabled: false, expectedRevision: 1 })
      .expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'revision_conflict', actualRevision: 2, expectedRevision: 1 });
  });

  it('serves managed entrypoint bytes only through an authenticated POST', async () => {
    const entrypoint = {
      artifactIntegrity: `sha256-${'a'.repeat(64)}`,
      entrypointId: 'main',
      module: {
        artifactIntegrity: `sha256-${'a'.repeat(64)}`,
        bytesBase64: 'bW9kdWxlLmV4cG9ydHM9e307',
        contentType: 'text/javascript',
        integrity: `sha256-${'b'.repeat(64)}`,
        path: 'runtime/surface/main/module.cjs',
      },
      styles: [],
    };
    const extensionPackages = { readManagedEntrypoint: vi.fn(async () => entrypoint) };
    const app = createApp({ snapshot: vi.fn(async () => snapshot()) }, extensionPackages);
    const path = '/api/piarium/extensions/v1/entrypoints/read';
    await request(app).post(path).send({}).expect(401);
    const response = await request(app).post(path).set('x-test-session', 'yes').send({}).expect(200);
    expect(response.body).toEqual(entrypoint);
  });

  it('coordinates Host state, candidate preparation, and service invocation through authenticated routes', async () => {
    const state = {
      catalog: snapshot(),
      revision: 4,
      routing: {
        authoritative: true,
        diagnostics: [],
        document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
        hostId: snapshot().hostId,
        storageState: 'missing',
      },
      services: { hostId: snapshot().hostId, providers: [], revision: 2, selections: {} },
      workbench: {
        authoritative: true,
        diagnostics: [],
        document: {
          activeProfileId: 'default', layouts: [], profileSelections: { users: {}, workspaces: {} },
          profiles: [{ id: 'default', label: 'Default' }], revision: 0, schemaVersion: 1,
          updatedAt: '1970-01-01T00:00:00.000Z',
        },
        hostId: snapshot().hostId,
        storageState: 'missing',
      },
    };
    const extensionRuntime = {
      state: vi.fn(async () => state),
      waitForState: vi.fn(async () => state),
      prepareCandidate: vi.fn(async (extensionId, integrity) => ({ extensionId, integrity, providers: [] })),
      reviewCandidateCapabilities: vi.fn(async () => snapshot()),
      invokeService: vi.fn(async () => 'service-result'),
      upsertServiceRoutingRule: vi.fn(async () => state.routing),
      removeServiceRoutingRule: vi.fn(async () => state.routing),
      updateWorkbenchLayout: vi.fn(async () => state.workbench),
    };
    const app = createApp({ snapshot: vi.fn(async () => snapshot()) }, {}, extensionRuntime);
    expect((await request(app).get('/api/piarium/extensions/v1/host-state').expect(200)).body).toEqual(state);
    await request(app).post('/api/piarium/extensions/v1/candidates/prepare').send({}).expect(401);
    const prepared = await request(app)
      .post('/api/piarium/extensions/v1/candidates/prepare')
      .set('x-test-session', 'yes')
      .send({ extensionId: 'dev.example.extension', candidateIntegrity: `sha256-${'a'.repeat(64)}` })
      .expect(200);
    expect(prepared.body.providers).toEqual([]);
    await request(app).post('/api/piarium/extensions/v1/candidates/review-capabilities').send({}).expect(401);
    const reviewed = await request(app)
      .post('/api/piarium/extensions/v1/candidates/review-capabilities')
      .set('x-test-session', 'yes')
      .send({
        candidateIntegrity: `sha256-${'a'.repeat(64)}`,
        decisions: [{ capability: 'workspace.files', granted: false, realm: 'host' }],
        expectedRevision: 1,
        extensionId: 'dev.example.extension',
      })
      .expect(200);
    expect(reviewed.body.snapshot.revision).toBe(1);
    const invoked = await request(app)
      .post('/api/piarium/extensions/v1/services/invoke')
      .set('x-test-session', 'yes')
      .send({ serviceId: 'dev.example.service', version: 1, method: 'read', args: [] })
      .expect(200);
    expect(invoked.body.result).toBe('service-result');
    await request(app).put('/api/piarium/extensions/v1/services/routing').send({}).expect(401);
    const routed = await request(app)
      .put('/api/piarium/extensions/v1/services/routing')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, rule: {} })
      .expect(200);
    expect(routed.body.document.rules).toEqual([]);
    await request(app)
      .post('/api/piarium/extensions/v1/services/routing/remove')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, scope: {}, serviceId: 'dev.example.service', version: 1 })
      .expect(200);
    await request(app).patch('/api/piarium/extensions/v1/workbench/layout').send({}).expect(401);
    const workbench = await request(app)
      .patch('/api/piarium/extensions/v1/workbench/layout')
      .set('x-test-session', 'yes')
      .send({ expectedRevision: 0, layer: {} })
      .expect(200);
    expect(workbench.body.document.activeProfileId).toBe('default');
  });
});
