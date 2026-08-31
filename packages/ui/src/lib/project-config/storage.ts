import type {
  DocumentsAPI,
  FilesAPI,
  PiariumDocumentReadResult,
  PiariumResourceReference,
} from '@piarium/application-client';
import { requireWorkspaceEpoch } from '@/lib/documents/mutation-token';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { documentIdentityForPath, pickWorkspaceRoot } from '@/lib/documents/path';
import { createProjectIdFromPath } from '@/lib/projectId';
import type { PiariumProjectConfig, PiariumProjectRef } from './types';

type ProjectConfigFailureReason = 'conflict' | 'malformed' | 'unavailable' | 'unsupported' | 'write-failed';

export class PiariumProjectConfigError extends Error {
  readonly reason: ProjectConfigFailureReason;
  readonly path?: string;

  constructor(message: string, options: { path?: string; reason: ProjectConfigFailureReason }) {
    super(message);
    this.name = 'PiariumProjectConfigError';
    this.reason = options.reason;
    this.path = options.path;
  }
}

export interface PiariumProjectConfigRuntime {
  documents: DocumentsAPI;
  files: FilesAPI;
  currentDirectory: string;
}

interface ProjectPaths {
  canonicalConfig: string;
  canonicalDirectory: string;
}

interface TextSnapshot {
  path: string;
  resource: PiariumResourceReference;
  result: PiariumDocumentReadResult;
  documents: DocumentsAPI;
}

const mutationToken = (snapshot: TextSnapshot, project: PiariumProjectRef) => ({
  workspaceId: snapshot.resource.workspaceId,
  epoch: requireWorkspaceEpoch(snapshot.result.epoch),
  owner: { kind: 'project-config', id: project.id },
});

interface LoadedConfig {
  config: PiariumProjectConfig;
  revision: string | null;
}

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return replaced || '/';
};

