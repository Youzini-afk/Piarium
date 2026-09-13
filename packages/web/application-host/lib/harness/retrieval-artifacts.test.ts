import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RetrievalArtifactRef, RetrievalEvidence, RetrievalReceiptAuthority, Thread } from "@piarium/protocol";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { mintWebFetchReceipt } from "./web-fetch-receipt.js";
import { createRetrievalArtifactAccess, hashRetrievalText } from "./retrieval-artifacts.js";

type TestRecord = {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  recordRevision: number;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

const openAccess = () => {
  const objects = new Map<string, Buffer>();
  const owners = new Map<string, string>();
  const records = new Map<string, TestRecord>();
  const puts: Array<{ operationId: string; recordId: string }> = [];
  const releases: Array<{ operationId: string; recordId: string }> = [];
  let objectSequence = 0;
  const store = {
    async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      owners.set(hash, `owner-${++objectSequence}`);
      return { hash, byteLength: bytes.byteLength };
    },
    async getObject(hash: string): Promise<Buffer | null> {
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes) : null;
    },
    async getObjectSlice(hash: string, _byteLength: number, offset: number, length: number): Promise<Buffer | null> {
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes.subarray(offset, offset + length)) : null;
    },
    ownerIdForObject(hash: string): string | undefined {
      return owners.get(hash);
    },
  };
  const context = {
    records: {
      async get(recordId: string): Promise<TestRecord | null> {
        return records.get(recordId) ?? null;
      },
      async list(input: { recordType?: string }): Promise<TestRecord[]> {
        return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType);
      },
      async put(input: Omit<TestRecord, "recordRevision"> & { operationId: string; expectedRecordRevision?: number }): Promise<TestRecord> {
        puts.push({ operationId: input.operationId, recordId: input.recordId });
        const existing = records.get(input.recordId);
        if (existing && input.expectedRecordRevision !== existing.recordRevision) throw new Error("record revision conflict");
        const record = { ...input, workspaceId: "ws", recordRevision: (existing?.recordRevision ?? 0) + 1, references: [...input.references] };
        records.set(input.recordId, record);
        return record;
      },
      async release(operationId: string, recordId: string): Promise<Record<string, unknown>> {
        releases.push({ operationId, recordId });
        const released = records.delete(recordId);
        return { recordId, released };
      },
    },
  };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (_workspaceId, _purpose, operation) => operation(
      store as unknown as WorkingStateRootStore,
      context as unknown as WorkingStateRootContext,
    ),
  };
  return {
    access: createRetrievalArtifactAccess(workingStates),
    records,
    puts,
    releases,
  };
};

const authority = (threadId: string, runId: string, sessionId = `session-${threadId}`): RetrievalReceiptAuthority => ({
  owningWorkspaceId: "ws",
  sessionId,
  threadId,
  runId,
});

const retrievalThread = (
  id: string,
  lifecycle: "active" | "settled",
  activeRunId: string | null,
  pendingEvidence?: RetrievalEvidence,
  report?: { evidence: RetrievalEvidence; evidenceRunId: string },
): Thread => ({
  id,
  workspaceId: "ws",
  lifecycle,
  activeRunId,
  pendingEvidence,
  report: report ?? null,
} as never);

const evidenceFor = (...artifacts: RetrievalArtifactRef[]): RetrievalEvidence => ({
  question: "fact",
  scope: [],
  facts: [{
    claim: "durable sources",
    status: "source-checked",
    sources: artifacts.map((artifact) => ({ kind: "output" as const, check: "source-valid" as const, artifact })),
  }],
  unknowns: [],
  attempted: [],
  completion: "delivered",
});

