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

test("consumer-owned external services clean up failed, replaced, and disabled owner generations", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const cleanup: string[] = [];
  const external = (label: string) => ({
    descriptor: { id: "piarium.editor.monaco", version: 1 },
    dispose: () => { cleanup.push(label); },
    implementation: { getActiveView: () => ({ status: "absent" }) },
    providerId: "piarium.builtin.text",
  });
  await runtime.activate({
    externalServices: [external("first")],
    owner: owner("dev.example.alpha", 1, 1),
    requirements: [{ id: "piarium.editor.monaco", optional: true, version: 1 }],
  }, (context) => {
    assert.ok(context.useService("piarium.editor.monaco", 1));
    context.contribute(page("dev.example.alpha.settings"), { version: 1 });
  });
  await assert.rejects(() => runtime.activate({
    externalServices: [external("failed")],
    owner: owner("dev.example.alpha", 2, 2),
    requirements: [{ id: "piarium.editor.monaco", optional: true, version: 1 }],
  }, () => { throw new Error("failed update"); }), /failed update/);
  assert.deepEqual(cleanup, ["failed"]);
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: number }).version, 1);

  await runtime.activate({
    externalServices: [external("second")],
    owner: owner("dev.example.alpha", 3, 3),
    requirements: [{ id: "piarium.editor.monaco", optional: true, version: 1 }],
  }, (context) => context.contribute(page("dev.example.alpha.settings"), { version: 3 }));
  assert.deepEqual(cleanup, ["failed", "first"]);
  await runtime.deactivate(owner("dev.example.alpha", 4, 4));
  assert.deepEqual(cleanup, ["failed", "first", "second"]);
});

test("a missing optional external service does not block activation", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({
    owner: owner("dev.example.alpha", 1, 1),
    requirements: [{ id: "piarium.editor.monaco", optional: true, version: 1 }],
  }, (context) => {
    assert.equal(context.useService("piarium.editor.monaco", 1), undefined);
    context.contribute(page("dev.example.alpha.settings"), { active: true });
  });
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
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

test("a newer disable queued during an external commit runs after the committed generation", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  let releaseCommit!: () => void;
  let commitStarted!: () => void;
  const committing = new Promise<void>((resolve) => { commitStarted = resolve; });
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const activating = runtime.activateWithCommit(
    { owner: owner("dev.example.alpha", 1, 1) },
    (context) => context.contribute(page("dev.example.alpha.settings"), {}),
    async () => {
      commitStarted();
      await commitGate;
    },
  );
  await committing;
  const disabling = runtime.deactivate(owner("dev.example.alpha", 2, 2));
  releaseCommit();
  await activating;
  await disabling;
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "inactive");
});

test("replacement selection and ordering update without a document refresh", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.alpha.shell", 10),
      data: { fallback: true },
      replacement: { target: "workbench.shell" },
    }, "alpha");
    context.contribute(page("dev.example.alpha.last", 20), "last");
  });
  await runtime.activate({ owner: owner("dev.example.beta", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.beta.shell", 0),
      replacement: { target: "workbench.shell" },
    }, "beta");
  });
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["alpha", "last"]);
  runtime.setReplacementSelection("workbench.shell", "dev.example.beta.shell");
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["beta", "last"]);
  await runtime.deactivate(owner("dev.example.beta", 2, 2));
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["alpha", "last"]);
});

test("a second replacement fallback is rejected before it becomes visible", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.alpha.shell"),
      data: { fallback: true },
      replacement: { target: "workbench.shell" },
    }, "alpha");
  });
  await assert.rejects(runtime.activate({ owner: owner("dev.example.beta", 1, 1) }, (context) => {
    context.contribute({
      ...page("dev.example.beta.shell"),
      data: { fallback: true },
      replacement: { target: "workbench.shell" },
    }, "beta");
  }), /more than one fallback/);
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["alpha"]);
  assert.equal(runtime.getSnapshot().actual.find((item) => item.extensionId === "dev.example.beta")?.status, "failed");
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

