import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessActorContext, HarnessActorIdentity, PiWorkContextSnapshot } from "@varin/protocol";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createHarnessServiceHost, type HarnessSessionContext, type WorkContextJournal } from "./service-host.js";

const actor: HarnessActorIdentity = { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1 };

function fixture(root: string) {
  let snapshot: PiWorkContextSnapshot = { leafId: "initial", entryId: null, context: null };
  let failCommit: "before" | "after" | null = null;
  let reads = 0;
  const journal: WorkContextJournal = {
    read: async () => { reads += 1; return structuredClone(snapshot); },
    commit: async (_actor, input) => {
      if (failCommit === "before") throw new Error("journal unavailable");
      if (input.expectedLeafId !== snapshot.leafId || input.expectedRevision !== (snapshot.context?.revision ?? 0)) {
        throw new Error("branch conflict");
      }
      snapshot = { leafId: `context-${input.context.revision}`, entryId: `context-${input.context.revision}`, context: structuredClone(input.context) };
      if (failCommit === "after") throw new Error("ack lost");
      return structuredClone(snapshot);
    },
  };
  const createHost = () => createHarnessServiceHost({
    search: async () => ({ status: "empty", generation: undefined }),
    resolveWorkspaceRoot: async () => root,
    discoveredShells: {},
    pathAuthority: createHarnessPathAuthority({ authorityId: "host", documents: { inspectWorkspace: async () => ({ root }) } }),
    workContextJournal: journal,
  });
  const context = (identity: HarnessActorIdentity = actor): HarnessSessionContext => ({
    actor: identity, workspaceId: "workspace", workspaceRoot: root, authorityWorkspaceRoot: root,
    grantedCapabilities: ["context.session"],
  });
  return { createHost, context, snapshot: () => snapshot, reads: () => reads,
    fail: (mode: "before" | "after" | null) => { failCommit = mode; },
    navigate: (next: PiWorkContextSnapshot) => { snapshot = next; },
    appendMessage: () => { snapshot = { ...snapshot, leafId: `message-after-${snapshot.leafId}` }; } };
}

async function admit(host: ReturnType<ReturnType<typeof fixture>["createHost"]>, context: HarnessSessionContext) {
  host.registerSession(await host.prepareWorkContext(context));
  return (await host.resolveActor(context.actor)) as HarnessActorContext;
}

