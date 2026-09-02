import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';

import { registerProjectIconRoutes } from './project-icon-routes.js';
import type { Express, Request, Response } from 'express';

type RouteHandler = (request: Request, response: Response) => unknown;
type RouteInvoker = (request: Record<string, unknown>, response: object) => unknown;

const createRouteRegistry = () => {
  const routes = new Map<string, RouteHandler>();

  return {
    app: {
      get(routePath: unknown, handler: RouteHandler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath: unknown, handler: RouteHandler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath: unknown, handler: RouteHandler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath: unknown, handler: RouteHandler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method: string, routePath: unknown): RouteInvoker {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) throw new Error('Route not registered');
      return (request, response) => handler(request as unknown as Request, response as unknown as Response);
    },
  };
};

const createMockResponse = () => {
  const headers = new Map<string, unknown>();
  let statusCode = 200;
  let body: unknown = null;

  return {
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('project icon routes', () => {
  it('uses fallback file extension MIME when metadata points to a missing icon', async () => {
    const { app, getRoute } = createRouteRegistry();
    const jpgBytes = Buffer.from('jpg-bytes');
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsPromises = {
      readFile: vi.fn(async (iconPath: string) => {
        if (iconPath.endsWith('.jpg')) {
          return jpgBytes;
        }
        throw enoent;
      }),
    };

    registerProjectIconRoutes(app as unknown as Express, {
      fsPromises,
      path,
      crypto,
      piariumDataDir: '/tmp/piarium-test',
      sanitizeProjects: (projects: unknown) => Array.isArray(projects) ? projects : [],
      readSettingsFromDisk: async () => ({
        projects: [{
          id: 'proj-1',
          path: '/repo',
          iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' },
        }],
      }),
      persistSettings: async () => ({}),
      createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/icon')({
      params: { projectId: 'proj-1' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
    expect(res.body).toBe(jpgBytes);
  });
});
