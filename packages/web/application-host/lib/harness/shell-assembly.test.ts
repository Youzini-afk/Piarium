import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessActorContext, HarnessActorIdentity } from "@piarium/protocol";
import { createShellExecService } from "./harness-services.js";
import type { HarnessServiceContext } from "./router.js";
import { discoverShells } from "./shell-discovery.js";
import { createHarnessServiceHost } from "./service-host.js";

const actor = (sessionId: string): HarnessActorIdentity => ({
  authorityInstanceId: "authority-1",
  sessionId,
  workerId: "worker-1",
  workerGeneration: 1,
});

const serviceContext = (sessionId: string, workspaceId: string): HarnessServiceContext => {
  const current: HarnessActorContext = {
    ...actor(sessionId),
    workspaceId,
    grantedCapabilities: ["process.shell"],
  };
  return {
    actor: current,
    authorizedPaths: [],
    sessionId,
    workspaceId,
    signal: new AbortController().signal,
  };
};

const hosts: Array<ReturnType<typeof createHarnessServiceHost>> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("production shell assembly", () => {
  it("discovers once at Host construction and keeps workspace settings from crossing", async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "shell-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "shell-b-"));
    dirs.push(workspaceA, workspaceB);
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async (workspaceId) => workspaceId === "ws-a" ? workspaceA : workspaceB,
      discoverShells: () => ({
        gitBashPath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        hasPowerShell: true,
      }),
    });
    hosts.push(host);
    host.registerSession({
      actor: actor("session-a"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-a",
      workspaceRoot: workspaceA,
      shellSetting: "git-bash",
    });
    host.registerSession({
      actor: actor("session-b"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-b",
      workspaceRoot: workspaceB,
      shellSetting: "powershell",
    });
    const gitBash = host.getInterpreter("session-a");
    const powershell = host.getInterpreter("session-b");
    expect(gitBash && "kind" in gitBash && gitBash.kind).toBe("git-bash");
    expect(gitBash && "command" in gitBash ? gitBash.command : "").toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
    expect(powershell && "kind" in powershell && powershell.kind).toBe("powershell");
  });

  it("reports a missing interpreter from production discovery, not an injected path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-missing-"));
    dirs.push(workspace);
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      discoverShells: () => ({}),
    });
    hosts.push(host);
    host.registerSession({
      actor: actor("session-missing"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-missing",
      workspaceRoot: workspace,
      shellSetting: "git-bash",
    });
    const interpreter = host.getInterpreter("session-missing");
    expect(interpreter && "unavailable" in interpreter).toBe(true);
    if (interpreter && "unavailable" in interpreter) {
      expect(interpreter.unavailable.reason).toMatch(/Git for Windows not found/);
      expect(interpreter.unavailable.hint).toMatch(/git-scm.com|powershell/);
    }
    const result = await createShellExecService(host).handle(
      { command: "echo should-not-run" },
      serviceContext("session-missing", "ws-missing"),
    );
    expect(result).toMatchObject({ kind: "spawn-failed", reason: expect.stringMatching(/Git for Windows not found/) });
  });

  it("executes through public shell.exec after real Host discovery", async () => {
    const discovered = discoverShells();
    if (process.platform === "win32") {
      expect(discovered.gitBashPath, "Git Bash should be discovered on this Windows machine").toBeTruthy();
      expect(discovered.gitBashPath).toMatch(/bash\.exe$/i);
      expect(discovered.gitBashPath).not.toMatch(/\\usr\\usr\\bin\\bash\.exe$/i);
    } else if (!discovered.hasBash) {
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), "shell-assembly-"));
    dirs.push(workspace);
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
    });
    hosts.push(host);
    host.registerSession({
      actor: actor("session-live"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-live",
      workspaceRoot: workspace,
      shellSetting: "auto",
    });
    const interpreter = host.getInterpreter("session-live");
    expect(interpreter && "kind" in interpreter).toBe(true);
    const result = await createShellExecService(host).handle(
      { command: "echo piarium-shell-assembly", waitMs: 15_000 },
      serviceContext("session-live", "ws-live"),
    );
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/piarium-shell-assembly/);
    }
  }, 30_000);

  it("executes consecutive commands and preserves non-zero exit through PowerShell", async () => {
    if (process.platform !== "win32") return;
    const discovered = discoverShells();
    expect(discovered.hasPowerShell, "PowerShell should be discovered on this Windows machine").toBe(true);
    const workspace = mkdtempSync(join(tmpdir(), "shell-powershell-"));
    dirs.push(workspace);
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
    });
    hosts.push(host);
    host.registerSession({
      actor: actor("session-powershell"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-powershell",
      workspaceRoot: workspace,
      shellSetting: "powershell",
    });
    const ctx = serviceContext("session-powershell", "ws-powershell");
    const first = await createShellExecService(host).handle(
      { command: "Write-Output piarium-powershell-one", cwd: workspace, waitMs: 15_000 },
      ctx,
    );
    const second = await createShellExecService(host).handle(
      { command: "Write-Output piarium-powershell-two", waitMs: 15_000 },
      ctx,
    );
    const failed = await createShellExecService(host).handle(
      { command: "cmd.exe /c exit 7", waitMs: 15_000 },
      ctx,
    );
    expect(first).toMatchObject({ kind: "completed", exitCode: 0 });
    expect(second).toMatchObject({ kind: "completed", exitCode: 0 });
    expect(failed).toMatchObject({ kind: "completed", exitCode: 7 });
    if (first.kind === "completed") expect(first.stdout).toContain("piarium-powershell-one");
    if (second.kind === "completed") expect(second.stdout).toContain("piarium-powershell-two");
  }, 45_000);
});
