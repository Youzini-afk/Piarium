import { describe, it, expect, vi } from "vitest";
import { createWebReadService } from "./web-read-service.js";
import type { FetchResult } from "@piarium/protocol";

describe("web.read service", () => {
  it("returns answer from reader model when configured", async () => {
    const okFetch: FetchResult = {
      status: "ok", url: "https://example.com/", finalUrl: "https://example.com/",
      contentType: "text/html", markdown: "The answer is 42.", bytes: 18, fromCache: false, rendered: false,
    };
    const service = createWebReadService({
      fetch: async () => okFetch,
      readerRequest: async (req) => {
        expect(req.systemPrompt).toContain("strictly from the provided page content");
        expect(req.userPrompt).toContain("The answer is 42.");
        expect(req.userPrompt).toContain("Question: What is the answer?");
        expect(req.providerId).toBe("test-provider");
        expect(req.modelId).toBe("test-model");
        return "42";
      },
      readerModel: { providerId: "test-provider", modelId: "test-model" },
    });

    const result = await service.handle(
      { url: "https://example.com/", prompt: "What is the answer?" },
      { sessionId: "s1", workspaceId: "ws", signal: new AbortController().signal },
    );
    expect(result.answer).toBe("42");
    expect(result.sources).toEqual(["https://example.com/"]);
  });

  it("returns unavailable when reader model not configured", async () => {
    const okFetch: FetchResult = {
      status: "ok", url: "https://example.com/", finalUrl: "https://example.com/",
      contentType: "text/html", markdown: "content", bytes: 7, fromCache: false, rendered: false,
    };
    const service = createWebReadService({
      fetch: async () => okFetch,
      readerRequest: async () => "should not be called",
      readerModel: null,
    });

    const result = await service.handle(
      { url: "https://example.com/", prompt: "What?" },
      { sessionId: "s1", workspaceId: "ws", signal: new AbortController().signal },
    );
    expect(result.answer).toContain("reader unavailable");
    expect(result.sources).toEqual([]);
  });

  it("returns error when fetch fails", async () => {
    const service = createWebReadService({
      fetch: async () => ({ status: "failed", url: "https://example.com/", reason: "timeout" }),
      readerRequest: async () => "should not be called",
      readerModel: { providerId: "p", modelId: "m" },
    });

    const result = await service.handle(
      { url: "https://example.com/", prompt: "What?" },
      { sessionId: "s1", workspaceId: "ws", signal: new AbortController().signal },
    );
    expect(result.answer).toContain("fetch failed");
    expect(result.sources).toEqual([]);
  });

  it("returns no workspace when workspaceId is null", async () => {
    const service = createWebReadService({
      fetch: async () => { throw new Error("should not be called"); },
      readerRequest: async () => "should not be called",
      readerModel: { providerId: "p", modelId: "m" },
    });

    const result = await service.handle(
      { url: "https://example.com/", prompt: "What?" },
      { sessionId: "s1", workspaceId: null, signal: new AbortController().signal },
    );
    expect(result.answer).toContain("no workspace");
  });
});