test("selected service binding resolves exactly the configured provider", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.shared", multiple: true, version: 1 }, "alpha");
  });
  await runtime.activate({ owner: owner("dev.example.beta", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.shared", multiple: true, version: 1 }, "beta");
  });
  runtime.setServiceSelection("dev.example.shared", 1, "dev.example.beta");
  await runtime.activate({
    owner: owner("dev.example.consumer", 1, 1),
    requirements: [{ binding: "selected", id: "dev.example.shared", version: 1 }],
  }, (context) => {
    assert.equal(context.useService("dev.example.shared", 1), "beta");
    assert.deepEqual(context.useServices("dev.example.shared", 1), ["beta"]);
  });
});

test("selected external binding rejects an absent selection and exposes only the chosen provider", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const externalServices = ["host-a", "host-b"].map((providerId) => ({
    descriptor: { id: "dev.example.shared", multiple: true, version: 1 },
    implementation: providerId,
    providerId,
  }));
  await assert.rejects(() => runtime.activate({
    externalServices,
    owner: owner("dev.example.consumer", 1, 1),
    requirements: [{ binding: "selected", id: "dev.example.shared", version: 1 }],
  }, () => undefined), /Selected Surface service provider is unavailable/);
  await runtime.activate({
    externalServices,
    owner: owner("dev.example.consumer", 2, 2),
    requirements: [{ binding: "selected", id: "dev.example.shared", version: 1 }],
    serviceSelections: { "dev.example.shared@1": "host-b" },
  }, (context) => {
    assert.equal(context.useService("dev.example.shared", 1), "host-b");
    assert.deepEqual(context.useServices("dev.example.shared", 1), ["host-b"]);
  });
});

test("single and all service bindings use the same complete provider set", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.shared", multiple: true, version: 1 }, "local");
  });
  const external = {
    descriptor: { id: "dev.example.shared", multiple: true, version: 1 },
    implementation: "external",
    providerId: "host-provider",
  };
  await assert.rejects(() => runtime.activate({
    externalServices: [external],
    owner: owner("dev.example.single-consumer", 1, 1),
    requirements: [{ binding: "single", id: "dev.example.shared", version: 1 }],
  }, () => undefined), /ambiguous/);
  await runtime.activate({
    externalServices: [external],
    owner: owner("dev.example.all-consumer", 1, 1),
    requirements: [{ binding: "all", id: "dev.example.shared", version: 1 }],
  }, (context) => {
    assert.deepEqual(context.useServices("dev.example.shared", 1), ["local", "external"]);
    assert.equal(context.useService("dev.example.shared", 1), undefined);
  });
  await assert.rejects(() => runtime.activate({
    externalServices: [external],
    owner: owner("dev.example.version-consumer", 1, 1),
    requirements: [{ binding: "single", id: "dev.example.shared", version: 2 }],
  }, () => undefined), /unavailable/);
});

test("required-service withdrawal tears down dependents before their provider", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const cleanup: string[] = [];
  const provider = await runtime.activate({ owner: owner("dev.example.provider", 1, 1) }, (context) => {
    context.provide({ id: "dev.example.required", version: 1 }, { read: () => "ok" });
    context.contribute(page("dev.example.provider.page"), "provider");
    context.onDispose(() => { cleanup.push("provider"); });
  });
  await runtime.activate({
    owner: owner("dev.example.consumer", 1, 1),
    requirements: [{ id: "dev.example.required", version: 1 }],
  }, (context) => {
    assert.equal(context.useService<{ read(): string }>("dev.example.required", 1)?.read(), "ok");
    context.contribute(page("dev.example.consumer.page"), "consumer");
    context.onDispose(() => { cleanup.push("consumer"); });
  });
  await provider.deactivate(2, 2);
  assert.deepEqual(cleanup, ["consumer", "provider"]);
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(runtime.getSnapshot().actual.find((state) => state.extensionId === "dev.example.consumer")?.diagnostics[0]?.code, "required_service_withdrawn");
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

test("unsupported contract version contributions are diagnosed without entering the registry", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute(page("dev.example.alpha.v1", 0), "v1");
    context.contribute({
      id: "dev.example.alpha.v99",
      kind: "settings-page",
      contractVersion: 99,
      supports: ["web"],
      placement: { order: 10 },
      data: {},
    }, "v99");
  });
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.contributions.length, 1);
  assert.deepEqual(snapshot.visibleContributions.map((item) => item.implementation), ["v1"]);
  assert.equal(snapshot.actual[0]?.diagnostics[0]?.code, "unsupported-contract-version");
  assert.match(snapshot.actual[0]?.diagnostics[0]?.message ?? "", /settings-page contract version 99/);
});

