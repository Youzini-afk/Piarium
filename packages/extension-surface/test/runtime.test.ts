import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceActivationStaleError, SurfaceExtensionRuntime } from "../src/index.js";

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";
const owner = (extensionId: string, desiredRevision: number, generation: number) => ({
  extensionId,
  extensionVersion: "1.0.0",
  entrypointId: "main",
  realmId: "window-1",
  hostId,
  desiredRevision,
  generation,
});

const page = (id: string, order = 0) => ({
  id,
  kind: "settings-page" as const,
  contractVersion: 1,
  supports: ["web" as const],
  placement: { order },
  data: {},
});

test("stages contributions and services until one atomic activation commit", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const activating = runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, async (context) => {
    context.contribute(page("dev.example.alpha.settings"), { render: "alpha" });
    context.provide({ id: "dev.example.alpha-service", version: 1 }, { call: () => "ok" });
    await gate;
  });

  await Promise.resolve();
  assert.equal(runtime.getSnapshot().contributions.length, 0);
  assert.equal(runtime.getSnapshot().services.length, 0);
  release();
  await activating;
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.descriptor.id), ["dev.example.alpha.settings"]);
  assert.equal(runtime.getService<{ call(): string }>("dev.example.alpha-service", 1)?.call(), "ok");
});

test("failed candidate activation preserves the previous active generation", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const cleanup: string[] = [];
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute(page("dev.example.alpha.settings"), { version: 1 });
    context.onDispose(() => { cleanup.push("old"); });
  });

  await assert.rejects(
    () => runtime.activate({ owner: owner("dev.example.alpha", 2, 2) }, (context) => {
      context.contribute(page("dev.example.alpha.settings"), { version: 2 });
      context.onDispose(() => { cleanup.push("candidate"); });
      throw new Error("candidate failed");
    }),
    /candidate failed/,
  );
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: number }).version, 1);
  assert.deepEqual(cleanup, ["candidate"]);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "active");
  assert.equal(runtime.getSnapshot().actual[0]?.diagnostics[0]?.code, "candidate_activation_failed");
});

test("a failed persistent candidate commit preserves every previous entrypoint generation", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const secondary = { ...owner("dev.example.alpha", 1, 1), entrypointId: "secondary" };
  await runtime.activateBatchWithCommit([
    {
      options: { owner: owner("dev.example.alpha", 1, 1) },
      activation: (context) => context.contribute(page("dev.example.alpha.main"), { version: 1 }),
    },
    {
      options: { owner: secondary },
      activation: (context) => context.contribute(page("dev.example.alpha.secondary"), { version: 1 }),
    },
  ], () => undefined);

  await assert.rejects(() => runtime.activateBatchWithCommit([
    {
      options: { owner: owner("dev.example.alpha", 1, 2) },
      activation: (context) => context.contribute(page("dev.example.alpha.main"), { version: 2 }),
    },
    {
      options: { owner: { ...secondary, generation: 2 } },
      activation: (context) => context.contribute(page("dev.example.alpha.secondary"), { version: 2 }),
    },
  ], () => { throw new Error("catalog revision changed"); }), /catalog revision changed/);

  assert.deepEqual(
    runtime.getSnapshot().visibleContributions.map((item) => (item.implementation as { version: number }).version),
    [1, 1],
  );
  assert.equal(runtime.getSnapshot().actual.every((state) => state.status === "active"), true);
});

test("a newer disable supersedes in-flight activation before it can publish", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const activating = runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, async (context) => {
    context.contribute(page("dev.example.alpha.settings"), {});
    await gate;
  });
  await Promise.resolve();
  const disabling = runtime.deactivate(owner("dev.example.alpha", 2, 2));
  release();
  await assert.rejects(() => activating, SurfaceActivationStaleError);
  await disabling;
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "inactive");
});

test("replacement selection and ordering update without a document refresh", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.alpha.shell", 10),
      replacement: { target: "workbench.shell", priority: 1 },
    }, "alpha");
    context.contribute(page("dev.example.alpha.last", 20), "last");
  });
  await runtime.activate({ owner: owner("dev.example.beta", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.beta.shell", 0),
      replacement: { target: "workbench.shell", priority: 2 },
    }, "beta");
  });
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["beta", "last"]);
  runtime.setReplacementSelection("workbench.shell", "dev.example.alpha.shell");
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["alpha", "last"]);
});

test("deactivation withdraws contributions before asynchronous cleanup completes", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  let release!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
  const handle = await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute(page("dev.example.alpha.settings"), {});
    context.onDispose(() => cleanupGate);
  });
  const deactivating = handle.deactivate(2, 2);
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  release();
  await deactivating;
  assert.equal(runtime.getSnapshot().actual[0]?.status, "inactive");
});

test("multiple service providers require an explicit single-provider selection", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.shared", version: 1, multiple: true }, "alpha");
  });
  await runtime.activate({ owner: owner("dev.example.beta", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.shared", version: 1, multiple: true }, "beta");
  });

  assert.equal(runtime.getService("dev.example.shared", 1), undefined);
  assert.deepEqual(runtime.getServices("dev.example.shared", 1), ["alpha", "beta"]);
  runtime.setServiceSelection("dev.example.shared", 1, "dev.example.beta");
  assert.equal(runtime.getService("dev.example.shared", 1), "beta");
});

test("layout references hide and reorder live contributions while preserving missing IDs", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute(page("dev.example.alpha.first", 0), "first");
    context.contribute(page("dev.example.alpha.second", 10), "second");
  });

  runtime.setLayoutReferences([
    { contributionId: "dev.example.alpha.first", visible: false },
    { contributionId: "dev.example.alpha.second", order: -10, region: "settings", size: 320 },
    { contributionId: "dev.example.missing", order: 5 },
  ]);
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["second"]);
  assert.deepEqual(
    runtime.getSnapshot().layoutReferences.map((reference) => reference.contributionId),
    ["dev.example.alpha.first", "dev.example.alpha.second", "dev.example.missing"],
  );

  runtime.setLayoutReferences([
    { contributionId: "dev.example.alpha.second", order: -10 },
    { contributionId: "dev.example.alpha.first", order: 10 },
    { contributionId: "dev.example.missing", order: 5 },
  ]);
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["second", "first"]);
});
