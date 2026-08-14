import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ApplicationExtensionRuntime } from "../src/index.js";

const directories: string[] = [];
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
test.after(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))); });

const extensionId = "dev.example.brokered";
const serviceId = "dev.example.memory";

const writeHostExtension = async (
  directory: string,
  version: string,
  schemaVersion: number,
  migration: "ok" | "throw",
  mode: "brokered" | "native" = "brokered",
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: extensionId,
    version,
    engines: { piarium: "*" },
    storage: { schemaVersion },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode } },
    provides: { services: [{ id: serviceId, version: 1 }] },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: extensionId, version }), "utf8");
  await writeFile(join(directory, "host.cjs"), `
module.exports = {
  migrate(input) {
    ${migration === "throw" ? "throw new Error('v2 migration failed');" : `return { ...input.data, value: '${version}' };`}
  },
  activate(context) {
    context.services.provide({ id: '${serviceId}', version: 1 }, {
      read() { return context.storage.snapshot.document.data.value || '${version}'; },
      generation() { return '${version}'; },
      async write(value) { await context.storage.update({ value }); return value; },
      crash() { setTimeout(() => process.exit(17), 100); return 'crashing'; }
    });
  }
};
`, "utf8");
};

const writeRoutingProvider = async (directory: string, providerExtensionId: string, value: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: providerExtensionId,
    version: "1.0.0",
    engines: { piarium: "*" },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: serviceId, multiple: true, version: 1 }] },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: providerExtensionId, version: "1.0.0" }), "utf8");
  await writeFile(join(directory, "host.cjs"), `
module.exports = {
  activate(context) {
    context.services.provide({ id: '${serviceId}', multiple: true, version: 1 }, {
      read() { return '${value}'; }
    });
  }
};
`, "utf8");
};