describe("durable work-context journal", () => {
  it("restores a root anchor for sibling child scopes without granting root or unrelated paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-scoped-anchor-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "sibling"));
    fs.writeFileSync(path.join(root, "only-in-parent.ts"), "export {};");
    const setup = fixture(root);
    const host = setup.createHost();
    const scopedActor = { ...actor, workspaceScope: ["src", "only-in-parent.ts"] };
    const context = setup.context(scopedActor);
    const authority = createHarnessPathAuthority({ authorityId: "host",
      documents: { inspectWorkspace: async () => ({ root }) } });
    try {
      const resolved = await admit(host, context);
      expect(host.workContextGet(resolved).context).toEqual({ operationDir: "", queryScope: null, revision: 0 });
      expect(await authority.resolve(resolved, path.join(root, "src"), { allowMissing: false })).not.toBeNull();
      expect(await authority.resolve(resolved, path.join(root, "sibling"), { allowMissing: false })).toBeNull();
      await expect(host.workContextSelect(resolved, { path: "sibling" })).rejects.toMatchObject({ harnessCode: "forbidden" });
      await expect(host.workContextSelect(resolved, { path: root })).rejects.toMatchObject({ harnessCode: "forbidden" });
      setup.navigate({ leafId: "sibling-branch", entryId: "sibling-branch", context: {
        workspaceId: "workspace", authorityRoot: root, sessionRoot: root,
        operationDir: "sibling", queryScope: null, revision: 1,
      } });
      await expect(host.prepareWorkContext(context)).rejects.toThrow(/no longer authorized/);
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
  it("restores selected directory and scope after worker and Host replacement", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-durable-"));
    fs.mkdirSync(path.join(root, "project"));
    const setup = fixture(root);
    const first = setup.createHost();
    try {
      const resolved = await admit(first, setup.context());
      await first.workContextSelect(resolved, { path: "project", expectedRevision: 0 });
      await first.workContextScope(resolved, { paths: ["project"], expectedRevision: 1 });
      expect(first.workContextGet(resolved).context).toMatchObject({ operationDir: "project", queryScope: ["project"], revision: 2 });
    } finally { await first.dispose(); }
    const second = setup.createHost();
    try {
      const restored = await admit(second, setup.context({ ...actor, workerGeneration: 2 }));
      expect(second.workContextGet(restored).context).toMatchObject({ operationDir: "project", queryScope: ["project"], revision: 2 });
      expect(second.workContextOperationDir(actor.sessionId)).toBe(path.join(root, "project"));
    } finally { await second.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not publish a failed write, and reconciles an acknowledged-lost write", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-commit-"));
    fs.mkdirSync(path.join(root, "project"));
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      const resolved = await admit(host, setup.context());
      setup.fail("before");
      await expect(host.workContextSelect(resolved, { path: "project", expectedRevision: 0 })).rejects.toThrow(/not acknowledged/);
      expect(host.workContextGet(resolved).context).toMatchObject({ operationDir: "", revision: 0 });
      setup.fail("after");
      await expect(host.workContextSelect(resolved, { path: "project", expectedRevision: 0 })).rejects.toThrow(/not acknowledged/);
      expect(host.workContextGet(resolved).context).toMatchObject({ operationDir: "project", revision: 1 });
      expect(setup.snapshot().context?.operationDir).toBe("project");
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a deleted restored directory and a changed workspace binding", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-missing-"));
    const directory = path.join(root, "project");
    fs.mkdirSync(directory);
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      const resolved = await admit(host, setup.context());
      await host.workContextSelect(resolved, { path: "project" });
      rmSync(directory, { recursive: true });
      await expect(host.prepareWorkContext(setup.context({ ...actor, workerGeneration: 2 }))).rejects.toThrow(/missing or inaccessible/);
      setup.navigate({ ...setup.snapshot(), context: { ...setup.snapshot().context!, workspaceId: "other" } });
      await expect(host.prepareWorkContext(setup.context({ ...actor, workerGeneration: 2 }))).rejects.toThrow(/different workspace/);
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("refreshes a navigation to a sibling branch before admitting another request", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-branch-"));
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      const resolved = await admit(host, setup.context());
      await host.workContextSelect(resolved, { path: "one" });
      setup.navigate({ leafId: "sibling", entryId: "sibling", context: {
        workspaceId: "workspace", authorityRoot: root, sessionRoot: root,
        operationDir: "two", queryScope: null, revision: 1,
      } });
      const next = await host.resolveActor(actor);
      expect(next?.operationDir).toBe("two");
      expect(host.workContextOperationDir(actor.sessionId)).toBe(path.join(root, "two"));
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reads a fresh Pi leaf before a second selection after ordinary messages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-leaf-"));
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      const resolved = await admit(host, setup.context());
      await host.workContextSelect(resolved, { path: "one", expectedRevision: 0 });
      setup.appendMessage();
      const current = await host.resolveActor(actor, setup.snapshot().entryId);
      await host.workContextSelect(current!, { path: "two", expectedRevision: 1 });
      expect(setup.snapshot().context).toMatchObject({ operationDir: "two", revision: 2 });
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("admits steady-state tools by branch entry identity without another journal read", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-steady-"));
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      await admit(host, setup.context());
      const reads = setup.reads();
      for (let i = 0; i < 3; i += 1) {
        const resolved = await host.resolveActor(actor, setup.snapshot().entryId);
        expect(resolved?.operationDir).toBe("");
      }
      expect(setup.reads()).toBe(reads);
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("cannot commit an old actor's delayed selection into a replacement worker", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-context-generation-"));
    fs.mkdirSync(path.join(root, "project"));
    let generation = 1;
    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const journal: WorkContextJournal = {
      read: async (identity) => {
        if (identity.workerGeneration !== generation) throw new Error("worker retired");
        return { leafId: "initial", entryId: null, context: null };
      },
      commit: async (identity) => {
        entered();
        await gate;
        if (identity.workerGeneration !== generation) throw new Error("worker retired");
        throw new Error("unexpected commit");
      },
    };
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => root, discoveredShells: {},
      pathAuthority: createHarnessPathAuthority({ authorityId: "host", documents: { inspectWorkspace: async () => ({ root }) } }),
      workContextJournal: journal,
    });
    const context = (identity: HarnessActorIdentity): HarnessSessionContext => ({
      actor: identity, workspaceId: "workspace", workspaceRoot: root, authorityWorkspaceRoot: root,
      grantedCapabilities: ["context.session"],
    });
    try {
      const old = await admit(host, context(actor));
      const selection = host.workContextSelect(old, { path: "project", expectedRevision: 0 });
      await atCommit;
      host.dropSession(actor.sessionId, actor);
      generation = 2;
      const replacement = { ...actor, workerGeneration: 2 };
      const current = await admit(host, context(replacement));
      release();
      await expect(selection).rejects.toThrow(/not acknowledged/);
      expect(host.workContextGet(current).context).toMatchObject({ operationDir: "", revision: 0 });
      expect(host.hasActor(replacement)).toBe(true);
    } finally { release(); await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts the same canonical Windows binding with different path casing", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "work-context-case-"));
    fs.mkdirSync(path.join(root, "project"));
    const setup = fixture(root);
    const host = setup.createHost();
    try {
      const resolved = await admit(host, setup.context());
      await host.workContextSelect(resolved, { path: "project" });
      setup.navigate({ ...setup.snapshot(), context: {
        ...setup.snapshot().context!, authorityRoot: root.toUpperCase(), sessionRoot: root.toUpperCase(),
      } });
      await expect(host.prepareWorkContext(setup.context({ ...actor, workerGeneration: 2 }))).resolves.toBeDefined();
    } finally { await host.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
});
