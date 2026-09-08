import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHashEmbedder } from "./embedder.js";
import { blockIdentity, workspaceScope } from "./identity.js";
import { createSemanticGenerationStore } from "./store.js";
import type { SemanticChunk } from "./chunker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const chunk = (documentId: string, body: string, startLine = 1, endLine = 3): SemanticChunk => ({
  blockId: blockIdentity(documentId, startLine, endLine),
  parentUnitId: `${encodeURIComponent(documentId)}#run#function`,
  documentId,
  parentName: "run",
  parentKind: "function",
  parentSignature: "function run()",
  startLine,
  endLine,
  contentHash: `hash-${body}`,
  body,
  embedText: body,
  fallback: false,
});

describe("semantic generation store", () => {
  it("keeps two scopeIds isolated and accepts a non-path documentId", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-semantic-scope-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const alpha = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("scope-alpha"),
      embedder,
    });
    const beta = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("scope-beta"),
      embedder,
    });
    try {
      await alpha.publishDocument({
        documentId: "mail:abc123",
        revision: "r1",
        chunks: [chunk("mail:abc123", "alpha unique pineapple token")],
      });
      await beta.publishDocument({
        documentId: "src/other.ts",
        revision: "r1",
        chunks: [chunk("src/other.ts", "beta unique coconut token")],
      });
      const alphaHits = await alpha.search((await embedder.embed(["alpha unique pineapple token"]))[0]!, 8);
      const betaHits = await beta.search((await embedder.embed(["alpha unique pineapple token"]))[0]!, 8);
      expect(alphaHits[0]?.documentId).toBe("mail:abc123");
      expect(alphaHits[0]?.blockId).toContain(encodeURIComponent("mail:abc123"));
      expect(alphaHits.some((hit) => hit.documentId === "src/other.ts")).toBe(false);
      expect(betaHits.some((hit) => hit.documentId === "mail:abc123")).toBe(false);
    } finally {
      await alpha.close();
      await beta.close();
    }
  });

  it("reports partial coverage and only returns published documents while a generation is half-built", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-semantic-partial-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-partial"),
      embedder,
    });
    try {
      store.markBuilding("building");
      await store.publishDocument({
        documentId: "src/ready.ts",
        revision: "r1",
        chunks: [chunk("src/ready.ts", "published zebra token")],
      });
      expect(store.coverage).toBe("partial");
      expect(store.lifecycle).toBe("building");
      const hits = await store.search((await embedder.embed(["published zebra token"]))[0]!, 8);
      expect(hits.map((hit) => hit.documentId)).toEqual(["src/ready.ts"]);
      expect(hits[0]?.generation).toBe(store.generation);
    } finally {
      await store.close();
    }
  });

  it("skips publishing when the embedder is unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-semantic-unavail-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    embedder.status = "unavailable";
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-unavail"),
      embedder,
    });
    try {
      await store.publishDocument({
        documentId: "src/a.ts",
        revision: "r1",
        chunks: [chunk("src/a.ts", "should not be stored")],
      });
      expect(await store.search((await createHashEmbedder().embed(["should not be stored"]))[0]!, 4)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
