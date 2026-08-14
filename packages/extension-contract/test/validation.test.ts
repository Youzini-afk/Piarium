import assert from "node:assert/strict";
import test from "node:test";
import {
  PiariumExtensionContractError,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogDocument,
  parsePiariumExtensionCandidateCapabilityReviewRequest,
  parsePiariumExtensionCapabilityReviewRequest,
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionManagedEntrypointRequest,
  parsePiariumExtensionManifest,
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

test("normalizes a complete Piarium extension manifest", () => {
  const parsed = parsePiariumExtensionManifest(manifest());
  assert.equal(parsed.id, "dev.example.memory-workbench");
  assert.equal(parsed.entrypoints?.surfaces?.[0]?.mode, "managed");
  assert.equal(parsed.contributions?.[0]?.data.route, "memory");
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
