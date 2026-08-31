import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import semver from "semver";
import * as Ajv2020Module from "ajv/dist/2020.js";
import {
  PiariumExtensionContractError,
  assertPiariumExtensionManifestCompatibility,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogDocument,
  parsePiariumExtensionCandidateCapabilityReviewRequest,
  parsePiariumExtensionCapabilityReviewRequest,
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionManagedEntrypointRequest,
  parsePiariumExtensionLocalSourceReloadRequest,
  parsePiariumExtensionLocalSourceReloadResult,
  parsePiariumExtensionManifest,
  parsePiariumExtensionRemoveRequest,
  parsePiariumExtensionStorageOpenRequest,
} from "../src/index.js";

const manifest = () => ({
  schemaVersion: 1,
  id: "dev.example.memory-workbench",
  version: "1.2.0",
  engines: { piarium: ">=0.2.0 <0.3.0" },
  entrypoints: {
    host: { file: "dist/host.mjs", mode: "brokered" },
    surfaces: [{ id: "main", file: "dist/surface.mjs", mode: "managed", supports: ["web", "desktop"] }],
  },
  requires: { services: [{ id: "piarium.sessions", version: 1 }] },
  provides: { services: [{ id: "dev.example.memory", version: 1, multiple: true }] },
  capabilities: { host: ["extension-storage"], surface: ["commands"] },
  contributions: [{
    id: "dev.example.memory-workbench.settings",
    kind: "settings-page",
    contractVersion: 1,
    entrypoint: "main",
    supports: ["web", "desktop"],
    requiresCapabilities: ["commands"],
    data: { route: "memory" },
  }],
  integrates: { piPackages: ["pi-observational-memory"] },
});

test("validates content-addressed managed entrypoint requests and asset bytes", () => {
  const integrity = `sha256-${"a".repeat(64)}`;
  assert.deepEqual(parsePiariumExtensionManagedEntrypointRequest({
    entrypointId: "main",
    extensionId: "dev.example.memory-workbench",
    integrity,
    slot: "candidate",
  }), {
    entrypointId: "main",
    extensionId: "dev.example.memory-workbench",
    integrity,
    slot: "candidate",
  });
  assert.equal(parsePiariumExtensionAssetPayload({
    artifactIntegrity: integrity,
    bytesBase64: "aGVsbG8=",
    contentType: "text/plain",
    integrity,
    path: "package/hello.txt",
  }).path, "package/hello.txt");
  assert.throws(() => parsePiariumExtensionManagedEntrypointRequest({
    entrypointId: "main",
    extensionId: "../escape",
    integrity: "sha256-not-a-digest",
    slot: "selected",
  }), PiariumExtensionContractError);
});

