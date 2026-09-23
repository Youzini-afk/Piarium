import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createResearchSearchTool } from "../../src/harness/research-search-tool.js";
import type { HarnessRequestData } from "@varin/protocol";

describe("research_search tool", () => {
  it("forwards a paper lookup and preserves metadata/content distinction", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ emit: (_event, data) => { emitted.push(data); }, sessionId: "test", defaultTimeoutMs: 5000 });
    const pending = createResearchSearchTool(bridge).execute("research-1", {
      action: "paper",
      provider: "semantic-scholar",
      paper_id: "CorpusId:123",
    } as never, undefined, undefined, {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted[0]?.method, "research.search");
    assert.deepEqual(emitted[0]?.params, { action: "paper", provider: "semantic-scholar", paperId: "CorpusId:123" });
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        status: "ok",
        provider: "semantic-scholar",
        action: "paper",
        papers: [{ provider: "semantic-scholar", id: "CorpusId:123", title: "A paper", authors: [], content: "metadata-only" }],
        capabilities: ["search", "paper", "open-access-location"],
      },
    });
    const result = await pending as { content: Array<{ type: string; text: string }> };
    assert.match(result.content[0]?.text ?? "", /A paper/);
    assert.match(result.content[0]?.text ?? "", /Content: metadata-only/);
    bridge.dispose();
  });

  it("expands relations and surfaces the edge kind plus paper identity", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ emit: (_event, data) => { emitted.push(data); }, sessionId: "test", defaultTimeoutMs: 5000 });
    const pending = createResearchSearchTool(bridge).execute("research-2", {
      action: "relations",
      provider: "openalex",
      paper_id: "W9",
      relation: "citations",
    } as never, undefined, undefined, {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted[0]?.method, "research.search");
    assert.deepEqual(emitted[0]?.params, { action: "relations", provider: "openalex", paperId: "W9", relation: "citations" });
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        status: "ok",
        provider: "openalex",
        action: "relations",
        relation: { kind: "citations", source: { provider: "openalex", id: "W9" } },
        papers: [{ provider: "openalex", id: "W5", title: "Citing work", authors: [], doi: "10.1/x", content: "open-location", openAccessUrl: "https://example.org/w5.pdf", landingUrl: "https://example.org/w5" }],
        capabilities: ["search", "paper", "relations", "open-access-location"],
        relationKinds: ["references", "citations", "related"],
        nextCursor: "cit-2",
      },
    });
    const result = await pending as { content: Array<{ type: string; text: string }>; details: { sources?: Array<{ paperId?: string; relation?: string }> } };
    assert.match(result.content[0]?.text ?? "", /citations of openalex:W9/);
    assert.match(result.content[0]?.text ?? "", /Citing work \[openalex:W5\]/);
    assert.match(result.content[0]?.text ?? "", /Next cursor: cit-2/);
    assert.deepEqual(result.details.sources?.[0], {
      url: "https://example.org/w5", title: "Citing work", provider: "openalex", paperId: "W5", relation: "citations",
    });
    bridge.dispose();
  });

  it("reports an unavailable relation without marking the call failed", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ emit: (_event, data) => { emitted.push(data); }, sessionId: "test", defaultTimeoutMs: 5000 });
    const pending = createResearchSearchTool(bridge).execute("research-3", {
      action: "relations",
      provider: "semantic-scholar",
      paper_id: "P9",
      relation: "related",
    } as never, undefined, undefined, {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        status: "unavailable",
        provider: "semantic-scholar",
        action: "relations",
        papers: [],
        capabilities: ["search", "paper", "relations", "open-access-location"],
        relationKinds: ["references", "citations"],
        message: "semantic-scholar does not expose a related-works relation",
      },
    });
    const result = await pending as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.match(result.content[0]?.text ?? "", /unavailable.*related-works/);
    assert.equal(result.isError, false);
    bridge.dispose();
  });
});
