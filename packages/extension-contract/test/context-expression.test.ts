import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parsePiariumContextExpression,
  evaluatePiariumContextExpression,
  collectPiariumContextExpressionKeys,
  PiariumContextExpressionError,
  parsePiariumExtensionManifest,
  PiariumExtensionContractError,
} from "../src/index.js";

const ctx = (entries: Record<string, string | number | boolean>) => new Map(Object.entries(entries));

test("parsePiariumContextExpression parses defined", () => {
  const expr = parsePiariumContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.deepEqual(expr, { op: "defined", key: "editorIsOpen" });
});

test("parsePiariumContextExpression parses equals", () => {
  const expr = parsePiariumContextExpression({ op: "equals", key: "editorLanguage", value: "markdown" });
  assert.deepEqual(expr, { op: "equals", key: "editorLanguage", value: "markdown" });
});

test("parsePiariumContextExpression parses not", () => {
  const expr = parsePiariumContextExpression({ op: "not", expression: { op: "defined", key: "editorIsDirty" } });
  assert.deepEqual(expr, { op: "not", expression: { op: "defined", key: "editorIsDirty" } });
});

test("parsePiariumContextExpression parses all", () => {
  const expr = parsePiariumContextExpression({ op: "all", expressions: [] });
  assert.deepEqual(expr, { op: "all", expressions: [] });
});

test("parsePiariumContextExpression parses any", () => {
  const expr = parsePiariumContextExpression({ op: "any", expressions: [{ op: "defined", key: "a" }] });
  assert.deepEqual(expr, { op: "any", expressions: [{ op: "defined", key: "a" }] });
});

test("parsePiariumContextExpression rejects invalid op", () => {
  assert.throws(
    () => parsePiariumContextExpression({ op: "invalid", key: "a" }),
    PiariumContextExpressionError,
  );
});

test("parsePiariumContextExpression rejects missing key", () => {
  assert.throws(
    () => parsePiariumContextExpression({ op: "defined" }),
    PiariumContextExpressionError,
  );
});

test("parsePiariumContextExpression rejects non-object", () => {
  assert.throws(
    () => parsePiariumContextExpression("string"),
    PiariumContextExpressionError,
  );
});

test("evaluatePiariumContextExpression: defined returns true when key exists", () => {
  const expr = parsePiariumContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ editorIsOpen: true })), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), false);
});

test("evaluatePiariumContextExpression: equals compares strictly", () => {
  const expr = parsePiariumContextExpression({ op: "equals", key: "editorLanguage", value: "markdown" });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ editorLanguage: "markdown" })), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ editorLanguage: "typescript" })), false);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), false);
});

test("evaluatePiariumContextExpression: not negates", () => {
  const expr = parsePiariumContextExpression({ op: "not", expression: { op: "defined", key: "editorIsDirty" } });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ editorIsDirty: true })), false);
});

test("evaluatePiariumContextExpression: empty all is true", () => {
  const expr = parsePiariumContextExpression({ op: "all", expressions: [] });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), true);
});

test("evaluatePiariumContextExpression: empty any is false", () => {
  const expr = parsePiariumContextExpression({ op: "any", expressions: [] });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), false);
});

test("evaluatePiariumContextExpression: all requires every expression true", () => {
  const expr = parsePiariumContextExpression({
    op: "all",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
    ],
  });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ a: true, b: 1 })), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ a: true, b: 2 })), false);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ b: 1 })), false);
});

test("evaluatePiariumContextExpression: any requires at least one true", () => {
  const expr = parsePiariumContextExpression({
    op: "any",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
    ],
  });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), false);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ a: true })), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ b: 1 })), true);
});

test("evaluatePiariumContextExpression: nested not + all", () => {
  const expr = parsePiariumContextExpression({
    op: "not",
    expression: {
      op: "all",
      expressions: [
        { op: "defined", key: "a" },
        { op: "defined", key: "b" },
      ],
    },
  });
  assert.equal(evaluatePiariumContextExpression(expr, ctx({})), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ a: true })), true);
  assert.equal(evaluatePiariumContextExpression(expr, ctx({ a: true, b: true })), false);
});

test("collectPiariumContextExpressionKeys collects all keys", () => {
  const expr = parsePiariumContextExpression({
    op: "all",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
      { op: "not", expression: { op: "defined", key: "c" } },
    ],
  });
  const keys = collectPiariumContextExpressionKeys(expr);
  assert.deepEqual(keys.sort(), ["a", "b", "c"]);
});

test("collectPiariumContextExpressionKeys: single key", () => {
  const expr = parsePiariumContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.deepEqual(collectPiariumContextExpressionKeys(expr), ["editorIsOpen"]);
});

test("collectPiariumContextExpressionKeys: empty all has no keys", () => {
  const expr = parsePiariumContextExpression({ op: "all", expressions: [] });
  assert.deepEqual(collectPiariumContextExpressionKeys(expr), []);
});

test("parsePiariumExtensionManifest accepts structured when on view", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  const parsed = parsePiariumExtensionManifest(manifest);
  assert.deepEqual(parsed.contributions?.[0].when, { op: "defined", key: "editorIsOpen" });
});

test("parsePiariumExtensionManifest rejects when on shell", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.shell",
      kind: "shell",
      contractVersion: 1,
      data: {
        contract: "piarium-workbench-shell/v1",
        seams: { web: { replacementTargets: [], slots: [] } },
      },
      supports: ["web"],
      replacement: { target: "workbench.shell" },
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  assert.throws(
    () => parsePiariumExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof PiariumExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parsePiariumExtensionManifest rejects when on transition-scene", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.transition",
      kind: "transition-scene",
      contractVersion: 1,
      data: {
        contract: "piarium-transition-scene/v1",
        scenes: ["workbench-profile"],
        durations: {
          "workbench-profile": {
            covering: { quick: 100, reduced: 200, standard: 300 },
            revealing: { quick: 100, reduced: 200, standard: 300 },
          },
        },
      },
      supports: ["web"],
      replacement: { target: "workbench.transition" },
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  assert.throws(
    () => parsePiariumExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof PiariumExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parsePiariumExtensionManifest rejects invalid when expression", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
      when: { op: "invalid" },
    }],
  };
  assert.throws(
    () => parsePiariumExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof PiariumExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("op must be defined"));
    },
  );
});
