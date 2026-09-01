import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const gitLibraries = {
  cloneRepository: vi.fn(),
  getProfile: vi.fn(),
  getGlobalIdentity: vi.fn(),
  getStatus: vi.fn(),
  isGitRepository: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  getWorktrees: vi.fn(),
  integrateWorktreeCommits: vi.fn(),
};

vi.mock('./index.js', () => ({
  cloneRepository: gitLibraries.cloneRepository,
  getProfile: gitLibraries.getProfile,
  getGlobalIdentity: gitLibraries.getGlobalIdentity,
  getStatus: gitLibraries.getStatus,
  isGitRepository: gitLibraries.isGitRepository,
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  createWorktree: gitLibraries.createWorktree,
  removeWorktree: gitLibraries.removeWorktree,
  getWorktrees: gitLibraries.getWorktrees,
  integrateWorktreeCommits: gitLibraries.integrateWorktreeCommits,
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
    gitLibraries.getStatus.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.createWorktree.mockReset();
    gitLibraries.removeWorktree.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.integrateWorktreeCommits.mockReset();
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

  it('registers a process writer around a workspace mutation', async () => {
    const writer = {
      markMutated: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const documents = {
      registerWriterForScope: vi.fn().mockResolvedValue(writer),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      createMockResponse(),
    );

    expect(documents.registerWriterForScope).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ kind: 'git-route' }),
      { mode: 'process', purpose: 'git-stage' },
    );
    expect(writer.markMutated).toHaveBeenCalledTimes(1);
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a mutation in maintenance before invoking Git', async () => {
    const error = Object.assign(new Error('Workspace is in maintenance mode'), {
      code: 'maintenance',
      statusCode: 409,
    });
    const documents = {
      registerWriterForScope: vi.fn().mockRejectedValue(error),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(409);
  });

  it('does not create a clone destination parent before maintenance admission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-git-route-maintenance-'));
    const parent = path.join(root, 'not-created');
    const error = Object.assign(new Error('Workspace is in maintenance mode'), {
      code: 'maintenance',
      statusCode: 409,
    });
    const documents = {
      registerWriterForScope: vi.fn().mockRejectedValue(error),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });
    const response = createMockResponse();

    try {
      await getRoute('POST', '/api/git/clone')({
        body: {
          remoteUrl: 'https://example.com/demo.git',
          destinationPath: path.join(parent, 'demo'),
        },
      }, response);

      expect(response.statusCode).toBe(409);
      expect(gitLibraries.cloneRepository).not.toHaveBeenCalled();
      await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not register a writer for read-only status', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ files: [] });
    const documents = { registerWriterForScope: vi.fn() };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/repo' } },
      createMockResponse(),
    );

    expect(documents.registerWriterForScope).not.toHaveBeenCalled();
  });

  it('lets worktree create own and hand off one writer lease', async () => {
    const input = {
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    };
    const created = {
      head: '',
      name: 'feature',
      branch: 'piarium/feature',
      path: '/worktrees/feature',
      directoryCreated: true,
      bootstrapStatus: { status: 'pending', phase: 'directory-created', error: null },
    };
    gitLibraries.createWorktree.mockResolvedValue(created);
    const documents = { registerWriterForScope: vi.fn() };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: input },
      response,
    );

    expect(response.body).toEqual(created);
    expect(gitLibraries.createWorktree).toHaveBeenCalledWith('/repo', input, {
      documents,
      writerOwner: { kind: 'git-route', id: 'git-worktree-create:/repo' },
    });
    expect(documents.registerWriterForScope).not.toHaveBeenCalled();
  });

  it('uses only the route writers for synchronous worktree removal', async () => {
    gitLibraries.removeWorktree.mockResolvedValue(true);
    const writerRecords = [];
    const documents = {
      registerWriterForScope: vi.fn(async () => {
        const record = {
          markMutated: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
        writerRecords.push(record);
        return record;
      }),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });
    const response = createMockResponse();

    await getRoute('DELETE', '/api/git/worktrees')(
      {
        query: { directory: '/repo' },
        body: { directory: '/worktrees/feature', deleteLocalBranch: true },
      },
      response,
    );

    expect(response.body).toEqual({ success: true });
    expect(gitLibraries.removeWorktree).toHaveBeenCalledWith('/repo', {
      directory: '/worktrees/feature',
      deleteLocalBranch: true,
    });
    expect(documents.registerWriterForScope).toHaveBeenCalledTimes(2);
    for (const writer of writerRecords) {
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
    }
  });

  it('uses only the route writers for synchronous integrate execution', async () => {
    const plan = {
      repoRoot: '/repo',
      sourceBranch: 'feature',
      targetBranch: 'main',
      commits: ['abcd1234'],
    };
    gitLibraries.getWorktrees.mockResolvedValue([{ path: '/worktrees/feature' }]);
    gitLibraries.integrateWorktreeCommits.mockResolvedValue({ kind: 'success', moved: 1 });
    const writerRecords = [];
    const documents = {
      registerWriterForScope: vi.fn(async () => {
        const record = {
          markMutated: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
        writerRecords.push(record);
        return record;
      }),
    };
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { documents });
    const response = createMockResponse();

    await getRoute('POST', '/api/git/integrate/run')(
      { body: { plan } },
      response,
    );

    expect(response.body).toEqual({ kind: 'success', moved: 1 });
    expect(gitLibraries.integrateWorktreeCommits).toHaveBeenCalledWith(plan);
    expect(documents.registerWriterForScope).toHaveBeenCalledTimes(2);
    for (const writer of writerRecords) {
      expect(writer.markMutated).toHaveBeenCalledTimes(1);
      expect(writer.close).toHaveBeenCalledTimes(1);
    }
  });
});
