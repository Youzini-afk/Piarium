import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  PIARIUM_RECOVERY_NAVIGATION_MARKER_TYPE,
  type SessionSnapshot,
} from "@piarium/protocol";
import { HostError } from "../src/errors.js";
import { SessionHost } from "../src/session-host.js";

interface NavigationFixture {
  agentDir: string;
  assistantEntryId: string;
  currentAssistantEntryId: string;
  cwd: string;
  firstUserEntryId: string;
  host: SessionHost;
  root: string;
  snapshot: SessionSnapshot;
  userEntryId: string;
}

async function createNavigationFixture(): Promise<NavigationFixture> {
  const root = await mkdtemp(join(tmpdir(), "piarium-recovery-navigation-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const host = new SessionHost({
    agentDir,
    emit: () => undefined,
    projectTrustOverride: true,
  });
  const snapshot = await host.create(cwd);
  const manager = host.session.sessionManager;
  const firstUserEntryId = manager.appendMessage({
    content: "first question",
    role: "user",
    timestamp: Date.now(),
  });
  const assistantEntryId = manager.appendMessage(fauxAssistantMessage("first answer"));
  manager.appendCustomMessageEntry(
    "piarium.instructions",
    "hidden application instructions",
    false,
  );
  const userEntryId = manager.appendMessage({
    content: [
      { text: "restore this turn", type: "text" },
      { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
    ],
    role: "user",
    timestamp: Date.now(),
  });
  const currentAssistantEntryId = manager.appendMessage(fauxAssistantMessage("second answer"));
  return {
    agentDir,
    assistantEntryId,
    currentAssistantEntryId,
    cwd,
    firstUserEntryId,
    host,
    root,
    snapshot,
    userEntryId,
  };
}

async function disposeFixture(fixture: NavigationFixture): Promise<void> {
  await fixture.host.dispose();
  await rm(fixture.root, { force: true, recursive: true });
}

describe("SessionHost atomic recovery navigation", () => {
  it("prepares native target semantics and commits a persisted navigation marker", async () => {
    const fixture = await createNavigationFixture();
    try {
      const rootUser = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.firstUserEntryId,
      );
      assert.equal(
        rootUser.targetLeafId,
        fixture.host.session.sessionManager.getEntry(fixture.firstUserEntryId)?.parentId,
      );

      const assistant = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.currentAssistantEntryId,
      );
      assert.equal(assistant.targetLeafId, fixture.currentAssistantEntryId);

      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      assert.equal(prepared.currentLeafId, fixture.currentAssistantEntryId);
      assert.equal(prepared.expectedLeafId, fixture.currentAssistantEntryId);
      assert.equal(prepared.targetLeafId, fixture.assistantEntryId);
      assert.equal(prepared.editorText, "restore this turn");
      assert.deepEqual(prepared.editorImages, [
        { data: "aW1hZ2U=", mimeType: "image/png" },
      ]);

      const committed = await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-1",
      );
      assert.equal(committed.alreadyApplied, false);
      assert.equal(committed.snapshot.leafId, committed.markerId);
      assert.equal(committed.editorText, "restore this turn");
      assert.deepEqual(committed.editorImages, prepared.editorImages);

      const marker = fixture.host.session.sessionManager.getEntry(committed.markerId);
      assert.deepEqual(marker, {
        customType: PIARIUM_RECOVERY_NAVIGATION_MARKER_TYPE,
        data: {
          expectedLeafId: fixture.currentAssistantEntryId,
          operationId: "navigation-1",
          schemaVersion: 1,
          targetId: fixture.userEntryId,
          targetLeafId: fixture.assistantEntryId,
        },
        id: committed.markerId,
        parentId: fixture.assistantEntryId,
        timestamp: marker?.timestamp,
        type: "custom",
      });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("rejects a stale expected leaf with retryable conflict details", async () => {
    const fixture = await createNavigationFixture();
    try {
      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      const current = fixture.host.session.sessionManager.appendCustomEntry("test.concurrent", {});

      await assert.rejects(
        fixture.host.commitRecoveryNavigation(
          fixture.snapshot.sessionId,
          fixture.userEntryId,
          prepared.targetLeafId,
          prepared.expectedLeafId,
          "navigation-stale",
        ),
        (error: unknown) => {
          assert.ok(error instanceof HostError);
          assert.equal(error.code, "session_leaf_conflict");
          assert.equal(error.retryable, true);
          assert.deepEqual(error.details, {
            current,
            expected: fixture.currentAssistantEntryId,
            operationId: "navigation-stale",
          });
          return true;
        },
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("retries the same operation idempotently when the marker is an active ancestor", async () => {
    const fixture = await createNavigationFixture();
    try {
      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      const committed = await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-retry",
      );
      const descendantId = fixture.host.session.sessionManager.appendCustomEntry("test.metadata", {});
      const retried = await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-retry",
      );

      assert.equal(retried.alreadyApplied, true);
      assert.equal(retried.markerId, committed.markerId);
      assert.equal(retried.snapshot.leafId, descendantId);
      assert.equal(
        fixture.host.session.sessionManager.getEntries().filter((entry) => (
          entry.type === "custom"
          && entry.customType === PIARIUM_RECOVERY_NAVIGATION_MARKER_TYPE
        )).length,
        1,
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("rejects a persisted operation marker outside the active branch", async () => {
    const fixture = await createNavigationFixture();
    try {
      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-diverged",
      );
      const manager = fixture.host.session.sessionManager;
      manager.branch(fixture.currentAssistantEntryId);
      const currentLeafId = manager.appendCustomEntry("test.diverged", {});

      await assert.rejects(
        fixture.host.commitRecoveryNavigation(
          fixture.snapshot.sessionId,
          fixture.userEntryId,
          prepared.targetLeafId,
          prepared.expectedLeafId,
          "navigation-diverged",
        ),
        (error: unknown) => {
          assert.ok(error instanceof HostError);
          assert.equal(error.code, "session_navigation_divergence");
          assert.equal(error.retryable, false);
          assert.equal((error.details as { currentLeafId?: unknown })?.currentLeafId, currentLeafId);
          return true;
        },
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("rejects reuse of an operation id with different navigation parameters", async () => {
    const fixture = await createNavigationFixture();
    try {
      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-conflict",
      );

      await assert.rejects(
        fixture.host.commitRecoveryNavigation(
          fixture.snapshot.sessionId,
          "missing-target",
          null,
          prepared.expectedLeafId,
          "navigation-conflict",
        ),
        (error: unknown) => {
          assert.ok(error instanceof HostError);
          assert.equal(error.code, "session_navigation_operation_conflict");
          assert.equal(error.retryable, false);
          return true;
        },
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("recognizes the persisted marker after opening the session in a new host", async () => {
    const fixture = await createNavigationFixture();
    let reopened: SessionHost | undefined;
    try {
      const prepared = fixture.host.prepareRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
      );
      const committed = await fixture.host.commitRecoveryNavigation(
        fixture.snapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-reopen",
      );
      const sessionFile = committed.snapshot.sessionFile;
      assert.ok(sessionFile);
      const persisted = await readFile(sessionFile, "utf8");
      assert.match(persisted, new RegExp(PIARIUM_RECOVERY_NAVIGATION_MARKER_TYPE.replace("/", "\\/")));
      assert.match(persisted, /"operationId":"navigation-reopen"/);

      await fixture.host.dispose();
      reopened = new SessionHost({
        agentDir: fixture.agentDir,
        emit: () => undefined,
        projectTrustOverride: true,
      });
      const reopenedSnapshot = await reopened.open({ cwd: fixture.cwd, sessionFile });
      const retried = await reopened.commitRecoveryNavigation(
        reopenedSnapshot.sessionId,
        fixture.userEntryId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-reopen",
      );

      assert.equal(retried.alreadyApplied, true);
      assert.equal(retried.markerId, committed.markerId);
      assert.equal(retried.snapshot.leafId, committed.markerId);
    } finally {
      await reopened?.dispose();
      await fixture.host.dispose();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("commits a direct leaf target for combined-operation undo", async () => {
    const fixture = await createNavigationFixture();
    try {
      const prepared = fixture.host.prepareRecoveryNavigationLeaf(
        fixture.snapshot.sessionId,
        fixture.assistantEntryId,
      );
      const committed = await fixture.host.commitRecoveryNavigationLeaf(
        fixture.snapshot.sessionId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-direct-leaf",
      );
      assert.equal(committed.alreadyApplied, false);
      const marker = fixture.host.session.sessionManager.getEntry(committed.markerId);
      assert.equal(marker?.parentId, fixture.assistantEntryId);
      assert.deepEqual(marker?.type === "custom" ? marker.data : null, {
        expectedLeafId: fixture.currentAssistantEntryId,
        operationId: "navigation-direct-leaf",
        schemaVersion: 1,
        targetId: null,
        targetLeafId: fixture.assistantEntryId,
      });
      const retried = await fixture.host.commitRecoveryNavigationLeaf(
        fixture.snapshot.sessionId,
        prepared.targetLeafId,
        prepared.expectedLeafId,
        "navigation-direct-leaf",
      );
      assert.equal(retried.alreadyApplied, true);
      assert.equal(retried.markerId, committed.markerId);
    } finally {
      await disposeFixture(fixture);
    }
  });
});
