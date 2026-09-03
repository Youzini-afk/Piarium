import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";

type LanguageSupervisor = ReturnType<typeof createLanguageSupervisor>;

interface CachedDiagnostics {
  items: Array<{
    line: number;
    character: number;
    severity: string;
    code?: string;
    message: string;
    source: string;
  }>;
  generation: number | undefined;
}

/**
 * Adapts the LanguageSupervisor's event-based diagnostics into the
 * DiagnosticsProvider interface expected by the harness diagnostics service.
 *
 * Subscribes to diagnostics events for each workspace and caches the latest
 * items per resource. When getDiagnostics is called, returns the cached items.
 */
export function createLanguageSupervisorDiagnosticsProvider(
  supervisor: LanguageSupervisor,
  _options: { resolveWorkspaceId: (workspaceRoot: string) => Promise<string | null> },
): DiagnosticsProvider {
  // workspaceId → resourceId → cached diagnostics
  const cache = new Map<string, Map<string, CachedDiagnostics>>();
  // workspaceId → subscriptions
  const subscriptions = new Map<string, () => void>();

  const ensureSubscription = (workspaceId: string): void => {
    if (subscriptions.has(workspaceId)) return;
    const sub = supervisor.subscribe(workspaceId, (event: unknown) => {
      const e = event as { kind?: string; resourceId?: string; generation?: number; items?: unknown[] };
      if (e.kind !== "diagnostics" || typeof e.resourceId !== "string") return;
      let wsCache = cache.get(workspaceId);
      if (!wsCache) {
        wsCache = new Map();
        cache.set(workspaceId, wsCache);
      }
      const items = Array.isArray(e.items) ? e.items.map((item) => {
        const d = item as {
          line?: number;
          character?: number;
          severity?: string;
          code?: string;
          message?: string;
          source?: string;
        };
        return {
          line: typeof d.line === "number" ? d.line : 0,
          character: typeof d.character === "number" ? d.character : 0,
          severity: typeof d.severity === "string" ? d.severity : "info",
          ...(d.code !== undefined ? { code: d.code } : {}),
          message: typeof d.message === "string" ? d.message : "",
          source: typeof d.source === "string" ? d.source : "unknown",
        };
      }) : [];
      wsCache.set(e.resourceId, { items, generation: e.generation });
    });
    subscriptions.set(workspaceId, () => sub.close());
  };

  const getDiagnostics: DiagnosticsProvider["getDiagnostics"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    const wsCache = cache.get(workspaceId);
    if (!wsCache) return [];
    // Try exact match, then prefix match (path may be relative or absolute)
    const exact = wsCache.get(path);
    if (exact) return exact.items;
    // Try matching by suffix (resourceId may be a full URI or path)
    for (const [resourceId, cached] of wsCache) {
      if (resourceId.endsWith(path) || path.endsWith(resourceId)) {
        return cached.items;
      }
    }
    return [];
  };

  const syncDocument: DiagnosticsProvider["syncDocument"] = async (workspaceId, path, content, reason) => {
    ensureSubscription(workspaceId);
    // The supervisor's syncDocument expects a LanguageRequest shape
    const result = await supervisor.syncDocument({
      resource: { workspaceId, resourceId: path },
      content,
      reason,
    } as never);
    return { status: typeof result === "object" && result !== null && "status" in result ? (result as { status: string }).status : "ok" };
  };

  const getSnapshot: DiagnosticsProvider["getSnapshot"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    const wsCache = cache.get(workspaceId);
    if (!wsCache) return null;
    const cached = wsCache.get(path);
    if (!cached) return null;
    return cached.generation !== undefined ? String(cached.generation) : null;
  };

  const isAvailable: DiagnosticsProvider["isAvailable"] = async (workspaceId, path) => {
    ensureSubscription(workspaceId);
    // Check if the supervisor has a ready session for this workspace
    // We infer the languageId from the file extension
    const ext = path.lastIndexOf(".") >= 0 ? path.slice(path.lastIndexOf(".") + 1) : "";
    const languageIdMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      css: "css",
      html: "html",
      json: "json",
      md: "markdown",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
      sh: "shellscript",
      bash: "shellscript",
    };
    const languageId = languageIdMap[ext] ?? "plaintext";
    const status = supervisor.getStatus(workspaceId, languageId);
    return status.status === "ready" || status.status === "degraded";
  };

  return {
    getDiagnostics,
    syncDocument,
    getSnapshot,
    isAvailable,
  };
}
