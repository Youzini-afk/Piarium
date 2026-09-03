import { describe, it, expect } from "vitest";
import {
  evaluateSmartMode,
  isSmartModeAvailable,
  SMART_MODE_PROMPT,
} from "./smart-mode.js";
import { defaultRules, type PermissionPolicy } from "./permission-gate.js";
import type { SlotResolution } from "./model-slots.js";

const judgeModel: SlotResolution = { providerId: "anthropic", modelId: "claude-haiku" };

function makePolicy(mode: "smart" = "smart"): PermissionPolicy {
  return { mode, rules: defaultRules(mode) };
}

describe("isSmartModeAvailable", () => {
  it("true when model configured", () => {
    expect(isSmartModeAvailable(judgeModel)).toBe(true);
  });

  it("false when no model", () => {
    expect(isSmartModeAvailable(null)).toBe(false);
  });
});

describe("evaluateSmartMode", () => {
  it("allows read-only tools without model", async () => {
    const result = await evaluateSmartMode("read", {}, makePolicy(), {
      permissionJudgeModel: null,
      callJudge: async () => "allow",
    });
    expect(result.decision).toBe("allow");
  });

  it("asks when no model configured and tool requires ask", async () => {
    const result = await evaluateSmartMode("edit", {}, makePolicy(), {
      permissionJudgeModel: null,
      callJudge: async () => "allow",
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("no permission judge");
  });

  it("uses model for ask decisions", async () => {
    const result = await evaluateSmartMode("edit", { path: "src/a.ts" }, makePolicy(), {
      permissionJudgeModel: judgeModel,
      callJudge: async () => "allow",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("model judged");
  });

  it("model can decide to ask", async () => {
    const result = await evaluateSmartMode("edit", { path: "src/a.ts" }, makePolicy(), {
      permissionJudgeModel: judgeModel,
      callJudge: async () => "ask",
    });
    expect(result.decision).toBe("ask");
  });

  it("high-risk always asks regardless of model", async () => {
    let modelCalled = false;
    const result = await evaluateSmartMode("bash", { command: "rm -rf /" }, makePolicy(), {
      permissionJudgeModel: judgeModel,
      callJudge: async () => { modelCalled = true; return "allow"; },
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("high-risk");
    expect(modelCalled).toBe(false);
  });

  it("high-risk .env path always asks", async () => {
    const result = await evaluateSmartMode("write", { path: ".env" }, makePolicy(), {
      permissionJudgeModel: judgeModel,
      callJudge: async () => "allow",
    });
    expect(result.decision).toBe("ask");
  });

  it("deny from rules is preserved", async () => {
    const policy: PermissionPolicy = {
      mode: "smart",
      rules: [{ tool: "edit", decision: "deny" }],
    };
    const result = await evaluateSmartMode("edit", {}, policy, {
      permissionJudgeModel: judgeModel,
      callJudge: async () => "allow",
    });
    expect(result.decision).toBe("deny");
  });
});

describe("SMART_MODE_PROMPT", () => {
  it("contains instruction to respond with allow or ask", () => {
    expect(SMART_MODE_PROMPT).toContain("allow");
    expect(SMART_MODE_PROMPT).toContain("ask");
  });
});
