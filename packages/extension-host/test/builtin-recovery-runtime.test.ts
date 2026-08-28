import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PIARIUM_BUILTIN_RECOVERY_EXTENSION,
  PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
  PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
} from "@piarium/extension-builtins";
import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@piarium/extension-contract";
import { ApplicationExtensionRuntime } from "../src/application-runtime.js";

test("the native recovery built-in declares a replaceable Host service without Pi package integration", () => {
  const manifest = PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest;
  assert.equal(manifest.id, "piarium.builtin.recovery");
  assert.equal(manifest.entrypoints?.host?.mode, "brokered");
  assert.deepEqual(manifest.entrypoints?.host?.activation, ["service-request"]);
  assert.deepEqual(manifest.capabilities?.host, ["workspace.recovery-primitives"]);
  assert.deepEqual(manifest.provides?.services, [{
    id: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
    multiple: true,
    version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
  }]);
  assert.equal(manifest.integrates, undefined);
  assert.equal(PIARIUM_BUILTIN_RECOVERY_EXTENSION.manifest.id, "piarium.builtin.pi-recovery");
  assert.notEqual(PIARIUM_BUILTIN_RECOVERY_EXTENSION.manifest.id, manifest.id);
});

test("the built-in recovery Host activates on service invocation and withdraws on deactivation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-builtin-recovery-"));
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    piariumVersion: "1.2.3",
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  runtime.capabilities.register("workspace.recovery-primitives", async (method, params) => {
    calls.push({ method, params });
    return {
      capabilities: { capture: true, diff: true, read: true, storageManagement: true },
      identity: {
        authorityId: runtime.services.hostId,
        canonicalRoot: "/workspace",
        filesystemProfile: "local-posix",
        workspaceId: "workspace-1",
      },
      status: "ready",
      storage: {
        authorityId: runtime.services.hostId,
        byteLength: 0,
        encryption: { available: false, enabled: false },
        location: { mode: "application-data" },
        objectCount: 0,
        readySnapshotCount: 0,
        registryRevision: 0,
        snapshotCount: 0,
        state: "missing",
        workspaceId: "workspace-1",
      },
    };
  });
  try {
    const started = await runtime.start();
    const entry = started.catalog.extensions.find((candidate) => (
      candidate.manifest.id === PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
    ));
    assert.equal(entry?.desired.enabled, true);
    assert.equal(entry?.integrity, undefined);
    assert.equal(calls.length, 0);

    const result = await runtime.invokeService({
      args: ["workspace-1"],
      method: "status",
      serviceId: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
      version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
    }) as { status?: string };
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, [{ method: "status", params: { workspaceId: "workspace-1" } }]);
    const active = await runtime.state();
    assert.equal(active.services.providers.some((provider) => (
      provider.extensionId === PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
      && provider.descriptor.id === PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID
    )), true);

    await runtime.setEnabled(
      PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
      false,
      active.catalog.revision,
    );
    assert.equal(runtime.services.getSnapshot().providers.some((provider) => (
      provider.extensionId === PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
    )), false);
    await assert.rejects(
      runtime.invokeService({
        args: ["workspace-1"],
        method: "status",
        serviceId: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
        version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
      }),
      /no provider is available|provider is unavailable/i,
    );
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(dataDir, { force: true, recursive: true });
  }
});
