import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext, HarnessServiceMap } from "@piarium/protocol";
import { createDocumentAuthority } from "../documents/authority.js";
import { createWorkspaceContentSearch } from "../search/content.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createExploreFileReader } from "./explore-file-reader.js";
import { createExploreSearchService } from "./explore-service.js";
import { createHarnessServiceHost } from "./service-host.js";
import { createHarnessRouter } from "./router.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture(scope?: string[]) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-explore-service-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const documents = createDocumentAuthority({ hostId: "test-host", dataDir: path.join(root, "data"), isAllowedRoot: async () => true, isTrusted: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host", sessionId: "test-session", workerId: "worker", workerGeneration: 1,
    workspaceId, grantedCapabilities: ["read.search"], ...(scope ? { workspaceScope: scope } : {}),
  };
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  const search = createWorkspaceContentSearch({ documents, pathModule: path, spawn });
  const host = createHarnessServiceHost({
    search: (request, options) => search.searchContent(request, options),
    resolveWorkspaceRoot: async () => workspace,
    readExploreFile: createExploreFileReader(documents, paths),
  });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("explore.search", createExploreSearchService(host));
  disposes.push(async () => {
    router.dispose();
    await host.dispose();
    await documents.dispose();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root, workspace, actor, host, documents, paths,
    async request(params: HarnessServiceMap["explore.search"]["params"], inputContext?: AgentInputContext) {
      await router.processEvent({
        kind: "host", actor,
        envelope: { kind: "event", event: "harness.request", data: {
          requestId: "request", method: "explore.search", params,
          ...(inputContext ? { inputContext } : {}),
        } },
      });
      return response as { ok: true; result: HarnessServiceMap["explore.search"]["result"] } | { ok: false; error: { code: string; message: string } };
    },
    async capture(resourceId: string, content: string, localEditRevision = 1, sessionId = actor.sessionId) {
      const disk = await documents.read({ workspaceId, resourceId });
      const baseRevision = disk.status === "missing" ? null : disk.revision;
      const resource = { workspaceId, resourceId };
      await documents.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface",
        resources: [{ baseRevision, localEditRevision, resource }],
        workspaceId,
      });
      return documents.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface",
        resources: [{ baseRevision, content, localEditRevision, resource }],
        sessionId,
        workspaceId,
      });
    },
  };
}

