import { describe, expect, it } from "vitest";
import { createTerminalCommandProjector } from "./terminal-projection.js";
import type { TerminalCommandRecord } from "../terminal/session-api.js";

const userCommand = (overrides: Partial<TerminalCommandRecord> = {}): TerminalCommandRecord => ({
  command: "echo hi",
  commandId: "term-1:1:1",
  cwd: "/workspace",
  endedAt: 10,
  exitCode: 0,
  integration: "osc-633",
  owner: "user",
  terminalId: "term-1",
  ...overrides,
});

describe("terminal command projector", () => {
  it("stores a user command for each bound session after drain", async () => {
    const observed: unknown[] = [];
    const projector = createTerminalCommandProjector({
      resolveWorkspaceId: async (cwd) => cwd === "/workspace" ? "ws-1" : null,
      observe: (event) => { observed.push(event); return true; },
      drain: async () => undefined,
      listBoundSessions: () => ["session-a", "session-b"],
    });
    await expect(projector.project(userCommand())).resolves.toEqual({ "session-a": true, "session-b": true });
    expect(observed).toHaveLength(2);
    expect(observed).toEqual([
      expect.objectContaining({
        command: "echo hi",
        commandId: "term-1:1:1",
        source: "user",
        workspaceId: "ws-1",
      }),
      expect.objectContaining({
        command: "echo hi",
        commandId: "term-1:1:1",
        source: "user",
        workspaceId: "ws-1",
      }),
    ]);
  });

  it("ignores harness commands and unresolved workspaces", async () => {
    let observed = 0;
    const projector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => null,
      observe: () => { observed += 1; return true; },
      drain: async () => undefined,
      listBoundSessions: () => ["session-a"],
    });
    await projector.project(userCommand({ owner: "harness" }));
    await projector.project(userCommand({ owner: "user" }));
    expect(observed).toBe(0);
  });

  it("reports per-session results when the drain fails", async () => {
    const errors: unknown[] = [];
    const projector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => "ws-1",
      observe: () => true,
      drain: async () => { throw new Error("drain failed"); },
      listBoundSessions: () => ["session-a"],
      onError: (error) => { errors.push(error); },
    });
    await expect(projector.project(userCommand())).resolves.toEqual({ "session-a": true });
    expect(errors).toHaveLength(1);
  });

  it("returns false for a session when the persistent write is a duplicate commandId", async () => {
    const projector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => "ws-1",
      observe: async () => false,
      drain: async () => undefined,
      listBoundSessions: () => ["session-a"],
    });
    await expect(projector.project(userCommand())).resolves.toEqual({ "session-a": false });
  });
});
