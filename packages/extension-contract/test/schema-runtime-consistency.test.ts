import { strict as assert } from "node:assert";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Ctor = Ajv2020 as any;
import semver from "semver";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePiariumExtensionManifest, PiariumExtensionContractError } from "../src/index.js";
import { manifestFixtures } from "./manifest-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "schema", "piarium.extension.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;

// Register a real semver-range format validator instead of the always-true stub.
const validateSchema = new Ajv2020Ctor({
  allErrors: true,
  strict: false,
  formats: {
    "semver-range": (input: string) => semver.validRange(input) !== null,
  },
}).compile(schema);

const schemaValid = (manifest: unknown): boolean => {
  const ok = validateSchema(manifest);
  if (ok) return true;
  // Collect errors for debugging
  const errors = validateSchema.errors;
  if (errors && errors.length > 0) {
    // Return false — errors are expected for invalid fixtures
  }
  return false;
};

const runtimeValid = (manifest: unknown): boolean => {
  try {
    parsePiariumExtensionManifest(manifest);
    return true;
  } catch (error) {
    if (error instanceof PiariumExtensionContractError) return false;
    throw error;
  }
};

test("schema and runtime agree on every manifest fixture", () => {
  const mismatches: string[] = [];
  for (const fixture of manifestFixtures) {
    const schemaResult = schemaValid(fixture.manifest);
    const runtimeResult = runtimeValid(fixture.manifest);
    // Check fixture expectations are met
    if (schemaResult !== fixture.schemaValid) {
      mismatches.push(
        `${fixture.label}: schema expected ${fixture.schemaValid} but got ${schemaResult}`,
      );
    }
    if (runtimeResult !== fixture.runtimeValid) {
      mismatches.push(
        `${fixture.label}: runtime expected ${fixture.runtimeValid} but got ${runtimeResult}`,
      );
    }
    // Assert schema and runtime agree, unless the fixture documents a
    // cross-field rule that only the runtime can express.
    // The only allowed divergence is schemaValid=true, runtimeValid=false
    // (schema accepts but runtime rejects a cross-field constraint).
    // schemaValid=false, runtimeValid=true is NOT acceptable — both must reject.
    if (fixture.schemaValid === false && fixture.runtimeValid === true) {
      mismatches.push(
        `${fixture.label}: schema rejects but runtime accepts — this divergence is not allowed`,
      );
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("semver-range format uses real semver.validRange validation", () => {
  // Valid ranges
  assert.equal(schemaValid({ ...minimalManifest(), engines: { piarium: ">=0.2.0" } }), true);
  assert.equal(schemaValid({ ...minimalManifest(), engines: { piarium: "^1.0.0" } }), true);
  assert.equal(schemaValid({ ...minimalManifest(), engines: { piarium: "*" } }), true);
  // Invalid range
  assert.equal(schemaValid({ ...minimalManifest(), engines: { piarium: "not-a-range" } }), false);
});

test("runtime-only rules have schemaValid: true and runtimeValid: false", () => {
  const runtimeOnlyFixtures = manifestFixtures.filter(
    (f) => f.schemaValid === true && f.runtimeValid === false,
  );
  // These are cross-field rules the schema cannot express
  for (const fixture of runtimeOnlyFixtures) {
    assert.equal(fixture.schemaValid, true, `${fixture.label} should be schemaValid: true`);
    assert.equal(fixture.runtimeValid, false, `${fixture.label} should be runtimeValid: false`);
  }
  // We expect at least the cross-field fixtures
  assert.ok(runtimeOnlyFixtures.length >= 4, "expected at least 4 runtime-only fixtures");
});

test("unsupported contract version fixtures are runtimeValid but not compatible", () => {
  const unsupportedFixtures = manifestFixtures.filter((f) => !f.compatible);
  for (const fixture of unsupportedFixtures) {
    assert.equal(fixture.runtimeValid, true, `${fixture.label} should be runtimeValid: true`);
  }
});

test("editor/shell/transition schema rules are scoped to contractVersion 1", () => {
  // A future editor with contractVersion 2 should NOT trigger the v1 data
  // rules (anyOf languageIds/filenames). The schema should accept it
  // (it's a future version, not yet validated) and the runtime should accept it
  // (it's parsed but not compatible).
  const futureEditor = {
    schemaVersion: 1,
    id: "dev.example.future-editor",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.future-editor.view",
      kind: "editor",
      contractVersion: 2,
      data: { futureField: true },
      supports: ["web"],
    }],
  };
  assert.equal(schemaValid(futureEditor), true, "future editor should be schemaValid (v1 rules don't apply)");
  assert.equal(runtimeValid(futureEditor), true, "future editor should be runtimeValid (parsed but not compatible)");
});

const minimalManifest = () => ({
  schemaVersion: 1,
  id: "dev.example.minimal",
  version: "1.0.0",
  engines: { piarium: ">=0.2.0" },
  contributions: [{
    id: "dev.example.minimal.view",
    kind: "view" as const,
    contractVersion: 1,
    data: {},
    supports: ["web" as const],
  }],
});
