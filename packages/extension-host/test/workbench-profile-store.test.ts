import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExtensionStorageRevisionConflictError,
  ExtensionStorageStore,
  WorkbenchProfileStore,
} from "../src/index.js";

const directories: string[] = [];
test.after(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

test("workbench layouts persist replacement choices and retain missing contribution references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-workbench-profile-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const missing = await store.read();
  assert.equal(missing.storageState, "missing");
  const written = await store.updateLayout({
    expectedRevision: 0,
    layer: {
      profileId: "default",
      references: [{ contributionId: "dev.example.not-installed", region: "right" }],
      replacementSelections: { "workbench.shell": "dev.example.alternative-shell" },
      scope: "workspace",
      scopeId: "/workspace",
      surface: "web",
    },
  });
  assert.equal(written.document.revision, 1);
  const restarted = new WorkbenchProfileStore({ hostId: written.hostId, storage: new ExtensionStorageStore(dataDir) });
  assert.deepEqual((await restarted.read()).document.layouts, written.document.layouts);
  await assert.rejects(
    store.updateLayout({ expectedRevision: 0, layer: written.document.layouts[0] as never }),
    ExtensionStorageRevisionConflictError,
  );
});

test("migrates raw filesystem workspace scope ids to canonical workspace ids on the same host", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-workbench-workspace-id-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const canonicalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherHostPath = "D:\\other-host\\project";
  const written = await store.selectProfile({
    expectedRevision: 0,
    profileId: "default",
    scope: "workspace",
    scopeId: "/workspace/demo",
  });
  assert.equal(written.document.profileSelections.workspaces["/workspace/demo"], "default");
  store.setWorkspaceScopeResolver(async (scopeId) => (
    scopeId === "/workspace/demo" || scopeId === canonicalId ? canonicalId : null
  ));
  const migrated = await store.read();
  assert.equal(migrated.document.profileSelections.workspaces[canonicalId], "default");
  assert.equal(migrated.document.profileSelections.workspaces["/workspace/demo"], undefined);
  const foreign = await store.selectProfile({
    expectedRevision: migrated.document.revision,
    profileId: "default",
    scope: "workspace",
    scopeId: otherHostPath,
  });
  assert.equal(foreign.document.profileSelections.workspaces[otherHostPath], "default");
  assert.equal(foreign.document.profileSelections.workspaces[canonicalId], "default");
});

test("missing storage keeps the Agent default document without persisting a migration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-workbench-agent-default-"));
  directories.push(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage: new ExtensionStorageStore(dataDir),
  });
  const missing = await store.read();
  assert.equal(missing.storageState, "missing");
  assert.equal(missing.document.revision, 0);
  assert.equal(missing.document.profiles[0]?.label, "Agent");
  assert.equal(missing.document.layouts.length, 3);
  const again = await store.read();
  assert.equal(again.storageState, "missing");
  assert.equal(again.document.revision, 0);
});

test("migrates persisted Default profiles onto Agent Workspace without replacing a chosen shell", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-workbench-agent-migrate-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const address = {
    extensionId: "piarium.core.workbench",
    key: "profiles",
    scope: "application",
  } as const;
  await storage.update(address, 0, 1, {
    activeProfileId: "default",
    layouts: [{
      profileId: "default",
      references: [],
      replacementSelections: { "workbench.shell": "dev.example.community.shell" },
      scope: "distribution",
      scopeId: "default",
      surface: "web",
    }],
    profileSelections: { users: {}, workspaces: {} },
    profiles: [{ id: "default", label: "Default" }],
  });
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const migrated = await store.read();
  assert.equal(migrated.storageState, "ready");
  assert.equal(migrated.document.revision, 2);
  assert.equal(migrated.document.profiles[0]?.label, "Agent");
  const bySurface = Object.fromEntries(
    migrated.document.layouts.map((layer) => [layer.surface, layer.replacementSelections["workbench.shell"]]),
  );
  assert.equal(bySurface.web, "dev.example.community.shell");
  assert.equal(bySurface.desktop, "piarium.builtin.agent-workspace.shell");
  assert.equal(bySurface.mobile, "piarium.builtin.agent-workspace.shell");
  const unchanged = await store.read();
  assert.equal(unchanged.document.revision, migrated.document.revision);
});
