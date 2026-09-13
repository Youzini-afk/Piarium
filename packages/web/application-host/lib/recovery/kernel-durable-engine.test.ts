import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "../kernel/kernel-recovery-store.js";
import { KernelStorageAdapter } from "../kernel/storage-adapter.js";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "./journal-engine.js";

const extension = process.platform === "win32" ? ".exe" : "";
const kernelPath = path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`);
const buildVersion = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")).version as string;
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
const roots: string[] = [];
const clients: KernelClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const catalogFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === "catalog.sqlite") result.push(target);
    }
  };
  await visit(root);
  return result;
};

it.skipIf(!hasReleaseKernel)("runs combined recovery and undo across a Rust-kernel restart without a TS recovery catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-combined-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "host-data");
  const storageRoot = path.join(root, "kernel-storage");
  const workspaceId = "durable-combined-workspace";
  const sessionId = "durable-combined-session";
  await fs.mkdir(workspace, { recursive: true });
  const note = path.join(workspace, "note.txt");
  await fs.writeFile(note, "before\n");

  let leaf: string | null = "assistant-1";
  let loseNavigationResponse = true;
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    inspectDirtyBuffers: async () => [],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    runResourceOperation: async (_workspaceId, _resources, operation) => operation(),
  };
  const navigation: CreateWorkspaceRecoveryEngineOptions["sessionNavigation"] = {
    prepare: async () => ({
      expectedLeafId: leaf,
      targetLeafId: "leaf-before",
      removedEntryIds: ["user-1", "assistant-1"],
    }),
    prepareLeaf: async ({ targetLeafId }) => ({ expectedLeafId: leaf, targetLeafId }),
    commit: async ({ expectedLeafId, preparedTargetLeafId }) => {
      if (leaf === expectedLeafId) leaf = preparedTargetLeafId;
      else expect(leaf).toBe(preparedTargetLeafId);
      if (loseNavigationResponse) {
        loseNavigationResponse = false;
        throw new Error("simulated lost navigation response");
      }
      return {};
    },
    commitLeaf: async ({ expectedLeafId, preparedTargetLeafId }) => {
      expect(leaf).toBe(expectedLeafId);
      leaf = preparedTargetLeafId;
      return {};
    },
  };

  const open = async (cacheName: string) => {
    const client = createKernelClient({ hostId: "durable-combined-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
    clients.push(client);
    await client.start();
    const adapter = new KernelStorageAdapter({ client, hostId: "durable-combined-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
    const content = new KernelRecoveryContentStore(adapter, path.join(root, cacheName));
    adapter.bindFileStore(content);
    const store = new KernelRecoveryStore(adapter, content);
    const base = createWorkspaceRecoveryEngine({ authorityId: "durable-combined-host", dataDir, documents, durableRecoveryStore: store, fileStore: content, sessionNavigation: navigation });
    const engine = createKernelRecoveryDirectFacade(base, store, {
      resourceOperationGateFor: () => ({ run: (_resources, operation) => operation() }),
    });
    return { adapter, client, engine, store };
  };

  let runtime = await open("cache-first");
  await runtime.engine.recordTurnStart({
    activeWriterScopes: [], executionId: "execution-1", provenance: "caused-by", runtimeGeneration: 1,
    sessionId, userEntryId: "user-1", workerId: "worker-1", workspaceId,
  });
  const mutation = {
    executionId: "execution-1", mutationId: "mutation-1", path: note, toolCallId: "tool-1",
    toolName: "write" as const, workspaceId,
  };
  expect(await runtime.engine.recordMutationBefore(mutation)).toMatchObject({ status: "ready", recorded: true });
  await fs.writeFile(note, "after\n");
  expect(await runtime.engine.recordMutationAfter({ ...mutation, succeeded: true })).toMatchObject({ status: "ready", recorded: true });
  const secondMutation = { ...mutation, mutationId: "mutation-2", toolCallId: "tool-2" };
  expect(await runtime.engine.recordMutationBefore(secondMutation)).toMatchObject({ status: "ready", recorded: true });
  await fs.writeFile(note, "after-twice\n");
  expect(await runtime.engine.recordMutationAfter({ ...secondMutation, succeeded: true })).toMatchObject({ status: "ready", recorded: true });
  expect(await runtime.engine.recordTurnSettled({
    activeWriterScopes: [], assistantEntryId: "assistant-1", executionId: "execution-1",
    mutationObserved: true, observationComplete: true, observedResourceIds: ["note.txt"],
    provenance: "caused-by", workspaceId,
  })).toMatchObject({ status: "ready", binding: { status: "ready", unrecordedResourceIds: [] } });

  const prepared = await runtime.engine.prepareCombinedRecovery({ entryId: "user-1", sessionId, workspaceId });
  expect(prepared).toMatchObject({ status: "ready", plan: { affectedPaths: ["note.txt"], coverage: "ready" } });
  if (prepared.status !== "ready") throw new Error("combined recovery was not prepared");
  const applied = await runtime.engine.applyCombinedRecovery({
    confirmedConflicts: [], conflictPolicy: "abort", expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
  });
  expect(applied).toMatchObject({ status: "failed", failure: { code: "navigation-conflict" } });
  expect(await fs.readFile(note, "utf8")).toBe("before\n");
  expect(await runtime.engine.getCombinedOperation(prepared.plan.id)).toMatchObject({ status: "ready", operation: { state: "navigating-conversation" } });
  expect(await catalogFiles(dataDir)).toEqual([]);

  await runtime.engine.dispose();
  await runtime.adapter.dispose();
  await runtime.client.close();
  clients.splice(clients.indexOf(runtime.client), 1);
  await fs.rm(path.join(root, "cache-first"), { recursive: true, force: true });

  runtime = await open("cache-second");
  await runtime.engine.resumeCombinedOperations();
  expect(await runtime.engine.getCombinedOperation(prepared.plan.id)).toMatchObject({ status: "ready", operation: { state: "complete" } });
  const undo = await runtime.engine.prepareCombinedUndo(prepared.plan.id);
  expect(undo.status).toBe("ready");
  if (undo.status !== "ready") throw new Error("combined undo was not prepared");
  const undone = await runtime.engine.applyCombinedRecovery({
    confirmedConflicts: [], conflictPolicy: "abort", expectedRevision: undo.plan.revision, operationId: undo.plan.id,
  });
  expect(undone).toMatchObject({ status: "ready", operation: { state: "complete", undoOf: prepared.plan.id } });
  expect(await fs.readFile(note, "utf8")).toBe("after-twice\n");
  expect(await catalogFiles(dataDir)).toEqual([]);

  await runtime.engine.dispose();
  await runtime.adapter.dispose();
});
