import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { registerWorkspaceSearchRoutes } from './routes.js';

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', null);
  return child;
};

describe('workspace search routes', () => {
  it('serves file-name search and keeps content failure distinct from empty', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'alpha.ts'), 'export const alpha = 1;\n');
      const app = express();
      app.use(express.json());
      registerWorkspaceSearchRoutes(app, {
        documents: harness.authority,
        fsPromises: fs.promises,
        path,
        os,
        spawn: () => {
          const child = createFakeChild();
          queueMicrotask(() => child.emit('close', 2));
          return child;
        },
        resolveGitBinaryForSpawn: () => 'git',
        resolveProjectDirectory: async () => ({ resolved: harness.workspaceRoot }),
      });

      const files = await request(app)
        .get('/api/find/file')
        .query({ query: 'alpha', directory: harness.workspaceRoot, respectGitignore: 'false' })
        .expect(200);
      expect(files.body).toEqual(['alpha.ts']);

      const failed = await request(app)
        .post('/api/workspace/search/content')
        .set('x-piarium-generation', '7')
        .send({ workspaceId: harness.identity.workspaceId, query: 'alpha' })
        .expect(200);
      expect(failed.body.status).toBe('failure');
      expect(failed.body.generation).toBe(7);
      expect(Array.isArray(failed.body.hits)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
