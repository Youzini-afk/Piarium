import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RetrievalArtifactRef, RetrievalEvidence, RetrievalReceiptAuthority, Thread } from "@varin/protocol";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createRetrievalArtifactAccess } from "./retrieval-artifacts.js";
import { createWebMaterialStore } from "./web-materials.js";

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

const openStore = () => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, TestRecord>();
  const store = {
    async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
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
  };
  const context = {
    records: {
      async get(recordId: string): Promise<TestRecord | null> {
        return records.get(recordId) ?? null;
      },
      async list(input: { recordType?: string }): Promise<TestRecord[]> {
        return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType);
      },
      async put(input: Omit<TestRecord, "recordRevision" | "workspaceId"> & { workspaceId?: string; operationId: string; expectedRecordRevision?: number }): Promise<TestRecord> {
        const existing = records.get(input.recordId);
        if (existing && input.expectedRecordRevision !== existing.recordRevision) throw new Error("record revision conflict");
        const record = { ...input, workspaceId: input.workspaceId ?? "ws", recordRevision: (existing?.recordRevision ?? 0) + 1, references: [...(input.references ?? [])] };
        records.set(record.recordId, record);
        return record;
      },
      async release(_operationId: string, recordId: string): Promise<Record<string, unknown>> {
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
    records,
    objects,
    // A fresh store over the same maps simulates a Host restart: durable
    // records remain resolvable while nothing about the process survived.
    reopen: () => createWebMaterialStore(workingStates),
    materials: createWebMaterialStore(workingStates),
    retrieval: createRetrievalArtifactAccess(workingStates),
  };
};

const authority = (sessionId: string, threadId?: string, runId?: string): RetrievalReceiptAuthority => ({
  owningWorkspaceId: "ws",
  sessionId,
  ...(threadId ? { threadId } : {}),
  ...(runId ? { runId } : {}),
});

const draft = (finalUrl: string) => ({
  sourceUrl: finalUrl,
  finalUrl,
  contentType: "text/plain",
  representation: "raw-text",
});

const retrievalThread = (id: string, lifecycle: "active" | "settled", activeRunId: string | null): Thread => ({
  id,
  workspaceId: "ws",
  lifecycle,
  activeRunId,
  report: null,
} as never);

const evidenceFor = (artifact: RetrievalArtifactRef): RetrievalEvidence => ({
  question: "fact",
  scope: [],
  facts: [{
    claim: "cited body",
    status: "source-checked",
    sources: [{ kind: "output" as const, check: "source-valid" as const, artifact }],
  }],
  unknowns: [],
  attempted: [],
  completion: "delivered",
});

