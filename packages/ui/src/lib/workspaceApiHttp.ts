import type {
  CreateGitCommitOptions,
  GitLogOptions,
  WorkspaceAPI,
  WorkspaceArchiveExtractRequest,
  WorkspaceArchiveExtractResult,
  WorkspaceArchivePreview,
  WorkspaceDeleteResult,
  WorkspaceEntry,
  WorkspaceGitCloneOptions,
  WorkspaceGitCloneResult,
  WorkspaceGitStatus,
  WorkspaceListResult,
  WorkspaceMutationResult,
  WorkspaceProjectOpenResult,
  WorkspaceReadResult,
  WorkspaceRootInfo,
  WorkspaceUploadFile,
  WorkspaceUploadResult,
} from './api/types';

const API_BASE = '/api/workspace';

const normalizeWorkspacePath = (value = ''): string => (
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '')
);

const buildUrl = (path: string, params?: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `${API_BASE}${path}?${query}` : `${API_BASE}${path}`;
};

const parseJsonError = async (response: Response, fallback: string): Promise<Error> => {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(payload?.error || fallback || response.statusText);
};

const ensureOk = async (response: Response, fallback: string): Promise<void> => {
  if (!response.ok) {
    throw await parseJsonError(response, fallback);
  }
};

const jsonRequest = async <TResult>(
  url: string,
  options: RequestInit,
  fallback: string,
): Promise<TResult> => {
  const response = await fetch(url, options);
  await ensureOk(response, fallback);
  return response.json() as Promise<TResult>;
};

const isBrowserFile = (value: WorkspaceUploadFile): value is File => (
  typeof File !== 'undefined' && value instanceof File
);

const getJson = async <TResult>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<TResult> => {
  const response = await fetch(buildUrl(path, params), { headers: { Accept: 'application/json' } });
  await ensureOk(response, 'Workspace request failed');
  return response.json() as Promise<TResult>;
};

type WorkspaceDownloadInfo = {
  type: 'file' | 'archive';
  fileName: string;
};

