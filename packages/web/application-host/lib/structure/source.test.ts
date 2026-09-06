import { describe, expect, it } from "vitest";
import { createStructureSource } from "./source.js";
import { NO_STRUCTURE_CAPABILITIES, type StructureProvider } from "./types.js";

const unused = async () => ({
  status: "unsupported" as const,
  provider: "lsp" as const,
  revision: "rev",
  hits: [],
  calls: [],
  imports: [],
});

const provider = (overrides: Partial<StructureProvider> & Pick<StructureProvider, "id" | "outline">): StructureProvider => ({
  capabilities: () => ({ outline: true, classifyHits: false, literalCalls: false, imports: false }),
  classifyHits: unused,
  literalCalls: unused,
  imports: unused,
  ...overrides,
});

describe("createStructureSource", () => {
  it("returns the first ready outline and does not consult a later provider", async () => {
    let later = 0;
    const source = createStructureSource([
      provider({
        id: "tree-sitter",
        outline: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: [{ name: "fromTree", kind: "function", range: { startLine: 1, endLine: 2 }, signature: { startLine: 1, endLine: 1 } }],
        }),
      }),
      provider({
        id: "lsp",
        outline: async (request) => {
          later += 1;
          return { status: "ready", provider: "lsp", revision: request.revision, symbols: [] };
        },
      }),
    ]);
    const result = await source.outline({
      path: "a.ts",
      languageId: "typescript",
      text: "fn",
      revision: "rev-1",
    });
    expect(result.status).toBe("ready");
    expect(result.provider).toBe("tree-sitter");
    expect(result.symbols[0]?.name).toBe("fromTree");
    expect(later).toBe(0);
  });

  it("tries the next provider when the first is unavailable", async () => {
    const source = createStructureSource([
      provider({
        id: "tree-sitter",
        outline: async (request) => ({
          status: "unavailable",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: [],
          message: "wasm missing",
        }),
      }),
      provider({
        id: "lsp",
        outline: async (request) => ({
          status: "ready",
          provider: "lsp",
          revision: request.revision,
          symbols: [{ name: "fromLsp", kind: "function", range: { startLine: 1, endLine: 2 }, signature: { startLine: 1, endLine: 1 } }],
        }),
      }),
    ]);
    const result = await source.outline({
      path: "a.ts",
      languageId: "typescript",
      text: "fn",
      revision: "rev-1",
    });
    expect(result).toMatchObject({ status: "ready", provider: "lsp", symbols: [{ name: "fromLsp" }] });
  });

  it("does not invent an empty success when no provider can outline", async () => {
    const source = createStructureSource([
      provider({
        id: "lsp",
        capabilities: () => NO_STRUCTURE_CAPABILITIES,
        outline: async () => {
          throw new Error("should not be called");
        },
      }),
    ]);
    const result = await source.outline({
      path: "notes.bin",
      languageId: null,
      text: "data",
      revision: "rev-1",
    });
    expect(result.status).toBe("unsupported");
    expect(result.symbols).toEqual([]);
    expect(result.provider).toBeNull();
  });
});
