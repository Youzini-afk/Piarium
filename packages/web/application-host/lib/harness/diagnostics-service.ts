import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { DiagnosticItem } from "@piarium/protocol";
import type { ObservationCursorStore } from "./observation-cursors.js";

export interface DiagnosticsProvider {
  getDiagnostics(workspaceId: string, path: string): Promise<DiagnosticItem[]>;
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
          const waitMs = params.waitMs ?? 5000;
          // Subscribe and capture the publication cursor before didOpen/didChange.
          // A language server may publish synchronously after the notification;
          // reading the baseline afterwards would swallow that update.
          const [beforeDiags, beforeSnapshot] = await Promise.all([
            provider.getDiagnostics(ctx.workspaceId, params.path),
            provider.getSnapshot(ctx.workspaceId, params.path),
          ]);
          const beforeKeys = new Set(beforeDiags.map((d) => `${d.line}:${d.character}:${d.message}`));
          const synced = await provider.syncDocument(ctx.workspaceId, params.path, params.afterSnapshot, "save");
          if (synced.status === "failed" || synced.status === "unsupported") {
            return { status: "unavailable", diagnostics: [], reason: "language server rejected document synchronization" };
          }
          // Wait for a publication, including an authoritative empty list when
          // an edit resolves the final diagnostic.
          const deadline = Date.now() + waitMs;
          let lastDiags = beforeDiags;
          let snapshot = beforeSnapshot;
          while (Date.now() < deadline) {
            [lastDiags, snapshot] = await Promise.all([
              provider.getDiagnostics(ctx.workspaceId, params.path),
              provider.getSnapshot(ctx.workspaceId, params.path),
            ]);
            if (snapshot !== beforeSnapshot) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (snapshot === beforeSnapshot) {
            return { status: "pending", diagnostics: [], reason: "diagnostics not yet published" };
          }
          const newDiags = lastDiags.filter((d) => !beforeKeys.has(`${d.line}:${d.character}:${d.message}`));
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

interface DiagnosticsCursor {
  diagnostics: DiagnosticItem[];
}

const diagnosticFingerprint = (diagnostic: DiagnosticItem): string => JSON.stringify([
  diagnostic.line,
  diagnostic.character,
  diagnostic.severity,
  diagnostic.code ?? null,
  diagnostic.message,
  diagnostic.source,
]);

const subtractDiagnostics = (left: readonly DiagnosticItem[], right: readonly DiagnosticItem[]): DiagnosticItem[] => {
  const remaining = new Map<string, number>();
  for (const diagnostic of right) {
    const key = diagnosticFingerprint(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return left.filter((diagnostic) => {
    const key = diagnosticFingerprint(diagnostic);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
    return false;
  });
};

export function createLspDiagnosticsSnapshotService(
  provider: DiagnosticsProvider,
  cursors: ObservationCursorStore,
): HarnessService<"lsp.diagnosticsSnapshot"> {
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
        if (params.full === true) {
          const diagnostics = await provider.getDiagnostics(ctx.workspaceId, params.path);
          const snapshot = await provider.getSnapshot(ctx.workspaceId, params.path);
          return {
            status: "ready",
            ...(snapshot !== null ? { snapshot } : {}),
            diagnostics,
          };
        }
        const canonicalResourceId = ctx.authorizedPaths[0]?.canonicalResourceId ?? params.path;
        const objectId = `${ctx.workspaceId}\0${canonicalResourceId}`;
        return cursors.observe<DiagnosticsCursor, import("@piarium/protocol").DiagnosticsResult>(
          ctx.sessionId,
          "diagnostics",
          objectId,
          async (previous) => {
            const diagnostics = await provider.getDiagnostics(ctx.workspaceId!, params.path);
            const snapshot = await provider.getSnapshot(ctx.workspaceId!, params.path);
            const added = previous === null
              ? diagnostics
              : subtractDiagnostics(diagnostics, previous.value.diagnostics);
            const resolved = previous === null
              ? []
              : subtractDiagnostics(previous.value.diagnostics, diagnostics);
            const now = cursors.now();
            return {
              cursor: { diagnostics },
              result: {
                status: "ready",
                ...(snapshot !== null ? { snapshot } : {}),
                diagnostics: added,
                resolvedDiagnostics: resolved,
                observation: {
                  mode: "incremental",
                  first: previous === null,
                  ...(previous === null ? {} : { sinceMs: Math.max(0, now - previous.observedAt) }),
                  added: added.length,
                  resolved: resolved.length,
                },
              },
            };
          },
        );
      } catch {
        return { status: "unavailable", diagnostics: [], reason: "diagnostics request failed" };
      }
    },
  };
}
