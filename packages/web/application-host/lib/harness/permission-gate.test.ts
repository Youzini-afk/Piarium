import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  defaultRules,
  mergePolicies,
  isHighRisk,
  type PermissionPolicy,
} from "./permission-gate.js";

describe("evaluateGate", () => {
  it("allows read-only tools in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("read", {}, policy).decision).toBe("allow");
    expect(evaluateGate("grep", {}, policy).decision).toBe("allow");
    expect(evaluateGate("explore", {}, policy).decision).toBe("allow");
  });

  it("asks for edit tools in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("ask");
    expect(evaluateGate("write", {}, policy).decision).toBe("ask");
    expect(evaluateGate("apply_patch", {}, policy).decision).toBe("ask");
    expect(evaluateGate("merge", {}, policy).decision).toBe("ask");
  });

  it("allows edit tools in accept-edits mode", () => {
    const policy: PermissionPolicy = { mode: "accept-edits", rules: defaultRules("accept-edits") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("allow");
    expect(evaluateGate("write", {}, policy).decision).toBe("allow");
  });

  it("asks for bash in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "ls" }, policy).decision).toBe("ask");
  });

  it("asks for high-risk bash even in accept-edits", () => {
    const policy: PermissionPolicy = { mode: "accept-edits", rules: defaultRules("accept-edits") };
    expect(evaluateGate("bash", { command: "rm -rf /" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "sudo apt install foo" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "git push origin main" }, policy).decision).toBe("ask");
  });

  it("asks for npm install", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "npm install foo" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "bun add foo" }, policy).decision).toBe("ask");
  });

  it("asks for .env paths", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "cat .env" }, policy).decision).toBe("ask");
  });

  it("allows everything in bypass mode", () => {
    const policy: PermissionPolicy = { mode: "bypass", rules: defaultRules("bypass") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("allow");
    expect(evaluateGate("bash", { command: "rm -rf /" }, policy).decision).toBe("allow");
  });

  it("dispatch respects askBefore", () => {
    const policy: PermissionPolicy = {
      mode: "normal",
      rules: defaultRules("normal", { "hard-implement": true }),
    };
    expect(evaluateGate("dispatch", { role: "hard-implement" }, policy).decision).toBe("ask");
  });

  it("rules evaluated top-down, first match wins", () => {
    const policy: PermissionPolicy = {
      mode: "normal",
      rules: [
        { tool: "bash", match: { param: "command", pattern: "^ls$" }, decision: "allow" },
        { tool: "bash", decision: "ask" },
      ],
    };
    expect(evaluateGate("bash", { command: "ls" }, policy).decision).toBe("allow");
    expect(evaluateGate("bash", { command: "rm" }, policy).decision).toBe("ask");
  });

  it("catch-all rule", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("unknown_tool", {}, policy).decision).toBe("ask");
  });
});

describe("mergePolicies", () => {
  it("workspace overrides user mode", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [] };
    const merged = mergePolicies(user, { mode: "accept-edits" });
    expect(merged.mode).toBe("accept-edits");
  });

  it("workspace overrides user rules", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [{ tool: "*", decision: "ask" }] };
    const merged = mergePolicies(user, { rules: [{ tool: "*", decision: "allow" }] });
    expect(merged.rules[0]?.decision).toBe("allow");
  });

  it("falls back to user when workspace doesn't specify", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [{ tool: "*", decision: "deny" }] };
    const merged = mergePolicies(user, {});
    expect(merged.mode).toBe("normal");
    expect(merged.rules).toEqual(user.rules);
  });
});

describe("isHighRisk", () => {
  it("detects rm command", () => {
    expect(isHighRisk("bash", { command: "rm -rf /" })).toBe(true);
  });

  it("detects sudo", () => {
    expect(isHighRisk("bash", { command: "sudo make me a sandwich" })).toBe(true);
  });

  it("detects git push", () => {
    expect(isHighRisk("bash", { command: "git push origin main" })).toBe(true);
  });

  it("detects npm install", () => {
    expect(isHighRisk("bash", { command: "npm install express" })).toBe(true);
  });

  it("detects .env path", () => {
    expect(isHighRisk("write", { path: ".env" })).toBe(true);
  });

  it("detects id_rsa path", () => {
    expect(isHighRisk("write", { path: "~/.ssh/id_rsa" })).toBe(true);
  });

  it("non-shell tools are not high risk", () => {
    expect(isHighRisk("read", { path: ".env" })).toBe(false);
  });

  it("safe commands are not high risk", () => {
    expect(isHighRisk("bash", { command: "ls -la" })).toBe(false);
    expect(isHighRisk("bash", { command: "bun test" })).toBe(false);
  });
});
