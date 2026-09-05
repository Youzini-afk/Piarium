import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createDocumentAuthority } from "../documents/authority.js";
import { createWorktreeReclaimGuard } from "./worktree-reclaim-guard.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-reclaim-guard-"));
  const directory = path.join(root, "worktree");
  await fs.mkdir(directory);
  const documents = createDocumentAuthority({ hostId: "host", dataDir: path.join(root, "data"), isAllowedRoot: async () => true, isTrusted: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: directory });
  disposes.push(async () => {
    await documents.dispose();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { directory, documents, workspaceId, acquire: () => createWorktreeReclaimGuard(documents)("parent", "thread", directory) };
}

it("keeps the real writer authority fenced until reclamation releases it", async () => {
  const f = await fixture();
  const permission = await f.acquire();
  expect(permission.safe).toBe(true);
  try {
    await expect(f.documents.registerWriterForScope(f.directory, { kind: "test", id: "late-writer" }, { mode: "process" })).rejects.toThrow();
    expect((await f.documents.inspectMutation(f.workspaceId)).maintenance).toBe(true);
  } finally { await permission.release?.(); }
  const writer = await f.documents.registerWriterForScope(f.directory, { kind: "test", id: "after-release" }, { mode: "process" });
  expect(writer).toBeTruthy();
  await writer?.close();
});

it("retains a worktree used by a terminal or other controlled process", async () => {
  const f = await fixture();
  const writer = await f.documents.registerWriterForScope(f.directory, { kind: "terminal", id: "terminal" }, { mode: "process" });
  try {
    expect(await f.acquire()).toMatchObject({ safe: false, reason: "Worktree has active writers" });
    expect((await f.documents.inspectMutation(f.workspaceId)).maintenance).toBe(false);
  } finally { await writer?.close(); }
});

it("retains even clean editor surfaces after requesting fresh state", async () => {
  const f = await fixture();
  let publication: Promise<void> = Promise.resolve();
  const surface = f.documents.registerDirtySurface({ workspaceId: f.workspaceId, ownerId: "editor", generation: 1 }, (value) => {
    const event = value as { action: string; barrierId: string };
    if (event.action !== "acquire") return;
    publication = (async () => {
      await f.documents.publishDirtyBuffers({ workspaceId: f.workspaceId, ownerId: "editor", generation: 1, resources: [] });
      await f.documents.acknowledgeDirtyStateBarrier({ workspaceId: f.workspaceId, ownerId: "editor", generation: 1, barrierId: event.barrierId });
    })();
  });
  try {
    expect(await f.acquire()).toMatchObject({ safe: false, reason: "Worktree is in use by an editor surface" });
    await publication;
    expect((await f.documents.inspectMutation(f.workspaceId)).maintenance).toBe(false);
  } finally { surface.close(); }
});
