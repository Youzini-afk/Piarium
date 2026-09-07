import { describe, expect, it } from "vitest";
import { resolveImportSpecifier } from "./import-resolve.js";

const files = new Set([
  "lib/harness/explore.ts",
  "lib/harness/explore-service.ts",
  "packages/web/src/index.ts",
  "src/a.ts",
  "src/b.tsx",
  "src/util/index.ts",
]);

describe("resolveImportSpecifier", () => {
  it("resolves a relative specifier with a missing extension", () => {
    expect(resolveImportSpecifier("lib/harness/explore-service.ts", "./explore", files)).toEqual({
      status: "resolved",
      resolvedPath: "lib/harness/explore.ts",
    });
  });

  it("resolves a TypeScript file imported with a .js specifier", () => {
    expect(resolveImportSpecifier("lib/harness/explore-service.ts", "./explore.js", files)).toEqual({
      status: "resolved",
      resolvedPath: "lib/harness/explore.ts",
    });
  });

  it("resolves parent-directory and index targets", () => {
    expect(resolveImportSpecifier("src/nested/file.ts", "../util", files)).toEqual({
      status: "resolved",
      resolvedPath: "src/util/index.ts",
    });
    expect(resolveImportSpecifier("packages/web/src/index.ts", "../../web/src/index.ts", files)).toEqual({
      status: "resolved",
      resolvedPath: "packages/web/src/index.ts",
    });
  });

  it("leaves package names and aliases unresolved instead of guessing", () => {
    expect(resolveImportSpecifier("src/a.ts", "@piarium/protocol", files)).toEqual({ status: "non-relative" });
    expect(resolveImportSpecifier("src/a.ts", "node:fs", files)).toEqual({ status: "non-relative" });
    expect(resolveImportSpecifier("src/a.ts", "#application-host/store", files)).toEqual({ status: "non-relative" });
  });

  it("refuses to guess when two extension twins exist", () => {
    const twins = new Set([...files, "src/a.tsx"]);
    expect(resolveImportSpecifier("src/util/index.ts", "../a", twins)).toEqual({ status: "unresolved-relative" });
  });

  it("reports a missing relative target as unresolved", () => {
    expect(resolveImportSpecifier("src/a.ts", "./missing", files)).toEqual({ status: "unresolved-relative" });
  });
});
