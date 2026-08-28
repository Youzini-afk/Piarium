import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error Application-host document authority is a JS module shared with Web.
import { createDocumentAuthority } from '../../web/server/lib/documents/authority.js';
// @ts-expect-error Host capability adapter is a JS module shared with Web.
import { createDocumentsCapabilityHandler } from '../../web/server/lib/documents/capability.js';

type VSCodeWorkspaceLike = {
  isTrusted: boolean;
  workspaceFolders?: readonly { uri: { fsPath: string } }[] | undefined;
};

export type VSCodeDocumentAuthority = ReturnType<typeof createVSCodeDocumentAuthority>;

type MutationOwner = {
  kind: string;
  id: string;
  generation?: number;
};

type MutationOptions = {
  mode?: 'controlled' | 'process' | 'external';
  purpose?: string;
};

type MutationAuthorityLike = {
  runMutationForScope?: <T>(
    scopeId: string,
    owner: MutationOwner,
    operation: () => PromiseLike<T> | T,
    options?: MutationOptions,
  ) => Promise<T>;
  registerWriterForScope?: (
    scopeId: string,
    owner: MutationOwner,
    options?: MutationOptions,
  ) => Promise<{
    markMutated: () => Promise<void>;
    close: () => Promise<void>;
  } | null>;
};

export type VSCodeMutationAuthority = MutationAuthorityLike;

const isPathInside = (candidate: string, root: string): boolean => {
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(rootWithSeparator);
};

const realpathWithMissingParents = async (target: string): Promise<string> => {
  let current = path.resolve(target);
  while (true) {
    try {
      return await fs.promises.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
};

/**
 * Resolve a native path to the VS Code workspace root it belongs to. The
 * nearest existing parent is canonicalized so writes to newly-created files or
 * directories still get the workspace's mutation authority, while symlink
 * escapes and paths outside every open workspace remain unscoped.
 */
export const resolveVSCodeWorkspaceScope = async (
  workspace: VSCodeWorkspaceLike,
  targetPath: string,
): Promise<string | null> => {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  const target = await realpathWithMissingParents(targetPath);
  const roots = await Promise.all((workspace.workspaceFolders ?? []).map(async (folder) => {
    const root = folder?.uri?.fsPath;
    if (!root) return null;
    return realpathWithMissingParents(root);
  }));
  return roots
    .filter((root): root is string => {
      if (!root) return false;
      return isPathInside(target, root);
    })
    .sort((a, b) => b.length - a.length)[0] ?? null;
};

/**
 * Run a native write with the document authority when its target belongs to an
 * open workspace. A path outside the workspace intentionally executes without
 * inventing a document writer.
 */
export const runVSCodeMutation = async <T>(options: {
  workspace: VSCodeWorkspaceLike;
  documents?: MutationAuthorityLike;
  targetPaths: readonly string[];
  owner: MutationOwner;
  operation: () => PromiseLike<T> | T;
  mutation?: MutationOptions;
}): Promise<T> => {
  const { workspace, documents, targetPaths, owner, operation, mutation } = options;
  if (!documents || typeof documents.runMutationForScope !== 'function') return operation();
  const scopes = [...new Set((await Promise.all(
    targetPaths.map((targetPath) => resolveVSCodeWorkspaceScope(workspace, targetPath)),
  )).filter((scope): scope is string => Boolean(scope)))];
  if (scopes.length === 0) return operation();
  if (scopes.length === 1 || typeof documents.registerWriterForScope !== 'function') {
    return documents.runMutationForScope(scopes[0]!, owner, operation, mutation);
  }
  const writers: Array<Awaited<ReturnType<NonNullable<MutationAuthorityLike['registerWriterForScope']>>>> = [];
  try {
    for (const scope of scopes) {
      const writer = await documents.registerWriterForScope(scope, owner, mutation);
      if (writer) writers.push(writer);
    }
    return await operation();
  } finally {
    for (const writer of writers.reverse()) {
      try { await writer?.markMutated(); } catch { /* authority may already be gone */ }
      try { await writer?.close(); } catch { /* authority may already be gone */ }
    }
  }
};

/**
 * Keep a process-mode writer alive for the complete lifetime of a native
 * process-backed operation. Unlike runVSCodeMutation, this uses the authority's
 * explicit writer handle so callers can release it on success, failure, or
 * cancellation without leaving an active writer behind.
 */
export const runVSCodeProcessMutation = async <T>(options: {
  workspace: VSCodeWorkspaceLike;
  documents?: MutationAuthorityLike;
  targetPaths: readonly string[];
  owner: MutationOwner;
  operation: () => PromiseLike<T> | T;
  purpose: string;
}): Promise<T> => {
  const { workspace, documents, targetPaths, owner, operation, purpose } = options;
  if (!documents || typeof documents.registerWriterForScope !== 'function') return operation();
  const scopes = [...new Set((await Promise.all(
    targetPaths.map((targetPath) => resolveVSCodeWorkspaceScope(workspace, targetPath)),
  )).filter((scope): scope is string => Boolean(scope)))];
  if (scopes.length === 0) return operation();
  const writers: Array<Awaited<ReturnType<NonNullable<MutationAuthorityLike['registerWriterForScope']>>>> = [];
  try {
    for (const scope of scopes) {
      const writer = await documents.registerWriterForScope(scope, owner, {
        mode: 'process',
        purpose,
      });
      if (writer) writers.push(writer);
    }
    return await operation();
  } finally {
    for (const writer of writers.reverse()) {
      try { await writer?.markMutated(); } catch { /* authority may already be gone */ }
      try { await writer?.close(); } catch { /* authority may already be gone */ }
    }
  }
};

export const createVSCodeDocumentAuthority = (options: {
  hostId: string;
  dataDir: string;
  workspace: VSCodeWorkspaceLike;
}) => createDocumentAuthority({
  hostId: options.hostId,
  dataDir: options.dataDir,
  isTrusted: async () => options.workspace.isTrusted !== false,
  isAllowedRoot: async (canonicalPath: string) => {
    const folders = options.workspace.workspaceFolders ?? [];
    const normalized = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    return folders.some((folder) => {
      const root = process.platform === 'win32' ? folder.uri.fsPath.toLowerCase() : folder.uri.fsPath;
      return normalized === root || normalized.startsWith(`${root}${path.sep}`);
    });
  },
});

export { createDocumentsCapabilityHandler };
