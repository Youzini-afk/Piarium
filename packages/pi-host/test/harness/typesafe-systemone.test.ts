import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestSystemone,
  SystemoneRequestError,
  SystemoneResponseError,
} from "../../src/harness/typesafe-systemone.js";
import type { FastDecisionQuestion } from "@varin/protocol";

const jsonResponse = (status: number, body: unknown) => (
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
);

const judge: FastDecisionQuestion = {
  id: "m:v1",
  kind: "judge",
  instructions: { question: "keep?", material: "v1" },
  criteria: { yes: "relevant", no: "noise" },
};
const choose: FastDecisionQuestion = {
  id: "a:next",
  kind: "choose",
  instructions: "pick a step",
  options: [{ id: "read:b.ts", detail: "read callee" }, { id: "symbol:foo" }],
  allowNone: true,
};
const score: FastDecisionQuestion = {
  id: "s:v1",
  kind: "score",
  instructions: "rate relevance",
  levels: ["unrelated", "partial", "direct"],
};

describe("TypeSafe System One adapter", () => {
  it("maps typed questions onto the native questions protocol and parses every answer kind", async () => {
    let seenBody: Record<string, unknown> | undefined;
    let seenUrl = "";
    let seenAuth: string | null = null;
    const result = await requestSystemone({
      baseUrl: "https://jev.example/api",
      apiKey: "secret",
      model: "jev-1.13",
      state: { goal: "how does callee work", materials: [{ id: "v1" }] },
      questions: [judge, choose, score],
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, {
          model: "jev-1.13-2026-09",
          answers: {
            "m:v1": { type: "noul", noul: 0.87 },
            "a:next": { type: "choice", choice: "read:b.ts", probabilities: { "read:b.ts": 0.8, "symbol:foo": 0.1 }, confidence: 0.9 },
            "s:v1": { type: "score", score: 2 },
          },
          usage: { input_tokens: 512, output_tokens: 9 },
        });
      },
    });
    assert.equal(seenUrl, "https://jev.example/api/v1/systemone");
    assert.equal(seenAuth, "Bearer secret");
    assert.equal(seenBody?.model, "jev-1.13");
    const questions = seenBody?.questions as Record<string, Record<string, unknown>>;
    assert.equal(questions["m:v1"]?.type, "noul");
    assert.deepEqual(questions["m:v1"]?.criteria, { true: "relevant", false: "noise" });
    assert.equal(questions["a:next"]?.type, "choice");
    const criteria = questions["a:next"]?.criteria as Record<string, unknown>;
    assert.ok(Object.hasOwn(criteria, "read:b.ts"));
    assert.ok(Object.hasOwn(criteria, "__none__"));
    assert.equal(questions["s:v1"]?.type, "score");
    assert.deepEqual(questions["s:v1"]?.criteria, ["unrelated", "partial", "direct"]);

    assert.equal(result.servedModelId, "jev-1.13-2026-09");
    assert.deepEqual(result.usage, { inputTokens: 512, outputTokens: 9 });
    const byId = new Map(result.answers.map((answer) => [answer.id, answer]));
    assert.deepEqual(byId.get("m:v1"), { id: "m:v1", kind: "judge", value: 0.87 });
    const choice = byId.get("a:next");
    assert.equal(choice?.kind, "choose");
    if (choice?.kind === "choose") assert.equal(choice.choice, "read:b.ts");
    const scored = byId.get("s:v1");
    assert.equal(scored?.kind, "score");
    if (scored?.kind === "score") assert.equal(scored.score, 2);
    assert.deepEqual(result.missing, []);
  });

  it("reports unanswered and invalid answers as missing instead of reinterpreting them", async () => {
    const result = await requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge, choose, score],
      fetchImpl: async () => jsonResponse(200, {
        answers: {
          "m:v1": { type: "noul", noul: 1.5 },
          "a:next": { type: "choice", choice: "read:other.ts" },
          "s:v1": { type: "score", score: 1 },
        },
      }),
    });
    assert.deepEqual(result.missing.sort(), ["a:next", "m:v1"]);
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0]?.id, "s:v1");

    const noneChosen = await requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [choose],
      fetchImpl: async () => jsonResponse(200, {
        answers: { "a:next": { type: "choice", choice: "__none__" } },
      }),
    });
    assert.equal(noneChosen.answers[0]?.kind, "choose");
    if (noneChosen.answers[0]?.kind === "choose") assert.equal(noneChosen.answers[0].choice, null);
  });

  it("honors a provider-relative endpoint and rejects transport/contract failures", async () => {
    let seenUrl = "";
    await requestSystemone({
      baseUrl: "https://jev.example/root/",
      apiKey: "secret",
      endpoint: "/custom/systemone",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async (url) => {
        seenUrl = String(url);
        return jsonResponse(200, { answers: { "m:v1": { type: "noul", noul: 1 } } });
      },
    });
    assert.equal(seenUrl, "https://jev.example/root/custom/systemone");

    await assert.rejects(() => requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async () => jsonResponse(503, { error: "down" }),
    }), SystemoneResponseError);
    await assert.rejects(() => requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async () => jsonResponse(200, { ok: true }),
    }), SystemoneResponseError);
  });

  it("rejects malformed questions before any HTTP request", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200, { answers: {} });
    };
    await assert.rejects(() => requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge, { ...judge }],
      fetchImpl,
    }), SystemoneRequestError);
    await assert.rejects(() => requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [{ id: "c", kind: "choose", instructions: "x", options: [{ id: "__none__" }] }],
      fetchImpl,
    }), SystemoneRequestError);
    await assert.rejects(() => requestSystemone({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [{ id: "s", kind: "score", instructions: "x", levels: ["only"] }],
      fetchImpl,
    }), SystemoneRequestError);
    assert.equal(calls, 0);
  });
});
