import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createOutputStore } from "./output-store.js";
import { createOutputReadService } from "./harness-services.js";

const GENERATION = "0123456789abcdef0123456789abcdef";
const NEXT_GENERATION = "fedcba9876543210fedcba9876543210";
const MAC_KEY = Buffer.alloc(32, 7);

const createStore = (maxBytesPerSession?: number) => createOutputStore({
  generation: GENERATION,
  macKey: MAC_KEY,
  ...(maxBytesPerSession === undefined ? {} : { maxBytesPerSession }),
});

describe("output store", () => {
  it("returns an explicit ephemeral ref and byte-addressed slice", () => {
    const store = createStore();
    const stored = store.store("session-1", "hello world");
    expect(stored.ref).toEqual({
      durability: "ephemeral",
      generation: GENERATION,
      handle: expect.stringMatching(/^out_[0-9a-f]{32}_[0-9a-z]+_[0-9a-f]{32}$/),
    });
    expect(store.read("session-1", stored.ref.handle)).toEqual({
      status: "ready",
      slice: { text: "hello world", offset: 0, length: 11, nextOffset: 11, total: 11, eof: true },
    });
    store.dispose();
  });

  it("pages Unicode by UTF-8 bytes without splitting a character", () => {
    const store = createStore();
    const text = "A你🙂B界C";
    const { ref, total } = store.store("session-1", text);
    let offset = 0;
    let rebuilt = "";
    while (offset < total) {
      const result = store.read("session-1", ref.handle, offset, 4);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") break;
      expect(result.slice.text).not.toContain("�");
      rebuilt += result.slice.text;
      expect(result.slice.nextOffset).toBeGreaterThan(offset);
      offset = result.slice.nextOffset;
    }
    expect(rebuilt).toBe(text);
    expect(offset).toBe(Buffer.byteLength(text, "utf8"));
    store.dispose();
  });

  it("normalizes an offset inside a multibyte code point", () => {
    const store = createStore();
    const { ref } = store.store("session-1", "A你B");
    expect(store.read("session-1", ref.handle, 2, 3)).toMatchObject({
      status: "ready",
      slice: { text: "你", offset: 1, length: 3, nextOffset: 4, eof: false },
    });
    store.dispose();
  });

  it("distinguishes forged and wrong-session handles from expired handles", () => {
    const store = createStore();
    const { ref } = store.store("session-1", "hello");
    const forged = ref.handle.replace(/.$/, (value) => value === "0" ? "1" : "0");
    expect(store.read("session-1", forged)).toEqual({ status: "not-found" });
    expect(store.read("session-2", ref.handle)).toEqual({ status: "not-found" });
    expect(store.read("session-1", "out_not-a-real-handle")).toEqual({ status: "not-found" });
    expect(store.read("session-1", "out_abcdefgh234567")).toEqual({ status: "expired" });
    const futureSequence = 99;
    const futureMac = createHmac("sha256", MAC_KEY)
      .update("session-1")
      .update("\0")
      .update(String(futureSequence))
      .digest("hex")
      .slice(0, 32);
    expect(store.read("session-1", `out_${GENERATION}_${futureSequence.toString(36)}_${futureMac}`)).toEqual({ status: "not-found" });

    const restarted = createOutputStore({ generation: NEXT_GENERATION, macKey: Buffer.alloc(32, 9) });
    expect(restarted.read("session-1", ref.handle)).toEqual({ status: "expired" });
    restarted.dispose();
    store.dispose();
  });

  it("uses FIFO eviction and reports evicted handles as expired", () => {
    const store = createStore(10);
    const first = store.store("session-1", "aaaa");
    const second = store.store("session-1", "bbbb");
    const third = store.store("session-1", "cccccccc");
    expect(store.read("session-1", first.ref.handle)).toEqual({ status: "expired" });
    expect(store.read("session-1", second.ref.handle)).toEqual({ status: "expired" });
    expect(store.read("session-1", third.ref.handle).status).toBe("ready");
    store.dispose();
  });

  it("marks every existing ref expired when a session is dropped and keeps sequence history", () => {
    const store = createStore();
    const first = store.store("session-1", "before");
    store.dropSession("session-1");
    expect(store.read("session-1", first.ref.handle)).toEqual({ status: "expired" });
    const second = store.store("session-1", "after");
    expect(second.ref.handle).not.toBe(first.ref.handle);
    expect(store.read("session-1", second.ref.handle).status).toBe("ready");
    store.dispose();
  });

  it("preserves expired as a typed harness failure", async () => {
    const store = createStore();
    const { ref } = store.store("session-1", "before");
    store.dropSession("session-1");
    const service = createOutputReadService(store);
    await expect(service.handle({ handle: ref.handle }, {
      authorizedPaths: [],
      actor: {
        authorityInstanceId: "authority",
        sessionId: "session-1",
        workerId: "worker",
        workerGeneration: 1,
        workspaceId: "workspace",
        grantedCapabilities: ["read.output"],
      },
      sessionId: "session-1",
      workspaceId: "workspace",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ harnessCode: "expired" });
    store.dispose();
  });

  it("recovers the complete original output through paging (truncation recovery path)", () => {
    const store = createStore();
    // Simulate a large tool output that was truncated for the transcript
    const fullText = "HEAD_LINE\n" + "x".repeat(100_000) + "\nTAIL_LINE";
    const { ref, total } = store.store("session-1", fullText, "bash");
    expect(total).toBe(Buffer.byteLength(fullText, "utf8"));

    // The transcript only has a truncated preview, but the full text is
    // recoverable through output.read with paging
    let offset = 0;
    let rebuilt = "";
    while (offset < total) {
      const result = store.read("session-1", ref.handle, offset, 32_768);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") break;
      rebuilt += result.slice.text;
      offset = result.slice.nextOffset;
    }
    expect(rebuilt).toBe(fullText);
    expect(rebuilt.startsWith("HEAD_LINE\n")).toBe(true);
    expect(rebuilt.endsWith("\nTAIL_LINE")).toBe(true);
    store.dispose();
  });

  it("reports expired (not not-found) when the Host generation changes", () => {
    const store = createStore();
    const { ref } = store.store("session-1", "some output");
    // Host restarts — new generation, old handles are expired
    const restarted = createOutputStore({ generation: NEXT_GENERATION, macKey: MAC_KEY });
    const result = restarted.read("session-1", ref.handle);
    expect(result.status).toBe("expired");
    restarted.dispose();
    store.dispose();
  });
});
