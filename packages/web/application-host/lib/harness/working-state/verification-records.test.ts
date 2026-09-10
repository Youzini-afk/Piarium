import { describe, expect, it } from "vitest";
import {
  bindCommandsToPublishedResult,
  cwdUnderRoot,
  formatPublishedResultDiff,
  inputChangedDuringCommand,
  projectThreadVerification,
  relateCommandToPublish,
} from "./verification-records.js";
import type { WorkingResult } from "./types.js";

describe("verification records", () => {
  it("treats cwd under the worktree as bindable and outside as unbound", () => {
    expect(cwdUnderRoot("D:\\ws\\thread\\src", "D:\\ws\\thread")).toBe(true);
    expect(relateCommandToPublish(
      { cwd: "D:\\ws\\thread", runId: "run-1", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20 },
    )).toBe("same-run-before-publish");
    expect(relateCommandToPublish(
      { cwd: "D:\\other", runId: "run-1", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20 },
    )).toBe("unbound");
    expect(relateCommandToPublish(
      { cwd: "D:\\ws\\thread", runId: "run-2", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20 },
    )).toBe("uncertain");
  });

  it("records input change only when identities actually differ", () => {
    expect(inputChangedDuringCommand({
      startPublishedRevision: 1,
      endPublishedRevision: 1,
      startHeadRevision: 1,
      endHeadRevision: 1,
    })).toBe(false);
    expect(inputChangedDuringCommand({
      startPublishedRevision: 1,
      endPublishedRevision: 2,
    })).toBe(true);
    expect(inputChangedDuringCommand({})).toBeNull();
  });

  it("binds same-run commands without claiming the published objects were tested", () => {
    const bundle = bindCommandsToPublishedResult({
      branchId: "thread-1",
      resultRevision: 2,
      runId: "run-1",
      worktreePath: "/ws/thread",
      publishedAt: 50,
      commands: [{
        id: "cmd-1",
        runId: "run-1",
        command: "bun test",
        cwd: "/ws/thread",
        startedAt: 10,
        endedAt: 20,
        exitCode: 0,
        cancelled: false,
        startPublishedRevision: 1,
        endPublishedRevision: 1,
        startHeadRevision: 1,
        endHeadRevision: 1,
        branchId: "thread-1",
      }],
    });
    expect(bundle.binding).toBe("bound");
    expect(bundle.checks[0]?.relationToPublished).toBe("same-run-before-publish");
    expect(bundle.checks[0]?.exitCode).toBe(0);
    expect(bundle.bindingReason).toMatch(/captured later/);
    const projection = projectThreadVerification({
      currentResultRevision: 2,
      child: bundle,
    });
    expect(projection.childChecks?.allExitedZero).toBe(true);
    expect(projection.review?.status).toBe("none");
  });

  it("formats a published result from stored objects rather than a live scan", async () => {
    const objects = new Map<string, Buffer>([
      ["sha256-a", Buffer.from("old\n")],
      ["sha256-b", Buffer.from("new\n")],
    ]);
    const result: WorkingResult = {
      resultRevision: 1,
      branchId: "thread-1",
      changedPaths: ["a.txt"],
      baseStates: { "a.txt": { kind: "regular-file", objectHash: "sha256-a", byteLength: 4, mode: 0o644 } },
      pathStates: { "a.txt": { kind: "regular-file", objectHash: "sha256-b", byteLength: 4, mode: 0o644 } },
      diffStats: { files: 1, insertions: 1, deletions: 1 },
      createdAt: new Date().toISOString(),
    };
    const diff = await formatPublishedResultDiff({
      getObject: async (hash) => objects.get(hash) ?? null,
    }, result);
    expect(diff).toContain("--- a/a.txt");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });
});
