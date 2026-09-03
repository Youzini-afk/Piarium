import { describe, it, expect } from "vitest";
import {
  executeSymbols,
  executeDefinition,
  executeReferences,
  executeHover,
  type LspNavDeps,
} from "./lsp-nav.js";

function makeDeps(overrides: Partial<LspNavDeps> = {}): LspNavDeps {
  return {
    symbols: async () => [],
    definition: async () => [],
    references: async () => [],
    hover: async () => ({ signature: "" }),
    getLanguage: () => "typescript",
    isServerRunning: () => true,
    ...overrides,
  };
}

describe("executeSymbols", () => {
  it("ready state with results", async () => {
    const deps = makeDeps({
      symbols: async () => [{
        name: "myFunc", kind: "Function", path: "src/a.ts",
        range: { startLine: 10, startCharacter: 0, endLine: 20, endCharacter: 0 },
      }],
    });
    const result = await executeSymbols("myFunc", deps);
    expect(result.state).toBe("ready");
    expect(result.data).toHaveLength(1);
    expect(result.message).toContain("myFunc");
  });

  it("empty state", async () => {
    const result = await executeSymbols("nonexistent", makeDeps());
    expect(result.state).toBe("empty");
  });

  it("unavailable state", async () => {
    const deps = makeDeps({ symbols: async () => null });
    const result = await executeSymbols("test", deps);
    expect(result.state).toBe("unavailable");
  });
});

describe("executeDefinition", () => {
  it("ready state", async () => {
    const deps = makeDeps({
      definition: async () => [{
        path: "src/b.ts", startLine: 5, startCharacter: 0, endLine: 10, endCharacter: 0,
      }],
    });
    const result = await executeDefinition("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("ready");
    expect(result.message).toContain("src/b.ts");
  });

  it("empty state", async () => {
    const result = await executeDefinition("src/a.ts", 1, 0, makeDeps());
    expect(result.state).toBe("empty");
  });

  it("unavailable when no server", async () => {
    const deps = makeDeps({ isServerRunning: () => false });
    const result = await executeDefinition("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("unavailable");
    expect(result.message).toContain("no language server");
  });
});

describe("executeReferences", () => {
  it("ready state", async () => {
    const deps = makeDeps({
      references: async () => [
        { path: "src/x.ts", line: 10, character: 5 },
        { path: "src/y.ts", line: 20, character: 0 },
      ],
    });
    const result = await executeReferences("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("ready");
    expect(result.message).toContain("2 references");
  });

  it("empty state", async () => {
    const result = await executeReferences("src/a.ts", 1, 0, makeDeps());
    expect(result.state).toBe("empty");
  });

  it("unavailable when no server", async () => {
    const deps = makeDeps({ isServerRunning: () => false });
    const result = await executeReferences("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("unavailable");
  });
});

describe("executeHover", () => {
  it("ready state with signature only", async () => {
    const deps = makeDeps({
      hover: async () => ({ signature: "function foo(x: number): string" }),
    });
    const result = await executeHover("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("ready");
    expect(result.message).toBe("function foo(x: number): string");
  });

  it("ready state with signature and docs", async () => {
    const deps = makeDeps({
      hover: async () => ({
        signature: "function foo(x: number): string",
        documentation: "Converts a number to a string",
      }),
    });
    const result = await executeHover("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("ready");
    expect(result.message).toContain("Converts a number to a string");
  });

  it("empty state when no signature", async () => {
    const deps = makeDeps({
      hover: async () => ({ signature: "" }),
    });
    const result = await executeHover("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("empty");
  });

  it("unavailable when no server", async () => {
    const deps = makeDeps({ isServerRunning: () => false });
    const result = await executeHover("src/a.ts", 1, 0, deps);
    expect(result.state).toBe("unavailable");
  });
});
