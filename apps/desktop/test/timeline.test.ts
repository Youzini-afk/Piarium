import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLiveAssistant, normalizeTimeline } from "../src/renderer/lib/timeline.js";

describe("timeline normalization", () => {
  it("maps persisted messages and tool calls without losing stable entry ids", () => {
    const items = normalizeTimeline([
      {
        id: "u1",
        message: { content: [{ text: "hello", type: "text" }], role: "user" },
        parentId: null,
        timestamp: "2026-08-02T00:00:00.000Z",
        type: "message",
      },
      {
        id: "a1",
        message: {
          content: [
            { thinking: "checking", type: "thinking" },
            { text: "done", type: "text" },
            { arguments: { path: "README.md" }, id: "tool-1", name: "read", type: "toolCall" },
          ],
          role: "assistant",
        },
        parentId: "u1",
        type: "message",
      },
      {
        id: "t1",
        message: {
          content: [{ text: "contents", type: "text" }],
          isError: false,
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
        },
        parentId: "a1",
        type: "message",
      },
    ]);
    assert.deepEqual(
      items.map((item) => [item.id, item.kind]),
      [
        ["u1", "user"],
        ["a1", "assistant"],
        ["t1", "tool"],
      ],
    );
    assert.equal(items[1]?.thinking, "checking");
    assert.equal(items[1]?.toolCalls[0]?.id, "tool-1");
    assert.equal(items[2]?.toolCallId, "tool-1");
  });

  it("preserves visible extension entries and hides display:false custom messages", () => {
    const items = normalizeTimeline([
      {
        customType: "hidden.context",
        display: false,
        id: "hidden",
        parentId: null,
        type: "custom_message",
      },
      {
        customType: "subagent.result",
        data: { status: "complete" },
        id: "custom",
        parentId: null,
        type: "custom",
      },
      {
        id: "summary",
        parentId: "custom",
        summary: "Earlier work",
        type: "compaction",
      },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.customType, "subagent.result");
    assert.equal(items[1]?.kind, "summary");
  });

  it("maps the latest partial assistant message for streaming", () => {
    const item = normalizeLiveAssistant({
      message: { content: [{ text: "streaming", type: "text" }], role: "assistant" },
      type: "message_update",
    });
    assert.equal(item?.text, "streaming");
    assert.equal(item?.id, "live-assistant");
  });
});