describe("explore through Host router, real ripgrep, and Documents", () => {
  it("reads both requested roots, preserves literal metacharacters, and issues a scoped output ref", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.workspace, "first"));
    await fs.mkdir(path.join(f.workspace, "second"));
    await fs.writeFile(path.join(f.workspace, "first", "a.ts"), "header\na.*b\nfirst body\n", "utf8");
    await fs.writeFile(path.join(f.workspace, "second", "b.ts"), "a.*b\nsecond body\n", "utf8");
    await fs.writeFile(path.join(f.workspace, "unselected.ts"), "a.*b\n", "utf8");
    const response = await f.request({ question: '"a.*b"', paths: ["first", "second"] });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const { result } = response;
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["first/a.ts", "second/b.ts"]);
    expect(result.snippets[0]).toMatchObject({ source: "disk", startLine: 1, text: "header\na.*b\nfirst body\n" });
    expect(result.snippets[0]?.revision).toBeTruthy();
    expect(result.text).toContain(result.handle);
    expect(f.host.outputStore.read(f.actor.sessionId, result.handle).status).toBe("ready");
    expect(f.host.outputStore.read("other-session", result.handle).status).not.toBe("ready");
  });

  it("enforces actor scope even without an explicit path", async () => {
    const f = await fixture(["allowed"]);
    await fs.mkdir(path.join(f.workspace, "allowed"));
    await fs.writeFile(path.join(f.workspace, "allowed", "a.ts"), "needle\n");
    await fs.writeFile(path.join(f.workspace, "outside.ts"), "needle\n");
    const response = await f.request({ question: "needle" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets.map((snippet) => snippet.path)).toEqual(["allowed/a.ts"]);
    expect(await f.request({ question: "needle", paths: ["outside.ts"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("rejects every explicit escaped path before searching", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "outside.ts"), "needle\n");
    expect(await f.request({ question: "needle", paths: [".", "../outside.ts"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("cannot read an out-of-scope derived hit", async () => {
    const f = await fixture(["allowed"]);
    await fs.mkdir(path.join(f.workspace, "allowed"));
    await fs.writeFile(path.join(f.workspace, "outside.ts"), "private text\n");
    const read = createExploreFileReader(f.documents, f.paths);
    expect(await read(f.actor, "outside.ts", new AbortController().signal)).toMatchObject({ status: "forbidden" });
  });

  it("Reports missing/binary documents without text fallback", async () => {
    const f = await fixture();
    const read = createExploreFileReader(f.documents, f.paths);
    expect(await read(f.actor, "missing.ts", new AbortController().signal)).toMatchObject({ status: "unavailable" });
    await fs.writeFile(path.join(f.workspace, "binary.bin"), Buffer.from([0, 255, 0, 1]));
    expect(await read(f.actor, "binary.bin", new AbortController().signal)).toMatchObject({ status: "unavailable" });
  });

  it("searches dirty-only text, removes stale disk matches, and reads one fixed draft revision", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "stalediskneedle\nbase\n", "utf8");
    const context = await f.capture("draft.ts", "newdraftneedle\nfirst frozen body\n", 3);

    const draft = await f.request({ question: "newdraftneedle" }, context);
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.message);
    expect(draft.result.snippets).toMatchObject([{
      path: "draft.ts",
      source: "surface-draft",
      text: "newdraftneedle\nfirst frozen body\n",
    }]);
    expect(draft.result.snippets[0]?.revision).toMatch(/^surface-draft:/);

    const deletedFromDraft = await f.request({ question: "stalediskneedle" }, context);
    expect(deletedFromDraft).toMatchObject({ ok: true, result: { snippets: [] } });

    await f.documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: (await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" }) as { revision: string }).revision,
        localEditRevision: 4,
        resource: { workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" },
      }],
      workspaceId: f.actor.workspaceId!,
    });
    const frozen = await f.request({ question: "first frozen body" }, context);
    expect(frozen).toMatchObject({ ok: true, result: { snippets: [{ source: "surface-draft" }] } });
  });

  it("blocks known dirty disk text when the surface source is unavailable", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "dirty.ts"), "mustNotLeakFromDisk\n", "utf8");
    const context: AgentInputContext = {
      source: "surface",
      workspaceId: f.actor.workspaceId!,
      dirtyPaths: ["dirty.ts"],
      snapshot: { status: "unavailable", reason: "surface-unavailable" },
    };
    const response = await f.request({ question: "mustNotLeakFromDisk" }, context);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("Expected unavailable source response");
    expect(response.error).toMatchObject({ code: "unavailable" });
    expect(response.error.message).toContain("dirty.ts (unavailable)");
  });

  it("rejects a surface context for another actor workspace", async () => {
    const f = await fixture();
    const response = await f.request({ question: "needle" }, {
      source: "surface",
      workspaceId: "another-workspace",
      dirtyPaths: ["secret.ts"],
      snapshot: { status: "unavailable", reason: "surface-unavailable" },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("does not read a ready snapshot owned by another session or outside actor scope", async () => {
    const scoped = await fixture(["allowed"]);
    await fs.mkdir(path.join(scoped.workspace, "allowed"));
    await fs.writeFile(path.join(scoped.workspace, "outside.ts"), "privateDiskNeedle\n", "utf8");
    const otherSession = await scoped.capture(
      "outside.ts",
      "privateDraftNeedle\n",
      1,
      "other-session",
    );
    const response = await scoped.request({ question: "privateDraftNeedle" }, otherSession);
    expect(response).toMatchObject({ ok: true, result: { snippets: [] } });
    expect(JSON.stringify(response)).not.toContain("privateDraftNeedle");

    const inScopeOtherSession = await scoped.capture(
      "allowed/draft.ts",
      "otherSessionNeedle\n",
      1,
      "other-session",
    );
    const unavailable = await scoped.request({ question: "otherSessionNeedle" }, inScopeOtherSession);
    expect(unavailable).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(unavailable)).not.toContain("otherSessionNeedle");
  });
});
