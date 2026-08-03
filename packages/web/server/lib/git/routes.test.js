import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const gitLibraries = {
  cloneRepository: vi.fn(),
  getProfile: vi.fn(),
  getGlobalIdentity: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
};

vi.mock('./index.js', () => ({
  cloneRepository: gitLibraries.cloneRepository,
  getProfile: gitLibraries.getProfile,
  getGlobalIdentity: gitLibraries.getGlobalIdentity,
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
}));

const { registerGitRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
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

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.cloneRepository.mockReset();
    gitLibraries.getProfile.mockReset();
    gitLibraries.getGlobalIdentity.mockReset();
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
  });

  it('clones a project through the Git service with the selected identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-git-route-clone-'));
    const destination = path.join(root, 'demo');
    const normalizedDestination = destination.replace(/\\/g, '/');
    const identity = {
      id: 'work',
      name: 'Work',
      userName: 'Pi User',
      userEmail: 'pi@example.com',
      sshKey: '/home/pi/.ssh/id_ed25519',
    };
    gitLibraries.getProfile.mockReturnValue(identity);
    gitLibraries.cloneRepository.mockResolvedValue({
      success: true,
      path: normalizedDestination,
      output: 'cloned',
    });

    try {
      const { app, getRoute } = createRouteRegistry();
      registerGitRoutes(app);
      const response = createMockResponse();

      await getRoute('POST', '/api/git/clone')({
        body: {
          remoteUrl: 'git@example.com:team/demo.git',
          destinationPath: destination,
          gitIdentityId: 'work',
        },
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ success: true, path: normalizedDestination, output: 'cloned' });
      expect(gitLibraries.cloneRepository).toHaveBeenCalledWith(root, {
        url: 'git@example.com:team/demo.git',
        directoryName: 'demo',
        identity,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects remote-ext clone URLs before reaching Git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/clone')({
      body: {
        remoteUrl: 'ext::sh -c calc',
        destinationPath: '/projects/demo',
      },
    }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'ext:: git remotes are not supported' });
    expect(gitLibraries.cloneRepository).not.toHaveBeenCalled();
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});
