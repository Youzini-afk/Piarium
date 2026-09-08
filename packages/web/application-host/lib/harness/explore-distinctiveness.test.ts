import { describe, expect, it } from "vitest";
import { queryInternalWeight, uniqueFileCoverage, ORDINARY_MATCH_WEIGHT } from "./explore-distinctiveness.js";

describe("query-internal distinctiveness", () => {
  it("gives extra weight only when unique-file coverage is complete", () => {
    const complete = queryInternalWeight(20, 2, "complete");
    const floor = queryInternalWeight(20, 2, "lower-bound");
    const unknown = queryInternalWeight(20, 2, "unknown");
    expect(complete).toBeGreaterThan(ORDINARY_MATCH_WEIGHT);
    expect(floor).toBe(ORDINARY_MATCH_WEIGHT);
    expect(unknown).toBe(ORDINARY_MATCH_WEIGHT);
    expect(complete).toBeCloseTo(ORDINARY_MATCH_WEIGHT + Math.log(21 / 3));
  });

  it("does not treat a per-file hit cap as incomplete unique-file coverage", () => {
    expect(uniqueFileCoverage({
      filesDropped: 0,
      backendIncomplete: false,
      backendCapped: false,
    })).toBe("complete");
  });

  it("marks filesDropped and an incomplete backend sweep as a lower bound", () => {
    expect(uniqueFileCoverage({
      filesDropped: 4,
      backendIncomplete: false,
      backendCapped: false,
    })).toBe("lower-bound");
    expect(uniqueFileCoverage({
      filesDropped: 0,
      backendIncomplete: true,
      backendCapped: false,
    })).toBe("lower-bound");
  });

  it("marks a backend hit cap without a file drop as unknown, not exact", () => {
    expect(uniqueFileCoverage({
      filesDropped: 0,
      backendIncomplete: false,
      backendCapped: true,
    })).toBe("unknown");
  });
});
