import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  ResolvedRole,
  ThreadDispatchResult,
  ThreadListResult,
  ThreadWaitResult,
  ThreadSendResult,
  ThreadReadResult,
  ThreadMergeResult,
  ThreadKillResult,
} from "@piarium/protocol";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, buildTeamPrompt } from "@piarium/protocol";

/**
 * Build an error result for a thread tool failure.
 * Returns isError:true with the harness error code and message.
 */
function threadErrorResult(toolName: string, error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error instanceof HarnessRequestError || (error as { code?: string }).code !== undefined)
    ? (error as { code: string }).code
    : "failed";
  return {
    content: [{ type: "text", text: `${toolName} failed (${code}): ${message}` }],
    isError: true,
    details: { code },
  };
}

const DispatchParams = Type.Object({
  role: Type.String(),
  task: Type.String(),
  scope: Type.Optional(Type.Array(Type.String())),
});

const ThreadListParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String())),
  full: Type.Optional(Type.Boolean()),
});

const ThreadWaitParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String())),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ThreadSendParams = Type.Object({
  threadId: Type.String(),
  message: Type.String(),
});

const ThreadReadParams = Type.Object({
  threadId: Type.String(),
  what: Type.Optional(Type.Union([
    Type.Literal("blocks"),
    Type.Literal("report"),
    Type.Literal("steps"),
  ])),
  since: Type.Optional(Type.Integer({ minimum: 0 })),
});

const ThreadMergeParams = Type.Object({
  threadId: Type.String(),
});

const ThreadKillParams = Type.Object({
  threadId: Type.String(),
  keep_worktree: Type.Optional(Type.Boolean()),
});

/**
 * `dispatch` presents the roles as a team (§9.2.4). Only roles whose model
 * slot resolves are listed and accepted: an unconfigured slot means the
 * capability is not registered rather than silently borrowing the main
 * model (invariant 6). The team prompt is generated from that role set at
 * session creation, so it is static for the session and does not invalidate
 * the prefix cache.
 */
export function createDispatchTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  roles: readonly ResolvedRole[] = [],
): ToolDefinition {
  const available = roles.map((r) => r.id);
  const teamPrompt = buildTeamPrompt([...roles]);
  return defineTool({
    name: "dispatch",
    label: "Dispatch",
    description: "Dispatch a sub-agent thread with a role and task. Asynchronous — returns immediately, never blocks.",
    promptSnippet: "dispatch: spawn a sub-agent thread with a role and task",
    promptGuidelines: [
      "Dispatch is asynchronous. Use wait to block until something changes; threads is a quick non-blocking glance — do not call it in a loop.",
      "Teammates report deviations from your brief; trust the report over your assumptions.",
      "read_thread shows a teammate's notes first; only read steps when the notes are not enough.",
      ...(teamPrompt ? [teamPrompt] : []),
    ],
    parameters: DispatchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!available.includes(params.role as ResolvedRole["id"])) {
        return {
          content: [{
            type: "text" as const,
            text: `unknown role: ${params.role}. Available roles: ${available.join(", ") || "(none configured)"}`,
          }],
          isError: true,
          details: { code: "invalid-params", availableRoles: available },
        };
      }
      try {
        const result = await bridge.request<"thread.dispatch">("thread.dispatch", {
          role: params.role,
          task: params.task,
          ...(params.scope !== undefined ? { scope: params.scope } : {}),
        });
        const typed = result as ThreadDispatchResult;
        return { content: [{ type: "text", text: typed.text }], details: { threadId: typed.threadId, queued: typed.queued } };
      } catch (error) {
        return threadErrorResult("dispatch", error);
      }
    },
  });
}

export function createThreadsTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "threads",
    label: "Threads",
    description: "List sub-agent threads — non-blocking dashboard glance. Default incremental (only changes since last view). Use wait to block instead of polling.",
    promptSnippet: "threads: quick non-blocking glance at sub-agent threads",
    promptGuidelines: [
      "threads is a quick non-blocking glance — do not call it in a loop. Use wait to block until something changes.",
    ],
    parameters: ThreadListParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.list">("thread.list", {
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          ...(params.full !== undefined ? { full: params.full } : {}),
        });
        const typed = result as ThreadListResult;
        return { content: [{ type: "text", text: typed.text }], details: { count: typed.threads.length } };
      } catch (error) {
        return threadErrorResult("threads", error);
      }
    },
  });
}

