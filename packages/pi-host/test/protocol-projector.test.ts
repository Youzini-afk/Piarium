import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  projectAgentEvent,
  projectMessage,
  projectProviderAuthEvent,
  projectProviderAuthPrompt,
  projectSessionEntry,
} from "../src/protocol-projector.js";

const usage = {
  cacheRead: 2,
  cacheWrite: 3,
  cost: { cacheRead: 0.2, cacheWrite: 0.3, input: 0.1, output: 0.4, total: 1 },
  input: 10,
  output: 20,
  reasoning: 5,
  totalTokens: 35,
};

const assistant = {
  api: "openai-responses",
  content: [
    { text: "hello", textSignature: "private-text-signature", type: "text" },
    {
      redacted: true,
      thinking: "hidden reasoning",
      thinkingSignature: "private-thinking-signature",
      type: "thinking",
    },
    {
      arguments: { count: Number.POSITIVE_INFINITY },
      id: "call-1",
      name: "read",
      thoughtSignature: "private-tool-signature",
      type: "toolCall",
    },
  ],
  diagnostics: [{ details: { credential: "must-not-cross" }, timestamp: 1, type: "debug" }],
  model: "gpt-test",
  provider: "openai",
  responseId: "provider-internal-response",
  role: "assistant",
  stopReason: "pending",
  timestamp: 123,
  usage,
} as unknown as AgentMessage;

describe("Pi protocol projector", () => {
  it("projects assistant messages while stripping provider continuity metadata", () => {
    const projected = projectMessage(assistant);
    assert.equal(projected.role, "assistant");
    const serialized = JSON.stringify(projected);
    assert.doesNotMatch(serialized, /private-|must-not-cross|provider-internal-response/);
    assert.match(serialized, /hidden reasoning/);
    assert.match(serialized, /Infinity/);
  });

  it("projects streaming updates once without duplicating raw partial messages", () => {
    const projected = projectAgentEvent({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: "llo",
        partial: assistant,
        type: "text_delta",
      },
      message: assistant,
      type: "message_update",
    } as AgentSessionEvent);

    assert.equal(projected.type, "message_update");
    if (projected.type !== "message_update") return;
    assert.deepEqual(projected.update, { contentIndex: 0, delta: "llo", type: "text_delta" });
    assert.equal("partial" in projected.update, false);
  });

  it("preserves Pi 0.84 deferred completion state", () => {
    const deferredAssistant = {
      ...assistant,
      deferred: { id: "provider-private-handle" },
      stopReason: "deferred",
    } as unknown as AgentMessage;
    const projectedMessage = projectMessage(deferredAssistant);
    assert.equal(projectedMessage.role, "assistant");
    if (projectedMessage.role !== "assistant") return;
    assert.equal(projectedMessage.stopReason, "deferred");
    assert.equal("deferred" in projectedMessage, false);

    const projectedEvent = projectAgentEvent({
      assistantMessageEvent: { reason: "deferred", type: "done" },
      message: deferredAssistant,
      type: "message_update",
    } as AgentSessionEvent);
    assert.equal(projectedEvent.type, "message_update");
    if (projectedEvent.type !== "message_update") return;
    assert.deepEqual(projectedEvent.update, { reason: "deferred", type: "done" });
  });

  it("preserves tree identity and sanitizes extension entry data", () => {
    const projected = projectSessionEntry({
      customType: "piarium.test",
      data: { count: 2, omitted: undefined },
      id: "entry-1",
      parentId: null,
      timestamp: "2026-08-02T00:00:00.000Z",
      type: "custom",
    } as SessionEntry);

    assert.deepEqual(projected, {
      customType: "piarium.test",
      data: { count: 2 },
      id: "entry-1",
      parentId: null,
      timestamp: "2026-08-02T00:00:00.000Z",
      type: "custom",
    });
  });

  it("projects all provider-owned auth interaction variants", () => {
    assert.deepEqual(
      projectProviderAuthPrompt("prompt-1", {
        message: "Choose login",
        options: [{ description: "Browser", id: "browser", label: "Browser OAuth" }],
        type: "select",
      }),
      {
        message: "Choose login",
        options: [{ description: "Browser", id: "browser", label: "Browser OAuth" }],
        requestId: "prompt-1",
        type: "select",
      },
    );
    assert.deepEqual(
      projectProviderAuthEvent({
        expiresInSeconds: 900,
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
      }),
      {
        expiresInSeconds: 900,
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
      },
    );
  });
});
