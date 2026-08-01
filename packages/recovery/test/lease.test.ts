import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { FileLease } from "../src/lease.js";

it("serializes recovery writers with a bounded wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-recovery-lease-"));
  const path = join(root, "workspace.lock");
  const first = await FileLease.acquire(path);
  try {
    await assert.rejects(FileLease.acquire(path, { pollMs: 10, timeoutMs: 50 }), /Timed out/);
  } finally {
    await first.release();
    await rm(root, { force: true, recursive: true });
  }
});
