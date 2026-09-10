import { describe, expect, it } from "vitest";
import { createVerificationCoordinator } from "./verification-coordinator.js";
import type {
  ParentVerificationBundle,
  ResultReviewRecord,
  ResultVerificationBundle,
} from "./working-state/types.js";
import type { WorkingStateStore } from "./working-state/working-state-store.js";

const memoryStore = () => {
  const child = new Map<string, ResultVerificationBundle[]>();
  const parent = new Map<string, ParentVerificationBundle[]>();
  const reviews = new Map<string, ResultReviewRecord[]>();
  const store = {
    getChildVerification: (threadId: string, revision: number) => (
      child.get(threadId)?.find((bundle) => bundle.resultRevision === revision) ?? null
    ),
    listChildVerifications: (threadId: string) => child.get(threadId) ?? [],
    getParentVerification: (threadId: string, revision?: number) => {
      const list = parent.get(threadId) ?? [];
      return revision === undefined ? list.at(-1) ?? null : list.find((bundle) => bundle.mergedResultRevision === revision) ?? null;
    },
    getReviewRecord: (threadId: string, revision: number) => (
      reviews.get(threadId)?.find((record) => record.resultRevision === revision) ?? null
    ),
    listReviewRecords: (threadId: string) => reviews.get(threadId) ?? [],
    putChildVerification: async (threadId: string, bundle: ResultVerificationBundle) => {
      child.set(threadId, [
        ...(child.get(threadId) ?? []).filter((item) => item.resultRevision !== bundle.resultRevision),
        bundle,
      ]);
    },
    putParentVerification: async (threadId: string, bundle: ParentVerificationBundle) => {
      parent.set(threadId, [
        ...(parent.get(threadId) ?? []).filter((item) => item.mergedResultRevision !== bundle.mergedResultRevision),
        bundle,
      ]);
    },
    putReviewRecord: async (threadId: string, record: ResultReviewRecord) => {
      reviews.set(threadId, [
        ...(reviews.get(threadId) ?? []).filter((item) => item.resultRevision !== record.resultRevision),
        record,
      ]);
    },
  };
  return store as unknown as WorkingStateStore;
};

describe("verification coordinator", () => {
  it("binds same-run worktree commands and leaves outside cwd unbound", async () => {
    const coordinator = createVerificationCoordinator();
    const store = memoryStore();
    coordinator.attachThreadSession("child-1", {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-1",
      worktreePath: "/ws/thread",
      branchId: "thread-a",
      lastPublishedRevision: 0,
      lastHeadRevision: 0,
    });
    coordinator.recordCommand({
      sessionId: "child-1",
      command: "bun test",
      cwd: "/ws/thread",
      exitCode: 0,
    });
    coordinator.recordCommand({
      sessionId: "child-1",
      command: "curl example.test",
      cwd: "/tmp",
      exitCode: 0,
    });
    const projection = await coordinator.bindPublishedResult(store, {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-1",
      branchId: "thread-a",
      resultRevision: 1,
      worktreePath: "/ws/thread",
    });
    expect(projection.childChecks?.binding).toBe("bound");
    expect(projection.childChecks?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "bun test", relation: "same-run-before-publish", exitCode: 0 }),
      expect.objectContaining({ command: "curl example.test", relation: "unbound" }),
    ]));
    expect(projection.childChecks?.allExitedZero).toBe(true);
    expect(projection.review?.status).toBe("none");
  });

  it("does not let a later revision inherit an older review or accept a late older complete as current", async () => {
    const coordinator = createVerificationCoordinator();
    const store = memoryStore();
    coordinator.attachThreadSession("child-1", {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-1",
      worktreePath: "/ws/thread",
    });
    coordinator.recordCommand({ sessionId: "child-1", command: "bun test", cwd: "/ws/thread", exitCode: 0 });
    await coordinator.bindPublishedResult(store, {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-1",
      branchId: "thread-a",
      resultRevision: 1,
      worktreePath: "/ws/thread",
    });
    await coordinator.putReview(store, "thread-a", {
      resultRevision: 1,
      status: "completed",
      recordedAt: 10,
      reviewThreadId: "review-old",
      conclusion: "old revision looks fine",
    }, 1);
    coordinator.attachThreadSession("child-1", {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-2",
      worktreePath: "/ws/thread",
      lastPublishedRevision: 1,
    });
    coordinator.recordCommand({ sessionId: "child-1", command: "bun test", cwd: "/ws/thread", exitCode: 0 });
    const next = await coordinator.bindPublishedResult(store, {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-2",
      branchId: "thread-a",
      resultRevision: 2,
      worktreePath: "/ws/thread",
    });
    expect(next.currentResultRevision).toBe(2);
    expect(next.review?.status).toBe("none");
    expect(next.review?.resultRevision).toBe(2);
    const late = await coordinator.putReview(store, "thread-a", {
      resultRevision: 1,
      status: "completed",
      recordedAt: 20,
      reviewThreadId: "review-late",
      conclusion: "late old review",
    }, 2);
    expect(late.review?.status).toBe("none");
    expect(store.getReviewRecord("thread-a", 1)?.reviewThreadId).toBe("review-old");
    await coordinator.putReview(store, "thread-a", {
      resultRevision: 1,
      status: "completed",
      recordedAt: 1,
      reviewThreadId: "review-older-stamp",
      conclusion: "stale stamp",
    }, 1);
    expect(store.getReviewRecord("thread-a", 1)?.reviewThreadId).toBe("review-old");
  });

  it("does not let a parent attach replace a child session binding", () => {
    const coordinator = createVerificationCoordinator();
    coordinator.attachThreadSession("shared", {
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-1",
      worktreePath: "/ws/thread",
    });
    coordinator.attachParentSession("shared", {
      workspaceId: "ws",
      parentRoot: "/ws",
      parentSessionId: "shared",
    });
    expect(coordinator.sessionBinding("shared")).toMatchObject({ scope: "child", threadId: "thread-a" });
  });

  it("keeps a completed review and records draft merge as unverifiable", async () => {
    const coordinator = createVerificationCoordinator();
    const store = memoryStore();
    await coordinator.putReview(store, "thread-a", {
      resultRevision: 1,
      status: "completed",
      recordedAt: 5,
      reviewThreadId: "review-1",
      conclusion: "done",
    }, 1);
    const ignored = await coordinator.putReview(store, "thread-a", {
      resultRevision: 1,
      status: "running",
      recordedAt: 6,
      reviewThreadId: "review-2",
    }, 1);
    expect(ignored.review?.status).toBe("completed");
    expect(ignored.review?.reviewThreadId).toBe("review-1");
    const parent = await coordinator.recordParentMerge(store, {
      threadId: "thread-a",
      mergedResultRevision: 1,
      draftUnsaved: true,
    });
    expect(parent.parentChecks).toMatchObject({
      mergedResultRevision: 1,
      draftUnsaved: true,
      binding: "cannot-verify-unsaved-draft",
      allExitedZero: null,
    });
    const disk = await coordinator.recordParentMerge(store, {
      threadId: "thread-a",
      mergedResultRevision: 1,
      draftUnsaved: false,
    });
    expect(disk.parentChecks?.binding).toBe("not-recorded");
  });
});
