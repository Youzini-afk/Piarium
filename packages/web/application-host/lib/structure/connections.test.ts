import { describe, expect, it } from "vitest";
import { classifyLiteralCall } from "./connections.js";

describe("classifyLiteralCall", () => {
  it("marks allowlisted callees as confirmed connections", () => {
    expect(classifyLiteralCall({ name: "register", literal: "explore.search" })).toBe("connects");
    expect(classifyLiteralCall({ name: "request", literal: "workspace/open" })).toBe("connects");
    expect(classifyLiteralCall({ name: "on", literal: "ready" })).toBe("connects");
    expect(classifyLiteralCall({ name: "once", literal: "exit" })).toBe("connects");
    expect(classifyLiteralCall({ name: "emit", literal: "change" })).toBe("connects");
    expect(classifyLiteralCall({ name: "subscribe", literal: "topic" })).toBe("connects");
    expect(classifyLiteralCall({ name: "addEventListener", literal: "click" })).toBe("connects");
  });

  it("marks other same-string calls as association candidates", () => {
    expect(classifyLiteralCall({ name: "log", literal: "explore.search" })).toBe("associates");
    expect(classifyLiteralCall({ name: "join", literal: "a" })).toBe("associates");
  });

  it("does not treat require/import or empty captures as either class", () => {
    expect(classifyLiteralCall({ name: "require", literal: "fs" })).toBeNull();
    expect(classifyLiteralCall({ name: "import", literal: "./dep" })).toBeNull();
    expect(classifyLiteralCall({ name: "register", literal: "" })).toBeNull();
    expect(classifyLiteralCall({ name: "", literal: "explore.search" })).toBeNull();
  });
});
