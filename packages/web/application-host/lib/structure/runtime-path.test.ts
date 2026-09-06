import { describe, expect, it } from "vitest";
import { remapAsarUnpackedPath } from "./runtime-path.js";

describe("remapAsarUnpackedPath", () => {
  it("rewrites app.asar to app.asar.unpacked when that path exists", () => {
    const logical = "C:\\Piarium\\resources\\app.asar\\server\\lib\\structure\\runtime\\web-tree-sitter.wasm";
    const unpacked = "C:\\Piarium\\resources\\app.asar.unpacked\\server\\lib\\structure\\runtime\\web-tree-sitter.wasm";
    expect(remapAsarUnpackedPath(logical, (candidate) => candidate === unpacked)).toBe(unpacked);
  });

  it("keeps the logical path when the unpacked file is absent", () => {
    const logical = "/opt/Piarium/resources/app.asar/server/lib/structure/runtime/web-tree-sitter.wasm";
    expect(remapAsarUnpackedPath(logical, () => false)).toBe(logical);
  });
});
