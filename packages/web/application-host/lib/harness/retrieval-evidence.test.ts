import { describe, expect, it } from "vitest";
import { createOutputStore } from "./output-store.js";
import { validateRetrievalEvidence } from "./retrieval-evidence.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import type { HarnessActorContext } from "@piarium/protocol";

const actor: HarnessActorContext = {
  authorityInstanceId: "host",
  sessionId: "retrieval-child",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["control.thread", "read.document"],
};

const reader = (files: Record<string, { content: string; revision: string }>): ExploreFileReader => (
  async (_actor, path) => {
    const file = files[path];
    if (!file) return { status: "unavailable", message: "missing" };
    return { status: "ready", content: file.content, revision: file.revision, source: "disk" };
  }
);

describe("validateRetrievalEvidence", () => {
  it("verifies an in-scope path and range, and rejects out-of-scope paths", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "Where is login?",
      brief: "Where is login?",
      frozenScope: ["src"],
      facts: [
        {
          claim: "login lives in auth.ts",
          sources: [{ kind: "local", path: "src/auth.ts", startLine: 2, endLine: 3 }],
        },
        {
          claim: "secret outside scope",
          sources: [{ kind: "local", path: "secrets/key.ts", startLine: 1, endLine: 1 }],
        },
        {
          claim: "invented range",
          sources: [{ kind: "local", path: "src/auth.ts", startLine: 90, endLine: 99 }],
        },
      ],
      readFile: reader({ "src/auth.ts": { content: "export const a = 1;\nexport function login() {}\nexport const b = 2;\n", revision: "d1_abc" } }),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts).toHaveLength(2);
    expect(evidence.facts[0]).toMatchObject({
      claim: "login lives in auth.ts",
      status: "verified",
      sources: [expect.objectContaining({ path: "src/auth.ts", startLine: 2, endLine: 3, revision: "d1_abc" })],
    });
    expect(evidence.facts[1]?.status).toBe("unknown");
    expect(evidence.attempted.some((item) => item.outcome === "rejected" && item.action.includes("secrets/key.ts"))).toBe(true);
    expect(evidence.facts.every((fact) => !fact.claim.includes("secret outside"))).toBe(true);
    expect(evidence).not.toHaveProperty("recommendations");
    expect(evidence).not.toHaveProperty("priority");
  });

  it("does not mark a missing path verified", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "ghost",
      brief: "ghost",
      frozenScope: [],
      facts: [{
        claim: "ghost file",
        sources: [{ kind: "local", path: "nope.ts", startLine: 1, endLine: 1 }],
      }],
      readFile: reader({}),
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts[0]?.status).not.toBe("verified");
    expect(evidence.attempted[0]?.outcome).toBe("unavailable");
  });

  it("stores large excerpts as OutputRef", async () => {
    const store = createOutputStore({ generation: "a".repeat(32), macKey: Buffer.alloc(32, 1) });
    const body = `${"x".repeat(40_000)}\nexport function login() {}\n`;
    const evidence = await validateRetrievalEvidence({
      question: "large",
      brief: "large",
      frozenScope: [],
      facts: [{
        claim: "large body",
        sources: [{ kind: "local", path: "big.ts", startLine: 1, endLine: 2 }],
      }],
      readFile: reader({ "big.ts": { content: body, revision: "d1_big" } }),
      actor,
      signal: new AbortController().signal,
      outputStore: store,
      sessionId: actor.sessionId,
      visibleBytes: 1024,
    });
    expect(evidence.facts[0]?.status).toBe("verified");
    expect(evidence.facts[0]?.sources[0]?.outputRef?.handle).toMatch(/^out_/);
    store.dispose();
  });

  it("leaves an unstored URL unknown", async () => {
    const evidence = await validateRetrievalEvidence({
      question: "docs",
      brief: "docs",
      frozenScope: [],
      facts: [{
        claim: "external note",
        sources: [{ kind: "url", url: "https://example.com/doc" }],
      }],
      actor,
      signal: new AbortController().signal,
      sessionId: actor.sessionId,
    });
    expect(evidence.facts[0]?.status).toBe("unknown");
  });
});
