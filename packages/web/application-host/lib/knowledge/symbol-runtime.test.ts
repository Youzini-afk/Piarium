import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createSymbolGraphRuntime } from "./symbol-runtime.js";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import type { DocumentMutationObservation } from "../documents/authority.js";

const TEST_DIR = join(tmpdir(), "piarium-symbol-runtime");

describe("symbol graph runtime", () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({ dataDir: TEST_DIR, hostId: "host", workspaceId: "workspace", embedding: null });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("projects committed document changes through the live LSP and preserves the last graph while unavailable", async () => {
    let available = true;
    let synced = false;
    let version: number | null = null;
    let symbols: unknown[] = [{
      name: "Outer",
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
      children: [{ name: "inner", kind: 12, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } }],
    }];
    const read = vi.fn(async () => ({
      status: "ready" as const,
      resource: { workspaceId: "workspace", resourceId: "src/a.ts" },
      content: "class Outer {}",
      revision: "r1",
      encoding: "utf-8",
      bom: false,
      byteLength: 14,
      epoch: 1,
    }));
    const supervisor = {
      getStatus: () => ({ status: available ? "ready" : "unavailable" }),
      hasSyncedDocument: () => synced,
      syncedDocumentVersion: () => version,
      syncDocument: vi.fn(async () => { synced = true; version = 1; return { status: "synced", documentVersion: 1 }; }),
      documentSymbols: vi.fn(async () => ({ status: "ready", value: symbols })),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: { read } as never,
      supervisor: supervisor as never,
    });
    const mutation = { workspaceId: "workspace", resourceId: "src/a.ts", kind: "modified" as const, owner: { kind: "web-route", id: "editor" } };
    try {
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect((await store.searchSymbols("Outer", 10)).map((entry) => entry.name)).toEqual(["Outer"]);
      expect((await store.searchSymbols("inner", 10)).map((entry) => entry.name)).toEqual(["inner"]);
      expect(read).toHaveBeenCalledTimes(1);

      symbols = [{ name: "Replacement", kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } } }];
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.searchSymbols("Outer", 10)).toEqual([]);
      expect(await store.searchSymbols("Replacement", 10)).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(1);

      available = false;
      symbols = [];
      runtime.observeDocumentMutation(mutation);
      await runtime.drain();
      expect(await store.searchSymbols("Replacement", 10)).toHaveLength(1);

      runtime.observeDocumentMutation({ ...mutation, kind: "deleted" });
      await runtime.drain();
      expect(await store.searchSymbols("Replacement", 10)).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("runs from the Documents post-commit observation boundary", async () => {
    let observe = (_event: DocumentMutationObservation): void => undefined;
    const documents = await createDocumentAuthorityHarness({
      authority: { onMutation: (event) => observe(event) },
    });
    const supervisor = {
      getStatus: () => ({ status: "ready" }),
      hasSyncedDocument: () => false,
      syncedDocumentVersion: () => null,
      syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
      documentSymbols: async () => ({
        status: "ready",
        value: [{ name: "ObservedSymbol", kind: 13, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 27 } } }],
      }),
    };
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: supervisor as never,
    });
    observe = runtime.observeDocumentMutation;
    try {
      const written = await documents.authority.write({
        resource: documents.resource("observed.ts"),
        token: documents.token(undefined, { kind: "web-route", id: "editor" }),
        content: "export const ObservedSymbol = true;\n",
        encoding: "utf-8",
        bom: false,
        expectedRevision: null,
        operationId: randomUUID(),
      });
      expect(written.status).toBe("written");
      await Promise.resolve();
      await runtime.drain();
      expect(await store.searchSymbols("ObservedSymbol", 5)).toEqual([
        expect.objectContaining({ name: "ObservedSymbol", path: "observed.ts" }),
      ]);
    } finally {
      observe = () => undefined;
      await runtime.dispose();
      await documents.cleanup();
    }
  });
});
