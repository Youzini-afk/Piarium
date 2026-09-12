import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { executeRelated } from "./related-tool.js";
import { pathInRoots } from "./explore-graph.js";
import { createRelatedQueryService } from "./related-service.js";
import type { HarnessServiceContext } from "./router.js";

const TEST_DIR = join(tmpdir(), "piarium-related-scope");
const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

let store: KnowledgeStore;

describe("related scope and authoritative reparse (D-240 rework)", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "related-scope-host",
      workspaceId: "ws",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not present owning-workspace graph positions as facts in an isolated execution view", async () => {
    const graphRecall = async () => ({ workspaceId: "owning-ws", store, directFactsCompatible: false });
    const service = createRelatedQueryService({ graphRecall, relationCollector: null } as never);
    const context = {
      actor: {
        authorityInstanceId: "host",
        sessionId: "child-session",
        workerId: "worker",
        workerGeneration: 1,
        workspaceId: "execution-ws",
        grantedCapabilities: ["read.search"],
      },
      sessionId: "child-session",
      workspaceId: "execution-ws",
      authorizedPaths: [],
      signal: new AbortController().signal,
    } satisfies HarnessServiceContext;
    const result = await service.handle({ anchor: "shared" }, context);
    expect(result.status).toBe("unavailable");
    expect(result.text).toContain("not pinned to this isolated execution view");
  });

  it("applies the actor workspace scope: out-of-scope same-name symbols are absent from definitions, references, and final body", async () => {
    // Two files define the same symbol name; only src/a is in scope.
    await store.replaceFileSymbols("src/a/target.ts", "typescript", [
      { name: "shared", kind: "function", range },
    ], "disk-r1");
    await store.replaceFileSymbols("src/b/out.ts", "typescript", [
      { name: "shared", kind: "function", range },
    ], "disk-r1");

    // Persist a reference site in src/b (out of scope) and src/a (in scope).
    await store.recordResolvedRelations("src/a/caller.ts", "typescript", [
      { kind: "references", value: "shared", line: 3, targetPath: "src/b/secret.ts", anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
    ]);
    await store.recordResolvedRelations("src/b/caller.ts", "typescript", [
      { kind: "references", value: "shared", line: 5, anchorPath: "src/b/out.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
    ]);

    // Without roots: both definitions and both reference sites are returned.
    const unscoped = await executeRelated({ anchor: "shared" }, store);
    expect(unscoped.definitions).toHaveLength(2);
    expect(unscoped.references.items).toHaveLength(2);

    // With roots limited to src/a: only the in-scope definition and reference site.
    const scoped = await executeRelated({ anchor: "shared" }, store, { roots: ["src/a"] });
    expect(scoped.definitions).toEqual([
      expect.objectContaining({ path: "src/a/target.ts" }),
    ]);
    expect(scoped.definitions.some((d) => d.path === "src/b/out.ts")).toBe(false);
    expect(scoped.references.items).toEqual([
      expect.objectContaining({ path: "src/a/caller.ts" }),
    ]);
    expect(scoped.references.items[0]?.targetPath).toBeUndefined();
    expect(scoped.references.items.some((r) => r.path === "src/b/caller.ts")).toBe(false);
  });

  it("rejects a path anchor outside the authorized scope", async () => {
    await store.replaceFileSymbols("src/a/file.ts", "typescript", [
      { name: "thing", kind: "function", range },
    ], "disk-r1");
    const result = await executeRelated({ anchor: "src/a/file.ts" }, store, { roots: ["src/b"] });
    expect(result.status).toBe("empty");
    expect(result.text).toContain("outside the authorized workspace scope");
  });

  it("authoritative reparse clears sites that disappeared: two sites shrink to one, then to empty", async () => {
    // First resolution: two reference sites for the same anchor.
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [
        { path: "src/a/c1.ts", language: "typescript", relations: [
          { kind: "references", value: "shared", line: 3, anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
        ]},
        { path: "src/a/c2.ts", language: "typescript", relations: [
          { kind: "references", value: "shared", line: 7, anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
        ]},
      ],
    );
    let refs = await store.findReferences("shared");
    expect(refs).toHaveLength(2);

    // Second resolution: only one site remains (c2 disappeared).
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [
        { path: "src/a/c1.ts", language: "typescript", relations: [
          { kind: "references", value: "shared", line: 3, anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
        ]},
      ],
    );
    refs = await store.findReferences("shared");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe("src/a/c1.ts");

    // Third resolution: empty — all sites disappeared.
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [],
    );
    refs = await store.findReferences("shared");
    expect(refs).toHaveLength(0);
  });

  it("authoritative reparse does not touch rows from a different anchor", async () => {
    // Two anchors resolve the same symbol; reparse of one must not clear the other.
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [
        { path: "src/a/c1.ts", language: "typescript", relations: [
          { kind: "references", value: "shared", line: 3, anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.references", siteRevision: null },
        ]},
      ],
    );
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/other.ts", line: 5 },
      [
        { path: "src/a/c2.ts", language: "typescript", relations: [
          { kind: "references", value: "shared", line: 9, anchorPath: "src/a/other.ts", anchorLine: 5, resolvedBy: "lsp.references", siteRevision: null },
        ]},
      ],
    );
    let refs = await store.findReferences("shared");
    expect(refs).toHaveLength(2);

    // Reparse the first anchor as empty — the second anchor's rows survive.
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [],
    );
    refs = await store.findReferences("shared");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe("src/a/c2.ts");
  });

  it("combined calls status is partial when one direction has results but the other failed", async () => {
    // Persist a symbol definition so executeRelated reaches the calls section.
    await store.replaceFileSymbols("src/a/target.ts", "typescript", [
      { name: "shared", kind: "function", range },
    ], "disk-r1");
    // Persist a call row so findCallers returns it.
    await store.replaceResolvedRelationsForAnchor(
      { path: "src/a/target.ts", line: 1 },
      [
        { path: "src/a/c1.ts", language: "typescript", relations: [
          { kind: "calls", value: "shared", line: 3, caller: "driver", targetPath: "src/a/target.ts", targetName: "shared", anchorPath: "src/a/target.ts", anchorLine: 1, resolvedBy: "lsp.callHierarchy.incoming", siteRevision: null },
        ]},
      ],
    );
    // Verify the row is findable.
    const directCallers = await store.findCallers("shared");
    expect(directCallers).toHaveLength(1);

    // Without a collector, outcomes is empty — status is based on rows only.
    // Rows exist and no failed outcomes, so status is ready.
    const result = await executeRelated(
      { anchor: "shared" },
      store,
      { roots: ["src/a"] },
    );
    expect(result.calls.status).toBe("ready");

    // Now simulate a failed outcome via the collector interface.
    const failingCollector = {
      collect: async () => ({
        status: "partial" as const,
        references: { status: "ready" as const, sites: [] },
        calls: { status: "failed" as const, callers: [], callees: [] },
      }),
    };
    const partial = await executeRelated(
      { anchor: "shared" },
      store,
      { workspaceId: "ws", collector: failingCollector, roots: ["src/a"] },
    );
    // Rows exist (from the persisted call above) but one outcome was failed,
    // so the combined status must be partial, not ready.
    expect(partial.calls.status).toBe("partial");
  });

  it("scopes findImporters and connection otherEnds to authorized roots", async () => {
    await store.replaceFileSymbols("src/a/hub.ts", "typescript", [
      { name: "hub", kind: "function", range },
    ], "disk-r1", [
      { kind: "connects", value: "hub.api", callee: "register", line: 4 },
    ]);
    await store.replaceFileSymbols("src/b/consumer.ts", "typescript", [
      { name: "consumer", kind: "function", range },
    ], "disk-r1", [
      { kind: "import", value: "../a/hub.js", line: 1 },
      { kind: "connects", value: "hub.api", callee: "request", line: 8 },
    ]);
    await store.replaceFileSymbols("src/a/inner.ts", "typescript", [
      { name: "inner", kind: "function", range },
    ], "disk-r1", [
      { kind: "import", value: "./hub.js", line: 1 },
    ]);

    const scoped = await executeRelated({ anchor: "src/a/hub.ts" }, store, { roots: ["src/a"] });
    // Importer in src/b is out of scope; importer in src/a is in scope.
    expect(scoped.importers.items).toEqual([
      { path: "src/a/inner.ts", specifier: "./hub.js" },
    ]);
    expect(scoped.importers.items.some((i) => i.path === "src/b/consumer.ts")).toBe(false);
    // Connection otherEnds: only in-scope ends.
    const conn = scoped.connections.items[0]!;
    expect(conn.otherEnds.some((e) => e.path === "src/b/consumer.ts")).toBe(false);
  });

  it("pathInRoots is consistent with the scope semantics used by related and explore", () => {
    expect(pathInRoots("src/a/file.ts", ["src/a"])).toBe(true);
    expect(pathInRoots("src/b/file.ts", ["src/a"])).toBe(false);
    expect(pathInRoots("src/a/file.ts", [])).toBe(true);
    expect(pathInRoots("src/a/file.ts", undefined)).toBe(true);
    expect(pathInRoots("src/a/sub/file.ts", ["src/a"])).toBe(true);
  });
});
