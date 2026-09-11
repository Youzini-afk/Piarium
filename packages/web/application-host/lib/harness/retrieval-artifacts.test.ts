import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../recovery/journal-files.js";
import { WorkingStateStore } from "./working-state/working-state-store.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";
import {
  createRetrievalArtifactAccess,
  RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
  RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND,
  RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND,
  WEB_FETCH_RECEIPT_OWNER_KIND,
} from "./retrieval-artifacts.js";
import { mintWebFetchReceipt } from "./web-fetch-receipt.js";
import type { HostResourceOperation } from "../recovery/durable-file-operation.js";
import type { RetrievalEvidence } from "@piarium/protocol";

const roots: string[] = [];

const openAccess = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-retrieval-artifacts-"));
  roots.push(parent);
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "recovery");
  await fs.promises.mkdir(workspace, { recursive: true });
  const database = await openRecoveryJournalCatalog(root, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly HostResourceOperation[], operation: () => Promise<Result>) => operation(),
    },
    root,
  };
  const store = await WorkingStateStore.open(context);
  const workingStates: WorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
  };
  return { context, database, parent, root, store, workingStates };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("retrieval artifacts", () => {
  it("lets a parent read a sealed excerpt after the store is reopened", async () => {
    const first = await openAccess();
    const access = createRetrievalArtifactAccess(first.workingStates);
    const artifact = await access.storeArtifact("ws", Buffer.from("child output after close\n"));
    const evidence: RetrievalEvidence = {
      question: "What did the child find?",
      scope: [],
      facts: [{
        claim: "child output",
        status: "source-checked",
        sources: [{ kind: "output", check: "source-valid", artifact }],
      }],
      unknowns: [],
      attempted: [],
      completion: "delivered",
    };
    await access.promotePendingEvidence({
      workspaceId: "ws",
      threadId: "thread-child",
      runId: "run-child",
      evidence,
      receiptAuthority: { owningWorkspaceId: "ws", sessionId: "session-child", threadId: "thread-child", runId: "run-child" },
    });
    first.database.close();

    const database = await openRecoveryJournalCatalog(first.root, { create: false });
    if (!database) throw new Error("reopen catalog missing");
    const context = { ...first.context, database };
    const store = await WorkingStateStore.open(context);
    const workingStates: WorkspaceWorkingStateAccess = {
      withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
    };
    try {
      const reopened = createRetrievalArtifactAccess(workingStates);
      const bytes = await reopened.readArtifact("ws", artifact.hash);
      expect(bytes?.toString("utf8")).toBe("child output after close\n");
    } finally {
      database.close();
    }
  });

  it("binds receipts to one Run and reconciles pending, sealed, stale, and deleted evidence owners", async () => {
    const opened = await openAccess();
    const access = createRetrievalArtifactAccess(opened.workingStates);
    const authority = { owningWorkspaceId: "ws", sessionId: "session-1", threadId: "thread-child", runId: "run-1" };
    const draft = mintWebFetchReceipt("https://example.com/fact", "web body", authority);
    const receipt = await access.persistReceipt("ws", draft, "web body");
    expect(await access.lookupReceipt("ws", authority, receipt.receiptId)).toMatchObject({ receiptId: receipt.receiptId });
    expect(await access.lookupReceipt("ws", { ...authority, runId: "run-2" }, receipt.receiptId)).toBeNull();

    const artifact = await access.storeArtifact("ws", Buffer.from("local body"), authority);
    const count = (kind: string): number => Number((opened.database.prepare(`
      SELECT COUNT(*) AS count FROM object_references WHERE workspace_id = ? AND owner_kind = ?
    `).get("ws", kind) as { count: number }).count);
    expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(1);
    const evidence: RetrievalEvidence = {
      question: "fact",
      scope: [],
      facts: [{
        claim: "two durable sources",
        status: "source-checked",
        sources: [
          { kind: "local", path: "fact.ts", check: "source-valid", artifact },
          { kind: "url", url: receipt.finalUrl, receiptId: receipt.receiptId, check: "source-valid", artifact: receipt.artifact },
        ],
      }],
      unknowns: [],
      attempted: [],
      completion: "delivered",
    };
    await access.promotePendingEvidence({
      workspaceId: "ws",
      threadId: "thread-child",
      runId: "run-1",
      evidence,
      receiptAuthority: authority,
    });
    expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(0);
    expect(count(RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND)).toBe(2);

    // Durable catalog intent without refs is rebuilt; stale refs and a late old
    // Run temporary owner are removed while the sealed Run remains stable.
    opened.database.prepare(`DELETE FROM object_references WHERE owner_kind = ?`).run(RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND);
    await access.syncThreadEvidence("ws", {
      id: "thread-child",
      workspaceId: "ws",
      lifecycle: "active",
      activeRunId: "run-1",
      pendingEvidence: evidence,
      report: null,
    } as never);
    expect(count(RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND)).toBe(2);

    await access.storeArtifact("ws", Buffer.from("late old run"), authority);
    await access.syncThreadEvidence("ws", {
      id: "thread-child",
      workspaceId: "ws",
      lifecycle: "active",
      activeRunId: "run-2",
      report: {
        evidence,
        evidenceRunId: "run-1",
      },
    } as never);
    expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(0);
    expect(count(RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND)).toBe(0);
    expect(count(RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND)).toBe(2);

    await access.storeArtifact("ws", Buffer.from("unsubmitted child artifact"), {
      ...authority,
      runId: "run-2",
    });
    const unsubmittedReceipt = mintWebFetchReceipt("https://example.com/unsubmitted", "pending body", {
      ...authority,
      runId: "run-2",
    });
    await access.persistReceipt("ws", unsubmittedReceipt, "pending body");
    const otherAuthority = {
      ...authority,
      threadId: "thread-sibling",
      runId: "run-sibling",
    };
    await access.storeArtifact("ws", Buffer.from("sibling temporary artifact"), otherAuthority);
    const siblingReceipt = mintWebFetchReceipt("https://example.com/sibling", "sibling body", otherAuthority);
    await access.persistReceipt("ws", siblingReceipt, "sibling body");
    expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(2);
    expect(count(WEB_FETCH_RECEIPT_OWNER_KIND)).toBe(4);

    await access.releaseThreadEvidence("ws", "thread-child");
    expect(count(RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND)).toBe(0);
    expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(1);
    expect(count(WEB_FETCH_RECEIPT_OWNER_KIND)).toBe(2);
    expect(await access.lookupReceipt("ws", otherAuthority, siblingReceipt.receiptId)).not.toBeNull();
    opened.database.close();
  });

  it("preserves active-Run receipts and temporary artifacts across store reopen", async () => {
    const first = await openAccess();
    const access = createRetrievalArtifactAccess(first.workingStates);
    const authority = {
      owningWorkspaceId: "ws",
      sessionId: "session-active",
      threadId: "thread-active",
      runId: "run-active",
    };
    const receipt = await access.persistReceipt(
      "ws",
      mintWebFetchReceipt("https://example.com/active", "active body", authority),
      "active body",
    );
    await access.storeArtifact("ws", Buffer.from("active temporary excerpt"), authority);
    first.database.close();

    const database = await openRecoveryJournalCatalog(first.root, { create: false });
    if (!database) throw new Error("reopen catalog missing");
    const context = { ...first.context, database };
    const store = await WorkingStateStore.open(context);
    const workingStates: WorkspaceWorkingStateAccess = {
      withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
    };
    const reopened = createRetrievalArtifactAccess(workingStates);
    const count = (kind: string): number => Number((database.prepare(`
      SELECT COUNT(*) AS count FROM object_references WHERE workspace_id = ? AND owner_kind = ?
    `).get("ws", kind) as { count: number }).count);
    try {
      await reopened.reconcileWorkspaceEvidence("ws", [{
        id: authority.threadId,
        workspaceId: "ws",
        role: "retrieval",
        lifecycle: "active",
        activeRunId: authority.runId,
        report: null,
      } as never]);
      expect(await reopened.lookupReceipt("ws", authority, receipt.receiptId)).not.toBeNull();
      expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(1);
      expect(count(WEB_FETCH_RECEIPT_OWNER_KIND)).toBe(2);

      await reopened.reconcileWorkspaceEvidence("ws", [{
        id: authority.threadId,
        workspaceId: "ws",
        role: "retrieval",
        lifecycle: "settled",
        activeRunId: null,
        report: null,
      } as never]);
      expect(await reopened.lookupReceipt("ws", authority, receipt.receiptId)).toBeNull();
      expect(count(RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND)).toBe(0);
      expect(count(WEB_FETCH_RECEIPT_OWNER_KIND)).toBe(0);
    } finally {
      database.close();
    }
  });
});
