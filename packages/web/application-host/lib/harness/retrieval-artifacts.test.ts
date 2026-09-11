import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../recovery/journal-files.js";
import { WorkingStateStore } from "./working-state/working-state-store.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";
import { createRetrievalArtifactAccess } from "./retrieval-artifacts.js";
import type { HostResourceOperation } from "../recovery/durable-file-operation.js";
import type { RetrievalEvidence } from "@piarium/protocol";

const roots: string[] = [];

const openAccess = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-retrieval-artifacts-"));
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
  return { context, database, parent, root, store, workingStates };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("retrieval artifacts", () => {
  it("lets a parent read a sealed excerpt after the store is reopened", async () => {
    const first = await openAccess();
    const access = createRetrievalArtifactAccess(first.workingStates);
    const artifact = await access.storeArtifact("ws", Buffer.from("child output after close\n"));
    const evidence: RetrievalEvidence = {
      question: "What did the child find?",
      scope: [],
      facts: [{
        claim: "child output",
        status: "source-checked",
        sources: [{ kind: "output", check: "source-valid", artifact }],
      }],
      unknowns: [],
      attempted: [],
      completion: "delivered",
    };
    await access.protectEvidence("ws", "thread-child", evidence);
    first.database.close();

    const database = await openRecoveryJournalCatalog(first.root, { create: false });
    if (!database) throw new Error("reopen catalog missing");
    const context = { ...first.context, database };
    const store = await WorkingStateStore.open(context);
    const workingStates: WorkspaceWorkingStateAccess = {
      withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
    };
    try {
      const reopened = createRetrievalArtifactAccess(workingStates);
      const bytes = await reopened.readArtifact("ws", artifact.hash);
      expect(bytes?.toString("utf8")).toBe("child output after close\n");
    } finally {
      database.close();
    }
  });
});