describe("retrieval artifacts", () => {
  it("keeps same-hash artifacts independently addressable and releasable", async () => {
    const opened = openAccess();
    const firstAuthority = authority("thread-a", "run-a");
    const secondAuthority = authority("thread-b", "run-b");
    const [first, second] = await Promise.all([
      opened.access.storeArtifact("ws", Buffer.from("same body"), firstAuthority),
      opened.access.storeArtifact("ws", Buffer.from("same body"), secondAuthority),
    ]);

    expect(first.hash).toBe(second.hash);
    expect(first.recordId).not.toBe(second.recordId);
    expect(opened.puts.map((put) => put.operationId)).toEqual(expect.arrayContaining([
      `artifact-put:${first.recordId}`,
      `artifact-put:${second.recordId}`,
    ]));
    expect((await opened.access.readArtifact("ws", first))?.toString()).toBe("same body");
    expect((await opened.access.readArtifactSlice("ws", second, 5, 4))?.toString()).toBe("body");
    const withoutSession = { ...first };
    delete withoutSession.sessionId;
    expect(await opened.access.readArtifact("ws", withoutSession)).toBeNull();

    await opened.access.releaseTemporaryArtifacts("ws", firstAuthority);
    expect(await opened.access.readArtifact("ws", first)).toBeNull();
    expect((await opened.access.readArtifact("ws", second))?.toString()).toBe("same body");
    expect(opened.records.has(second.recordId)).toBe(true);

    await opened.access.releaseTemporaryArtifacts("ws", secondAuthority);
    expect(opened.records.has(second.recordId)).toBe(false);
  });

  it("releases source records on promotion while evidence refs keep both bodies readable", async () => {
    const opened = openAccess();
    const owner = authority("thread-promote", "run-promote");
    const local = await opened.access.storeArtifact("ws", Buffer.from("local body"), owner);
    const receipt = await opened.access.persistReceipt(
      "ws",
      mintWebFetchReceipt("https://example.com/fact", "web body", owner),
      "web body",
    );
    const evidence: RetrievalEvidence = {
      ...evidenceFor(local, receipt.artifact),
      facts: [{
        claim: "durable sources",
        status: "source-checked",
        sources: [
          { kind: "output", check: "source-valid", artifact: local },
          { kind: "url", url: receipt.finalUrl, receiptId: receipt.receiptId, check: "source-valid", artifact: receipt.artifact },
        ],
      }],
    };

    await opened.access.promotePendingEvidence({
      workspaceId: "ws",
      threadId: owner.threadId!,
      runId: owner.runId!,
      evidence,
      receiptAuthority: owner,
    });

    expect([...opened.records.values()].filter((record) => record.recordType === "retrieval.artifact")).toHaveLength(0);
    expect([...opened.records.values()].filter((record) => record.recordType === "retrieval.receipt")).toHaveLength(0);
    const pending = opened.records.get(`retrieval-evidence:pending:${owner.threadId}:${owner.runId}`);
    expect(pending?.references.map((reference) => reference.objectHash).sort()).toEqual([
      local.hash,
      receipt.artifact.hash,
    ].sort());
    expect((await opened.access.readArtifactSlice("ws", local, 0, 5))?.toString()).toBe("local");
    expect((await opened.access.readArtifact("ws", receipt.artifact))?.toString()).toBe("web body");
  });

  it("uses exact owner fields when releasing a thread", async () => {
    const opened = openAccess();
    const prefix = await opened.access.storeArtifact("ws", Buffer.from("prefix"), authority("thread-a", "run-a"));
    const sibling = await opened.access.storeArtifact("ws", Buffer.from("sibling"), authority("thread-ab", "run-ab"));

    await opened.access.releaseThreadEvidence("ws", "thread-a");
    expect(opened.records.has(prefix.recordId)).toBe(false);
    expect(opened.records.has(sibling.recordId)).toBe(true);
  });

  it("reconciles orphan records even when no corresponding Thread is supplied", async () => {
    const opened = openAccess();
    const activeAuthority = authority("thread-live", "run-live");
    const active = await opened.access.storeArtifact("ws", Buffer.from("live"), activeAuthority);
    const orphan = await opened.access.storeArtifact("ws", Buffer.from("orphan"), authority("thread-gone", "run-gone"));
    const orphanReceipt = await opened.access.persistReceipt(
      "ws",
      mintWebFetchReceipt("https://example.com/orphan", "orphan receipt", authority("thread-gone", "run-gone")),
      "orphan receipt",
    );
    const orphanEvidence = evidenceFor(orphan);
    await opened.access.syncThreadEvidence("ws", retrievalThread("thread-gone", "active", "run-gone", orphanEvidence));

    await opened.access.reconcileWorkspaceEvidence("ws", [retrievalThread("thread-live", "active", "run-live")]);

    expect(opened.records.has(active.recordId)).toBe(true);
    expect(opened.records.has(orphan.recordId)).toBe(false);
    expect(opened.records.has(`retrieval-receipt:${Buffer.from("ws").toString("base64url")}.${Buffer.from("session-thread-gone").toString("base64url")}.${Buffer.from("thread-gone").toString("base64url")}.${Buffer.from("run-gone").toString("base64url")}:${Buffer.from(orphanReceipt.receiptId).toString("base64url")}`)).toBe(false);
    expect(opened.records.has(`retrieval-evidence:pending:thread-gone:run-gone`)).toBe(false);
  });

  it("rebuilds pending and sealed evidence without collapsing equal hashes", async () => {
    const opened = openAccess();
    const owner = authority("thread-evidence", "run-evidence");
    const one = await opened.access.storeArtifact("ws", Buffer.from("equal"), owner);
    const two = await opened.access.storeArtifact("ws", Buffer.from("equal"), owner);
    expect(one.recordId).not.toBe(two.recordId);
    const evidence = evidenceFor(one, two);

    await opened.access.syncThreadEvidence("ws", retrievalThread("thread-evidence", "active", "run-evidence", evidence));
    await opened.access.syncThreadEvidence("ws", retrievalThread("thread-evidence", "settled", null, undefined, {
      evidence,
      evidenceRunId: "run-evidence",
    }));

    expect([...opened.records.values()].filter((record) => record.recordType === "retrieval.evidence.sealed")).toHaveLength(1);
    expect((await opened.access.readArtifact("ws", one))?.toString()).toBe("equal");
    expect((await opened.access.readArtifact("ws", two))?.toString()).toBe("equal");
    expect(hashRetrievalText("equal")).toBe(one.hash);
  });
});
