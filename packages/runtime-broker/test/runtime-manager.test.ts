import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeCandidate } from "@piarium/pi-host/discovery";
import { PiRuntimeManager } from "../src/runtime-manager.js";

const systemReady: RuntimeCandidate = {
  available: true,
  command: "C:\\tools\\pi.cmd",
  compatible: true,
  id: "system",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent",
  source: "system",
  version: "0.84.1",
};

const systemOld: RuntimeCandidate = {
  ...systemReady,
  compatible: false,
  version: "0.80.0",
};

test("probes a discovered system install and records the real handshake source", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-manager-"));
  try {
    const manager = new PiRuntimeManager({
      dataDir,
      discover: async () => [systemReady],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      probe: async (options) => {
        assert.equal(options.packageRoot, systemReady.packageRoot);
        assert.equal(options.runtimeSource, "system");
        return {
          handshake: {
            capabilities: {
              agentProviders: true,
              extensionUi: true,
              fleet: true,
              models: true,
              packages: true,
              providerConfiguration: true,
              recovery: true,
              resources: true,
              sessionFeatures: true,
              sessions: true,
              settings: true,
            },
            hostVersion: "0.1.0",
            protocolVersion: 1,
            runtime: {
              agentDir: dataDir,
              nodePath: "C:\\tools\\node.exe",
              nodeVersion: "22.19.0",
              packageRoot: "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent",
              piVersion: "0.84.1",
              source: "system",
            },
          },
          sessionCreated: false,
        };
      },
    });
    const snapshot = await manager.refresh();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.source, "system");
    assert.equal(snapshot.active?.packageRoot, systemReady.packageRoot);
    assert.equal(snapshot.active?.state, "ready");
    assert.equal("compatible" in (snapshot.active ?? {}), false);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("does not probe or recommend a downgrade when the installed Pi is newer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-manager-"));
  try {
    const newer = { ...systemReady, version: "0.99.0" };
    let probed = false;
    const manager = new PiRuntimeManager({
      dataDir,
      discover: async () => [newer],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      probe: async () => {
        probed = true;
        return {
          handshake: {
            capabilities: {
              agentProviders: true,
              extensionUi: true,
              fleet: true,
              models: true,
              packages: true,
              providerConfiguration: true,
              recovery: true,
              resources: true,
              sessionFeatures: true,
              sessions: true,
              settings: true,
            },
            hostVersion: "0.1.0",
            protocolVersion: 1,
            runtime: {
              agentDir: dataDir,
              nodePath: "C:\\tools\\node.exe",
              nodeVersion: "22.19.0",
              packageRoot: "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent",
              piVersion: "0.99.0",
              source: "system",
            },
          },
          sessionCreated: false,
        };
      },
    });
    const snapshot = await manager.refresh();
    assert.equal(probed, true);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.version, "0.99.0");
    assert.equal(JSON.stringify(snapshot).includes("downgrade"), false);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("marks an older install as upgrade-required without a version ceiling", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-manager-"));
  try {
    let probed = false;
    const manager = new PiRuntimeManager({
      dataDir,
      discover: async () => [systemOld],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      probe: async () => {
        probed = true;
        throw new Error("should not probe an upgrade-required install");
      },
    });
    const snapshot = await manager.refresh();
    assert.equal(probed, false);
    assert.equal(snapshot.status, "upgrade-required");
    assert.equal(snapshot.installations[0]?.state, "upgrade-required");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("returns the missing module name when an external package root cannot load", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-manager-"));
  try {
    const manager = new PiRuntimeManager({
      dataDir,
      discover: async () => [systemReady],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      probe: async () => {
        throw new Error("Pi package root is missing required modules: @earendil-works/pi-ai");
      },
    });
    const snapshot = await manager.refresh();
    assert.equal(snapshot.status, "failed");
    assert.match(snapshot.issue ?? "", /@earendil-works\/pi-ai/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
