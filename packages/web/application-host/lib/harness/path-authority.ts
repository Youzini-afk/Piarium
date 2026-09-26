import fs from "node:fs";
import path from "node:path";
import type { HarnessActorContext } from "@varin/protocol";
import type { HarnessAuthorizedPath } from "./router.js";
import {
  assertAbsolutePathInWorkspace,
  normalizePathIdentity,
  WorkspacePathError,
  type PathSafetyFsPromises,
} from "../workspace/path-safety.js";

export interface HarnessPathAuthorityOptions {
  authorityId: string;
  documents: { inspectWorkspace(workspaceId: string): Promise<{ root: string }> };
  fsPromises?: PathSafetyFsPromises;
  /** Test seam for interleaving a filesystem change with an authorized read. */
  readFsPromises?: Pick<typeof fs.promises, "open" | "stat">;
  pathModule?: typeof path;
  platform?: string;
}

export function createHarnessPathAuthority({
  authorityId,
  documents,
  fsPromises = fs.promises,
  readFsPromises = fs.promises,
  pathModule = path,
  platform = process.platform,
}: HarnessPathAuthorityOptions) {
  const resolve = async (
      actor: HarnessActorContext,
      inputPath: string,
      options: { allowMissing: boolean },
    ): Promise<HarnessAuthorizedPath | null> => {
      if (!actor.workspaceId) return null;
      const workspace = await documents.inspectWorkspace(actor.workspaceId);
      // Relative paths anchor at the session's operation dir (RR2 work
      // context), not always the workspace root. `operationDir` is stored
      // relative to the root; absent it falls back to the root itself.
      const baseDir = actor.operationDir
        ? pathModule.resolve(workspace.root, actor.operationDir)
        : workspace.root;
      const absolutePath = pathModule.isAbsolute(inputPath)
        ? inputPath
        : pathModule.resolve(baseDir, inputPath);
      try {
        const resolved = await assertAbsolutePathInWorkspace(absolutePath, {
          root: workspace.root,
          fsPromises,
          pathModule,
          allowMissing: options.allowMissing,
        });
        if (actor.workspaceScope?.length) {
          const targetIdentity = normalizePathIdentity(resolved.realPath, { pathModule, platform });
          let permitted = false;
          for (const scopePath of actor.workspaceScope) {
            const scopeAbsolute = pathModule.isAbsolute(scopePath)
              ? scopePath
              : pathModule.resolve(workspace.root, scopePath);
            try {
              const scope = await assertAbsolutePathInWorkspace(scopeAbsolute, {
                root: workspace.root,
                fsPromises,
                pathModule,
                allowMissing: true,
              });
              const scopeIdentity = normalizePathIdentity(scope.realPath, { pathModule, platform });
              const relative = pathModule.relative(scopeIdentity, targetIdentity);
              if (!relative || (relative !== ".." && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative))) {
                permitted = true;
                break;
              }
            } catch (error) {
              if (!(error instanceof WorkspacePathError)) throw error;
            }
          }
          if (!permitted) return null;
        }
        return {
          authorityId,
          workspaceId: actor.workspaceId,
          canonicalResourceId: normalizePathIdentity(resolved.realPath, { pathModule, platform }),
          resolvedPath: resolved.realPath,
          inputPath,
          resourceId: resolved.relativePath.split(pathModule.sep).join("/"),
        };
      } catch (error) {
        if (error instanceof WorkspacePathError) return null;
        throw error;
      }
    };

  const readAuthorizedFile = async (
    actor: HarnessActorContext,
    authorized: HarnessAuthorizedPath,
    signal?: AbortSignal,
  ): Promise<Buffer> => {
    if (authorized.authorityId !== authorityId || authorized.workspaceId !== actor.workspaceId) {
      throw new Error("Document read authorization changed");
    }
    if (!authorized.resolvedPath) throw new Error("Authorized disk target has no resolved filesystem path");
    signal?.throwIfAborted();
    const before = await resolve(actor, authorized.inputPath, { allowMissing: false });
    if (!before || before.canonicalResourceId !== authorized.canonicalResourceId
      || before.resourceId !== authorized.resourceId || before.resolvedPath !== authorized.resolvedPath) {
      throw new Error("Document path changed before reading");
    }

    // Open the canonical target selected during router authorization, never
    // the original alias. O_NOFOLLOW protects the final component on systems
    // that support it; handle identity checks below cover systems that do not.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const handle = await readFsPromises.open(
      authorized.resolvedPath,
      fs.constants.O_RDONLY | noFollow,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino === 0n) throw new Error("Document path is not a readable regular file");
      signal?.throwIfAborted();
      const bytes = await handle.readFile(signal ? { signal } : undefined);
      signal?.throwIfAborted();

      const after = await resolve(actor, authorized.inputPath, { allowMissing: false });
      if (!after || after.canonicalResourceId !== authorized.canonicalResourceId
        || after.resourceId !== authorized.resourceId || after.resolvedPath !== authorized.resolvedPath) {
        throw new Error("Document path changed while reading");
      }
      const current = await readFsPromises.stat(after.resolvedPath, { bigint: true });
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error("Document path changed while reading");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  };

  return {
    resolve,
    readAuthorizedFile,
  };
}

export type HarnessPathAuthority = ReturnType<typeof createHarnessPathAuthority>;
