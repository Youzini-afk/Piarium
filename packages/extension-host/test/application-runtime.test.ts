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
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: extensionId,
    version,
    engines: { piarium: "*" },
    storage: { schemaVersion },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
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
      async write(value) { await context.storage.update({ value }); return value; },
      crash() { setTimeout(() => process.exit(17), 10); return 'crashing'; }
    });
  }
};
`, "utf8");
};

test("brokered Host storage, migration rollback, services, and crash isolation preserve application state", { timeout: 10_000 }, async () => {
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
    await runtime.start();
    const installed = await runtime.installOrStage({
    expectedRevision: 0,
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
