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

  it("rejects absolute paths and unresolved parent segments before comparison", () => {
    expect(resolveNestedThreadScope(["src"], ["/etc/passwd"])).toEqual({ ok: false, expanded: ["/etc/passwd"] });
    expect(resolveNestedThreadScope(["src"], ["src/../docs"])).toEqual({ ok: false, expanded: ["src/../docs"] });
    expect(resolveNestedThreadScope(["src"], ["C:/windows"])).toEqual({ ok: false, expanded: ["C:/windows"] });
    expect(resolveNestedThreadScope(["src"], ["src/./app"])).toEqual({ ok: true, scope: ["src/app"] });
  });

  it("accepts relative names that contain consecutive dots and only rejects a .. segment", () => {
    expect(resolveNestedThreadScope([], ["src/foo..bar"])).toEqual({ ok: true, scope: ["src/foo..bar"] });
    expect(resolveNestedThreadScope([], ["version...txt"])).toEqual({ ok: true, scope: ["version...txt"] });
    expect(resolveNestedThreadScope(["src"], ["src/foo..bar"])).toEqual({ ok: true, scope: ["src/foo..bar"] });
    expect(resolveNestedThreadScope(["src"], ["src\\..\\docs"])).toEqual({ ok: false, expanded: ["src\\..\\docs"] });
  });
});
