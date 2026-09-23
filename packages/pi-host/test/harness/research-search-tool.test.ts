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
    } as never, undefined, undefined, undefined);
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
});
