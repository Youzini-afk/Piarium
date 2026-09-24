import type { HarnessServiceHost } from "./service-host.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import type { PdfMaterialRouteOptions } from "./pdf-material-routes.js";
import type { HarnessPathAuthority } from "./path-authority.js";
import type { HarnessActorContext } from "@varin/protocol";
import { createMaterialReadService } from "./material-read-service.js";

/** Authenticated UI requests resolve the session's execution workspace on the Host. */
export function createUserMaterialReadAdapter(
  getHost: () => HarnessServiceHost,
  runtime: Pick<ThreadRuntime, "scopeForSession">,
  paths: Pick<HarnessPathAuthority, "resolve">,
): PdfMaterialRouteOptions["readDocument"] {
  return async ({ sessionId, request, signal }) => {
    const scope = await runtime.scopeForSession(sessionId);
    const workspace = scope.snapshot?.workspace;
    const executionWorkspaceId = workspace?.kind === "workspace" ? workspace.authorityId ?? workspace.id : scope.workspaceId;
    const actor: HarnessActorContext = {
      authorityInstanceId: "ui-material-reader",
      sessionId,
      workerId: "ui-material-reader",
      workerGeneration: 0,
      workspaceId: executionWorkspaceId,
      grantedCapabilities: [],
    };
    const authorizedPaths = [];
    if (request.path !== undefined) {
      if (typeof request.path !== "string" || !request.path.trim()) {
        return { status: "failed", url: "", reason: "A non-empty document path is required" };
      }
      const authorized = await paths.resolve(actor, request.path, { allowMissing: true });
      if (!authorized) return { status: "failed", url: "", reason: "Document is outside the session workspace" };
      authorizedPaths.push(authorized);
    }
    return createMaterialReadService(getHost()).handle(request, {
      actor,
      requestSource: "user",
      sessionId,
      workspaceId: executionWorkspaceId,
      authorizedPaths,
      signal,
    });
  };
}
