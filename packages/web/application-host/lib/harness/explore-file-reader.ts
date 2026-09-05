import type { HarnessActorContext } from "@piarium/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import type { HarnessPathAuthority } from "./path-authority.js";

export type ExploreFileSnapshot =
  | { status: "ready"; content: string; revision: string; source: "disk" }
  | { status: "unavailable" | "failed" | "stale" | "forbidden"; message: string };

export type ExploreFileReader = (
  actor: HarnessActorContext,
  path: string,
  signal: AbortSignal,
) => Promise<ExploreFileSnapshot>;

/** Text is always read through Documents; the actor scope also applies to derived search hits. */
export function createExploreFileReader(
  documents: Pick<DocumentAuthority, "read">,
  paths: Pick<HarnessPathAuthority, "resolve">,
): ExploreFileReader {
  return async (actor, path, signal) => {
    signal.throwIfAborted();
    try {
      const before = await paths.resolve(actor, path, { allowMissing: true });
      if (!before) return { status: "forbidden", message: "Path is outside the permitted workspace scope." };
      const snapshot = await documents.read({ workspaceId: before.workspaceId, resourceId: before.resourceId });
      signal.throwIfAborted();
      if (snapshot.status !== "ready") {
        return { status: "unavailable", message: `Document cannot be read (${snapshot.status}).` };
      }
      const after = await paths.resolve(actor, path, { allowMissing: true });
      signal.throwIfAborted();
      if (!after || before.canonicalResourceId !== after.canonicalResourceId) {
        return { status: "stale", message: "Path identity changed while reading. Search again." };
      }
      return { status: "ready", content: snapshot.content, revision: snapshot.revision, source: "disk" };
    } catch {
      signal.throwIfAborted();
      return { status: "failed", message: "Document read failed. Retry the read or inspect workspace availability." };
    }
  };
}