const joinPath = (base: string, ...segments: string[]): string => {
  const root = normalizePath(base);
  const tail = segments.map((segment) => segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return root === '/' ? `/${tail.join('/')}` : [root, ...tail].join('/');
};

const parentPath = (value: string): string => value.slice(0, value.lastIndexOf('/')) || '/';

const parseConfig = (raw: string, path: string): PiariumProjectConfig => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be an object');
    }
    return parsed as PiariumProjectConfig;
  } catch (error) {
    throw new PiariumProjectConfigError(
      `Project configuration is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { path, reason: 'malformed' },
    );
  }
};

const defaultRuntime = (): PiariumProjectConfigRuntime | null => {
  const apis = getRegisteredRuntimeAPIs();
  if (!apis?.documents || !apis.files) return null;
  return {
    documents: apis.documents,
    files: apis.files,
    currentDirectory: useDirectoryStore.getState().currentDirectory,
  };
};

export const createPiariumProjectConfigStore = (
  getRuntime: () => PiariumProjectConfigRuntime | null = defaultRuntime,
) => {
  const mutationQueues = new Map<string, Promise<unknown>>();

  const runSerialized = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    mutationQueues.set(key, result);
    void result.finally(() => {
      if (mutationQueues.get(key) === result) mutationQueues.delete(key);
    }).catch(() => undefined);
    return result;
  };

  const requireRuntime = (): PiariumProjectConfigRuntime => {
    const runtime = getRuntime();
    if (!runtime) {
      throw new PiariumProjectConfigError('Project configuration runtime is unavailable', { reason: 'unavailable' });
    }
    return runtime;
  };

  const resolvePaths = async (project: PiariumProjectRef): Promise<ProjectPaths> => {
    const runtime = requireRuntime();
    const rawHome = (await runtime.files.getHomeDirectory()).trim();
    if (!rawHome) {
      throw new PiariumProjectConfigError('Home directory is unavailable', { reason: 'unavailable' });
    }
    const home = normalizePath(rawHome);
    const projectPath = normalizePath(project.path.trim());
    if (!project.path.trim()) {
      throw new PiariumProjectConfigError('Project path is required', { reason: 'unavailable' });
    }
    const pathId = createProjectIdFromPath(projectPath);
    if (!pathId) {
      throw new PiariumProjectConfigError('Project identity is unavailable', { reason: 'unavailable' });
    }
    const piariumProjects = joinPath(home, '.config', 'piarium', 'projects');
    const canonicalConfig = joinPath(piariumProjects, `${pathId}.json`);
    return {
      canonicalConfig,
      canonicalDirectory: joinPath(piariumProjects, pathId),
    };
  };

  const resolveTextSnapshot = async (path: string, project?: PiariumProjectRef): Promise<TextSnapshot> => {
    const runtime = requireRuntime();
    const home = await runtime.files.getHomeDirectory().catch(() => '');
    const root = pickWorkspaceRoot(path, [home, runtime.currentDirectory, project?.path ?? '']);
    if (!root) {
      throw new PiariumProjectConfigError('Project configuration path is outside available roots', {
        path,
        reason: 'unavailable',
      });
    }
    const workspace = await runtime.documents.resolveWorkspace({ path: root });
    const resource = documentIdentityForPath(workspace.workspaceId, root, path);
    if (!resource) {
      throw new PiariumProjectConfigError('Project configuration path is outside its workspace', {
        path,
        reason: 'unavailable',
      });
    }
    return {
      path,
      resource,
      result: await runtime.documents.read(resource),
      documents: runtime.documents,
    };
  };

  const configFromSnapshot = (snapshot: TextSnapshot): LoadedConfig | null => {
    if (snapshot.result.status === 'missing') return null;
    if (snapshot.result.status !== 'ready') {
      throw new PiariumProjectConfigError('Project configuration must be a UTF text file', {
        path: snapshot.path,
        reason: 'unsupported',
      });
    }
    return {
      config: parseConfig(snapshot.result.content, snapshot.path),
      revision: snapshot.result.revision,
    };
  };

  const writeConfigSnapshot = async (
    project: PiariumProjectRef,
    path: string,
    config: PiariumProjectConfig,
    expectedRevision: string | null,
  ): Promise<{ status: 'written'; revision: string } | { status: 'conflict' }> => {
    const runtime = requireRuntime();
    const directory = parentPath(path);
    const created = await runtime.files.createDirectory(directory);
    if (created.success === false) {
      throw new PiariumProjectConfigError('Failed to create the project configuration directory', {
        path: directory,
        reason: 'write-failed',
      });
    }
    const snapshot = await resolveTextSnapshot(path, project);
    const encoding = snapshot.result.status === 'ready' ? snapshot.result.encoding : 'utf-8';
    const bom = snapshot.result.status === 'ready' ? snapshot.result.bom : false;
    const result = await snapshot.documents.write({
      token: mutationToken(snapshot, project),
      resource: snapshot.resource,
      content: `${JSON.stringify(config, null, 2)}\n`,
      encoding,
      bom,
      expectedRevision,
      operationId: crypto.randomUUID(),
    });
    return result.status === 'written'
      ? { status: 'written', revision: result.revision }
      : { status: 'conflict' };
  };

  const loadCanonical = async (
    project: PiariumProjectRef,
    paths: ProjectPaths,
  ): Promise<LoadedConfig> => {
    const canonicalSnapshot = await resolveTextSnapshot(paths.canonicalConfig, project);
    const canonical = configFromSnapshot(canonicalSnapshot);
    if (canonical) return canonical;
    return { config: {}, revision: null };
  };

  const read = async (project: PiariumProjectRef): Promise<PiariumProjectConfig> => {
    const paths = await resolvePaths(project);
    return runSerialized(paths.canonicalConfig, async () => (
      (await loadCanonical(project, paths)).config
    ));
  };

  const mutate = async (
    project: PiariumProjectRef,
    createPatch: (current: Readonly<PiariumProjectConfig>) => Partial<PiariumProjectConfig> | null,
  ): Promise<boolean> => {
    const paths = await resolvePaths(project);
    return runSerialized(paths.canonicalConfig, async () => {
      const current = await loadCanonical(project, paths);
      const patch = createPatch(current.config);
      if (patch === null) return false;
      const next: PiariumProjectConfig = {
        ...current.config,
        ...patch,
        projectPath: normalizePath(project.path),
      };
      const written = await writeConfigSnapshot(project, paths.canonicalConfig, next, current.revision);
      return written.status === 'written';
    });
  };

  const update = async (
    project: PiariumProjectRef,
    patch: Partial<PiariumProjectConfig>,
  ): Promise<boolean> => mutate(project, () => patch);

  const readText = async (project: PiariumProjectRef, path: string): Promise<string | null> => {
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status === 'missing') return null;
    if (snapshot.result.status !== 'ready') {
      throw new PiariumProjectConfigError('Project text resource is not UTF text', { path, reason: 'unsupported' });
    }
    return snapshot.result.content;
  };

  const writeText = async (project: PiariumProjectRef, path: string, content: string): Promise<boolean> => {
    const runtime = requireRuntime();
    const created = await runtime.files.createDirectory(parentPath(path));
    if (created.success === false) return false;
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status !== 'missing' && snapshot.result.status !== 'ready') return false;
    const result = await snapshot.documents.write({
      token: mutationToken(snapshot, project),
      resource: snapshot.resource,
      content,
      encoding: snapshot.result.status === 'ready' ? snapshot.result.encoding : 'utf-8',
      bom: snapshot.result.status === 'ready' ? snapshot.result.bom : false,
      expectedRevision: snapshot.result.status === 'ready' ? snapshot.result.revision : null,
      operationId: crypto.randomUUID(),
    });
    return result.status === 'written';
  };

  const deleteText = async (project: PiariumProjectRef, path: string): Promise<boolean> => {
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status === 'missing') return true;
    const result = await snapshot.documents.delete({
      token: mutationToken(snapshot, project),
      resource: snapshot.resource,
      expectedRevision: snapshot.result.revision,
      operationId: crypto.randomUUID(),
    });
    return result.status === 'deleted';
  };

  return {
    deleteText,
    getPaths: resolvePaths,
    mutate,
    read,
    readText,
    update,
    writeText,
  };
};

export const piariumProjectConfigStore = createPiariumProjectConfigStore();
