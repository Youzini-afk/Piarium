import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sliceUtf8ByBytes } from "../src/index.js";

describe("UTF-8 byte slicing", () => {
  it("pages mixed ASCII, Chinese, and emoji without replacement characters", () => {
    const text = "A你🙂B界C";
    const pages = [];
    let offset = 0;
    do {
      const page = sliceUtf8ByBytes(text, offset, 4);
      pages.push(page);
      assert.ok(!page.text.includes("�"));
      assert.ok(page.nextOffset > offset || page.eof);
      offset = page.nextOffset;
    } while (!pages.at(-1)!.eof);
    assert.equal(pages.map((page) => page.text).join(""), text);
    assert.equal(pages.at(-1)!.nextOffset, Buffer.byteLength(text, "utf8"));
  });

  it("moves an offset inside a code point back to its leading byte", () => {
    const slice = sliceUtf8ByBytes("A你B", 2, 3);
    assert.equal(slice.offset, 1);
    assert.equal(slice.text, "你");
    assert.equal(slice.nextOffset, 4);
  });

  it("expands a tiny page enough to make progress across one code point", () => {
    const slice = sliceUtf8ByBytes("🙂", 0, 1);
    assert.equal(slice.text, "🙂");
    assert.equal(slice.length, 4);
    assert.equal(slice.eof, true);
  });
});
