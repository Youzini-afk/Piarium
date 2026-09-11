import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext, HarnessServiceMap } from "@piarium/protocol";
import { createDocumentAuthority } from "../documents/authority.js";
import { createSurfaceSnapshotStore } from "../documents/surface-snapshot-store.js";
import { createDocumentReadSourceService, createDocumentSurfaceWriteService } from "./harness-services.js";
import { attachLiveSurfaceCompleter, hashSurfaceText, type LiveSurfaceBuffer } from "../documents/contract-fixtures.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createHarnessRouter } from "./router.js";
import { createHarnessServiceHost } from "./service-host.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-document-read-source-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const documents = createDocumentAuthority({
    hostId: "test-host",
    dataDir: path.join(root, "data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "test-session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "write.document"],
  };
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  const host = createHarnessServiceHost({
    search: async () => ({ status: "empty", generation: undefined }),
    resolveWorkspaceRoot: async () => workspace,
    discoveredShells: {},
    documentReadSource: (sessionId, context, resourceId) => (
      documents.readAgentInputSnapshot(sessionId, context, resourceId)
    ),
    documentSurfaceWrite: (sessionId, context, changes, signal) => (
      documents.applyAgentSurfaceWrite(sessionId, context, changes, signal)
    ),
  });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.readSource", createDocumentReadSourceService(host));
  router.register("document.surfaceWrite", createDocumentSurfaceWriteService(host));
  disposes.push(async () => {
    router.dispose();
    await host.dispose();
    await documents.dispose();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (resourcePath: string, inputContext?: AgentInputContext) => {
    await router.processEvent({
      kind: "host",
      actor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: {
          requestId: crypto.randomUUID(),
          method: "document.readSource",
          params: { path: resourcePath },
          ...(inputContext ? { inputContext } : {}),
        },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap["document.readSource"]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };
  const write = async (
    params: HarnessServiceMap["document.surfaceWrite"]["params"],
    inputContext?: AgentInputContext,
  ) => {
    await router.processEvent({
      kind: "host",
      actor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: {
          requestId: crypto.randomUUID(),
          method: "document.surfaceWrite",
          params,
          ...(inputContext ? { inputContext } : {}),
        },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap["document.surfaceWrite"]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };
  const capture = async (resourceId: string, content: string, localEditRevision: number, bom = false) => {
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
      resources: [{ baseRevision, bom, content, encoding: "utf-8", localEditRevision, resource }],
      sessionId: actor.sessionId,
      workspaceId,
    });
  };
  return { actor, capture, documents, request, workspace, write };
}

describe("native read source through Host router and Documents", () => {
  it("matches equivalent resource casing when the workspace is case-insensitive", () => {
    const snapshots = createSurfaceSnapshotStore({ caseSensitive: false });
    const context = snapshots.capture({
      ownerId: "surface",
      sessionId: "session",
      workspaceId: "workspace",
      resources: [{
        baseRevision: null,
        bom: false,
        content: "fixed\n",
        encoding: "utf-8",
        localEditRevision: 1,
        resource: { workspaceId: "workspace", resourceId: "src/Draft.ts" },
      }],
    });

    expect(snapshots.read("session", context, "SRC/draft.ts")).toMatchObject({
      status: "ready",
      content: "fixed\n",
    });
    snapshots.dispose();
  });

  it("returns the fixed save-compatible draft bytes after the live surface changes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "disk value\n", "utf8");
    const context = await f.capture("draft.ts", "fixed draft\r\n", 3, true);
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

    const response = await f.request("draft.ts", context);

    expect(response.ok).toBe(true);
    if (!response.ok || response.result.source !== "surface-draft") throw new Error("Expected fixed surface bytes");
    expect(Buffer.from(response.result.base64, "base64").toString("utf8")).toBe("\uFEFFfixed draft\r\n");
    expect(response.result.revision).toMatch(/^surface-draft:/);
  });

  it("reads a dirty-only path and refuses disk fallback after the snapshot expires", async () => {
    const f = await fixture();
    const context = await f.capture("new.ts", "unsaved\n", 1);
    const ready = await f.request("new.ts", context);
    expect(ready).toMatchObject({ ok: true, result: { source: "surface-draft" } });

    await fs.writeFile(path.join(f.workspace, "new.ts"), "must not leak\n", "utf8");
    f.documents.dropAgentInputSnapshots(f.actor.sessionId);
    const expired = await f.request("new.ts", context);
    expect(expired).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(expired)).not.toContain("must not leak");
  });

  it("reads back the agent's own write instead of the draft captured before it", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "disk value\n", "utf8");
    const context = await f.capture("draft.ts", "unsaved editor value\n", 2);
    expect(await f.request("draft.ts", context)).toMatchObject({ ok: true, result: { source: "surface-draft" } });

    // The native write tool writes disk; the Host observes it through the Pi
    // mutation journal, exactly as index.ts wires observeToolWrite (D-088).
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "agent write\n", "utf8");
    await f.documents.observeAgentWrite(f.actor.workspaceId!, path.join(f.workspace, "draft.ts"));

    // The disk sentinel hands the read back to Pi's native tool, which now
    // reads the bytes the agent just wrote.
    expect(await f.request("draft.ts", context)).toEqual({ ok: true, result: { source: "disk" } });
    expect(f.documents.agentInputDraftPaths(f.actor.sessionId, context)).toEqual([]);
  });

  it("writes the fixed draft through the router and keeps disk unchanged", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "A\n", "utf8");
    const disk = await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" });
    if (disk.status !== "ready") throw new Error("Expected draft fixture");
    const live = new Map<string, LiveSurfaceBuffer>();
    const binding = {
      baseRevision: disk.revision,
      localEditRevision: 2,
      documentInstanceId: "document-instance",
      bufferHash: hashSurfaceText("B\n"),
      encoding: "utf-8" as const,
      bom: false,
      lineEnding: "lf" as const,
      resource: { workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" },
    };
    live.set("draft.ts", { ...binding, content: "B\n" });
    const surface = attachLiveSurfaceCompleter(f.documents, {
      generation: 1,
      live,
      ownerId: "surface",
      workspaceId: f.actor.workspaceId!,
    });
    await f.documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [binding],
      workspaceId: f.actor.workspaceId!,
    });
    const context = await f.documents.captureAgentInputSnapshot({
      generation: 1,
      ownerId: "surface",
      resources: [{ ...binding, content: "B\n" }],
      sessionId: f.actor.sessionId,
      workspaceId: f.actor.workspaceId!,
    });
    f.documents.commitAgentInputSnapshot(f.actor.sessionId, context);
    try {
      const written = await f.write({
        path: "draft.ts",
        action: "edit",
        edits: [{ oldText: "B\n", newText: "C\n" }],
      }, context);
      expect(written).toMatchObject({ ok: true, result: { status: "applied" } });
      if (!written.ok || written.result.status === "disk") throw new Error("Expected a surface write");
      expect(written.result.results[0]).toMatchObject({ target: "surface", status: "applied" });
      expect(live.get("draft.ts")?.content).toBe("C\n");
      expect(await fs.readFile(path.join(f.workspace, "draft.ts"), "utf8")).toBe("A\n");
      const reread = await f.request("draft.ts", context);
      expect(reread.ok).toBe(true);
      if (!reread.ok || reread.result.source !== "surface-draft") throw new Error("Expected updated draft");
      expect(Buffer.from(reread.result.base64, "base64").toString("utf8")).toBe("C\n");

      const diskPath = await f.write({
        path: "other.ts",
        action: "write",
        content: "plain\n",
      }, context);
      expect(diskPath).toEqual({ ok: true, result: { status: "disk" } });
    } finally {
      surface.close();
    }
  });

  it("returns a disk sentinel when the current input has no draft for the path", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "disk.txt"), "disk\n", "utf8");
    expect(await f.request("disk.txt", { source: "disk" })).toEqual({
      ok: true,
      result: { source: "disk" },
    });
  });
});
