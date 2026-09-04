import fs from "node:fs";
import path from "node:path";
import type { HarnessActorContext } from "@piarium/protocol";
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
  pathModule?: typeof path;
  platform?: string;
}

export function createHarnessPathAuthority({
  authorityId,
  documents,
  fsPromises = fs.promises,
  pathModule = path,
  platform = process.platform,
}: HarnessPathAuthorityOptions) {
  return {
    async resolve(
      actor: HarnessActorContext,
      inputPath: string,
      options: { allowMissing: boolean },
    ): Promise<HarnessAuthorizedPath | null> {
      if (!actor.workspaceId) return null;
      const workspace = await documents.inspectWorkspace(actor.workspaceId);
      const absolutePath = pathModule.isAbsolute(inputPath)
        ? inputPath
        : pathModule.resolve(workspace.root, inputPath);
      try {
        const resolved = await assertAbsolutePathInWorkspace(absolutePath, {
          root: workspace.root,
          fsPromises,
          pathModule,
          allowMissing: options.allowMissing,
        });
        return {
          authorityId,
          workspaceId: actor.workspaceId,
          canonicalResourceId: normalizePathIdentity(resolved.realPath, { pathModule, platform }),
          inputPath,
        };
      } catch (error) {
        if (error instanceof WorkspacePathError) return null;
        throw error;
      }
    },
  };
}

export type HarnessPathAuthority = ReturnType<typeof createHarnessPathAuthority>;
