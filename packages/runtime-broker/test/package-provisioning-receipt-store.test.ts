import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createPackageProvisioningReceiptStore,
  packageProvisioningReceiptPath,
} from "../src/package-provisioning-receipt-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "piarium-package-receipt-"));
  roots.push(root);
  return root;
}

describe("package provisioning receipt store", () => {
  it("uses the missing-receipt defaults below the canonical agent directory", async () => {
    const agentDir = await createAgentDir();
    const canonicalAgentDir = await realpath(agentDir);
    const store = await createPackageProvisioningReceiptStore(agentDir);

    assert.equal(store.agentDir, canonicalAgentDir);
    assert.equal(store.filePath, packageProvisioningReceiptPath(canonicalAgentDir));
    assert.deepEqual(await store.read(), {
      autoInstallNew: true,
      entries: {},
      manifestRevisionSeen: 0,
      version: 1,
    });
    await assert.rejects(access(store.filePath));
  });

  it("fails creation when the agent directory cannot be canonicalized", async () => {
    const root = await createAgentDir();
    await assert.rejects(
      createPackageProvisioningReceiptStore(join(root, "missing-agent-dir")),
      /ENOENT|no such file/i,
    );
  });

  it("preserves unknown top-level fields, integrations, and known-entry fields", async () => {
    const agentDir = await createAgentDir();
    const store = await createPackageProvisioningReceiptStore(agentDir);
    await mkdir(dirname(store.filePath), { recursive: true });
    await writeFile(
      store.filePath,
      JSON.stringify({
        autoInstallNew: true,
        entries: {
          future: { futureEntry: true },
          mcp: {
            futureKnownField: { nested: true },
            intent: "eligible",
            lastObservedPresent: true,
            provenance: "adopted",
            source: "npm:pi-mcp-adapter",
          },
        },
        futureTopLevel: { retained: true },
        manifestRevisionSeen: 1,
        version: 1,
      }),
      "utf8",
    );

    await store.commitEntries([
      {
        id: "mcp",
        intent: "eligible",
        lastObservedPresent: true,
        provenance: "auto_managed",
        source: "https://github.com/Youzini-afk/pi-mcp-adapter.git",
      },
    ]);

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      entries: Record<
        string,
        {
          futureEntry?: boolean;
          futureKnownField?: { nested: boolean };
          provenance?: string;
          source?: string;
        }
      >;
      futureTopLevel?: { retained: boolean };
    };
    assert.deepEqual(persisted.futureTopLevel, { retained: true });
    assert.deepEqual(persisted.entries.future, { futureEntry: true });
    const persistedMcp = persisted.entries.mcp;
    assert.ok(persistedMcp);
    assert.deepEqual(persistedMcp.futureKnownField, { nested: true });
    assert.equal(persistedMcp.provenance, "auto_managed");
    assert.equal(
      persistedMcp.source,
      "https://github.com/Youzini-afk/pi-mcp-adapter.git",
    );
  });

  it("persists suppression before any later package removal", async () => {
    const agentDir = await createAgentDir();
    const first = await createPackageProvisioningReceiptStore(agentDir);
    await first.markSuppressed("mcp");

    const second = await createPackageProvisioningReceiptStore(agentDir);
    assert.deepEqual((await second.read()).entries.mcp, {
      intent: "suppressed",
      lastObservedPresent: false,
      provenance: "none",
    });
  });

  it("records the current manifest revision as the auto-install cutoff", async () => {
    const agentDir = await createAgentDir();
    const store = await createPackageProvisioningReceiptStore(agentDir);

    const disabled = await store.setAutoInstallNew(false);
    assert.equal(disabled.autoInstallNew, false);
    assert.equal(disabled.manifestRevisionSeen, 2);

    const enabled = await store.setAutoInstallNew(true);
    assert.equal(enabled.autoInstallNew, true);
    assert.equal(enabled.manifestRevisionSeen, 2);
  });

  it("fails closed for malformed and unsupported receipt documents", async () => {
    const agentDir = await createAgentDir();
    const store = await createPackageProvisioningReceiptStore(agentDir);
    await mkdir(dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, "{not-json", "utf8");

    await assert.rejects(store.read(), SyntaxError);
    await assert.rejects(store.markSuppressed("mcp"), SyntaxError);
    assert.equal(await readFile(store.filePath, "utf8"), "{not-json");

    await writeFile(
      store.filePath,
      JSON.stringify({ autoInstallNew: true, entries: {}, manifestRevisionSeen: 1, version: 2 }),
      "utf8",
    );
    await assert.rejects(store.read(), /Unsupported or malformed/);
    await assert.rejects(store.setAutoInstallNew(false), /Unsupported or malformed/);
    assert.equal(
      (JSON.parse(await readFile(store.filePath, "utf8")) as { version: number }).version,
      2,
    );
  });

  it("serializes awaited exclusive transactions across two store instances", async () => {
    const agentDir = await createAgentDir();
    const first = await createPackageProvisioningReceiptStore(agentDir);
    const second = await createPackageProvisioningReceiptStore(agentDir);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let firstEntered!: () => void;
    const firstHasEntered = new Promise<void>((resolvePromise) => {
      firstEntered = resolvePromise;
    });
    const order: string[] = [];

    const firstTransaction = first.transact(async () => {
      order.push("first-enter");
      firstEntered();
      await firstMayFinish;
      order.push("first-exit");
      return { result: undefined, write: false };
    });
    await firstHasEntered;

    const secondTransaction = second.transact(async () => {
      order.push("second-enter");
      return { result: undefined, write: false };
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(order, ["first-enter"]);

    releaseFirst();
    await Promise.all([firstTransaction, secondTransaction]);
    assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
    await assert.rejects(access(`${first.filePath}.lock`));
    assert.equal(dirname(first.filePath), join(await realpath(agentDir), "piarium"));
  });
});
