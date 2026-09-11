import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessActorContext, HarnessServiceMap } from "@piarium/protocol";
import { createDocumentAuthority } from "../../documents/authority.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { createDocumentPathOverlayService, createDocumentReadSourceService, createSearchContentService } from "../harness-services.js";
import { createHarnessPathAuthority } from "../path-authority.js";
import { createHarnessRouter } from "../router.js";
import { createHarnessSearchService } from "../search-service.js";
import { createExploreFileReader } from "../explore-file-reader.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { createWorkingBranchLookups } from "./working-branch-lookups.js";
import { WorkingStateStore, type WorkspaceWorkingStateAccess } from "./working-state-store.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-working-branch-view-"));
  const workspace = path.join(root, "workspace");
  const recoveryRoot = path.join(root, "recovery");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(workspace, "kept.txt"), "fixed kept\n");
  await fs.writeFile(path.join(workspace, "draft.ts"), "disk draft\n");
  await fs.writeFile(path.join(workspace, "src", "nested.ts"), "nested baseline\n");
  const documents = createDocumentAuthority({
    hostId: "test-host",
    dataDir: path.join(root, "data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test-host", canonicalRoot: workspace, filesystemProfile: "test", workspaceId },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly unknown[], operation: () => Promise<Result>) => operation(),
    },
    root: recoveryRoot,
  };
  const store = await WorkingStateStore.open(context);
  const workingStates: WorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
  };
  const views = new ThreadExecutionViewRegistry();
  const lookups = createWorkingBranchLookups({ views, workingStates });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "child-session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "read.search"],
    runId: "run-1",
  };
  const scopedActor: HarnessActorContext = { ...actor, sessionId: "scoped-session", workspaceScope: [path.join(workspace, "src")] };
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  const base = await store.captureDirectory(workspace);
  const draftBytes = Buffer.from("fixed draft body\n");
  const draftObject = await store.putObject(draftBytes);
  await store.createBranch(workspaceId, "thread-child", {
    ...base,
    "draft.ts": { kind: "regular-file", objectHash: draftObject.hash, byteLength: draftObject.byteLength },
  }, "base", ["draft.ts"]);
  views.bind({
    sessionId: actor.sessionId,
    workspaceId,
    threadId: "child",
    runId: "run-1",
    branchId: "thread-child",
    revision: 0,
    mode: "virtual",
    draftBasePaths: ["draft.ts"],
  });
  views.bind({
    sessionId: scopedActor.sessionId,
    workspaceId,
    threadId: "child",
    runId: "run-1",
    branchId: "thread-child",
    revision: 0,
    mode: "virtual",
    draftBasePaths: ["draft.ts"],
  });

  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async (identity) => identity.sessionId === scopedActor.sessionId ? scopedActor : actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.readSource", createDocumentReadSourceService({
    documentReadSource: async (sessionId, _context, resourceId) => {
      const result = await lookups.readSource(sessionId, resourceId);
      if (!result) throw new Error("working-branch read source is unbound");
      return result;
    },
  }));
  router.register("document.pathOverlay", createDocumentPathOverlayService({
    documentPathOverlay: async (sessionId, _context, resourceId) => {
      const result = await lookups.pathOverlay(sessionId, resourceId);
      if (!result) throw new Error("working-branch path overlay is unbound");
      return result;
    },
  }));
  const search = createHarnessSearchService({
    search: async () => {
      throw new Error("parent disk search must not run for a bound branch");
    },
    resolveWorkspaceRoot: async () => workspace,
    branchCorpus: (sessionId) => lookups.searchCorpus(sessionId),
    readFile: createExploreFileReader(documents, paths, (sessionId, resourceId) => lookups.exploreFile(sessionId, resourceId)),
  });
  router.register("search.content", createSearchContentService(search));

  disposes.push(async () => {
    router.dispose();
    database.close();
    await documents.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = async <M extends "document.readSource" | "document.pathOverlay" | "search.content">(
    method: M,
    params: HarnessServiceMap[M]["params"],
    currentActor: HarnessActorContext = actor,
  ) => {
    await router.processEvent({
      kind: "host",
      actor: currentActor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: { requestId: crypto.randomUUID(), method, params },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap[M]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };

  return { actor, request, scopedActor, store, views, workspace, worktree, workspaceId };
}

describe("WorkingState Host branch view production chain", () => {
  it("keeps child read/grep/find/ls on the fixed base after parent and worktree drift", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "kept.txt"), "parent live kept\n");
    await fs.writeFile(path.join(f.worktree, "kept.txt"), "worktree live kept\n");
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "parent live draft\n");

    const read = await f.request("document.readSource", { path: "kept.txt" });
    expect(read).toMatchObject({ ok: true, result: { source: "working-branch" } });
    if (!read.ok || read.result.source !== "working-branch" || !read.result.base64) {
      throw new Error("expected working-branch bytes");
    }
    expect(Buffer.from(read.result.base64, "base64").toString("utf8")).toBe("fixed kept\n");
    expect(read.result.provenance).toEqual({ branchId: "thread-child", revision: 0, origin: "base" });

    const draft = await f.request("document.readSource", { path: "draft.ts" });
    expect(draft).toMatchObject({ ok: true, result: { source: "working-branch", provenance: { origin: "draft-base" } } });
    if (!draft.ok || draft.result.source !== "working-branch" || !draft.result.base64) {
      throw new Error("expected draft-base bytes");
    }
    expect(Buffer.from(draft.result.base64, "base64").toString("utf8")).toBe("fixed draft body\n");

    const overlay = await f.request("document.pathOverlay", { path: ".", pattern: "*" });
    expect(overlay).toMatchObject({ ok: true, result: { status: "ready", authority: "working-branch" } });
    if (!overlay.ok || overlay.result.status !== "ready") throw new Error("expected exclusive overlay");
    expect(overlay.result.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["kept.txt", "draft.ts", "src", "src/nested.ts"]));

    const grep = await f.request("search.content", { pattern: "fixed kept" });
    expect(grep).toMatchObject({ ok: true, result: { status: "ready", totalHits: 1 } });
    if (!grep.ok || grep.result.status !== "ready") throw new Error("expected branch grep hits");
    expect(grep.result.files[0]?.path).toBe("kept.txt");

    const liveGrep = await f.request("search.content", { pattern: "parent live" });
    expect(liveGrep).toMatchObject({ ok: true, result: { status: "empty" } });
  });

  it("rejects a path outside the child scope before reading the branch", async () => {
    const f = await fixture();
    const refused = await f.request("document.readSource", { path: "kept.txt" }, f.scopedActor);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected scope refusal");
    expect(refused.error.code).toBe("forbidden");
    expect(JSON.stringify(refused)).not.toContain("fixed kept");
  });
});
