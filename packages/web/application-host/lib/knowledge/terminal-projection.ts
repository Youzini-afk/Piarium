import type { TerminalCommandRecord } from "../terminal/session-api.js";
import type { TerminalCommandEvent } from "./observers.js";

export type TerminalMemoryNudgeCommand = {
  command: string;
  commandId: string;
  cwd?: string;
  exitCode: number;
};

export type TerminalCommandProjectionResult = Readonly<Record<string, boolean>>;

export interface TerminalCommandProjectorDeps {
  drain(): Promise<void>;
  inspectCwd?(terminalId: string): string | undefined;
  listBoundSessions(workspaceId: string): string[];
  nudgeMemory(sessionId: string, input: {
    commands: TerminalMemoryNudgeCommand[];
    reason: "user-command";
  }): Promise<unknown>;
  /** Persist the observation for one target Pi session. */
  observe(event: TerminalCommandEvent, targetSessionId?: string): boolean | Promise<boolean>;
  onError?(error: unknown): void;
  resolveWorkspaceId(scope: string): Promise<string | null>;
}

export type TerminalCommandObservationRuntime = {
  observeTerminalCommand(event: TerminalCommandEvent, targetSessionId?: string): Promise<boolean>;
};

/** The application-host adapter preserves the projector's target session. */
export const createTerminalCommandObserveAdapter = (
  runtime: TerminalCommandObservationRuntime,
): TerminalCommandProjectorDeps["observe"] => (
  (event, targetSessionId) => runtime.observeTerminalCommand(event, targetSessionId)
);

const commandFrom = (record: TerminalCommandRecord, cwd?: string): TerminalMemoryNudgeCommand => ({
  command: record.command,
  commandId: record.commandId,
  exitCode: record.exitCode,
  ...(cwd === undefined ? {} : { cwd }),
});

export function createTerminalCommandProjector(deps: TerminalCommandProjectorDeps) {
  const project = async (record: TerminalCommandRecord): Promise<TerminalCommandProjectionResult> => {
    if (record.owner !== "user") return {};
    const cwd = record.cwd ?? deps.inspectCwd?.(record.terminalId);
    if (!cwd) return {};
    let workspaceId: string | null;
    try {
      workspaceId = await deps.resolveWorkspaceId(cwd);
    } catch (error) {
      deps.onError?.(error);
      return {};
    }
    if (!workspaceId) return {};
    const event: TerminalCommandEvent = {
      workspaceId,
      sessionId: record.terminalId,
      command: record.command,
      commandId: record.commandId,
      exitCode: record.exitCode,
      source: "user",
      integration: record.integration,
      endedAt: record.endedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      cwd,
    };
    const targetSessionIds = [...new Set(deps.listBoundSessions(workspaceId))];
    if (targetSessionIds.length === 0) return {};
    const inserted = await Promise.all(targetSessionIds.map(async (targetSessionId) => {
      try {
        return {
          sessionId: targetSessionId,
          inserted: await deps.observe(event, targetSessionId),
        };
      } catch (error) {
        deps.onError?.(error);
        return { sessionId: targetSessionId, inserted: false };
      }
    }));
    try {
      await deps.drain();
    } catch (error) {
      deps.onError?.(error);
      return Object.fromEntries(inserted.map(({ sessionId, inserted: wasInserted }) => [sessionId, wasInserted]));
    }
    const result = Object.fromEntries(inserted.map(({ sessionId, inserted: wasInserted }) => [sessionId, wasInserted]));
    const commands = [commandFrom(record, cwd)];
    await Promise.all(inserted.filter((result) => result.inserted).map(async ({ sessionId }) => {
      try {
        await deps.nudgeMemory(sessionId, { reason: "user-command", commands });
      } catch (error) {
        deps.onError?.(error);
      }
    }));
    return result;
  };

  return { project };
}
