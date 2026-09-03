/**
 * Host observers — subscribe to document/terminal/lsp/git events and write
 * them as `event` nodes to the knowledge store.
 *
 * Design: agent-harness.md §7.3
 * Plan: agent-harness-plan.md §2.3
 *
 * Source determination:
 * - Document write with active `pi-worker` writer → 'agent'
 * - Document write without active writer → 'user' (editor save) or 'external'
 * - Terminal exit from harness shell supervisor → 'agent'
 * - Terminal exit from user terminal tab → 'user'
 */

import type { KnowledgeStore, EventInput, EventSource, EventKind } from "./store.js";

// ── Observer interfaces ────────────────────────────────────────────

export interface DocumentWriteEvent {
  workspaceId: string;
  path: string;
  kind: "modified" | "created" | "deleted";
  /** Whether a pi-worker (agent) writer was active at write time */
  agentWriterActive: boolean;
}

export interface TerminalExitEvent {
  workspaceId: string;
  sessionId: string;
  command: string;
  exitCode: number;
  /** Whether this came from a harness shell (agent) or user terminal (user) */
  source: "harness" | "user";
}

export interface DiagnosticEvent {
  workspaceId: string;
  sessionId: string;
  path: string;
  count: number;
  worst: "error" | "warning";
}

export interface GitStatusEvent {
  workspaceId: string;
  branch?: string;
  changed?: number;
  note?: string;
}

// ── Source determination ───────────────────────────────────────────

export function determineWriteSource(agentWriterActive: boolean): EventSource {
  return agentWriterActive ? "agent" : "user";
}

export function determineTerminalSource(source: "harness" | "user"): EventSource {
  return source === "harness" ? "agent" : "user";
}

// ── Observer ───────────────────────────────────────────────────────

export interface ObserverDeps {
  store: KnowledgeStore;
  sessionId: string;
}

export function createObservers(deps: ObserverDeps) {
  const { store, sessionId } = deps;

  async function onDocumentWrite(event: DocumentWriteEvent): Promise<void> {
    const source = determineWriteSource(event.agentWriterActive);
    const input: EventInput = {
      kind: "edit",
      at: Date.now(),
      sessionId,
      text: `${event.kind} ${event.path}`,
      refs: { path: event.path },
      source,
    };
    await store.putEvent(input);
  }

  async function onTerminalExit(event: TerminalExitEvent): Promise<void> {
    const source = determineTerminalSource(event.source);
    const input: EventInput = {
      kind: "command",
      at: Date.now(),
      sessionId,
      text: `exit ${event.exitCode} · ${event.command}`,
      ...(event.sessionId ? { refs: { handle: event.sessionId } } : {}),
      source,
    };
    await store.putEvent(input);
  }

  async function onDiagnostics(event: DiagnosticEvent): Promise<void> {
    const input: EventInput = {
      kind: "diagnostic",
      at: Date.now(),
      sessionId,
      text: `${event.path}: ${event.count} ${event.worst}${event.count > 1 ? "s" : ""}`,
      refs: { path: event.path },
      source: "external",
    };
    await store.putEvent(input);
  }

  async function onGitStatus(event: GitStatusEvent): Promise<void> {
    const parts: string[] = [];
    if (event.branch) parts.push(`branch ${event.branch}`);
    if (event.changed !== undefined) parts.push(`${event.changed} files changed`);
    if (event.note) parts.push(event.note);
    const input: EventInput = {
      kind: "edit",
      at: Date.now(),
      sessionId,
      text: `git: ${parts.join(", ")}`,
      source: "external",
    };
    await store.putEvent(input);
  }

  return {
    onDocumentWrite,
    onTerminalExit,
    onDiagnostics,
    onGitStatus,
  };
}

export type Observers = ReturnType<typeof createObservers>;
