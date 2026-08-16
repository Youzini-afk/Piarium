import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostHandshakeResult } from "@piarium/protocol";
import type { RuntimeCandidate } from "@piarium/pi-host/discovery";
import { PiRuntimeNotReadyError } from "../src/errors.js";
import { PiRuntimeLifecycle } from "../src/runtime-lifecycle.js";
import type { PiRuntimeBroker } from "../src/runtime-broker.js";

const SYSTEM_ROOT = "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent";
const CUSTOM_ROOT = "D:\\other\\pi-coding-agent";

const handshakeFor = (packageRoot: string, source: "system" | "custom"): HostHandshakeResult => ({
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
    agentDir: "C:\\agent",
    nodePath: "C:\\tools\\node.exe",
    nodeVersion: "22.19.0",
    packageRoot,
    piVersion: "0.84.1",
    source,
  },
});

const systemCandidate: RuntimeCandidate = {
  available: true,
  command: "C:\\tools\\pi.cmd",
  compatible: true,
  id: "system",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: SYSTEM_ROOT,
  source: "system",
  version: "0.84.1",
};

const customCandidate: RuntimeCandidate = {
  available: true,
  compatible: true,
  id: "custom:other",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: CUSTOM_ROOT,
  source: "custom",
  version: "0.84.1",
};

const fakeBroker = (
  packageRoot: string,
  activeSessionIds: string[] = [],
  onDispose?: () => void,
): PiRuntimeBroker => ({
  activeSessionIds,
  packageRoot,
  workerCount: activeSessionIds.length + 1,
  subscribe: () => () => {},
  warmup: async () => handshakeFor(packageRoot, packageRoot === CUSTOM_ROOT ? "custom" : "system"),
  dispose: async () => {
    onDispose?.();
  },
} as unknown as PiRuntimeBroker);

test("starts without a broker when Pi is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-lifecycle-"));
  try {
    const lifecycle = new PiRuntimeLifecycle({
      dataDir,
      createBroker: () => {
        throw new Error("should not create a broker");
      },
      discover: async () => [],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "install",
        reason: "missing",
        targetVersion: "0.84.1",
      }),
      probe: async () => {
        throw new Error("should not probe");
      },
    });
    const result = await lifecycle.start();
    assert.equal(result, undefined);
    assert.equal(lifecycle.snapshot.status, "missing");
    assert.throws(() => lifecycle.requireBroker(), PiRuntimeNotReadyError);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("creates a broker after a successful probe without restarting the process", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-lifecycle-"));
  try {
    const created: string[] = [];
    const lifecycle = new PiRuntimeLifecycle({
      dataDir,
      createBroker: (options) => {
        created.push(options.packageRoot ?? "");
        return fakeBroker(options.packageRoot ?? SYSTEM_ROOT);
      },
      discover: async () => [systemCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: "0.84.1",
      }),
      probe: async () => ({
        handshake: handshakeFor(SYSTEM_ROOT, "system"),
        sessionCreated: false,
      }),
    });
    const result = await lifecycle.start();
    assert.equal(result?.runtime.source, "system");
    assert.deepEqual(created, [SYSTEM_ROOT]);
    assert.equal(lifecycle.requireBroker().packageRoot, SYSTEM_ROOT);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("keeps the previous broker generation after activating another install", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-lifecycle-"));
  try {
    const first = fakeBroker(SYSTEM_ROOT, ["session-old"]);
    const second = fakeBroker(CUSTOM_ROOT);
    const created: PiRuntimeBroker[] = [];
    const lifecycle = new PiRuntimeLifecycle({
      dataDir,
      createBroker: (options) => {
        const broker = options.packageRoot === CUSTOM_ROOT ? second : first;
        created.push(broker);
        return broker;
      },
      discover: async () => [systemCandidate, customCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: "0.84.1",
      }),
      probe: async (options) => ({
        handshake: handshakeFor(options.packageRoot ?? SYSTEM_ROOT, options.packageRoot === CUSTOM_ROOT ? "custom" : "system"),
        sessionCreated: false,
      }),
    });
    await lifecycle.start();
    await lifecycle.activate("custom:other");
    assert.equal(lifecycle.brokerForSession("session-old"), first);
    assert.equal(lifecycle.requireBroker(), second);
    assert.equal(created.length, 2);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("stops workers that use the global install before upgrading", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-lifecycle-"));
  try {
    let disposed = false;
    const lifecycle = new PiRuntimeLifecycle({
      dataDir,
      createBroker: (options) => fakeBroker(options.packageRoot ?? SYSTEM_ROOT, ["session-old"], () => {
        disposed = true;
      }),
      discover: async () => [systemCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      installer: {
        runCommand: async () => {
          assert.equal(disposed, true);
          return { exitCode: 0, stderr: "", stdout: "upgraded" };
        },
      },
      planInstall: () => ({
        action: "upgrade",
        args: ["install", "-g", "@earendil-works/pi-coding-agent@0.84.1"],
        currentVersion: "0.80.0",
        executable: "npm.cmd",
        manager: "npm",
        reason: "upgrade",
        targetVersion: "0.84.1",
      }),
      probe: async () => ({
        handshake: handshakeFor(SYSTEM_ROOT, "system"),
        sessionCreated: false,
      }),
    });
    await lifecycle.start();
    assert.equal(disposed, false);
    await lifecycle.upgrade();
    assert.equal(disposed, true);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