test("brokered Host storage, migration rollback, services, and crash isolation preserve application state", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("piarium-broker-runtime-");
  const v1 = await temporaryDirectory("piarium-broker-v1-");
  const v2 = await temporaryDirectory("piarium-broker-v2-");
  await writeHostExtension(v1, "1.0.0", 1, "ok");
  await writeHostExtension(v2, "2.0.0", 2, "throw");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
  });
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Broker v1", kind: "local", specifier: v1 },
    });
    assert.equal(installed.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "1.0.0");
    assert.equal(await runtime.invokeService({ args: ["persisted"], method: "write", serviceId, version: 1 }), "persisted");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");

    const staged = await runtime.installOrStage({
      expectedRevision: installed.revision,
      source: { display: "Broker v2", kind: "local", specifier: v2 },
    });
    assert.equal(staged.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(staged.extensions[0]?.candidate?.resolvedVersion, "2.0.0");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");
    const candidateIntegrity = staged.extensions[0]?.candidate?.integrity;
    assert.ok(candidateIntegrity);
    await assert.rejects(
      runtime.discardCandidate({
        candidateIntegrity,
        expectedRevision: installed.revision,
        extensionId,
      }),
      /revision/i,
    );
    assert.equal((await runtime.state()).catalog.extensions[0]?.candidate?.integrity, candidateIntegrity);
    const discarded = await runtime.discardCandidate({
      candidateIntegrity,
      expectedRevision: staged.revision,
      extensionId,
    });
    assert.equal(discarded.extensions[0]?.candidate, undefined);
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");

    const failed = new Promise<void>((resolveFailed) => {
      const unsubscribe = runtime.subscribe(() => {
        void runtime.state().then((state) => {
          const status = state.catalog.extensions[0]?.actual.find((actual) => actual.realmKind === "host")?.status;
          if (status === "failed") { unsubscribe(); resolveFailed(); }
        });
      });
    });
    assert.equal(await runtime.invokeService({ args: [], method: "crash", serviceId, version: 1 }), "crashing");
    await failed;
    const afterCrash = await runtime.state();
    assert.equal(afterCrash.catalog.extensions[0]?.actual.find((actual) => actual.realmKind === "host")?.status, "failed");
    assert.equal(afterCrash.services.providers.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("trusted-native Host updates remain on the prior generation until application restart", async () => {
  const dataDir = await temporaryDirectory("piarium-native-runtime-");
  const v1 = await temporaryDirectory("piarium-native-v1-");
  const v2 = await temporaryDirectory("piarium-native-v2-");
  await writeHostExtension(v1, "1.0.0", 1, "ok", "native");
  await writeHostExtension(v2, "2.0.0", 1, "ok", "native");
  const brokerScript = fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url));
  const first = await ApplicationExtensionRuntime.create({ brokerScript, dataDir });
  const started = await first.start();
  const installed = await first.installOrStage({
    expectedRevision: started.catalog.revision,
    source: { display: "Native v1", kind: "local", specifier: v1 },
  });
  assert.equal(await first.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "1.0.0");
  const staged = await first.installOrStage({
    expectedRevision: installed.revision,
    source: { display: "Native v2", kind: "local", specifier: v2 },
  });
  assert.equal(staged.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal((await first.state()).catalog.extensions[0]?.actual.find((state) => state.realmKind === "host")?.status, "active");
  assert.equal(await first.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "1.0.0");
  const requested = await first.requestCandidateApplication({
    candidateIntegrity: staged.extensions[0]?.candidate?.integrity,
    expectedRevision: staged.revision,
    extensionId,
  });
  assert.equal(requested.extensions[0]?.candidate?.applyRequested, true);
  await assert.rejects(
    () => first.prepareCandidate(extensionId, staged.extensions[0]?.candidate?.integrity ?? ""),
    /requires an application-host restart/,
  );
  assert.equal((await first.state()).catalog.extensions[0]?.actual.find((state) => state.realmKind === "host")?.status, "restart-required");
  await first.stop();

  const restarted = await ApplicationExtensionRuntime.create({ brokerScript, dataDir });
  try {
    await restarted.start();
    const state = await restarted.state();
    assert.equal(state.catalog.extensions[0]?.selectedVersion, "2.0.0");
    assert.equal(await restarted.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "2.0.0");
  } finally {
    await restarted.stop();
  }
});

test("persistent routes select different real providers by session and isolate provider withdrawal", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("piarium-routing-runtime-");
  const alpha = await temporaryDirectory("piarium-routing-alpha-");
  const beta = await temporaryDirectory("piarium-routing-beta-");
  await writeRoutingProvider(alpha, "dev.example.alpha", "alpha");
  await writeRoutingProvider(beta, "dev.example.beta", "beta");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
  });
  try {
    const started = await runtime.start();
    const withAlpha = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Alpha", kind: "local", specifier: alpha },
    });
    await runtime.installOrStage({
      expectedRevision: withAlpha.revision,
      source: { display: "Beta", kind: "local", specifier: beta },
    });
    await assert.rejects(
      runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }),
      /explicit routing rule is required/,
    );
    const providers = (await runtime.state()).services.providers;
    const alphaProvider = providers.find((provider) => provider.extensionId === "dev.example.alpha");
    const betaProvider = providers.find((provider) => provider.extensionId === "dev.example.beta");
    assert.ok(alphaProvider);
    assert.ok(betaProvider);
    const alphaRoute = await runtime.upsertServiceRoutingRule({
      expectedRevision: 0,
      rule: {
        allowFallback: false,
        providerKey: alphaProvider.providerKey,
        scope: { sessionId: "session-alpha" },
        serviceId,
        version: 1,
      },
    });
    await runtime.upsertServiceRoutingRule({
      expectedRevision: alphaRoute.document.revision,
      rule: {
        allowFallback: false,
        providerKey: betaProvider.providerKey,
        scope: { sessionId: "session-beta" },
        serviceId,
        version: 1,
      },
    });
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-alpha" }, serviceId, version: 1,
    }), "alpha");
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-beta" }, serviceId, version: 1,
    }), "beta");

    await runtime.setEnabled("dev.example.alpha", false, (await runtime.state()).catalog.revision);
    await assert.rejects(
      runtime.invokeService({ args: [], method: "read", routing: { sessionId: "session-alpha" }, serviceId, version: 1 }),
      /Selected provider .* is unavailable/,
    );
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-beta" }, serviceId, version: 1,
    }), "beta");

    const beforeProfile = await runtime.state();
    await runtime.upsertWorkbenchProfile({
      expectedRevision: beforeProfile.workbench.document.revision,
      profile: { extensionIds: ["dev.example.beta"], id: "beta-only", label: "Beta only" },
    });
    const applied = await runtime.applyWorkbenchProfile({
      expectedCatalogRevision: (await runtime.state()).catalog.revision,
      profileId: "beta-only",
    });
    assert.equal(applied.extensions.find((entry) => entry.manifest.id === "dev.example.alpha")?.desired.enabled, false);
    assert.equal(applied.extensions.find((entry) => entry.manifest.id === "dev.example.beta")?.desired.enabled, true);

    const disabledBeta = await runtime.setEnabled(
      "dev.example.beta",
      false,
      (await runtime.state()).catalog.revision,
    );
    const removed = await runtime.removeExtension({
      expectedRevision: disabledBeta.revision,
      extensionId: "dev.example.beta",
    });
    assert.equal(removed.extensions.some((entry) => entry.manifest.id === "dev.example.beta"), false);
  } finally {
    await runtime.stop();
  }
});
