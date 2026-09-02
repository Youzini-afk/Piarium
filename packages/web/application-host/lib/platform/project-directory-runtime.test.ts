import { describe, expect, it } from 'vitest';

import {
  createProjectDirectoryRuntime,
  type ProjectDirectoryDependencies,
} from './project-directory-runtime.js';

type RuntimeOverrides = Omit<Partial<ProjectDirectoryDependencies>, 'fsPromises'> & {
  fsPromises?: Partial<ProjectDirectoryDependencies['fsPromises']> | undefined;
};

const createTestRuntime = (overrides: RuntimeOverrides = {}) => {
  const defaultFsPromises: ProjectDirectoryDependencies['fsPromises'] = {
    stat: async () => ({ isDirectory: () => true }),
    realpath: async (value: string) => value,
  };
  const defaults: ProjectDirectoryDependencies = {
    fsPromises: defaultFsPromises,
    path: {
      resolve: (value: string) => value,
    },
    normalizeDirectoryPath: (value: string) => value,
    readSettingsFromDisk: async () => ({}),
    getReadSettingsFromDisk: () => async () => ({}),
    sanitizeProjects: (input: unknown) => Array.isArray(input)
      ? input.filter((entry): entry is { id: string; path: string } => (
          Boolean(entry) && typeof entry === 'object'
          && typeof (entry as { id?: unknown }).id === 'string'
          && typeof (entry as { path?: unknown }).path === 'string'
        ))
      : undefined,
  };

  return createProjectDirectoryRuntime({
    ...defaults,
    ...overrides,
    fsPromises: { ...defaultFsPromises, ...overrides.fsPromises },
  });
};

