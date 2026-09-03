import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HostEventData } from "@piarium/protocol";
import type { HostServicesBridge } from "./harness/host-services-bridge.js";

type WorkspaceMutationRequest = HostEventData<"workspace.mutation.request">;
type WorkspaceMutationToolName = WorkspaceMutationRequest["toolName"];
type WithoutRequestIdentity<T> = T extends unknown
  ? Omit<T, "requestId" | "sessionId">
  : never;
type WorkspaceMutationRequestInput = WithoutRequestIdentity<WorkspaceMutationRequest>;

interface PendingMutationRequest {
  resolve: (accepted: boolean) => void;
  sessionId: string;
}

export interface WorkspaceMutationJournalBridgeOptions {
  emit: (event: "workspace.mutation.request", data: WorkspaceMutationRequest) => void;
  sessionId: string;
}

export class WorkspaceMutationJournalBridge {
  readonly #emit: WorkspaceMutationJournalBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingMutationRequest>();
  readonly #sessionId: string;
  #disposed = false;

  constructor(options: WorkspaceMutationJournalBridgeOptions) {
    this.#emit = options.emit;
    this.#sessionId = options.sessionId;
  }

  async request(
    input: WorkspaceMutationRequestInput,
  ): Promise<boolean> {
    if (this.#disposed) return false;
    const requestId = randomUUID();
    let resolveResponse: (accepted: boolean) => void = () => {};
    const response = new Promise<boolean>((resolvePending) => {
      resolveResponse = resolvePending;
    });
    this.#pending.set(requestId, {
      resolve: resolveResponse,
      sessionId: this.#sessionId,
    });
    try {
      this.#emit("workspace.mutation.request", {
        ...input,
        requestId,
        sessionId: this.#sessionId,
      });
    } catch {
      this.#pending.delete(requestId);
      return false;
    }
    return response;
  }

  respond(sessionId: string, requestId: string, accepted: boolean): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.#pending.delete(requestId);
    pending.resolve(accepted);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.resolve(false);
    this.#pending.clear();
  }
}

interface JournaledExecutionOptions<TResult> {
  bridge: WorkspaceMutationJournalBridge;
  cwd: string;
  execute: () => Promise<TResult>;
  inputPath: string;
  toolCallId: string;
  toolName: WorkspaceMutationToolName;
  hostServicesBridge?: HostServicesBridge;
  sessionId?: string;
}

async function fetchDiagnostics(
  bridge: HostServicesBridge,
  path: string,
): Promise<{ status: string; summary: string } | null> {
  try {
    const result = await bridge.request("lsp.diagnostics", { path, waitMs: 500 });
    if (result.status === "unavailable") return { status: "unavailable", summary: "diagnostics unavailable" };
    if (result.diagnostics.length === 0) return { status: "clean", summary: "clean (0 diagnostics)" };
    const errors = result.diagnostics.filter((d: { severity: string }) => d.severity === "error").length;
    const warnings = result.diagnostics.filter((d: { severity: string }) => d.severity === "warning").length;
    const summary = `${result.diagnostics.length} diagnostic(s)${errors > 0 ? `, ${errors} error(s)` : ""}${warnings > 0 ? `, ${warnings} warning(s)` : ""}`;
    return { status: "pending", summary };
  } catch {
    return { status: "unavailable", summary: "diagnostics unavailable" };
  }
}

async function executeWithMutationJournal<TResult extends { content: Array<{ type: string; text?: string }> }>(
  options: JournaledExecutionOptions<TResult>,
): Promise<TResult> {
  const path = resolve(options.cwd, options.inputPath);
  await options.bridge.request({
    path,
    phase: "before",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
  });
  let succeeded = false;
  try {
    const result = await options.execute();
    succeeded = true;
    return result;
  } finally {
    await options.bridge.request({
      path,
      phase: "after",
      succeeded,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
    });
    // Best-effort diagnostics after mutation
    if (succeeded && options.hostServicesBridge) {
      const diag = await fetchDiagnostics(options.hostServicesBridge, path);
      if (diag && diag.status !== "clean") {
        // Append diagnostics summary to the result content
        // This is best-effort: if the result is immutable, we skip
        try {
          const firstText = result.content.find((c: { type: string }) => c.type === "text");
          if (firstText && typeof firstText.text === "string") {
            firstText.text = `${firstText.text}\n\n[diagnostics: ${diag.summary}]`;
          }
        } catch {
          // Result may be frozen; skip
        }
      }
    }
  }
}

export function createWorkspaceMutationJournalTools(
  cwd: string,
  bridge: WorkspaceMutationJournalBridge,
  hostServicesBridge?: HostServicesBridge,
  sessionId?: string,
): ToolDefinition[] {
  const write = createWriteToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const journaledWrite = defineTool({
    ...write,
    execute: (toolCallId, params, signal, onUpdate, ctx) => executeWithMutationJournal({
      bridge,
      cwd,
      execute: () => write.execute(toolCallId, params, signal, onUpdate, ctx),
      inputPath: params.path,
      toolCallId,
      toolName: "write",
      ...(hostServicesBridge ? { hostServicesBridge } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  });
  const journaledEdit = defineTool({
    ...edit,
    execute: (toolCallId, params, signal, onUpdate, ctx) => executeWithMutationJournal({
      bridge,
      cwd,
      execute: () => edit.execute(toolCallId, params, signal, onUpdate, ctx),
      inputPath: params.path,
      toolCallId,
      toolName: "edit",
      ...(hostServicesBridge ? { hostServicesBridge } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  });
  return [journaledWrite, journaledEdit];
}
