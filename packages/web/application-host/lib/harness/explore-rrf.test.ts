import { describe, expect, it } from "vitest";
import { EXPLORE_RRF_K, fuseFileRanks, reciprocalRank } from "./explore-rrf.js";

describe("file-level RRF", () => {
  it("uses k=60 and omits a missing source", () => {
    expect(EXPLORE_RRF_K).toBe(60);
    expect(reciprocalRank(1)).toBeCloseTo(1 / 61);
    expect(fuseFileRanks({ semantic: 1 })).toBeCloseTo(1 / 61);
    expect(fuseFileRanks({ lexical: 3, semantic: 1 })).toBeCloseTo(1 / 63 + 1 / 61);
  });

  it("does not give a file ten votes for ten semantic blocks", () => {
    const bestFile = fuseFileRanks({ semantic: 1 });
    const noisyFile = Array.from({ length: 10 }, (_, index) => reciprocalRank(2 + index))
      .reduce((sum, item) => sum + item, 0);
    expect(bestFile).toBeGreaterThan(fuseFileRanks({ semantic: 2 }));
    expect(noisyFile).toBeGreaterThan(bestFile);
  });
});
