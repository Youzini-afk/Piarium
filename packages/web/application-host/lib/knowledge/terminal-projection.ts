import type { TerminalCommandRecord } from "../terminal/session-api.js";
import type { TerminalCommandEvent } from "./observers.js";

export type TerminalMemoryNudgeCommand = {
  command: string;
  commandId: string;
  cwd?: string;
  exitCode: number;
};

export interface TerminalCommandProjectorDeps {
  drain(): Promise<void>;
  inspectCwd?(terminalId: string): string | undefined;
  listBoundSessions(workspaceId: string): string[];
  nudgeMemory(sessionId: string, input: {
    commands: TerminalMemoryNudgeCommand[];
    reason: "user-command";
  }): Promise<unknown>;
  observe(event: TerminalCommandEvent): boolean | Promise<boolean>;
  onError?(error: unknown): void;
  resolveWorkspaceId(scope: string): Promise<string | null>;
}

const commandFrom = (record: TerminalCommandRecord, cwd?: string): TerminalMemoryNudgeCommand => ({
  command: record.command,
  commandId: record.commandId,
  exitCode: record.exitCode,
  ...(cwd === undefined ? {} : { cwd }),
});

export function createTerminalCommandProjector(deps: TerminalCommandProjectorDeps) {
  const project = async (record: TerminalCommandRecord): Promise<void> => {
    if (record.owner !== "user") return;
    const cwd = record.cwd ?? deps.inspectCwd?.(record.terminalId);
    if (!cwd) return;
    let workspaceId: string | null;
    try {
      workspaceId = await deps.resolveWorkspaceId(cwd);
    } catch (error) {
      deps.onError?.(error);
      return;
    }
    if (!workspaceId) return;
    const inserted = await deps.observe({
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
    });
    try {
      await deps.drain();
    } catch (error) {
      deps.onError?.(error);
      return;
    }
    if (!inserted) return;
    const commands = [commandFrom(record, cwd)];
    await Promise.all(deps.listBoundSessions(workspaceId).map(async (sessionId) => {
      try {
        await deps.nudgeMemory(sessionId, { reason: "user-command", commands });
      } catch (error) {
        deps.onError?.(error);
      }
    }));
  };

  return { project };
}
