import type { DiagnosticsResult } from "@piarium/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";

export interface DiagnosticsProvider {
  getDiagnostics(workspaceId: string, path: string): Promise<Array<{
    line: number;
    character: number;
    severity: string;
    code?: string;
    message: string;
    source: string;
  }>>;
  syncDocument(workspaceId: string, path: string, content: string, reason: "change" | "save"): Promise<{ status: string }>;
  getSnapshot(workspaceId: string, path: string): Promise<string | null>;
}

export function createLspDiagnosticsService(provider: DiagnosticsProvider): HarnessService<"lsp.diagnostics"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!ctx.workspaceId) {
        return { status: "unavailable", diagnostics: [] };
      }
      try {
        // If afterSnapshot is provided, sync the document first
        if (params.afterSnapshot) {
          await provider.syncDocument(ctx.workspaceId, params.path, params.afterSnapshot, "save");
        }
        // Wait for diagnostics to settle (best-effort)
        const waitMs = params.waitMs ?? 500;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const diagnostics = await provider.getDiagnostics(ctx.workspaceId, params.path);
        const snapshot = await provider.getSnapshot(ctx.workspaceId, params.path);
        return {
          status: "ready",
          ...(snapshot !== null ? { snapshot } : {}),
          diagnostics,
        };
      } catch {
        return { status: "unavailable", diagnostics: [] };
      }
    },
  };
}

export function createLspDiagnosticsSnapshotService(provider: DiagnosticsProvider): HarnessService<"lsp.diagnosticsSnapshot"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!ctx.workspaceId) {
        return { status: "unavailable", diagnostics: [] };
      }
      try {
        const diagnostics = await provider.getDiagnostics(ctx.workspaceId, params.path);
        const snapshot = await provider.getSnapshot(ctx.workspaceId, params.path);
        return {
          status: "ready",
          ...(snapshot !== null ? { snapshot } : {}),
          diagnostics,
        };
      } catch {
        return { status: "unavailable", diagnostics: [] };
      }
    },
  };
}
