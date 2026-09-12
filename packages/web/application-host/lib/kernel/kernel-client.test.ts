import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKernelClient, KernelClient } from "./kernel-client.js";

const extension = process.platform === "win32" ? ".exe" : "";
const kernelPath = path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`);
const clients: KernelClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("real Rust kernel persists roots, CAS revisions, pins, and objects", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-test-"));
  roots.push(root);
  const client = createKernelClient({
    hostId: "kernel-test-host",
    storageRoot: root,
    buildVersion: "test",
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  const handshake = await client.start();
  assert.equal(handshake.protocolVersion, 1);
  const first = await client.putBlob(Buffer.from("one\n"), "op-blob-one");
  const created = await client.createBranch({
    operationId: "op-create",
    branchId: "branch-test",
    workspaceId: "workspace-test",
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } }],
  });
  const initial = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0]?.path, "src/file.txt");
  const second = await client.putBlob(Buffer.from("two\n"), "op-blob-two");
  const committed = await client.writeBranch({
    operationId: "op-write",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: second.byteLength, objectHash: second.hash, mode: 0o755 } }],
  });
  assert.equal(committed.status, "committed");
  const conflict = await client.writeBranch({
    operationId: "op-write-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/other.txt", state: { kind: "directory" } }],
  });
  assert.equal(conflict.status, "conflict");
  const published = await client.publishBranch({ operationId: "op-publish", branchId: "branch-test" });
  const pin = await client.pinBranch({ operationId: "op-pin", branchId: "branch-test", revision: Number(published.revision) });
  assert.equal(pin.pinned, true);
  const changed = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(changed.entries[0]?.state.mode, 0o755);
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: changed.root });
  assert.deepEqual(diff.changed, ["src/file.txt"]);
  assert.equal((await client.health()).integrity, "ok");
  await client.close();
  const reopened = createKernelClient({ hostId: "kernel-test-host", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(reopened);
  await reopened.start();
  const afterRestart = await reopened.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(afterRestart.entries[0]?.state.objectHash, second.hash);
});
