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
  /** Check if a language server is available for the given workspace + path. */
  isAvailable(workspaceId: string, path: string): Promise<boolean>;
}

/**
 * Diagnostics service semantics:
 * - No server → unavailable (text: "[diagnostics: unavailable — <reason>]")
 * - Server available, afterSnapshot provided → sync document, wait for
 *   diagnostics newer than the before-snapshot, up to waitMs (default 5000).
 *   If diagnostics arrive → ready (only return NEW diagnostics vs before).
 *   If timeout → pending (text: "[diagnostics: pending — call diagnostics(\"<path>\")]")
 * - Server available, no afterSnapshot → ready (return current diagnostics).
 */
export function createLspDiagnosticsService(provider: DiagnosticsProvider): HarnessService<"lsp.diagnostics"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!ctx.workspaceId) {
        return { status: "unavailable", diagnostics: [], reason: "no workspace" };
      }
      const available = await provider.isAvailable(ctx.workspaceId, params.path);
      if (!available) {
        return { status: "unavailable", diagnostics: [], reason: "no language server for this file type" };
      }
      try {
        // If afterSnapshot is provided, sync the document and wait for new diagnostics
        if (params.afterSnapshot) {
          await provider.syncDocument(ctx.workspaceId, params.path, params.afterSnapshot, "save");
          const waitMs = params.waitMs ?? 5000;
          // Get before-snapshot diagnostics for diff
          const beforeDiags = await provider.getDiagnostics(ctx.workspaceId, params.path);
          const beforeKeys = new Set(beforeDiags.map((d) => `${d.line}:${d.character}:${d.message}`));
          // Poll for new diagnostics up to waitMs
          const deadline = Date.now() + waitMs;
          let lastDiags = beforeDiags;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            lastDiags = await provider.getDiagnostics(ctx.workspaceId, params.path);
            // Check if any diagnostics are new (not in beforeKeys)
            const hasNew = lastDiags.some((d) => !beforeKeys.has(`${d.line}:${d.character}:${d.message}`));
            if (hasNew) break;
          }
          // Check if we got new diagnostics
          const newDiags = lastDiags.filter((d) => !beforeKeys.has(`${d.line}:${d.character}:${d.message}`));
          if (newDiags.length === 0 && Date.now() >= deadline) {
            // Timed out waiting for diagnostics
            return { status: "pending", diagnostics: [], reason: "diagnostics not yet published" };
          }
          const snapshot = await provider.getSnapshot(ctx.workspaceId, params.path);
          return {
            status: "ready",
            ...(snapshot !== null ? { snapshot } : {}),
            diagnostics: newDiags,
          };
        }
        // No afterSnapshot — just return current diagnostics
        const diagnostics = await provider.getDiagnostics(ctx.workspaceId, params.path);
        const snapshot = await provider.getSnapshot(ctx.workspaceId, params.path);
        return {
          status: "ready",
          ...(snapshot !== null ? { snapshot } : {}),
          diagnostics,
        };
      } catch {
        return { status: "unavailable", diagnostics: [], reason: "diagnostics request failed" };
      }
    },
  };
}

export function createLspDiagnosticsSnapshotService(provider: DiagnosticsProvider): HarnessService<"lsp.diagnosticsSnapshot"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!ctx.workspaceId) {
        return { status: "unavailable", diagnostics: [], reason: "no workspace" };
      }
      const available = await provider.isAvailable(ctx.workspaceId, params.path);
      if (!available) {
        return { status: "unavailable", diagnostics: [], reason: "no language server for this file type" };
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
        return { status: "unavailable", diagnostics: [], reason: "diagnostics request failed" };
      }
    },
  };
}