export function createWaitTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "wait",
    label: "Wait",
    description: "Block until any sub-agent thread changes state or timeout. Timeout is a normal result, not an error. Done threads include full report.",
    promptSnippet: "wait: block until a teammate changes state (timeout is normal)",
    promptGuidelines: [
      "wait blocks until a teammate changes state; timeout is a normal result, not an error.",
    ],
    parameters: ThreadWaitParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const waitTimeout = Math.min(
          params.timeout_ms ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
          HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
        );
        // Pass timeout + 5s buffer to bridge so the bridge/router don't
        // time out before the service's internal wait timeout fires.
        const result = await bridge.request<"thread.wait">("thread.wait", {
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          timeoutMs: waitTimeout,
        }, { timeoutMs: Math.min(waitTimeout + 5_000, HARNESS_MAX_REQUEST_TIMEOUT_MS), ...(signal ? { signal } : {}) });
        const typed = result as ThreadWaitResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: {
            done: typed.done,
            running: typed.running,
            waiting: typed.waiting,
            queued: typed.queued,
            timedOut: typed.timedOut,
          },
        };
      } catch (error) {
        return threadErrorResult("wait", error);
      }
    },
  });
}

export function createSendTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "send",
    label: "Send",
    description: "Send a message to a sub-agent thread. Wakes idle or waiting-for-input threads. Message is marked as from parent agent.",
    promptSnippet: "send: pass a teammate new information; wakes idle or waiting threads",
    promptGuidelines: [],
    parameters: ThreadSendParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.send">("thread.send", {
          threadId: params.threadId,
          message: params.message,
          from: "parent-agent",
        });
        const typed = result as ThreadSendResult;
        const state = `${typed.lifecycle}/${typed.attention}`;
        return { content: [{ type: "text", text: typed.accepted ? `sent to ${params.threadId} (${state})` : "not accepted" }], details: { accepted: typed.accepted, lifecycle: typed.lifecycle, attention: typed.attention } };
      } catch (error) {
        return threadErrorResult("send", error);
      }
    },
  });
}

export function createReadThreadTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "read_thread",
    label: "Read Thread",
    description: "Read a sub-agent thread's notes. Default 'blocks' (progress/decisions/errors), 'report' for final report, 'steps' for transcript slice.",
    promptSnippet: "read_thread: read a teammate's notes (blocks), report, or steps",
    promptGuidelines: [
      "read_thread shows a teammate's notes first; only read steps when the notes are not enough.",
    ],
    parameters: ThreadReadParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.read">("thread.read", {
          threadId: params.threadId,
          ...(params.what !== undefined ? { what: params.what } : {}),
          ...(params.since !== undefined ? { since: params.since } : {}),
        });
        const typed = result as ThreadReadResult;
        return { content: [{ type: "text", text: typed.text }], details: { hasReport: typed.report !== null, traceHandle: typed.traceHandle } };
      } catch (error) {
        return threadErrorResult("read_thread", error);
      }
    },
  });
}

export function createMergeTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "merge",
    label: "Merge",
    description: "Merge a completed sub-agent thread's worktree diff into the parent. Uses git apply --3way; conflicts leave markers in place.",
    promptSnippet: "merge: merge a completed teammate's changes into your worktree",
    promptGuidelines: [],
    parameters: ThreadMergeParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.merge">("thread.merge", {
          threadId: params.threadId,
        });
        const typed = result as ThreadMergeResult;
        return { content: [{ type: "text", text: typed.text }], details: { merged: typed.merged, conflicts: typed.conflicts } };
      } catch (error) {
        return threadErrorResult("merge", error);
      }
    },
  });
}

export function createKillTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "kill",
    label: "Kill",
    description: "Kill a sub-agent thread. Default keeps worktree (half-finished work is never lost).",
    promptSnippet: "kill: stop a teammate; worktree is kept by default",
    promptGuidelines: [],
    parameters: ThreadKillParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.kill">("thread.kill", {
          threadId: params.threadId,
          ...(params.keep_worktree !== undefined ? { keepWorktree: params.keep_worktree } : {}),
        });
        const typed = result as ThreadKillResult;
        return { content: [{ type: "text", text: typed.text }], details: {} };
      } catch (error) {
        return threadErrorResult("kill", error);
      }
    },
  });
}
