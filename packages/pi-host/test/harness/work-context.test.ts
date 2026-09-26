import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextGetResult } from "@varin/protocol";
import {
  applyWorkContextResult,
  createWorkContextMirror,
  resolveWorkContextPath,
  WorkContextSync,
} from "../../src/harness/work-context.js";
import { withToolExecutionResources } from "../../src/harness/tool-execution-resources.js";
import { createWorkContextTool } from "../../src/harness/work-context-tool.js";

const getResult = (operationDir: string, revision: number): ContextGetResult => ({
  context: { operationDir, queryScope: null, revision },
  workspaceRoot: path.resolve("/ws"),
});

test("work context mirror seeds from the session cwd and applies host state", () => {
  const mirror = createWorkContextMirror(path.resolve("/ws/session"));
  assert.equal(mirror.operationDirAbs, path.resolve("/ws/session"));
  assert.equal(mirror.revision, null);

  applyWorkContextResult(mirror, {
    context: { operationDir: "packages/web", queryScope: ["packages/web/src"], revision: 3 },
    workspaceRoot: path.resolve("/ws"),
  });
  assert.equal(mirror.operationDir, "packages/web");
  assert.equal(mirror.operationDirAbs, path.resolve("/ws", "packages/web"));
  assert.equal(mirror.revision, 3);
  assert.deepEqual(mirror.queryScope, ["packages/web/src"]);
});

test("resolveWorkContextPath anchors relatives at the operation dir only", () => {
  const mirror = createWorkContextMirror("/ws");
  applyWorkContextResult(mirror, getResult("apps/web", 1));
  assert.equal(
    resolveWorkContextPath(mirror, "src/index.ts"),
    path.resolve("/ws", "apps/web", "src/index.ts"),
  );
  const abs = path.resolve("/elsewhere/x.ts");
  assert.equal(resolveWorkContextPath(mirror, abs), abs);
});

test("a stale revision piggyback triggers exactly one refresh", async () => {
  const mirror = createWorkContextMirror("/ws");
  const calls: string[] = [];
  const bridge = {
    request: async (method: string) => {
      calls.push(method);
      return getResult("packages/web", 7);
    },
  };
  const sync = new WorkContextSync(bridge as never, mirror);
  sync.noteRevision(7);
  sync.noteRevision(7);
  await sync.refresh();
  await sync.refresh();
  assert.deepEqual(calls, ["context.get"]);
  assert.equal(mirror.revision, 7);
  assert.equal(mirror.operationDirAbs, path.resolve("/ws", "packages/web"));
  // Converged revisions do not re-fetch.
  sync.noteRevision(7);
  assert.equal(calls.length, 1);
});

test("resource plans anchor at the live operation dir while params stay as typed", async () => {
  let operationDir = path.resolve("/ws", "apps", "web");
  const seen: unknown[] = [];
  const tool: ToolDefinition = {
    name: "read",
    label: "read",
    description: "read",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => {
      seen.push(params);
      return { content: [], details: {} };
    },
  };
  const wrapped = withToolExecutionResources(tool, path.resolve("/ws"), () => operationDir);
  const first = await wrapped.prepareExecution!({ path: "src/a.ts" });
  await wrapped.execute("call-1", { path: "src/a.ts" }, undefined, undefined, {} as never);

  // A context switch takes effect on the very next plan — no restart.
  operationDir = path.resolve("/ws", "apps", "api");
  const second = await wrapped.prepareExecution!({ path: "src/b.ts" });
  await wrapped.execute("call-2", { path: "src/b.ts" }, undefined, undefined, {} as never);

  // Bridge payloads stay workspace-relative: the Host path authority resolves
  // them against the authoritative operation dir. Only the local resource
  // identities used for scheduling anchor at the pi-side mirror.
  assert.deepEqual(seen, [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  const firstId = first!.resources![0]!.id;
  const secondId = second!.resources![0]!.id;
  assert.ok(firstId.includes(path.normalize(path.resolve("/ws", "apps", "web", "src", "a.ts")).replaceAll("\\", "/").toLowerCase()),
    `first plan anchors at apps/web: ${firstId}`);
  assert.ok(secondId.includes(path.normalize(path.resolve("/ws", "apps", "api", "src", "b.ts")).replaceAll("\\", "/").toLowerCase()),
    `second plan anchors at apps/api: ${secondId}`);
});

test("unlisted tools keep their params untouched", async () => {
  const seen: unknown[] = [];
  const tool: ToolDefinition = {
    name: "send",
    label: "send",
    description: "send",
    parameters: Type.Any(),
    execute: async (_id, params) => {
      seen.push(params);
      return { content: [], details: {} };
    },
  };
  const wrapped = withToolExecutionResources(tool, "/ws", () => "/ws/pkg");
  await wrapped.execute("call-1", { path: "relative/thread.ts" }, undefined, undefined, {} as never);
  assert.deepEqual(seen, [{ path: "relative/thread.ts" }]);
});

test("an older context read cannot overwrite a completed select", async () => {
  const mirror = createWorkContextMirror("/ws");
  let release!: (value: ContextGetResult) => void;
  const gate = new Promise<ContextGetResult>((r) => { release = r; });
  const sync = new WorkContextSync({ request: () => gate } as never, mirror);
  const read = sync.refresh();
  sync.apply(getResult("second", 2));
  release(getResult("first", 1));
  await read;
  assert.equal(mirror.operationDir, "second");
  assert.equal(mirror.revision, 2);
});

test("a branch navigation replaces the mirror even at the same or lower revision", async () => {
  const mirror = createWorkContextMirror("/ws");
  applyWorkContextResult(mirror, { ...getResult("first", 4), contextEntryId: "entry-first" });
  applyWorkContextResult(mirror, { ...getResult("second", 1), contextEntryId: "entry-second" });
  assert.equal(mirror.operationDir, "second");
  assert.equal(mirror.revision, 1);
  assert.equal(mirror.contextEntryId, "entry-second");
  applyWorkContextResult(mirror, { ...getResult("", 0), contextEntryId: null });
  assert.equal(mirror.operationDir, "");
  assert.equal(mirror.revision, 0);
});

test("steady tools use the local branch marker and refresh only after navigation", async () => {
  const mirror = createWorkContextMirror("/ws");
  let entryId: string | null = "entry-one";
  let calls = 0;
  const bridge = { request: async () => {
    calls += 1;
    return { ...getResult(entryId === "entry-one" ? "one" : "two", 1), contextEntryId: entryId };
  } };
  const sync = new WorkContextSync(bridge as never, mirror, () => entryId);
  await sync.ensureCurrent();
  await sync.ensureCurrent();
  await sync.ensureCurrent();
  assert.equal(calls, 1);
  entryId = "entry-two";
  await sync.ensureCurrent();
  assert.equal(calls, 2);
  assert.equal(mirror.operationDir, "two");
});

test("work_context uses the known revision when the caller omits its CAS guard", async () => {
  const mirror = createWorkContextMirror("/ws");
  applyWorkContextResult(mirror, getResult("first", 4));
  const seen: Array<{ method: string; params: unknown }> = [];
  const bridge = {
    request: async (method: string, params: unknown) => {
      seen.push({ method, params });
      return getResult("second", 5);
    },
  };
  const sync = new WorkContextSync(bridge as never, mirror);
  await createWorkContextTool(bridge as never, sync).execute(
    "call-select", { action: "select", path: "second" }, undefined, undefined, {} as never,
  );
  assert.deepEqual(seen, [{ method: "context.select", params: { path: "second", expectedRevision: 4 } }]);
  assert.equal(mirror.revision, 5);
});
