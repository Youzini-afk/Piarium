import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../recovery/journal-files.js";
import type { HostResourceOperation } from "../recovery/durable-file-operation.js";
import { WorkingStateStore } from "./working-state/working-state-store.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";
import { createThreadRegistry } from "./thread-registry.js";
import { pinRetrievalParentBaseline } from "./retrieval-parent-baseline.js";

const roots: string[] = [];

const openStore = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-retrieval-baseline-"));
  roots.push(parent);
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "recovery");
  await fs.promises.mkdir(workspace, { recursive: true });
  const database = await openRecoveryJournalCatalog(root, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly HostResourceOperation[], operation: () => Promise<Result>) => operation(),
    },
    root,
  };
  const store = await WorkingStateStore.open(context);
  const workingStates: WorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
  };
  return { context, database, parent, store, workingStates, workspace };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("pinRetrievalParentBaseline", () => {
  it("lets nested retrieval read a virtual parent file that is not on the live root", async () => {
    const h = await openStore();
    const dataDir = path.join(h.parent, "threads");
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "root.ts"), "root live\n");
      const base = await h.store.captureDirectory(h.workspace);
      const onlyParent = await h.store.putObject(Buffer.from("export const onlyInParent = true;\n"));
      await h.store.createBranch("ws", "thread-parent", {
        ...base,
        "only-in-parent.ts": { kind: "regular-file", objectHash: onlyParent.hash, byteLength: onlyParent.byteLength },
      }, "base");
      const parent = await registry.createThread({
        workspaceId: "ws",
        parent: { kind: "session", id: "root-session" },
        brief: "parent work",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        worktree: "isolated",
        tools: ["read"],
        permissions: { mode: "normal", rules: [] },
        autoRun: false,
      });
      await registry.setWorkingState("ws", parent.id, {
        branchId: "thread-parent",
        worktree: {
          path: h.workspace,
          base: "base",
          viewMode: "virtual",
          materialized: false,
          preparationStage: "ready",
        },
      });
      const child = await registry.createThread({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        brief: "Where is only-in-parent?",
        role: "retrieval",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        worktree: "none",
        tools: ["read", "submit_facts"],
        permissions: { mode: "normal", rules: [] },
        autoRun: false,
      });
      const pinned = await pinRetrievalParentBaseline({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        childThreadId: child.id,
        cwd: h.workspace,
        registry,
        workingStates: h.workingStates,
      });
      expect(pinned?.branchId).toBe(`thread-${child.id}`);
      await fs.promises.writeFile(path.join(h.workspace, "root-drift.ts"), "late live drift\n");
      const childView = h.store.effectiveState(pinned!.branchId);
      expect(childView?.["only-in-parent.ts"]).toMatchObject({ kind: "regular-file" });
      expect(childView?.["root-drift.ts"]).toBeUndefined();
      expect(await fs.promises.readFile(path.join(h.workspace, "root.ts"), "utf8")).toBe("root live\n");
      await expect(fs.promises.access(path.join(h.workspace, "only-in-parent.ts"))).rejects.toThrow();
    } finally {
      await registry.dispose();
      h.database.close();
    }
  });

  it("freezes a materialized parent directory instead of following later live edits", async () => {
    const h = await openStore();
    const dataDir = path.join(h.parent, "threads");
    const materialized = path.join(h.parent, "parent-dir");
    await fs.promises.mkdir(materialized, { recursive: true });
    await fs.promises.writeFile(path.join(materialized, "frozen.ts"), "parent frozen\n");
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    try {
      const parent = await registry.createThread({
        workspaceId: "ws",
        parent: { kind: "session", id: "root-session" },
        brief: "materialized parent",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        worktree: "isolated",
        tools: ["read"],
        permissions: { mode: "normal", rules: [] },
        autoRun: false,
      });
      await registry.setWorktree("ws", parent.id, {
        path: materialized,
        base: "materialized",
        viewMode: "materialized",
        materialized: true,
        preparationStage: "ready",
      });
      const child = await registry.createThread({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        brief: "read parent",
        role: "retrieval",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        worktree: "none",
        tools: ["read", "submit_facts"],
        permissions: { mode: "normal", rules: [] },
        autoRun: false,
      });
      const pinned = await pinRetrievalParentBaseline({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        childThreadId: child.id,
        cwd: h.workspace,
        registry,
        workingStates: h.workingStates,
      });
      expect(pinned).not.toBeNull();
      await fs.promises.writeFile(path.join(materialized, "after-dispatch.ts"), "late parent dir\n");
      const childView = h.store.effectiveState(pinned!.branchId);
      expect(childView?.["frozen.ts"]).toMatchObject({ kind: "regular-file" });
      expect(childView?.["after-dispatch.ts"]).toBeUndefined();
    } finally {
      await registry.dispose();
      h.database.close();
    }
  });
});
