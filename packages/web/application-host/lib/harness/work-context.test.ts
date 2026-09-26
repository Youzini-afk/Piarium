import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HarnessActorContext } from "@varin/protocol";
import { createHarnessPathAuthority } from "./path-authority.js";
import {
  discoverProjects,
  getWorkContext,
  operationDirAbsolute,
  resetWorkContext,
  seedWorkContext,
  selectOperationDir,
  setQueryScope,
} from "./work-context.js";

const actor = (overrides: Partial<HarnessActorContext> = {}): HarnessActorContext => ({
  authorityInstanceId: "broker-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["context.session"],
  ...overrides,
});

const harness = (root: string) => {
  const authority = createHarnessPathAuthority({
    authorityId: "host-1",
    documents: { inspectWorkspace: async () => ({ root }) },
  });
  const a = actor();
  return {
    workspaceRoot: root,
    sessionRoot: root,
    authorize: (candidate: string, options: { allowMissing: boolean }) =>
      authority.resolve(a, candidate, options),
    authorizeScopeRoots: [root],
  };
};

describe("harness work context", () => {
  it("rejects a delayed selection that loses its revision during authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-cas-"));
    fs.mkdirSync(join(root, "first"));
    fs.mkdirSync(join(root, "second"));
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const delayed = {
      ...deps,
      authorize: async (candidate: string, options: { allowMissing: boolean }) => {
        if (candidate === join(root, "first")) await gate;
        return deps.authorize(candidate, options);
      },
    };
    try {
      const first = selectOperationDir(state, { path: "first", expectedRevision: 0 }, delayed);
      await selectOperationDir(state, { path: "second", expectedRevision: 0 }, deps);
      release();
      await expect(first).rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(state).toMatchObject({ operationDir: "second", revision: 1 });
    } finally { release(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not reset to a deleted launch directory or seed outside its authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-reset-missing-"));
    const launch = join(root, "launch");
    fs.mkdirSync(launch);
    const state = seedWorkContext(root, launch);
    const deps = { ...harness(root), sessionRoot: launch };
    try {
      await selectOperationDir(state, { path: "." }, deps);
      rmSync(launch, { recursive: true });
      await expect(Promise.resolve().then(() => resetWorkContext(state, {}, deps))).rejects.toThrow();
      expect(state).toMatchObject({ operationDir: "", revision: 1 });
      expect(() => seedWorkContext(root, resolve(root, "../outside"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("authorizes discovery roots before enumerating them", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-denied-"));
    writeFileSync(join(root, "package.json"), "{}");
    try {
      const found = await discoverProjects({}, { ...harness(root), authorize: async () => null });
      expect(found.candidates).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("seeds the operation dir from the session launch dir relative to the root", () => {
    const state = seedWorkContext("/ws", join("/ws", "packages", "web"));
    expect(state).toEqual({ operationDir: "packages/web", queryScope: null, revision: 0 });
    expect(operationDirAbsolute(state, "/ws")).toBe(resolve("/ws", "packages", "web"));
    expect(() => seedWorkContext("/ws", "/elsewhere")).toThrow();
  });

  it("selects a project dir, rejects non-directories, and enforces CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-"));
    fs.mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    try {
      const selected = await selectOperationDir(state, { path: "apps/web" }, deps);
      expect(selected.context.operationDir).toBe("apps/web");
      expect(selected.context.revision).toBe(1);

      // Stale expectedRevision is rejected and does not mutate.
      await expect(selectOperationDir(state, { path: ".", expectedRevision: 0 }, deps))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(state.operationDir).toBe("apps/web");

      // A file is not a valid operation dir.
      await expect(selectOperationDir(state, { path: "file.txt" }, deps))
        .rejects.toMatchObject({ harnessCode: "invalid-params" });

      // Outside the workspace is forbidden, not silently rebased.
      await expect(selectOperationDir(state, { path: ".." }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps select inside a restricted workspace scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-scope-"));
    fs.mkdirSync(join(root, "packages", "web"), { recursive: true });
    fs.mkdirSync(join(root, "other"), { recursive: true });
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    const scoped = actor({ workspaceScope: ["packages/web"] });
    const deps = {
      workspaceRoot: root,
      sessionRoot: join(root, "packages", "web"),
      authorize: (candidate: string, options: { allowMissing: boolean }) =>
        authority.resolve(scoped, candidate, options),
      authorizeScopeRoots: [join(root, "packages", "web")],
    };
    const state = seedWorkContext(root, join(root, "packages", "web"));
    try {
      await expect(selectOperationDir(state, { path: "other" }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
      const ok = await selectOperationDir(state, { path: "packages/web" }, deps);
      expect(ok.context.operationDir).toBe("packages/web");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets and clears the query scope inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-qscope-"));
    fs.mkdirSync(join(root, "src"), { recursive: true });
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    try {
      const scoped = await setQueryScope(state, { paths: ["src", "missing-future-dir"] }, deps);
      expect(scoped.context.queryScope).toEqual(["src", "missing-future-dir"]);
      const cleared = await setQueryScope(state, { paths: [] }, deps);
      expect(cleared.context.queryScope).toBeNull();
      await expect(setQueryScope(state, { paths: ["../outside"] }, deps))
        .rejects.toMatchObject({ harnessCode: "forbidden" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets to the session launch dir and bumps the revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-reset-"));
    fs.mkdirSync(join(root, "sub"), { recursive: true });
    const sessionRoot = join(root, "sub");
    const deps = { ...harness(root), sessionRoot };
    const state = seedWorkContext(root, sessionRoot);
    await selectOperationDir(state, { path: "." }, deps);
    expect(state.operationDir).toBe("");
    const reset = await resetWorkContext(state, {}, deps);
    expect(reset.context.operationDir).toBe("sub");
    expect(reset.context.revision).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers marker-bearing project dirs without leaving the scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-discover-"));
    fs.mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "package.json"), "{}");
    fs.mkdirSync(join(root, "libs", "core", ".git"), { recursive: true });
    fs.mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(root, "node_modules", "junk", "package.json"), "{}");
    const deps = harness(root);
    try {
      const found = await discoverProjects({}, deps);
      const paths = found.candidates.map((candidate) => candidate.path).sort();
      expect(paths).toEqual(["apps/web", "libs/core"]);
      // The root marker file also makes "" a candidate; node_modules never is.
      expect(paths).not.toContain("node_modules/junk");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the current state through context.get", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-ctx-get-"));
    const deps = harness(root);
    const state = seedWorkContext(root, root);
    const view = getWorkContext(state, deps);
    expect(view.workspaceRoot).toBe(root);
    expect(view.context).toMatchObject({ operationDir: "", queryScope: null, revision: 0 });
    rmSync(root, { recursive: true, force: true });
  });
});