describe('project directory runtime', () => {
  describe('validateDirectoryPath', () => {
    it('returns resolved real path for a valid directory', async () => {
      const runtime = createTestRuntime();
      const result = await runtime.validateDirectoryPath('/home/user/project');

      expect(result).toEqual({ ok: true, directory: '/home/user/project' });
    });

    it('resolves symlinks via fsPromises.realpath', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/path/to/project',
        },
      });

      const result = await runtime.validateDirectoryPath('/symlink/path/to/project');

      expect(result).toEqual({ ok: true, directory: '/real/path/to/project' });
    });

    it('returns error when candidate is empty', async () => {
      const runtime = createTestRuntime();
      const result = await runtime.validateDirectoryPath('');

      expect(result).toEqual({ ok: false, error: 'Directory parameter is required' });
    });

    it('returns error when candidate is not a string', async () => {
      const runtime = createTestRuntime();
      const result = await runtime.validateDirectoryPath(null);

      expect(result).toEqual({ ok: false, error: 'Directory parameter is required' });
    });

    it('returns error when path is not a directory', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => false }),
          realpath: async (p) => p,
        },
      });

      const result = await runtime.validateDirectoryPath('/some/file.txt');

      expect(result).toEqual({ ok: false, error: 'Specified path is not a directory' });
    });

    it('returns error when path does not exist', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => { throw { code: 'ENOENT' }; },
          realpath: async (p) => p,
        },
      });

      const result = await runtime.validateDirectoryPath('/nonexistent');

      expect(result).toEqual({ ok: false, error: 'Directory not found' });
    });

    it('returns error when access is denied', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => { throw { code: 'EACCES' }; },
          realpath: async (p) => p,
        },
      });

      const result = await runtime.validateDirectoryPath('/restricted');

      expect(result).toEqual({ ok: false, error: 'Access to directory denied' });
    });

    it('returns error when realpath fails after stat succeeds', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => { throw { code: 'ENOENT' }; },
        },
      });

      const result = await runtime.validateDirectoryPath('/deleted-after-stat');

      expect(result).toEqual({ ok: false, error: 'Directory not found' });
    });
  });

  describe('resolveProjectDirectory', () => {
    it('resolves symlinks in x-piarium-directory header', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/workspace/project',
        },
      });

      const req = {
        get: (header: string) => header === 'x-piarium-directory' ? '/home/user/workspace/project' : null,
        query: {},
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(result).toEqual({ directory: '/real/workspace/project', error: null });
    });

    it('decodes marked x-piarium-directory header values', async () => {
      const pathWithUnicode = '/home/user/测试项目';
      let validatedPath = null;
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async (p) => {
            validatedPath = p;
            return { isDirectory: () => true };
          },
          realpath: async (p) => p,
        },
      });

      const req = {
        get: (header: string) => {
          if (header === 'x-piarium-directory') return encodeURIComponent(pathWithUnicode);
          if (header === 'x-piarium-directory-encoding') return 'uri';
          return null;
        },
        query: {},
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(validatedPath).toBe(pathWithUnicode);
      expect(result).toEqual({ directory: pathWithUnicode, error: null });
    });

    it('preserves raw percent sequences without directory encoding marker', async () => {
      const rawPath = '/home/user/foo%20bar';
      let validatedPath = null;
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async (p) => {
            validatedPath = p;
            return { isDirectory: () => true };
          },
          realpath: async (p) => p,
        },
      });

      const req = {
        get: (header: string) => header === 'x-piarium-directory' ? rawPath : null,
        query: {},
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(validatedPath).toBe(rawPath);
      expect(result).toEqual({ directory: rawPath, error: null });
    });

    it('falls back to query directory when an unmarked encoded header is invalid', async () => {
      const validPath = '/home/user/workspace/project';
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async (p) => {
            if (p === validPath) return { isDirectory: () => true };
            throw { code: 'ENOENT' };
          },
          realpath: async (p) => p,
        },
      });

      const req = {
        get: (header: string) => header === 'x-piarium-directory' ? encodeURIComponent(validPath) : null,
        query: { directory: validPath },
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(result).toEqual({ directory: validPath, error: null });
    });

    it('resolves symlinks in query directory parameter', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/workspace/project',
        },
      });

      const req = {
        get: () => null,
        query: { directory: '/home/user/workspace/project' },
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(result).toEqual({ directory: '/real/workspace/project', error: null });
    });

    it('resolves symlinks in lastDirectory from settings', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/workspace/project',
        },
        getReadSettingsFromDisk: () => async () => ({
          lastDirectory: '/home/user/workspace/project',
        }),
      });

      const req = {
        get: () => null,
        query: {},
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(result).toEqual({ directory: '/real/workspace/project', error: null });
    });

    it('resolves symlinks in active project path from settings', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/workspace/project',
        },
        getReadSettingsFromDisk: () => async () => ({
          projects: [{ id: 'proj-1', path: '/home/user/workspace/project' }],
          activeProjectId: 'proj-1',
        }),
      });

      const req = {
        get: () => null,
        query: {},
      };

      const result = await runtime.resolveProjectDirectory(req);

      expect(result).toEqual({ directory: '/real/workspace/project', error: null });
    });
  });

  describe('resolveOptionalProjectDirectory', () => {
    it('returns null directory when no directory is requested', async () => {
      const runtime = createTestRuntime();

      const req = {
        get: () => null,
        query: {},
      };

      const result = await runtime.resolveOptionalProjectDirectory(req);

      expect(result).toEqual({ directory: null, error: null });
    });

    it('resolves symlinks when directory is provided', async () => {
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async () => ({ isDirectory: () => true }),
          realpath: async () => '/real/workspace/project',
        },
      });

      const req = {
        get: (header: string) => header === 'x-piarium-directory' ? '/symlink/workspace/project' : null,
        query: {},
      };

      const result = await runtime.resolveOptionalProjectDirectory(req);

      expect(result).toEqual({ directory: '/real/workspace/project', error: null });
    });

    it('preserves raw percent sequences without directory encoding marker', async () => {
      const rawPath = '/optional/foo%25bar';
      let validatedPath = null;
      const runtime = createTestRuntime({
        fsPromises: {
          stat: async (p) => {
            validatedPath = p;
            return { isDirectory: () => true };
          },
          realpath: async (p) => p,
        },
      });

      const req = {
        get: (header: string) => header === 'x-piarium-directory' ? rawPath : null,
        query: {},
      };

      const result = await runtime.resolveOptionalProjectDirectory(req);

      expect(validatedPath).toBe(rawPath);
      expect(result).toEqual({ directory: rawPath, error: null });
    });
  });
});
