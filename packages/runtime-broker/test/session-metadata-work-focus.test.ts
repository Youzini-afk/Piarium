import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionMetadataStore } from "../src/session-metadata-store.js";

describe("session metadata work focus", () => {
  it("persists selected, failed, and applied states without replacing the active generation early", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-focus-metadata-"));
    try {
      const store = new SessionMetadataStore(root);
      const initial = await store.ensureWorkFocus("session-1", {
        id: "code",
        source: "project-default",
      });
      assert.deepEqual(initial.active, {
        generation: 1,
        id: "code",
        source: "project-default",
      });

      const pending = await store.selectWorkFocus("session-1", {
        id: "research",
        source: "explicit",
      });
      assert.equal(pending.status, "pending");
      assert.equal(pending.active.id, "code");
      assert.equal(pending.selected.id, "research");

      const failed = await store.failSelectedWorkFocus(
        "session-1",
        pending.selected,
        "candidate unavailable",
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.active.id, "code");
      assert.match(failed.failure?.message ?? "", /candidate unavailable/);

      const applied = await store.applySelectedWorkFocus("session-1", pending.selected);
      assert.equal(applied.status, "applied");
      assert.deepEqual(applied.active, {
        generation: 2,
        id: "research",
        source: "explicit",
      });

      const reopened = new SessionMetadataStore(root);
      assert.deepEqual(await reopened.getWorkFocus("session-1"), applied);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