const startBrowserDownload = (url: string, filename: string): void => {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const createWorkspaceHttpAPI = (): WorkspaceAPI => ({
  getRoot(): Promise<WorkspaceRootInfo> {
    return getJson('/root');
  },

  list(path = ''): Promise<WorkspaceListResult> {
    return getJson('/list', { path: normalizeWorkspacePath(path) });
  },

  tree(path = '', depth = 2): Promise<WorkspaceListResult> {
    return getJson('/tree', { path: normalizeWorkspacePath(path), depth });
  },

  entry(path: string): Promise<WorkspaceEntry> {
    return getJson('/entry', { path: normalizeWorkspacePath(path) });
  },

  createFolder(path: string): Promise<WorkspaceMutationResult> {
    return jsonRequest(
      buildUrl('/folder'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeWorkspacePath(path) }),
      },
      'Failed to create workspace folder',
    );
  },

  createFile(path: string, content = ''): Promise<WorkspaceMutationResult> {
    return jsonRequest(
      buildUrl('/file'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeWorkspacePath(path), content }),
      },
      'Failed to create workspace file',
    );
  },

  move(from: string, to: string): Promise<WorkspaceMutationResult> {
    return jsonRequest(
      buildUrl('/move'),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: normalizeWorkspacePath(from),
          to: normalizeWorkspacePath(to),
        }),
      },
      'Failed to move workspace entry',
    );
  },

  deleteEntry(path: string, options = {}): Promise<WorkspaceDeleteResult> {
    return jsonRequest(
      buildUrl('/entry'),
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: normalizeWorkspacePath(path),
          permanent: options.permanent === true,
        }),
      },
      'Failed to delete workspace entry',
    );
  },

  readFile(path: string): Promise<WorkspaceReadResult> {
    return getJson('/read', { path: normalizeWorkspacePath(path) });
  },

  writeFile(path: string, content: string, expectedMtimeMs?: number | null): Promise<WorkspaceMutationResult> {
    return jsonRequest(
      buildUrl('/write'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: normalizeWorkspacePath(path),
          content,
          expectedMtimeMs: typeof expectedMtimeMs === 'number' ? expectedMtimeMs : null,
        }),
      },
      'Failed to write workspace file',
    );
  },

  upload(path: string, files: WorkspaceUploadFile[]): Promise<WorkspaceUploadResult> {
    if (files.every(isBrowserFile)) {
      const formData = new FormData();
      formData.set('path', normalizeWorkspacePath(path));
      for (const file of files) {
        formData.append('files', file, file.name);
      }
      return jsonRequest(
        buildUrl('/upload'),
        {
          method: 'POST',
          body: formData,
        },
        'Failed to upload workspace files',
      );
    }

    return jsonRequest(
      buildUrl('/upload'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeWorkspacePath(path), files }),
      },
      'Failed to upload workspace files',
    );
  },

  async download(path: string): Promise<void> {
    const normalizedPath = normalizeWorkspacePath(path);
    const info = await getJson<WorkspaceDownloadInfo>('/download/check', { path: normalizedPath });
    const fallbackName = normalizedPath.split('/').pop() || 'download';
    startBrowserDownload(buildUrl('/download', { path: normalizedPath }), info.fileName || fallbackName);
  },

  previewArchive(path: string): Promise<WorkspaceArchivePreview> {
    return getJson('/archive/preview', { path: normalizeWorkspacePath(path) });
  },

  extractArchive(request: WorkspaceArchiveExtractRequest): Promise<WorkspaceArchiveExtractResult> {
    return jsonRequest(
      buildUrl('/archive/extract'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          path: normalizeWorkspacePath(request.path),
          destination: normalizeWorkspacePath(request.destination),
        }),
      },
      'Failed to extract workspace archive',
    );
  },

  openProject(path: string): Promise<WorkspaceProjectOpenResult> {
    return jsonRequest(
      buildUrl('/projects/open'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeWorkspacePath(path) }),
      },
      'Failed to open workspace project',
    );
  },

  gitStatus(path: string, options?: { mode?: 'light' }): Promise<WorkspaceGitStatus> {
    return getJson('/git/status', {
      path: normalizeWorkspacePath(path),
      mode: options?.mode,
    });
  },

  gitFetch(path: string, options = {}): Promise<{ success: boolean }> {
    return jsonRequest(
      buildUrl('/git/fetch'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, path: normalizeWorkspacePath(path) }),
      },
      'Failed to fetch workspace repo',
    );
  },

  gitClone(path: string, options: WorkspaceGitCloneOptions): Promise<WorkspaceGitCloneResult> {
    return jsonRequest(
      buildUrl('/git/clone'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: normalizeWorkspacePath(path),
          url: options.url,
          branch: options.branch,
          directoryName: options.directoryName,
        }),
      },
      'Failed to clone workspace repo',
    );
  },

  gitPull(path: string, options = {}) {
    return jsonRequest(
      buildUrl('/git/pull'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, path: normalizeWorkspacePath(path) }),
      },
      'Failed to pull workspace repo',
    );
  },

  gitPush(path: string, options = {}) {
    return jsonRequest(
      buildUrl('/git/push'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, path: normalizeWorkspacePath(path) }),
      },
      'Failed to push workspace repo',
    );
  },

  gitCheckout(path: string, branch: string) {
    return jsonRequest(
      buildUrl('/git/checkout'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeWorkspacePath(path), branch }),
      },
      'Failed to checkout workspace branch',
    );
  },

  gitCommit(path: string, message: string, options: CreateGitCommitOptions = {}) {
    return jsonRequest(
      buildUrl('/git/commit'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: normalizeWorkspacePath(path),
          message,
          addAll: options.addAll === true,
          files: options.files,
        }),
      },
      'Failed to commit workspace changes',
    );
  },

  gitLog(path: string, options: GitLogOptions = {}) {
    return getJson('/git/log', {
      path: normalizeWorkspacePath(path),
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
    });
  },

  gitRemotes(path: string) {
    return getJson('/git/remotes', { path: normalizeWorkspacePath(path) });
  },
});
