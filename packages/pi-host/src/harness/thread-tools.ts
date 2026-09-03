import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type {
  ThreadDispatchResult,
  ThreadListResult,
  ThreadWaitResult,
  ThreadSendResult,
  ThreadReadResult,
  ThreadMergeResult,
  ThreadKillResult,
} from "@piarium/protocol";

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

export function createDispatchTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "dispatch",
    label: "Dispatch",
    description: "Dispatch a sub-agent thread with a role and task. Asynchronous — returns immediately, never blocks.",
    promptSnippet: "dispatch: spawn a sub-agent thread with a role and task",
    promptGuidelines: [
      "Dispatch is asynchronous. Use wait to block until something changes; threads is a quick non-blocking glance — do not call it in a loop.",
      "Teammates report deviations from your brief; trust the report over your assumptions.",
      "read_thread shows a teammate's notes first; only read steps when the notes are not enough.",
    ],
    parameters: DispatchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.dispatch">("thread.dispatch", {
          parentSessionId,
          role: params.role,
          task: params.task,
          ...(params.scope !== undefined ? { scope: params.scope } : {}),
        });
        const typed = result as ThreadDispatchResult;
        return { content: [{ type: "text", text: typed.text }], details: { threadId: typed.threadId, queued: typed.queued } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `dispatch failed: ${message}` }], details: {} };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.list">("thread.list", {
          parentSessionId,
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          ...(params.full !== undefined ? { full: params.full } : {}),
        });
        const typed = result as ThreadListResult;
        return { content: [{ type: "text", text: typed.text }], details: { count: typed.threads.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `threads failed: ${message}` }], details: { count: 0 } };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.wait">("thread.wait", {
          parentSessionId,
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          ...(params.timeout_ms !== undefined ? { timeoutMs: params.timeout_ms } : {}),
        });
        const typed = result as ThreadWaitResult;
        return { content: [{ type: "text", text: typed.text }], details: { done: typed.done, running: typed.running, queued: typed.queued, timedOut: typed.timedOut } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `wait failed: ${message}` }], details: {} };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.send">("thread.send", {
          parentSessionId,
          threadId: params.threadId,
          message: params.message,
          from: "parent-agent",
        });
        const typed = result as ThreadSendResult;
        return { content: [{ type: "text", text: typed.accepted ? `sent to ${params.threadId} (${typed.status})` : "not accepted" }], details: { accepted: typed.accepted, status: typed.status } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `send failed: ${message}` }], details: { accepted: false } };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.read">("thread.read", {
          parentSessionId,
          threadId: params.threadId,
          ...(params.what !== undefined ? { what: params.what } : {}),
          ...(params.since !== undefined ? { since: params.since } : {}),
        });
        const typed = result as ThreadReadResult;
        return { content: [{ type: "text", text: typed.text }], details: { hasReport: typed.report !== null, traceHandle: typed.traceHandle } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `read_thread failed: ${message}` }], details: { hasReport: false, traceHandle: null } };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.merge">("thread.merge", {
          parentSessionId,
          threadId: params.threadId,
        });
        const typed = result as ThreadMergeResult;
        return { content: [{ type: "text", text: typed.text }], details: { merged: typed.merged, conflicts: typed.conflicts } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `merge failed: ${message}` }], details: { merged: 0, conflicts: [] } };
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const parentSessionId = ctx?.sessionManager.getSessionId() ?? _sessionId;
        const result = await bridge.request<"thread.kill">("thread.kill", {
          parentSessionId,
          threadId: params.threadId,
          ...(params.keep_worktree !== undefined ? { keepWorktree: params.keep_worktree } : {}),
        });
        const typed = result as ThreadKillResult;
        return { content: [{ type: "text", text: typed.text }], details: {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `kill failed: ${message}` }], details: {} };
      }
    },
  });
}