test("same extension can have compatible and incompatible contributions simultaneously", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute(page("dev.example.alpha.view", 0), "view-impl");
    context.contribute({
      id: "dev.example.alpha.future",
      kind: "view",
      contractVersion: 2,
      supports: ["web"],
      data: {},
    }, "future-impl");
  });
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.contributions.length, 1);
  assert.equal(snapshot.visibleContributions.length, 1);
  assert.equal(snapshot.visibleContributions[0]?.descriptor.id, "dev.example.alpha.view");
  assert.equal(snapshot.actual[0]?.diagnostics[0]?.code, "unsupported-contract-version");
});

test("when expression hides contributions when context is false and shows when true", async () => {
  const contextKeys = new Map<string, string | number | boolean>();
  const listeners = new Set<() => void>();
  const contextProvider = {
    getContext: () => contextKeys,
    subscribe: (_keys: readonly string[], listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    createWriter: () => ({
      commit: () => undefined,
      dispose: () => undefined,
      writer: { delete: () => false, set: () => false },
    }),
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web", contextProvider });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute({
      id: "dev.example.alpha.conditional",
      kind: "view",
      contractVersion: 1,
      supports: ["web"],
      data: {},
      when: { op: "defined", key: "editorIsOpen" },
    }, "conditional");
    context.contribute(page("dev.example.alpha.always", 0), "always");
  });
  // When editorIsOpen is not set, conditional is hidden
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["always"]);
  // When editorIsOpen is true, conditional is visible
  contextKeys.set("editorIsOpen", true);
  // The runtime subscribes to context key changes and re-publishes automatically
  for (const listener of listeners) listener();
  assert.deepEqual(
    runtime.getSnapshot().visibleContributions.map((item) => item.implementation).sort(),
    ["always", "conditional"],
  );
});

test("when expression false preserves replacement selection and falls back", async () => {
  const contextKeys = new Map<string, string | number | boolean>();
  const contextProvider = {
    getContext: () => contextKeys,
    subscribe: (_keys: readonly string[], listener: () => void) => {
      return () => { listener; };
    },
    createWriter: () => ({
      commit: () => undefined,
      dispose: () => undefined,
      writer: { delete: () => false, set: () => false },
    }),
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web", contextProvider });
  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.contribute({
      id: "dev.example.alpha.primary",
      kind: "view",
      contractVersion: 1,
      supports: ["web"],
      data: { fallback: true },
      replacement: { target: "workbench.sidebar" },
    }, "primary");
    context.contribute({
      id: "dev.example.alpha.conditional",
      kind: "view",
      contractVersion: 1,
      supports: ["web"],
      data: {},
      replacement: { target: "workbench.sidebar" },
      when: { op: "defined", key: "editorIsOpen" },
    }, "conditional");
  });
  // Select the conditional replacement
  runtime.setReplacementSelection("workbench.sidebar", "dev.example.alpha.conditional");
  // When editorIsOpen is not set, conditional is hidden; fallback should show
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["primary"]);
  // Selection is preserved even though conditional is hidden
  assert.equal(runtime.getSnapshot().replacementSelections["workbench.sidebar"], "dev.example.alpha.conditional");
});

