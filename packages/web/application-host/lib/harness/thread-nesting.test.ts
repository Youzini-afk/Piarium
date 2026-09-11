import { describe, expect, it } from "vitest";
import { resolveNestedThreadScope, scopePathContainedBy } from "./thread-nesting.js";

describe("nested thread scope", () => {
  it("inherits the parent scope when the child omits one and rejects expansion", () => {
    expect(scopePathContainedBy("src", "src/app.ts")).toBe(true);
    expect(scopePathContainedBy("src", "docs/readme.md")).toBe(false);
    expect(resolveNestedThreadScope(["src"], undefined)).toEqual({ ok: true, scope: ["src"] });
    expect(resolveNestedThreadScope(["src"], ["src/app"])).toEqual({ ok: true, scope: ["src/app"] });
    expect(resolveNestedThreadScope(["src"], ["docs"])).toEqual({ ok: false, expanded: ["docs"] });
    expect(resolveNestedThreadScope(["src"], ["."])).toEqual({ ok: false, expanded: ["."] });
  });
});
