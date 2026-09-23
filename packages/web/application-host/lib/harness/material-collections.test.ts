import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MaterialsCollectionParams, RetrievalReceiptAuthority, WebSnapshotRef } from "@varin/protocol";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import type { HarnessServiceContext } from "./router.js";
import { createMaterialCollections, MATERIAL_COLLECTION_RECORD_TYPE } from "./material-collections.js";
import { createWebMaterialStore } from "./web-materials.js";
import { createRetrievalArtifactAccess } from "./retrieval-artifacts.js";

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
        if (existing && input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== existing.recordRevision) {
          throw new Error("record revision conflict");
        }
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
    materials: createWebMaterialStore(workingStates),
    retrieval: createRetrievalArtifactAccess(workingStates),
    workingStates,
  };
};

const ctx = (sessionId: string, workspaceId = "ws"): HarnessServiceContext => ({
  sessionId,
  workspaceId,
} as HarnessServiceContext);

const call = async (
  service: { handle: (p: MaterialsCollectionParams, c: HarnessServiceContext) => Promise<unknown> },
  params: MaterialsCollectionParams,
  sessionId: string,
) => service.handle(params, ctx(sessionId)) as Promise<import("@varin/protocol").MaterialsCollectionResult>;

describe("material collections", () => {
  it("creates, adds members, lists, and keyword-searches within the collection scope", async () => {
    const opened = openStore();
    const authority: RetrievalReceiptAuthority = { owningWorkspaceId: "ws", sessionId: "s1", threadId: "t1" };
    const snapA = await opened.materials.put("ws", {
      sourceUrl: "https://a.test/", finalUrl: "https://a.test/", representation: "raw-text",
    }, Buffer.from("alpha body\ncontains retrieval keyword\nmore alpha"), authority);
    const snapB = await opened.materials.put("ws", {
      sourceUrl: "https://b.test/", finalUrl: "https://b.test/", representation: "raw-text",
    }, Buffer.from("beta body without the term"), authority);

    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
      resolveThreadId: async () => "t1",
    });

    const created = await call(service, { action: "create", name: "paper-set" }, "s1");
    expect(created.status).toBe("ok");
    const collectionId = created.collection!.collectionId;

    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: snapA.snapshotId } }, "s1");
    await call(service, { action: "add", collectionId, member: { kind: "snapshot", snapshotId: snapB.snapshotId } }, "s1");
    await call(service, { action: "add", collectionId, member: { kind: "paper", paper: { provider: "openalex", id: "W1", doi: "10.1/x" }, role: "main" } }, "s1");

    const listed = await call(service, { action: "list" }, "s1");
    expect(listed.collections).toEqual([
      expect.objectContaining({ collectionId, memberCount: 3, persisted: false }),
    ]);

    const searched = await call(service, { action: "search", collectionId, query: "retrieval" }, "s1");
    expect(searched.status).toBe("ok");
    // Scope applies before recall: only member bodies are scanned.
    expect(searched.hits).toEqual([
      expect.objectContaining({ snapshotId: snapA.snapshotId, line: 2 }),
    ]);
  });

  it("denies foreign-authority writes and reports unreadable members", async () => {
    const opened = openStore();
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
      resolveThreadId: async (sessionId) => (sessionId === "s1" ? "t1" : "t2"),
    });
    const created = await call(service, { action: "create" }, "s1");
    const collectionId = created.collection!.collectionId;

    // A different thread cannot mutate or search this collection.
    const denied = await call(service, {
      action: "add", collectionId, member: { kind: "paper", paper: { provider: "openalex", id: "W9" } },
    }, "s2");
    expect(denied.status).toBe("denied");
    const deniedSearch = await call(service, { action: "search", collectionId, query: "x" }, "s2");
    expect(deniedSearch.status).toBe("not-found");

    // A snapshot owned by another thread is not readable under this authority.
    const foreignSnap = await opened.materials.put("ws", {
      sourceUrl: "https://f.test/", finalUrl: "https://f.test/", representation: "raw-text",
    }, Buffer.from("foreign body"), { owningWorkspaceId: "ws", sessionId: "s2", threadId: "t2" });
    const addForeign = await call(service, {
      action: "add", collectionId, member: { kind: "snapshot", snapshotId: foreignSnap.snapshotId },
    }, "s1");
    expect(addForeign.status).toBe("denied");
  });

  it("fetches and pins url members through the wired fetch path", async () => {
    const opened = openStore();
    const fetched: string[] = [];
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
      resolveThreadId: async () => "t1",
      fetchUrl: async (params) => {
        fetched.push(params.url);
        const ref = await opened.materials.put("ws", {
          sourceUrl: params.url, finalUrl: params.url, representation: "raw-text",
        }, Buffer.from("fetched body"), { owningWorkspaceId: "ws", sessionId: "s1", threadId: "t1" });
        return { status: "ok", snapshot: ref, finalUrl: params.url };
      },
    });
    const created = await call(service, { action: "create" }, "s1");
    const collectionId = created.collection!.collectionId;
    const added = await call(service, {
      action: "add", collectionId, member: { kind: "url", url: "https://paper.test/full" },
    }, "s1");
    expect(added.status).toBe("ok");
    expect(fetched).toEqual(["https://paper.test/full"]);
    expect(added.member?.snapshotId).toBeDefined();
  });

  it("keeps persisted collections across thread release while temporary ones follow it", async () => {
    const opened = openStore();
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
      resolveThreadId: async () => "t1",
    });
    const kept = await call(service, { action: "create", persist: true }, "s1");
    const temp = await call(service, { action: "create" }, "s1");

    await opened.retrieval.releaseThreadEvidence("ws", "t1");

    const records = [...opened.records.values()].filter((r) => r.recordType === MATERIAL_COLLECTION_RECORD_TYPE);
    expect(records.map((r) => r.recordId)).toEqual([`material.collection:${kept.collection!.collectionId}`]);
    // Persisted collections are readable workspace-wide.
    const found = await call(service, { action: "list" }, "s-other");
    expect(found.collections).toEqual([
      expect.objectContaining({ collectionId: kept.collection!.collectionId, persisted: true }),
    ]);
    expect(temp.collection).toBeDefined();
  });

  it("keeps member snapshot bodies alive through collection references", async () => {
    const opened = openStore();
    const authority: RetrievalReceiptAuthority = { owningWorkspaceId: "ws", sessionId: "s1", threadId: "t1" };
    const snap = await opened.materials.put("ws", {
      sourceUrl: "https://a.test/", finalUrl: "https://a.test/", representation: "raw-text",
    }, Buffer.from("kept body"), authority);
    const service = createMaterialCollections(opened.workingStates, {
      materials: opened.materials,
      resolveThreadId: async () => "t1",
    });
    const created = await call(service, { action: "create" }, "s1");
    await call(service, {
      action: "add", collectionId: created.collection!.collectionId,
      member: { kind: "snapshot", snapshotId: snap.snapshotId },
    }, "s1");
    const record = opened.records.get(`material.collection:${created.collection!.collectionId}`);
    expect(record?.references.some((reference) => reference.objectHash === snap.contentHash)).toBe(true);
  });
});
