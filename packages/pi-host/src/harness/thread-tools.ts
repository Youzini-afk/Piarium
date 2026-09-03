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

const ThreadListParams = Type.Object({});

const ThreadWaitParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String())),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ThreadSendParams = Type.Object({
  threadId: Type.String(),
  message: Type.String(),
});

const ThreadReadParams = Type.Object({
  threadId: Type.String(),
  steps: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ThreadMergeParams = Type.Object({
  threadId: Type.String(),
});

const ThreadKillParams = Type.Object({
  threadId: Type.String(),
});

export function createDispatchTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "dispatch",
    label: "Dispatch",
    description: "Dispatch a sub-agent thread with a role and task",
    promptSnippet: "dispatch: spawn a sub-agent thread with a role and task",
    promptGuidelines: [
      "Use dispatch for parallelizable sub-tasks. Each thread runs independently.",
    ],
    parameters: DispatchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.dispatch">("thread.dispatch", {
          parentSessionId: sessionId,
          role: params.role,
          task: params.task,
          ...(params.scope !== undefined ? { scope: params.scope } : {}),
        });
        const typed = result as ThreadDispatchResult;
        return { content: [{ type: "text", text: typed.text }], details: { threadId: typed.threadId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `dispatch failed: ${message}` }], details: {} };
      }
    },
  });
}

export function createThreadsTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "threads",
    label: "Threads",
    description: "List all sub-agent threads for this session",
    promptSnippet: "threads: list all sub-agent threads for this session",
    promptGuidelines: [],
    parameters: ThreadListParams,
    executionMode: "parallel",
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.list">("thread.list", {
          parentSessionId: sessionId,
        });
        const typed = result as ThreadListResult;
        if (typed.threads.length === 0) {
          return { content: [{ type: "text", text: "no threads" }], details: { count: 0 } };
        }
        const lines = typed.threads.map((t) =>
          `${t.id} (${t.role ?? "unknown"}) \u2014 ${t.status} \u00b7 ${t.brief} \u00b7 ${t.steps} steps \u00b7 ${t.lastActivityAt}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: typed.threads.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `threads failed: ${message}` }], details: { count: 0 } };
      }
    },
  });
}

export function createWaitTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "wait",
    label: "Wait",
    description: "Wait for sub-agent threads to complete",
    promptSnippet: "wait: wait for sub-agent threads to complete",
    promptGuidelines: [],
    parameters: ThreadWaitParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.wait">("thread.wait", {
          parentSessionId: sessionId,
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        });
        const typed = result as ThreadWaitResult;
        return { content: [{ type: "text", text: typed.text }], details: { done: typed.done, running: typed.running, queued: typed.queued } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `wait failed: ${message}` }], details: {} };
      }
    },
  });
}

export function createSendTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "send",
    label: "Send",
    description: "Send a message to a sub-agent thread",
    promptSnippet: "send: send a message to a sub-agent thread",
    promptGuidelines: [],
    parameters: ThreadSendParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.send">("thread.send", {
          parentSessionId: sessionId,
          threadId: params.threadId,
          message: params.message,
          from: "parent-agent",
        });
        const typed = result as ThreadSendResult;
        return { content: [{ type: "text", text: typed.accepted ? "sent" : "not accepted" }], details: { accepted: typed.accepted } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `send failed: ${message}` }], details: { accepted: false } };
      }
    },
  });
}

export function createReadThreadTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "read_thread",
    label: "Read Thread",
    description: "Read a sub-agent thread's status and report",
    promptSnippet: "read_thread: read a sub-agent thread's status and report",
    promptGuidelines: [],
    parameters: ThreadReadParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.read">("thread.read", {
          parentSessionId: sessionId,
          threadId: params.threadId,
          ...(params.steps !== undefined ? { steps: params.steps } : {}),
        });
        const typed = result as ThreadReadResult;
        return { content: [{ type: "text", text: typed.text }], details: { hasReport: typed.report !== null } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `read_thread failed: ${message}` }], details: { hasReport: false } };
      }
    },
  });
}

export function createMergeTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "merge",
    label: "Merge",
    description: "Merge a completed sub-agent thread's worktree diff into the parent",
    promptSnippet: "merge: merge a completed sub-agent thread's changes",
    promptGuidelines: [],
    parameters: ThreadMergeParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.merge">("thread.merge", {
          parentSessionId: sessionId,
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

export function createKillTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "kill",
    label: "Kill",
    description: "Kill a sub-agent thread",
    promptSnippet: "kill: kill a sub-agent thread",
    promptGuidelines: [],
    parameters: ThreadKillParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.kill">("thread.kill", {
          parentSessionId: sessionId,
          threadId: params.threadId,
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
