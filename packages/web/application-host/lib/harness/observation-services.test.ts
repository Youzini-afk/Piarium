import { describe, expect, it } from "vitest";
import { sliceUtf8ByBytes, type DiagnosticItem, type HarnessActorContext } from "@piarium/protocol";
import { createLspDiagnosticsSnapshotService, type DiagnosticsProvider } from "./diagnostics-service.js";
import { createCompactionAfterService, createShellExecService, createShellReadService } from "./harness-services.js";
import { createObservationCursorStore } from "./observation-cursors.js";
import { createKeeperCoverageStore } from "./compaction.js";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";

const ACTOR: HarnessActorContext = {
  authorityInstanceId: "authority",
  sessionId: "observer",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace",
  grantedCapabilities: ["context.session", "process.shell", "read.lsp"],
};

const context = (canonicalResourceId = "src/main.ts"): HarnessServiceContext => ({
  actor: ACTOR,
  authorizedPaths: [{
    authorityId: "authority",
    workspaceId: "workspace",
    canonicalResourceId,
    inputPath: canonicalResourceId,
    resourceId: canonicalResourceId,
  }],
  sessionId: ACTOR.sessionId,
  workspaceId: ACTOR.workspaceId,
  signal: new AbortController().signal,
});

describe("incremental shell observation", () => {
  it("starts after the output already returned by a backgrounded bash call", async () => {
    let output = "already shown";
    const cursors = createObservationCursorStore();
    const supervisor = {
      exec: async () => ({ kind: "background" as const, id: "sh_1", waitedMs: 10, cwd: ".", outputSoFar: "already shown" }),
      read: async (_id: string, offset = 0, length = 32_768) => ({
        ...sliceUtf8ByBytes(output, offset, length),
        running: true,
      }),
    };
    const host = {
      observationCursors: cursors,
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    await createShellExecService(host).handle({ command: "slow", waitMs: 10 }, context());
    output += " new";
    const observed = await createShellReadService(host).handle({ id: "sh_1" }, context());
    expect(observed).toMatchObject({ text: " new", offset: 13, observation: { first: false } });
    cursors.dispose();
  });

  it("advances only default reads and resets the baseline after compaction", async () => {
    let now = 1_000;
    let output = "first";
    const shellState: { exitCode?: number; running: boolean } = { running: true };
    const cursors = createObservationCursorStore({ now: () => now });
    const supervisor = {
      read: async (_id: string, offset = 0, length = 32_768) => ({
        ...sliceUtf8ByBytes(output, offset, length),
        running: shellState.running,
        ...(shellState.exitCode === undefined ? {} : { exitCode: shellState.exitCode }),
        lastOutputAt: 900,
      }),
    };
    let clearedThreadCursors = 0;
    const host = {
      observationCursors: cursors,
      getShellSupervisor: () => supervisor,
      threadRegistry: { clearCursorsForSession: () => { clearedThreadCursors += 1; } },
      keeperCoverageStore: createKeeperCoverageStore(),
    } as unknown as HarnessServiceHost;
    const service = createShellReadService(host);

    const first = await service.handle({ id: "sh_1" }, context());
    expect(first).toMatchObject({ text: "first", offset: 0, nextOffset: 5, observation: { first: true } });

    output += "你";
    now = 2_000;
    const second = await service.handle({ id: "sh_1" }, context());
    expect(second).toMatchObject({ text: "你", offset: 5, length: 3, nextOffset: 8, observation: { first: false, sinceMs: 1_000 } });

    const randomAccess = await service.handle({ id: "sh_1", offset: 0, length: 5 }, context());
    expect(randomAccess.text).toBe("first");
    expect(randomAccess.observation).toBeUndefined();

    output += " done";
    shellState.running = false;
    shellState.exitCode = 0;
    now = 3_000;
    const final = await service.handle({ id: "sh_1" }, context());
    expect(final).toMatchObject({ text: " done", running: false, exitCode: 0, observation: { first: false } });
    const unchanged = await service.handle({ id: "sh_1" }, context());
    expect(unchanged).toMatchObject({ text: "", length: 0, running: false, exitCode: 0 });

    await createCompactionAfterService(host).handle({ summary: "summary", firstKeptEntryId: "entry", tokensBefore: 10 }, context());
    expect(clearedThreadCursors).toBe(1);
    const afterCompaction = await service.handle({ id: "sh_1" }, context());
    expect(afterCompaction).toMatchObject({ text: output, offset: 0, observation: { first: true } });
    cursors.dispose();
  });
});

describe("incremental diagnostics observation", () => {
  it("returns added and resolved diagnostics while full reads leave the cursor alone", async () => {
    const a: DiagnosticItem = { line: 1, character: 1, severity: "error", code: "A", message: "first", source: "ts" };
    const b: DiagnosticItem = { line: 2, character: 1, severity: "warning", code: "B", message: "second", source: "ts" };
    let diagnostics = [a];
    const provider: DiagnosticsProvider = {
      getDiagnostics: async () => diagnostics,
      getSnapshot: async () => "1",
      isAvailable: async () => true,
      syncDocument: async () => ({ status: "ready" }),
    };
    const cursors = createObservationCursorStore();
    const service = createLspDiagnosticsSnapshotService(provider, cursors);

    const first = await service.handle({ path: "src/main.ts" }, context());
    expect(first).toMatchObject({ diagnostics: [a], resolvedDiagnostics: [], observation: { first: true, added: 1, resolved: 0 } });

    diagnostics = [a, b];
    const full = await service.handle({ path: "src/main.ts", full: true }, context());
    expect(full.diagnostics).toEqual([a, b]);
    expect(full.observation).toBeUndefined();

    const added = await service.handle({ path: "src/main.ts" }, context());
    expect(added).toMatchObject({ diagnostics: [b], resolvedDiagnostics: [], observation: { first: false, added: 1, resolved: 0 } });

    diagnostics = [b];
    const resolved = await service.handle({ path: "src/main.ts" }, context());
    expect(resolved).toMatchObject({ diagnostics: [], resolvedDiagnostics: [a], observation: { first: false, added: 0, resolved: 1 } });

    const unchanged = await service.handle({ path: "src/main.ts" }, context());
    expect(unchanged).toMatchObject({ diagnostics: [], resolvedDiagnostics: [], observation: { added: 0, resolved: 0 } });
    cursors.dispose();
  });
});
