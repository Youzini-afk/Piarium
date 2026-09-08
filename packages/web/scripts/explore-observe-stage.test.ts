import { describe, expect, it } from "vitest";
import { formatSemanticLine, stageForTarget } from "./explore-observe-stage.js";

const need = { label: "rank/schedule/materialize body", match: /rankCandidates/ };
const target = { id: "materialize", pathIncludes: "explore.ts", need };

describe("observe stageForTarget", () => {
  it("does not treat a pre-budget snippet as visible when text omitted it", () => {
    const stage = stageForTarget(target, {
      text: "1 excerpt(s) from 1 matched file(s)\n--- other.ts:1-2 ---\nhello",
      snippets: [{ path: "packages/web/application-host/lib/harness/explore.ts", text: "function rankCandidates() {}", why: "" }],
      details: {
        provenance: [{ path: "packages/web/application-host/lib/harness/explore.ts", status: "ready" }],
        windows: [{
          path: "packages/web/application-host/lib/harness/explore.ts",
          startLine: 490,
          endLine: 530,
          why: "matched rankCandidates",
          packed: true,
          hits: ["rankCandidates"],
        }],
      },
    });
    expect(stage).toBe("materialize: packed snippet has rank/schedule/materialize body, not in visible text");
    expect(stage).not.toMatch(/visible #/);
  });

  it("numbers visibility from the formatted text, not the snippets array", () => {
    const stage = stageForTarget(target, {
      text: [
        "2 excerpt(s)",
        "--- other.ts:1-2 ---",
        "hello",
        "--- packages/web/application-host/lib/harness/explore.ts:490-530 ---",
        "function rankCandidates() {}",
      ].join("\n"),
      snippets: [
        { path: "packages/web/application-host/lib/harness/explore.ts", text: "function rankCandidates() {}", why: "" },
        { path: "other.ts", text: "hello", why: "" },
      ],
      details: {
        provenance: [{ path: "packages/web/application-host/lib/harness/explore.ts", status: "ready" }],
      },
    });
    expect(stage).toBe("materialize: acquired → scheduled → read → rank/schedule/materialize body verified → visible #2");
  });
});

describe("observe semantic line", () => {
  it("reports the two status axes and how many blocks became primary", () => {
    expect(formatSemanticLine({
      status: "unavailable",
      coverage: "empty",
      index: { lifecycle: "idle" },
      blocks: 0,
      units: 0,
      primary: 0,
    })).toBe("semantic: status=unavailable coverage=empty lifecycle=idle blocks=0 units=0 primary=0");
  });
});
