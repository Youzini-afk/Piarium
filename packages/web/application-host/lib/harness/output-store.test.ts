import { describe, expect, it } from "vitest";
import { createOutputStore } from "./output-store.js";

describe("output store", () => {
  it("stores and reads text by handle", () => {
    const store = createOutputStore();
    const { handle, total } = store.store("session-1", "hello world");
    expect(handle).toMatch(/^out_[a-z2-7]+$/);
    expect(total).toBe(11);
    const slice = store.read("session-1", handle);
    expect(slice).toEqual({ text: "hello world", offset: 0, length: 11, total: 11 });
    store.dispose();
  });

  it("reads with offset and length", () => {
    const store = createOutputStore();
    const { handle } = store.store("session-1", "abcdefghij");
    const slice = store.read("session-1", handle, 2, 3);
    expect(slice).toEqual({ text: "cde", offset: 2, length: 3, total: 10 });
    store.dispose();
  });

  it("returns null for unknown handle", () => {
    const store = createOutputStore();
    expect(store.read("session-1", "out_unknown")).toBeNull();
    store.dispose();
  });

  it("returns null for unknown session", () => {
    const store = createOutputStore();
    store.store("session-1", "hello");
    expect(store.read("session-2", "out_anything")).toBeNull();
    store.dispose();
  });

  it("drops a session", () => {
    const store = createOutputStore();
    const { handle } = store.store("session-1", "hello");
    store.dropSession("session-1");
    expect(store.read("session-1", handle)).toBeNull();
    store.dispose();
  });

  it("evicts oldest when maxBytesPerSession is exceeded", () => {
    const store = createOutputStore({ maxBytesPerSession: 10 });
    const r1 = store.store("session-1", "aaaa"); // 4 bytes
    const r2 = store.store("session-1", "bbbb"); // 4 bytes, total 8
    const r3 = store.store("session-1", "cccccccc"); // 8 bytes; 8+8=16>10, evict r1 (→4), 4+8=12>10, evict r2 (→0), 0+8=8≤10
    // r1 and r2 should be evicted
    expect(store.read("session-1", r1.handle)).toBeNull();
    expect(store.read("session-1", r2.handle)).toBeNull();
    // r3 should still exist
    expect(store.read("session-1", r3.handle)).not.toBeNull();
    store.dispose();
  });

  it("handles unicode text byte length correctly", () => {
    const store = createOutputStore();
    const text = "héllo 世界"; // h(1) + é(2) + l(1) + l(1) + o(1) + space(1) + 世(3) + 界(3) = 13 bytes
    const { handle, total } = store.store("session-1", text);
    expect(total).toBe(Buffer.byteLength(text, "utf8"));
    const slice = store.read("session-1", handle);
    expect(slice?.text).toBe(text);
    store.dispose();
  });
});
