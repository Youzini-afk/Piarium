import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchRuntimeRequest, PiRuntimeBroker } from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

const delay = (milliseconds: number) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

test("foundational provisioning stays behind the first-session barrier and respects removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-foundation-broker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const packageRoot = join(root, "mcp-package");
  const alternatePackageRoot = join(root, "custom-mcp-source");
  const gate = join(root, "allow-package-load");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(alternatePackageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.27.0-test",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(alternatePackageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.27.0-alternate",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(alternatePackageRoot, "index.ts"),
    "export default function () {}\n",
    "utf8",
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    `import { existsSync } from "node:fs";
await new Promise<void>((resolve) => {
  const poll = () => existsSync(${JSON.stringify(gate)}) ? resolve() : setTimeout(poll, 10);
  poll();
});
export default function (pi: any) {
  pi.registerCommand("foundation-ready", { description: "Foundation ready", handler() {} });
}
`,
    "utf8",
  );

  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "foundation-broker-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: workspace,
    environment: { HOME: homeDir },
    execArgv: ["--import", import.meta.resolve("tsx")],
    foundationalPackages: [{
      id: "mcp",
      introducedRevision: 1,
      packageAliases: ["pi-mcp-adapter"],
      packageName: "pi-mcp-adapter",
      source: packageRoot,
    }],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });

  try {
    await broker.warmup();
    for (let attempt = 0; attempt < 100 && broker.foundationalPackageStatus().state !== "running"; attempt += 1) {
      await delay(10);
    }
    assert.equal(broker.foundationalPackageStatus().state, "running");

    let sessionSettled = false;
    const sessionPromise = broker.createSession(workspace).finally(() => {
      sessionSettled = true;
    });
    await delay(50);
    assert.equal(sessionSettled, false, "a new session must wait for foundational provisioning");

    await writeFile(gate, "ready\n", "utf8");
    const session = await sessionPromise;
    const ready = broker.foundationalPackageStatus();
    assert.equal(ready.state, "ready");
    assert.equal(ready.entries[0]?.observed, "enabled");
    assert.equal(ready.entries[0]?.provenance, "auto_managed");
    assert.ok(
      (await dispatchRuntimeRequest(broker, "command.list", { sessionId: session.sessionId }))
        .some((command) => command.name === "foundation-ready"),
    );
    assert.throws(
      () => (broker.requestForSession as unknown as (
        sessionId: string,
        method: string,
        params: unknown,
      ) => Promise<unknown>)(session.sessionId, "package.bootstrap", { sources: [] }),
      /private to the broker provisioner/,
    );

    const settings = await dispatchRuntimeRequest(broker, "settings.get", { cwd: workspace });
    await dispatchRuntimeRequest(broker, "settings.update", {
      cwd: workspace,
      expectedRevision: settings.globalRevision,
      remove: ["packages"],
      scope: "global",
      set: {},
    });
    assert.equal(broker.foundationalPackageStatus().entries[0]?.intent, "suppressed");
    await dispatchRuntimeRequest(broker, "package.foundation.restore", { ids: ["mcp"] });

    const removed = await dispatchRuntimeRequest(broker, "package.remove", {
      cwd: workspace,
      scope: "global",
      source: packageRoot,
    });
    assert.equal(removed.removed, true);
    const suppressed = broker.foundationalPackageStatus();
    assert.equal(suppressed.entries[0]?.intent, "suppressed");
    assert.equal(suppressed.entries[0]?.observed, "missing");

    const restored = await dispatchRuntimeRequest(broker, "package.foundation.restore", {
      ids: ["mcp"],
    });
    assert.equal(restored.state, "ready");
    assert.equal(restored.entries[0]?.intent, "eligible");
    assert.equal(restored.entries[0]?.observed, "enabled");

    await dispatchRuntimeRequest(broker, "package.remove", {
      cwd: workspace,
      scope: "global",
      source: packageRoot,
    });
    const alternate = await dispatchRuntimeRequest(broker, "package.install", {
      cwd: workspace,
      scope: "global",
      source: alternatePackageRoot,
    });
    assert.equal(alternate.name, "pi-mcp-adapter");
    assert.equal(broker.foundationalPackageStatus().entries[0]?.intent, "eligible");
    await dispatchRuntimeRequest(broker, "package.remove", {
      cwd: workspace,
      scope: "global",
      source: alternate.source,
    });
    assert.equal(broker.foundationalPackageStatus().entries[0]?.intent, "suppressed");
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("dispose force-stops a foundational bootstrap whose extension never finishes loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-foundation-dispose-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "blocking-package");
  const gate = join(root, "gate-that-is-never-created");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.27.0-blocking",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    `import { existsSync } from "node:fs";
await new Promise<void>((resolve) => {
  const poll = () => existsSync(${JSON.stringify(gate)}) ? resolve() : setTimeout(poll, 10);
  poll();
});
export default function () {}
`,
    "utf8",
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "foundation-dispose-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: workspace,
    execArgv: ["--import", import.meta.resolve("tsx")],
    foundationalPackages: [{
      id: "mcp",
      introducedRevision: 1,
      packageAliases: ["pi-mcp-adapter"],
      packageName: "pi-mcp-adapter",
      source: packageRoot,
    }],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
    shutdownTimeoutMs: 100,
  });

  try {
    await broker.warmup();
    for (let attempt = 0; attempt < 100 && broker.foundationalPackageStatus().state !== "running"; attempt += 1) {
      await delay(10);
    }
    assert.equal(broker.foundationalPackageStatus().state, "running");
    await Promise.race([
      broker.dispose(),
      delay(3_000).then(() => {
        throw new Error("broker disposal remained blocked behind foundational provisioning");
      }),
    ]);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