describe("web material snapshots", () => {
  it("pins fetched content and reads it back by snapshotId across reopen", async () => {
    const opened = openStore();
    const ref = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("page body"), authority("s1"));

    const found = await opened.materials.read("ws", ref.snapshotId);
    expect(found?.ref).toEqual(ref);
    expect(found?.body.toString()).toBe("page body");

    // Durable records resolve again after a restart-equivalent reopen.
    const reopened = await opened.reopen().read("ws", ref.snapshotId);
    expect(reopened?.body.toString()).toBe("page body");
    expect(await opened.materials.read("ws", "snap-missing")).toBeNull();
    expect(await opened.materials.read("other-ws", ref.snapshotId)).toBeNull();
  });

  it("dedupes identical content within one authority and keeps snapshots separate across threads", async () => {
    const opened = openStore();
    const owner = authority("s1", "thread-a", "run-a");
    const first = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    const same = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    expect(same.snapshotId).toBe(first.snapshotId);

    const other = authority("s2", "thread-b", "run-b");
    const separate = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), other);
    expect(separate.snapshotId).not.toBe(first.snapshotId);
    expect(await opened.materials.read("ws", separate.snapshotId, owner)).toBeNull();
    expect((await opened.materials.read("ws", separate.snapshotId, other))?.body.toString()).toBe("v1");

    const refreshed = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v2 changed"), owner, { forceNew: true });
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
    expect((await opened.materials.read("ws", first.snapshotId))?.body.toString()).toBe("v1");
    expect((await opened.materials.read("ws", refreshed.snapshotId))?.body.toString()).toBe("v2 changed");
  });

  it("keeps a snapshot whose body is cited by another run while releasing unreferenced ones", async () => {
    const opened = openStore();
    const owner = authority("session-a", "thread-a", "run-a");
    const sharedBody = Buffer.from("shared body");
    const cited = await opened.materials.put("ws", draft("https://example.com/cited"), sharedBody, owner);
    const uncited = await opened.materials.put("ws", draft("https://example.com/uncited"), Buffer.from("dropped"), owner);

    // A different run mints its own receipt over the same body bytes.
    const other = authority("session-b", "thread-b", "run-b");
    const otherArtifact = await opened.retrieval.storeArtifact("ws", sharedBody, other);
    expect(otherArtifact.hash).toBe(cited.contentHash);

    await opened.retrieval.releaseTemporaryArtifacts("ws", owner);

    expect(await opened.materials.read("ws", cited.snapshotId)).not.toBeNull();
    expect(await opened.materials.read("ws", uncited.snapshotId)).toBeNull();
  });

  it("keeps a snapshot cited by promoted evidence when its run settles", async () => {
    const opened = openStore();
    const owner = authority("session-a", "thread-a", "run-a");
    const ref = await opened.materials.put("ws", draft("https://example.com/cited"), Buffer.from("cited body"), owner);
    const artifactRef: RetrievalArtifactRef = {
      durability: "durable",
      hash: ref.contentHash,
      byteLength: ref.byteLength,
      recordId: `web.snapshot:${ref.snapshotId}`,
      recordType: "web.snapshot" as never,
      workspaceId: "ws",
      sessionId: owner.sessionId,
      ...(owner.threadId ? { threadId: owner.threadId } : {}),
      ...(owner.runId ? { runId: owner.runId } : {}),
    };
    await opened.retrieval.promotePendingEvidence({
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-a",
      evidence: evidenceFor(artifactRef),
      receiptAuthority: owner,
    });

    expect(await opened.materials.read("ws", ref.snapshotId)).not.toBeNull();
    expect(opened.records.get(`retrieval-evidence:pending:thread-a:run-a`)?.references.map((r) => r.objectHash)).toEqual([ref.contentHash]);
  });

  it("releases session-scoped snapshots on authority release and orphans on reconcile", async () => {
    const opened = openStore();
    const sessionRef = await opened.materials.put("ws", draft("https://example.com/session"), Buffer.from("session body"), authority("s1"));
    const runRef = await opened.materials.put("ws", draft("https://example.com/run"), Buffer.from("run body"), authority("s2", "thread-gone", "run-gone"));
    const liveRef = await opened.materials.put("ws", draft("https://example.com/live"), Buffer.from("live body"), authority("s3", "thread-live", "run-live"));

    await opened.retrieval.releaseReceiptAuthority("ws", authority("s1"));
    expect(await opened.materials.read("ws", sessionRef.snapshotId)).toBeNull();

    await opened.retrieval.reconcileWorkspaceEvidence("ws", [retrievalThread("thread-live", "active", "run-live")]);
    expect(await opened.materials.read("ws", runRef.snapshotId)).toBeNull();
    expect((await opened.materials.read("ws", liveRef.snapshotId))?.body.toString()).toBe("live body");
  });

  it("keeps a thread snapshot across Run reconciliation and releases it when the thread disappears", async () => {
    const opened = openStore();
    const ref = await opened.materials.put(
      "ws",
      draft("https://example.com/thread-retained"),
      Buffer.from("retained body"),
      authority("session-a", "thread-a", "run-a"),
    );

    await opened.retrieval.syncThreadEvidence("ws", retrievalThread("thread-a", "active", "run-b"));
    expect((await opened.materials.read("ws", ref.snapshotId, authority("session-new", "thread-a", "run-b")))?.body.toString())
      .toBe("retained body");

    await opened.retrieval.reconcileWorkspaceEvidence("ws", [retrievalThread("thread-a", "active", "run-b")]);
    expect(await opened.materials.read("ws", ref.snapshotId, authority("session-new", "thread-a", "run-b"))).not.toBeNull();

    await opened.retrieval.reconcileWorkspaceEvidence("ws", []);
    expect(await opened.materials.read("ws", ref.snapshotId)).toBeNull();
  });
});
