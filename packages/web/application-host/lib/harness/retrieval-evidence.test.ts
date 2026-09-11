import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOutputStore } from "./output-store.js";
import { validateRetrievalEvidence } from "./retrieval-evidence.js";
import { mintWebFetchReceipt } from "./web-fetch-receipt.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import type { HarnessActorContext, RetrievalArtifactRef, RetrievalUrlReceipt } from "@piarium/protocol";

const actor: HarnessActorContext = {
  authorityInstanceId: "host",
  sessionId: "retrieval-child",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["control.thread", "read.document"],
};

const reader = (files: Record<string, { content: string; revision: string }>): ExploreFileReader => (
  async (_actor, path) => {
    const file = files[path];
    if (!file) return { status: "unavailable", message: "missing" };
    return { status: "ready", content: file.content, revision: file.revision, source: "disk" };
  }
);

const memoryArtifacts = () => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    storeArtifact: async (bytes: Buffer): Promise<RetrievalArtifactRef> => {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      return { durability: "durable", hash, byteLength: bytes.byteLength };
    },
  };
};

describe("validateRetrievalEvidence", () => {
  it("marks an in-scope path source-checked and rejects out-of-scope paths", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "Where is login?",
      brief: "Where is login?",
      frozenScope: ["src"],
      facts: [
        {
          claim: "login lives in auth.ts",
          sources: [{ kind: "local", path: "src/auth.ts", startLine: 2, endLine: 3 }],
        },
        {
          claim: "secret outside scope",
          sources: [{ kind: "local", path: "secrets/key.ts", startLine: 1, endLine: 1 }],
        },
        {
          claim: "invented range",
          sources: [{ kind: "local", path: "src/auth.ts", startLine: 90, endLine: 99 }],
        },
      ],
      readFile: reader({ "src/auth.ts": { content: "export const a = 1;\nexport function login() {}\nexport const b = 2;\n", revision: "d1_abc" } }),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.question).toBe("Where is login?");
    expect(evidence.completion).toBe("delivered");
    expect(evidence.facts).toHaveLength(2);
    expect(evidence.facts[0]).toMatchObject({
      claim: "login lives in auth.ts",
      status: "source-checked",
      sources: [expect.objectContaining({
        path: "src/auth.ts",
        startLine: 2,
        endLine: 3,
        revision: "d1_abc",
        check: "source-valid",
        excerpt: "export function login() {}\nexport const b = 2;",
      })],
    });
    expect(evidence.facts[0]?.status).not.toBe("verified");
    expect(evidence.facts[1]?.status).toBe("unknown");
    expect(evidence.attempted.some((item) => item.outcome === "rejected" && item.action.includes("secrets/key.ts"))).toBe(true);
    expect(evidence.facts.every((fact) => !fact.claim.includes("secret outside"))).toBe(true);
    expect(evidence).not.toHaveProperty("recommendations");
    expect(evidence).not.toHaveProperty("priority");
  });

  it("does not call a valid source range a verified claim", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "child restatement",
      brief: "Where is login?",
      frozenScope: ["src"],
      facts: [{
        claim: "this file proves the moon is cheese",
        sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }],
      }],
      readFile: reader({ "src/auth.ts": { content: "export function login() {}\n", revision: "d1_auth" } }),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.question).toBe("Where is login?");
    expect(evidence.facts[0]?.status).toBe("source-checked");
    expect(JSON.stringify(evidence)).not.toMatch(/verified/);
  });

  it("does not mark a missing path source-checked", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "ghost",
      brief: "ghost",
      frozenScope: [],
      facts: [{
        claim: "ghost file",
        sources: [{ kind: "local", path: "nope.ts", startLine: 1, endLine: 1 }],
      }],
      readFile: reader({}),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts[0]?.status).not.toBe("source-checked");
    expect(evidence.facts[0]?.status).toBe("unavailable");
    expect(evidence.attempted[0]?.outcome).toBe("unavailable");
  });

  it("aggregates mixed sources independently of input order", async () => {
    const files = reader({
      "src/auth.ts": { content: "export function login() {}\n", revision: "d1_auth" },
    });
    const good = { kind: "local" as const, path: "src/auth.ts", startLine: 1, endLine: 1 };
    const bad = { kind: "local" as const, path: "src/missing.ts", startLine: 1, endLine: 1 };
    const first = await validateRetrievalEvidence({
      question: "login",
      brief: "login",
      frozenScope: ["src"],
      facts: [{ claim: "login exists", sources: [bad, good] }],
      readFile: files,
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    const second = await validateRetrievalEvidence({
      question: "login",
      brief: "login",
      frozenScope: ["src"],
      facts: [{ claim: "login exists", sources: [good, bad] }],
      readFile: files,
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(first.facts[0]?.status).toBe("source-checked");
    expect(second.facts[0]?.status).toBe(first.facts[0]?.status);
    expect(first.facts[0]?.sources.map((source) => source.check).sort()).toEqual(["source-valid", "unavailable"]);
    expect(second.facts[0]?.sources.map((source) => source.check).sort()).toEqual(["source-valid", "unavailable"]);
  });

  it("stores checked excerpts as durable artifacts and keeps them after the output store is dropped", async () => {
    const store = createOutputStore({ generation: "a".repeat(32), macKey: Buffer.alloc(32, 1) });
    const artifacts = memoryArtifacts();
    const body = `${"x".repeat(40_000)}\nexport function login() {}\n`;
    const evidence = await validateRetrievalEvidence({
      question: "large",
      brief: "large",
      frozenScope: [],
      facts: [{
        claim: "large body",
        sources: [{ kind: "local", path: "big.ts", startLine: 1, endLine: 2 }],
      }],
      readFile: reader({ "big.ts": { content: body, revision: "d1_big" } }),
      actor,
      signal: new AbortController().signal,
      outputStore: store,
      storeArtifact: artifacts.storeArtifact,
      sessionId: actor.sessionId,
      visibleBytes: 1024,
    });
    expect(evidence.facts[0]?.status).toBe("source-checked");
    expect(evidence.facts[0]?.sources[0]?.outputRef).toBeUndefined();
    const artifact = evidence.facts[0]?.sources[0]?.artifact;
    expect(artifact?.durability).toBe("durable");
    store.dropSession(actor.sessionId);
    store.dispose();
    expect(artifacts.objects.get(artifact!.hash)?.toString("utf8")).toContain("export function login()");
  });

  it("copies an ephemeral output handle into a durable artifact", async () => {
    const store = createOutputStore({ generation: "a".repeat(32), macKey: Buffer.alloc(32, 1) });
    const artifacts = memoryArtifacts();
    const stored = store.store(actor.sessionId, "child session output body", "retrieval");
    const evidence = await validateRetrievalEvidence({
      question: "output",
      brief: "output",
      frozenScope: [],
      facts: [{
        claim: "child output",
        sources: [{ kind: "output", outputRef: stored.ref }],
      }],
      actor,
      signal: new AbortController().signal,
      outputStore: store,
      storeArtifact: artifacts.storeArtifact,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts[0]?.status).toBe("source-checked");
    expect(evidence.facts[0]?.sources[0]?.outputRef).toBeUndefined();
    const artifact = evidence.facts[0]?.sources[0]?.artifact;
    store.dropSession(actor.sessionId);
    store.dispose();
    expect(artifacts.objects.get(artifact!.hash)?.toString("utf8")).toBe("child session output body");
  });

  it("accepts a short URL receipt and rejects rebinding it to another URL", async () => {
    const markdown = "short page";
    const receiptAuthority = { owningWorkspaceId: "ws", sessionId: actor.sessionId, threadId: "thread-1", runId: "run-1" };
    const draft = mintWebFetchReceipt("https://example.com/doc", markdown, receiptAuthority);
    const receipt: RetrievalUrlReceipt = {
      ...draft,
      artifact: { durability: "durable", hash: draft.contentHash, byteLength: Buffer.byteLength(markdown) },
    };
    const receipts = new Map<string, RetrievalUrlReceipt>([[receipt.receiptId, receipt]]);
    const valid = await validateRetrievalEvidence({
      question: "docs",
      brief: "docs",
      frozenScope: [],
      facts: [{
        claim: "external note",
        sources: [{ kind: "url", url: "https://example.com/doc", receiptId: receipt.receiptId }],
      }],
      lookupReceipt: async (receiptId) => receipts.get(receiptId) ?? null,
      receiptAuthority,
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(valid.facts[0]?.status).toBe("source-checked");
    expect(valid.facts[0]?.sources[0]).toMatchObject({
      check: "source-valid",
      url: "https://example.com/doc",
      receiptId: receipt.receiptId,
      contentHash: receipt.contentHash,
    });

    const rebound = await validateRetrievalEvidence({
      question: "docs",
      brief: "docs",
      frozenScope: [],
      facts: [{
        claim: "other site",
        sources: [{ kind: "url", url: "https://evil.example/doc", receiptId: receipt.receiptId }],
      }],
      lookupReceipt: async (receiptId) => receipts.get(receiptId) ?? null,
      receiptAuthority,
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(rebound.facts[0]?.status).toBe("unknown");
    expect(rebound.facts[0]?.sources[0]?.check).toBe("unknown");
  });

  it("leaves an unstored URL unknown", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "docs",
      brief: "docs",
      frozenScope: [],
      facts: [{
        claim: "external note",
        sources: [{ kind: "url", url: "https://example.com/doc" }],
      }],
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts[0]?.status).toBe("unknown");
  });

  it("keeps the checked excerpt identity after the live file changes", async () => {
    const files = { "src/auth.ts": { content: "export function login() {}\n", revision: "d1_old" } };
    const evidence = await validateRetrievalEvidence({
      question: "login",
      brief: "login",
      frozenScope: ["src"],
      facts: [{
        claim: "login exists",
        sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }],
      }],
      readFile: reader(files),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    files["src/auth.ts"] = { content: "replaced\n", revision: "d1_new" };
    expect(evidence.facts[0]?.sources[0]?.revision).toBe("d1_old");
    expect(evidence.facts[0]?.sources[0]?.excerpt).toBe("export function login() {}");
    expect(evidence.facts[0]?.sources[0]?.contentHash).toMatch(/^sha256-/);
  });
});
