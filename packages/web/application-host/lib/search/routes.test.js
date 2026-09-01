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

const finishWithOutput = (child, output, code = 0) => {
  child.stdout.once('end', () => child.emit('close', code));
  child.stdout.end(output);
};

const matchLine = (absolutePath, preview) => JSON.stringify({
  type: 'match',
  data: {
    path: { text: absolutePath },
    line_number: 2,
    lines: { text: `${preview}\n` },
    submatches: [{ start: 0, end: 4 }],
  },
});

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

  it('streams content batches and a terminal result over NDJSON', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const workspace = await harness.authority.inspectWorkspace(harness.identity.workspaceId);
      const app = express();
      app.use(express.json());
      registerWorkspaceSearchRoutes(app, {
        documents: harness.authority,
        fsPromises: fs.promises,
        path,
        os,
        spawn: () => {
          const child = createFakeChild();
          queueMicrotask(() => {
            finishWithOutput(child, `${matchLine(path.join(workspace.root, 'alpha.ts'), 'alpha')}\n`);
          });
          return child;
        },
        resolveGitBinaryForSpawn: () => 'git',
        resolveProjectDirectory: async () => ({ resolved: harness.workspaceRoot }),
      });

      const streamed = await request(app)
        .post('/api/workspace/search/content')
        .set('accept', 'application/x-ndjson')
        .set('x-piarium-generation', '8')
        .send({ workspaceId: harness.identity.workspaceId, query: 'alpha' })
        .expect(200);
      const frames = streamed.text.trim().split('\n').map((line) => JSON.parse(line));
      expect(frames).toEqual([
        { type: 'batch', hits: [expect.objectContaining({ preview: 'alpha' })] },
        { type: 'result', result: { status: 'ready', generation: 8 } },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it('does not silently truncate file-name search when no caller limit is requested', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      await Promise.all(Array.from({ length: 81 }, (_, index) => (
        fs.promises.writeFile(path.join(harness.workspaceRoot, `match-${index}.ts`), '')
      )));
      const app = express();
      app.use(express.json());
      registerWorkspaceSearchRoutes(app, {
        documents: harness.authority,
        fsPromises: fs.promises,
        path,
        os,
        spawn: () => createFakeChild(),
        resolveGitBinaryForSpawn: () => 'git',
        resolveProjectDirectory: async () => ({ resolved: harness.workspaceRoot }),
      });

      const files = await request(app)
        .get('/api/find/file')
        .query({ query: 'match', directory: harness.workspaceRoot, respectGitignore: 'false' })
        .expect(200);
      expect(files.body).toHaveLength(81);
    } finally {
      await harness.cleanup();
    }
  });
});
