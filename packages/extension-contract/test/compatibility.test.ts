import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PIARIUM_CONTRIBUTION_SUPPORTED_VERSIONS,
  checkPiariumContributionCompatibility,
  isPiariumContributionCompatible,
  parsePiariumExtensionManifest,
  PiariumExtensionContractError,
} from "../src/index.js";

const manifest = () => ({
  schemaVersion: 1,
  id: "dev.example.compat",
  version: "1.0.0",
  engines: { piarium: ">=0.2.0" },
  contributions: [
    {
      id: "dev.example.compat.view",
      kind: "view" as const,
      contractVersion: 1,
      data: {},
      supports: ["web" as const],
    },
  ],
});

test("checkPiariumContributionCompatibility returns supported for v1", () => {
  const result = checkPiariumContributionCompatibility("view", 1);
  assert.equal(result.status, "supported");
  assert.equal(result.kind, "view");
  assert.equal(result.contractVersion, 1);
});

test("checkPiariumContributionCompatibility returns unsupported for higher version", () => {
  const result = checkPiariumContributionCompatibility("view", 2);
  assert.equal(result.status, "unsupported-contract-version");
  assert.equal(result.kind, "view");
  assert.equal(result.contractVersion, 2);
  assert.deepEqual(result.supportedVersions, [1]);
});

test("isPiariumContributionCompatible predicate", () => {
  assert.equal(isPiariumContributionCompatible("shell", 1), true);
  assert.equal(isPiariumContributionCompatible("shell", 99), false);
  assert.equal(isPiariumContributionCompatible("editor", 1), true);
  assert.equal(isPiariumContributionCompatible("editor", 2), false);
});

test("all contribution kinds have v1 in supported versions", () => {
  for (const [kind, versions] of Object.entries(PIARIUM_CONTRIBUTION_SUPPORTED_VERSIONS)) {
    assert.ok(versions.includes(1), `kind ${kind} must support version 1`);
  }
});

test("parsePiariumExtensionManifest accepts contractVersion 1", () => {
  const parsed = parsePiariumExtensionManifest(manifest());
  assert.equal(parsed.contributions?.[0].contractVersion, 1);
});

test("parsePiariumExtensionManifest parses higher contractVersion without throwing", () => {
  const m = manifest();
  (m.contributions![0] as { contractVersion: number }).contractVersion = 99;
  // Should not throw — the manifest is structurally valid, just incompatible
  const parsed = parsePiariumExtensionManifest(m);
  assert.equal(parsed.contributions?.[0].contractVersion, 99);
});

test("parsePiariumExtensionManifest skips kind-specific data validation for unsupported version", () => {
  // An editor with contractVersion 2 and missing languageIds/filenames
  // should NOT trigger the "must declare languageIds or filenames" issue
  // because the data is not validated for unsupported versions.
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.editor",
    kind: "editor",
    contractVersion: 2,
    data: {},
    supports: ["web"],
  };
  const parsed = parsePiariumExtensionManifest(m);
  assert.equal(parsed.contributions?.[0].contractVersion, 2);
});

test("parsePiariumExtensionManifest still validates kind-specific data for v1 editor", () => {
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.editor",
    kind: "editor",
    contractVersion: 1,
    data: {},
    supports: ["web"],
  };
  assert.throws(
    () => parsePiariumExtensionManifest(m),
    (error: unknown) => {
      if (!(error instanceof PiariumExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("must declare languageIds or filenames"));
    },
  );
});

test("parsePiariumExtensionManifest validates shell data only for compatible version", () => {
  // shell with contractVersion 2 and invalid data should not throw shell data errors
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.shell",
    kind: "shell",
    contractVersion: 2,
    data: { contract: "wrong", seams: {} },
    supports: ["web"],
    replacement: { target: "workbench.shell" },
  };
  const parsed = parsePiariumExtensionManifest(m);
  assert.equal(parsed.contributions?.[0].contractVersion, 2);
});

test("same extension can have both compatible and incompatible contributions", () => {
  const m = manifest();
  m.contributions = [
    {
      id: "dev.example.compat.view1",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
    },
    {
      id: "dev.example.compat.view2",
      kind: "view",
      contractVersion: 99,
      data: {},
      supports: ["web"],
    },
  ];
  const parsed = parsePiariumExtensionManifest(m);
  assert.equal(parsed.contributions?.length, 2);
  assert.equal(parsed.contributions?.[0].contractVersion, 1);
  assert.equal(parsed.contributions?.[1].contractVersion, 99);
});
