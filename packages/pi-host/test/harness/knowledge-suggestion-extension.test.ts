import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKnowledgeSuggestionExtension,
  parseSuggestionDraft,
} from "../../src/harness/knowledge-suggestion-extension.js";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for knowledge suggestion");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

describe("knowledge suggestion extension", () => {
  it("parses JSON drafts and rejects prose or null", () => {
    assert.deepEqual(parseSuggestionDraft('{"content":"Use bun","trigger":"packages"}'), {
      content: "Use bun",
      trigger: "packages",
    });
    assert.deepEqual(parseSuggestionDraft('```json\n{"content":"Use bun","trigger":""}\n```'), {
      content: "Use bun",
      trigger: "",
    });
    assert.equal(parseSuggestionDraft("null"), null);
    assert.equal(parseSuggestionDraft("Use bun forever"), null);
    assert.equal(parseSuggestionDraft('{"content":""}'), null);
  });

  it("does not call the host when the suggestions model is unconfigured", async () => {
    const requests: unknown[] = [];
    const handlers = new Map<string, (event: { prompt: string }) => unknown>();
    createKnowledgeSuggestionExtension({
      bridge: { request: async (method: string, params: unknown) => { requests.push([method, params]); } } as never,
    })({
      on: (event: string, handler: (event: { prompt: string }) => unknown) => { handlers.set(event, handler); },
    } as never);
    handlers.get("before_agent_start")?.({ prompt: "Always use bun" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, []);
  });

  it("drafts through the suggestions slot and stores the result on the host", async () => {
    const requests: unknown[] = [];
    const prompts: string[] = [];
    const handlers = new Map<string, (event: { prompt: string }) => unknown>();
    const draftState: { current?: (prompt: string) => Promise<string> } = {};
    createKnowledgeSuggestionExtension({
      bridge: {
        request: async (method: string, params: unknown) => {
          requests.push([method, params]);
          return { created: true };
        },
      } as never,
      getDraftWithModel: () => draftState.current,
    })({
      on: (event: string, handler: (event: { prompt: string }) => unknown) => { handlers.set(event, handler); },
    } as never);

    handlers.get("before_agent_start")?.({ prompt: "Always use bun" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, []);

    draftState.current = async (prompt) => {
      prompts.push(prompt);
      return '{"content":"Use bun for package management","trigger":"package management"}';
    };
    handlers.get("before_agent_start")?.({ prompt: "Always use bun" });
    await waitFor(() => requests.length === 1);
    assert.match(prompts[0] ?? "", /Always use bun/);
    assert.deepEqual(requests[0], [
      "knowledge.suggest",
      {
        content: "Use bun for package management",
        trigger: "package management",
      },
    ]);
  });

  it("does not store a suggestion when the model returns null", async () => {
    const requests: unknown[] = [];
    const handlers = new Map<string, (event: { prompt: string }) => unknown>();
    createKnowledgeSuggestionExtension({
      bridge: { request: async (method: string, params: unknown) => { requests.push([method, params]); } } as never,
      getDraftWithModel: () => async () => "null",
    })({
      on: (event: string, handler: (event: { prompt: string }) => unknown) => { handlers.set(event, handler); },
    } as never);
    handlers.get("before_agent_start")?.({ prompt: "What is the current status?" });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(requests, []);
  });
});