test("owner-scoped context writes stay staged until the activation transaction commits", async () => {
  const contextKeys = new Map<string, string | number | boolean>();
  const listeners = new Set<() => void>();
  const createWriter = (o: { extensionId: string }) => {
    const staged = new Map<string, string | number | boolean>();
    let committed = false;
    let disposed = false;
    return {
      writer: {
        set: (key: string, value: string | number | boolean): boolean => {
          if (disposed) return false;
          staged.set(`${o.extensionId}.${key}`, value);
          return true;
        },
        delete: (key: string): boolean => {
          if (disposed) return false;
          return staged.delete(`${o.extensionId}.${key}`);
        },
      },
      commit: () => {
        committed = true;
        for (const [key, value] of staged) contextKeys.set(key, value);
        for (const listener of listeners) listener();
      },
      dispose: () => {
        disposed = true;
        if (committed) for (const key of staged.keys()) contextKeys.delete(key);
        for (const listener of listeners) listener();
      },
    };
  };
  const contextProvider = {
    getContext: () => contextKeys,
    subscribe: (_keys: readonly string[], listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    createWriter,
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web", contextProvider });

  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const activating = runtime.activateWithCommit({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    assert.equal(context.context.set("myKey", "hello"), true);
  }, () => commitGate);
  await Promise.resolve();
  assert.equal(contextKeys.has("dev.example.alpha.myKey"), false);
  releaseCommit();
  await activating;
  assert.equal(contextKeys.get("dev.example.alpha.myKey"), "hello");

  // Deactivate — should clean up the owner's keys
  await runtime.deactivate({ ...owner("dev.example.alpha", 1, 1), desiredRevision: 2, generation: 2 });
  assert.equal(contextKeys.has("dev.example.alpha.myKey"), false);
});

test("failed candidate context writes never replace the active context layer", async () => {
  const contextKeys = new Map<string, string | number | boolean>();
  let activeWriter: { set(key: string, value: string | number | boolean): boolean } | undefined;
  const contextProvider = {
    getContext: () => contextKeys,
    subscribe: (_keys: readonly string[], listener: () => void) => {
      return () => { listener; };
    },
    createWriter: (o: { extensionId: string }) => {
      const prefix = `${o.extensionId}.`;
      const staged = new Map<string, string | number | boolean>();
      let committed = false;
      let disposed = false;
      const writer = {
        set: (key: string, value: string | number | boolean): boolean => {
          if (disposed) return false;
          staged.set(`${prefix}${key}`, value);
          return true;
        },
        delete: (key: string): boolean => !disposed && staged.delete(`${prefix}${key}`),
      };
      return {
        writer,
        commit: () => {
          committed = true;
          activeWriter = writer;
          for (const [key, value] of staged) contextKeys.set(key, value);
        },
        dispose: () => {
          disposed = true;
          if (committed && activeWriter === writer) for (const key of staged.keys()) contextKeys.delete(key);
        },
      };
    },
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web", contextProvider });

  await runtime.activate({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    context.context.set("myKey", "v1");
  });
  assert.equal(contextKeys.get("dev.example.alpha.myKey"), "v1");
  await assert.rejects(() => runtime.activate({ owner: owner("dev.example.alpha", 2, 2) }, (context) => {
    context.context.set("myKey", "v2");
    throw new Error("candidate failed");
  }), /candidate failed/);
  assert.equal(contextKeys.get("dev.example.alpha.myKey"), "v1");
});

test("a context publication failure after persistent commit does not roll back the committed owner", async () => {
  let contextDisposed = false;
  const runtime = new SurfaceExtensionRuntime({
    surface: "web",
    contextProvider: {
      createWriter: () => ({
        commit: () => { throw new Error("context store unavailable"); },
        dispose: () => { contextDisposed = true; },
        writer: { delete: () => false, set: () => !contextDisposed },
      }),
      getContext: () => new Map(),
      subscribe: () => () => undefined,
    },
  });
  let persistentCommit = false;
  let retainedWriter: import("../src/index.js").SurfaceContextWriter | undefined;
  await runtime.activateWithCommit({ owner: owner("dev.example.alpha", 1, 1) }, (context) => {
    retainedWriter = context.context;
    context.context.set("ready", true);
    context.contribute(page("dev.example.alpha.page"), "committed");
  }, () => { persistentCommit = true; });
  assert.equal(persistentCommit, true);
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.implementation), ["committed"]);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "active");
  assert.equal(runtime.getSnapshot().actual[0]?.diagnostics[0]?.code, "context_commit_failed");
  assert.equal(retainedWriter?.set("late", true), false);
});
