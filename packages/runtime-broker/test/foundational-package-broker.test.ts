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

test("foundational package authority reconciles before a new session executes extensions", async () => {
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
    await Promise.race([
      broker.restoreFoundationalPackages(),
      delay(15_000).then(() => {
        throw new Error("foundational package authority did not reach a terminal state");
      }),
    ]);
    assert.equal(broker.foundationalPackageStatus().state, "ready");
    assert.deepEqual(
      await Promise.race([
        broker.listSessions(),
        delay(1_000).then(() => {
          throw new Error("session catalog was blocked by foundational provisioning");
        }),
      ]),
      [],
    );

    let sessionSettled = false;
    const sessionPromise = broker.createSession(workspace).finally(() => {
      sessionSettled = true;
    });
    await delay(50);
    assert.equal(sessionSettled, false, "the real session worker must still observe extension startup");

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

test("foundational package authority never loads project extensions from the server cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-foundation-neutral-cwd-"));
  const serverCwd = join(root, "server-project");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const packageRoot = join(root, "foundation-package");
  await Promise.all([
    mkdir(join(serverCwd, ".pi", "extensions"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(serverCwd, ".pi", "extensions", "blocking-project-extension.ts"),
    "await new Promise<void>(() => {});\nexport default function () {}\n",
    "utf8",
  );
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.29.0-neutral-cwd",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "index.ts"), "export default function () {}\n", "utf8");

  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "foundation-neutral-cwd-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: serverCwd,
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
    await Promise.race([
      broker.restoreFoundationalPackages(),
      delay(15_000).then(() => {
        throw new Error("package authority was blocked by the server cwd");
      }),
    ]);
    assert.equal(broker.foundationalPackageStatus().state, "ready");
    assert.deepEqual(await broker.listSessions(), []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("a broken global extension remains removable through the package authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-package-recovery-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "blocking-package");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.29.0-blocking",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    "await new Promise<void>(() => {});\nexport default function () {}\n",
    "utf8",
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: { clientName: "package-recovery-test", clientVersion: "0.1.0", mode: "test" },
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
  let blocked: Promise<{ error?: unknown; status: "fulfilled" | "rejected" }> | undefined;
  try {
    await broker.warmup();
    await Promise.race([
      broker.restoreFoundationalPackages(),
      delay(15_000).then(() => { throw new Error("foundation reconcile did not finish"); }),
    ]);
    blocked = broker.listCommandsForWorkspace(workspace).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );
    await delay(50);
    const removed = await Promise.race([
      dispatchRuntimeRequest(broker, "package.remove", {
        cwd: workspace,
        scope: "global",
        source: packageRoot,
      }),
      delay(15_000).then(() => { throw new Error("package recovery was blocked by its extension"); }),
    ]);
    assert.equal(removed.removed, true);
    assert.equal((await blocked).status, "rejected");
    assert.deepEqual(await broker.listSessions(), []);
  } finally {
    await broker.dispose();
    await blocked;
    await rm(root, { force: true, recursive: true });
  }
});