test("validates explicit candidate capability decisions", () => {
  const request = parsePiariumExtensionCandidateCapabilityReviewRequest({
    candidateIntegrity: `sha256-${"b".repeat(64)}`,
    decisions: [{ capability: "workspace.files", granted: false, realm: "host" }],
    expectedRevision: 4,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(request.decisions[0]?.granted, false);
  assert.throws(() => parsePiariumExtensionCandidateCapabilityReviewRequest({
    ...request,
    decisions: [request.decisions[0], request.decisions[0]],
  }), PiariumExtensionContractError);
});

test("validates explicit selected-version capability decisions", () => {
  const request = parsePiariumExtensionCapabilityReviewRequest({
    decisions: [{ capability: "commands", granted: true, realm: "surface" }],
    expectedRevision: 2,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(request.decisions[0]?.granted, true);
  assert.throws(() => parsePiariumExtensionCapabilityReviewRequest({
    ...request,
    decisions: [request.decisions[0], request.decisions[0]],
  }), PiariumExtensionContractError);
});

test("validates local source reload requests and results without a source specifier", () => {
  const request = parsePiariumExtensionLocalSourceReloadRequest({
    expectedRevision: 4,
    extensionId: "dev.example.memory-workbench",
  });
  assert.deepEqual(request, { expectedRevision: 4, extensionId: "dev.example.memory-workbench" });
  assert.equal("source" in request, false);
  const snapshot = {
    schemaVersion: 1,
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    revision: 4,
    loadedAt: "2026-08-14T00:00:00.000Z",
    authoritative: true,
    storageState: "ready",
    diagnostics: [],
    extensions: [],
  };
  const staged = parsePiariumExtensionLocalSourceReloadResult({
    candidateIntegrity: `sha256-${"c".repeat(64)}`,
    outcome: "staged",
    snapshot,
  });
  assert.equal(staged.outcome, "staged");
  assert.throws(() => parsePiariumExtensionLocalSourceReloadResult({
    outcome: "staged",
    snapshot,
  }), PiariumExtensionContractError);
});

test("defaults legacy remove requests to retained data and validates explicit deletion", () => {
  assert.deepEqual(parsePiariumExtensionRemoveRequest({
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }), {
    deleteData: false,
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(parsePiariumExtensionRemoveRequest({
    deleteData: true,
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }).deleteData, true);
  assert.throws(() => parsePiariumExtensionRemoveRequest({
    deleteData: "yes",
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }), PiariumExtensionContractError);
});

test("validates public storage addresses without accepting a forged extension namespace", () => {
  assert.deepEqual(parsePiariumExtensionStorageOpenRequest({
    key: "preferences",
    schemaVersion: 2,
    scope: "workspace",
  }), { key: "preferences", schemaVersion: 2, scope: "workspace" });
  assert.throws(() => parsePiariumExtensionStorageOpenRequest({
    extensionId: "dev.example.someone-else",
    key: "preferences",
    scope: "workspace",
  }), (error) => error instanceof PiariumExtensionContractError
    && error.issues.some((issue) => issue.includes("assigned by the Piarium Host")));
});

test("normalizes a complete Piarium extension manifest", () => {
  const parsed = parsePiariumExtensionManifest(manifest());
  assert.equal(parsed.id, "dev.example.memory-workbench");
  assert.equal(parsed.entrypoints?.surfaces?.[0]?.mode, "managed");
  assert.equal(parsed.contributions?.[0]?.data.route, "memory");
});

test("rejects invalid Piarium SemVer ranges and checks compatibility at range boundaries", () => {
  assert.throws(
    () => parsePiariumExtensionManifest({ ...manifest(), engines: { piarium: "definitely not semver" } }),
    (error) => error instanceof PiariumExtensionContractError
      && error.issues.includes("engines.piarium must be a valid SemVer range"),
  );
  const parsed = parsePiariumExtensionManifest({
    ...manifest(),
    engines: { piarium: ">=1.2.3 <2.0.0" },
  });
  assert.doesNotThrow(() => assertPiariumExtensionManifestCompatibility(parsed, "1.2.3"));
  assert.doesNotThrow(() => assertPiariumExtensionManifestCompatibility(parsed, "1.9.9"));
  assert.throws(
    () => assertPiariumExtensionManifestCompatibility(parsed, "2.0.0"),
    /requires Piarium >=1\.2\.3 <2\.0\.0; current version is 2\.0\.0/,
  );
});

test("rejects traversal, duplicate IDs, and unsupported surfaces together", () => {
  const candidate = manifest();
  candidate.entrypoints.surfaces = [
    { id: "main", file: "../surface.mjs", mode: "managed", supports: ["browser"] },
    { id: "main", file: "dist/other.mjs", mode: "managed", supports: ["web"] },
  ];
  assert.throws(
    () => parsePiariumExtensionManifest(candidate),
    (error) => error instanceof PiariumExtensionContractError
      && error.issues.some((issue) => issue.includes("parent traversal"))
      && error.issues.some((issue) => issue.includes("duplicate entrypoint"))
      && error.issues.some((issue) => issue.includes("unsupported surface")),
  );
});

test("distinguishes a valid empty catalog from malformed persisted content", () => {
  const empty = parsePiariumExtensionCatalogDocument({
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-08-14T00:00:00.000Z",
    extensions: {},
  });
  assert.deepEqual(empty.extensions, {});
  assert.throws(
    () => parsePiariumExtensionCatalogDocument({ schemaVersion: 1, revision: 0, extensions: [] }),
    PiariumExtensionContractError,
  );
});

test("validates public catalog snapshots before a surface accepts them", () => {
  const ready = parsePiariumExtensionCatalogAvailability({
    supported: true,
    status: "ready",
    snapshot: {
      schemaVersion: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      revision: 0,
      loadedAt: "2026-08-14T00:00:00.000Z",
      authoritative: true,
      storageState: "missing",
      diagnostics: [],
      extensions: [],
    },
  });
  assert.equal(ready.supported, true);
  assert.throws(() => parsePiariumExtensionCatalogAvailability({
    supported: true,
    status: "ready",
    snapshot: { schemaVersion: 1, extensions: [] },
  }), PiariumExtensionContractError);
});

test("rejects unknown contribution kinds instead of coercing them", () => {
  const source = manifest();
  source.contributions = [{ ...source.contributions[0]!, kind: "unknown-kind" }];
  assert.throws(() => parsePiariumExtensionManifest(source), (error: unknown) => (
    error instanceof PiariumExtensionContractError
    && error.issues.some((issue) => issue.includes("kind is unsupported"))
  ));
});

test("accepts view, editor, and transition scene contribution kinds", () => {
  const source = manifest();
  source.contributions = [
    { ...source.contributions[0]!, id: "dev.example.memory-workbench.panel-view", kind: "view" },
    {
      ...source.contributions[0]!,
      id: "dev.example.memory-workbench.markdown",
      kind: "editor",
      data: Object.assign({ route: "memory" }, { languageIds: ["markdown"], priority: 40 }),
    },
    Object.assign({
      ...source.contributions[0]!,
      id: "dev.example.memory-workbench.transition",
      kind: "transition-scene",
      data: Object.assign({ route: "memory" }, {
        contract: "piarium-transition-scene/v1",
        durations: {
          "workbench-profile": {
            covering: { quick: 800, reduced: 0, standard: 1_600 },
            revealing: { quick: 800, reduced: 0, standard: 1_600 },
          },
        },
        scenes: ["workbench-profile"],
      }),
    }, { replacement: { target: "workbench.transition" } }),
  ];
  const parsed = parsePiariumExtensionManifest(source);
  assert.deepEqual(parsed.contributions?.map((item) => item.kind), ["view", "editor", "transition-scene"]);
});

test("rejects transition scenes without a complete timing contract", () => {
  const source = manifest();
  source.contributions = [Object.assign({
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.transition",
    kind: "transition-scene",
    data: Object.assign({ route: "memory" }, {
      contract: "piarium-transition-scene/v1",
      durations: { "workbench-profile": { covering: { quick: 1 } } },
      scenes: ["workbench-profile"],
    }),
  }, { replacement: { target: "workbench.transition" } })];
  assert.throws(() => parsePiariumExtensionManifest(source), (error: unknown) => (
    error instanceof PiariumExtensionContractError
    && error.issues.some((issue) => issue.includes("data.durations.workbench-profile.covering.reduced"))
    && error.issues.some((issue) => issue.includes("data.durations.workbench-profile.revealing"))
  ));
});

test("requires transition scenes to use the public workbench transition target", () => {
  const source = manifest();
  source.contributions = [Object.assign({
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.transition",
    kind: "transition-scene",
    data: Object.assign({ route: "memory" }, {
      contract: "piarium-transition-scene/v1",
      durations: {
        "workbench-profile": {
          covering: { quick: 1, reduced: 0, standard: 1 },
          revealing: { quick: 1, reduced: 0, standard: 1 },
        },
      },
      scenes: ["workbench-profile"],
    }),
  }, { replacement: { target: "dev.example.private-transition" } })];
  assert.throws(() => parsePiariumExtensionManifest(source), (error: unknown) => (
    error instanceof PiariumExtensionContractError
    && error.issues.some((issue) => issue.includes("replacement.target must be workbench.transition"))
  ));
});

test("rejects editor contributions without a resource selector", () => {
  const source = manifest();
  source.contributions = [{
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.editor",
    kind: "editor",
    data: { route: "memory" },
  }];
  assert.throws(() => parsePiariumExtensionManifest(source), (error: unknown) => (
    error instanceof PiariumExtensionContractError
    && error.issues.some((issue) => issue.includes("languageIds or filenames"))
  ));
});

test("published JSON Schema and runtime parser agree on shell seam fixtures", async () => {
  const schemaPath = fileURLToPath(new URL("../schema/piarium.extension.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  type AjvInstance = { compile(schemaValue: unknown): (value: unknown) => boolean };
  type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;
  const Ajv2020 = ((Ajv2020Module as unknown as { default?: AjvConstructor }).default
    ?? Ajv2020Module as unknown as AjvConstructor);
  const validateSchema = new Ajv2020({
    allErrors: true,
    strict: false,
    formats: { "semver-range": (input: string) => semver.validRange(input) !== null },
  }).compile(schema);
  type ShellSeams = { replacementTargets: string[]; slots: string[] };
  type MutableShellManifest = Record<string, unknown> & {
    contributions: [{
      contractVersion: number;
      data: { contract: string; seams: Record<string, ShellSeams> };
      entrypoint: string;
      id: string;
      kind: string;
      replacement: { target: string };
      supports: string[];
    }];
  };
  const shellManifest = (): MutableShellManifest => ({
    ...manifest(),
    contributions: [{
      contractVersion: 1,
      data: {
        contract: "piarium-workbench-shell/v1",
        seams: { web: { replacementTargets: ["workbench.editor"], slots: ["workbench.editor.actions"] } },
      },
      entrypoint: "main",
      id: "dev.example.memory-workbench.shell",
      kind: "shell",
      replacement: { target: "workbench.shell" },
      supports: ["web"],
    }],
  } as unknown as MutableShellManifest);
  const fixtures: Array<{ name: string; value: ReturnType<typeof shellManifest>; valid: boolean }> = [
    { name: "valid", value: shellManifest(), valid: true },
    {
      name: "missing supported surface",
      value: (() => {
        const value = shellManifest();
        value.contributions[0]!.data.seams = {};
        return value;
      })(),
      valid: false,
    },
    {
      name: "undeclared supported surface",
      value: (() => {
        const value = shellManifest();
        Object.assign(value.contributions[0]!.data.seams, {
          mobile: { replacementTargets: [], slots: [] },
        });
        return value;
      })(),
      valid: false,
    },
    {
      name: "recursive target",
      value: (() => {
        const value = shellManifest();
        value.contributions[0]!.data.seams.web!.replacementTargets = ["workbench.shell"];
        return value;
      })(),
      valid: false,
    },
    {
      name: "duplicate target",
      value: (() => {
        const value = shellManifest();
        value.contributions[0]!.data.seams.web!.replacementTargets = ["workbench.editor", "workbench.editor"];
        return value;
      })(),
      valid: false,
    },
  ];
  for (const fixture of fixtures) {
    assert.equal(validateSchema(fixture.value), fixture.valid, `${fixture.name}: JSON Schema`);
    if (fixture.valid) assert.doesNotThrow(() => parsePiariumExtensionManifest(fixture.value));
    else assert.throws(() => parsePiariumExtensionManifest(fixture.value), `${fixture.name}: runtime parser`);
  }
});
