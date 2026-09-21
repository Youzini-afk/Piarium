import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseVarinContextExpression,
  evaluateVarinContextExpression,
  collectVarinContextExpressionKeys,
  VarinContextExpressionError,
  parseVarinExtensionManifest,
  VarinExtensionContractError,
} from "../src/index.js";

const ctx = (entries: Record<string, string | number | boolean>) => new Map(Object.entries(entries));

test("parseVarinContextExpression parses defined", () => {
  const expr = parseVarinContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.deepEqual(expr, { op: "defined", key: "editorIsOpen" });
});

test("parseVarinContextExpression parses equals", () => {
  const expr = parseVarinContextExpression({ op: "equals", key: "editorLanguage", value: "markdown" });
  assert.deepEqual(expr, { op: "equals", key: "editorLanguage", value: "markdown" });
});

test("parseVarinContextExpression parses not", () => {
  const expr = parseVarinContextExpression({ op: "not", expression: { op: "defined", key: "editorIsDirty" } });
  assert.deepEqual(expr, { op: "not", expression: { op: "defined", key: "editorIsDirty" } });
});

test("parseVarinContextExpression parses all", () => {
  const expr = parseVarinContextExpression({ op: "all", expressions: [] });
  assert.deepEqual(expr, { op: "all", expressions: [] });
});

test("parseVarinContextExpression parses any", () => {
  const expr = parseVarinContextExpression({ op: "any", expressions: [{ op: "defined", key: "a" }] });
  assert.deepEqual(expr, { op: "any", expressions: [{ op: "defined", key: "a" }] });
});

test("parseVarinContextExpression rejects invalid op", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "invalid", key: "a" }),
    VarinContextExpressionError,
  );
});

test("parseVarinContextExpression rejects missing key", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "defined" }),
    VarinContextExpressionError,
  );
});

test("parseVarinContextExpression rejects non-object", () => {
  assert.throws(
    () => parseVarinContextExpression("string"),
    VarinContextExpressionError,
  );
});

test("evaluateVarinContextExpression: defined returns true when key exists", () => {
  const expr = parseVarinContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.equal(evaluateVarinContextExpression(expr, ctx({ editorIsOpen: true })), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), false);
});

test("evaluateVarinContextExpression: equals compares strictly", () => {
  const expr = parseVarinContextExpression({ op: "equals", key: "editorLanguage", value: "markdown" });
  assert.equal(evaluateVarinContextExpression(expr, ctx({ editorLanguage: "markdown" })), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ editorLanguage: "typescript" })), false);
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), false);
});

test("evaluateVarinContextExpression: not negates", () => {
  const expr = parseVarinContextExpression({ op: "not", expression: { op: "defined", key: "editorIsDirty" } });
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ editorIsDirty: true })), false);
});

test("evaluateVarinContextExpression: empty all is true", () => {
  const expr = parseVarinContextExpression({ op: "all", expressions: [] });
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), true);
});

test("evaluateVarinContextExpression: empty any is false", () => {
  const expr = parseVarinContextExpression({ op: "any", expressions: [] });
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), false);
});

test("evaluateVarinContextExpression: all requires every expression true", () => {
  const expr = parseVarinContextExpression({
    op: "all",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
    ],
  });
  assert.equal(evaluateVarinContextExpression(expr, ctx({ a: true, b: 1 })), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ a: true, b: 2 })), false);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ b: 1 })), false);
});

test("evaluateVarinContextExpression: any requires at least one true", () => {
  const expr = parseVarinContextExpression({
    op: "any",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
    ],
  });
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), false);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ a: true })), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ b: 1 })), true);
});

test("evaluateVarinContextExpression: nested not + all", () => {
  const expr = parseVarinContextExpression({
    op: "not",
    expression: {
      op: "all",
      expressions: [
        { op: "defined", key: "a" },
        { op: "defined", key: "b" },
      ],
    },
  });
  assert.equal(evaluateVarinContextExpression(expr, ctx({})), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ a: true })), true);
  assert.equal(evaluateVarinContextExpression(expr, ctx({ a: true, b: true })), false);
});

test("collectVarinContextExpressionKeys collects all keys", () => {
  const expr = parseVarinContextExpression({
    op: "all",
    expressions: [
      { op: "defined", key: "a" },
      { op: "equals", key: "b", value: 1 },
      { op: "not", expression: { op: "defined", key: "c" } },
    ],
  });
  const keys = collectVarinContextExpressionKeys(expr);
  assert.deepEqual(keys.sort(), ["a", "b", "c"]);
});

test("collectVarinContextExpressionKeys: single key", () => {
  const expr = parseVarinContextExpression({ op: "defined", key: "editorIsOpen" });
  assert.deepEqual(collectVarinContextExpressionKeys(expr), ["editorIsOpen"]);
});

test("collectVarinContextExpressionKeys: empty all has no keys", () => {
  const expr = parseVarinContextExpression({ op: "all", expressions: [] });
  assert.deepEqual(collectVarinContextExpressionKeys(expr), []);
});

test("parseVarinExtensionManifest accepts structured when on view", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  const parsed = parseVarinExtensionManifest(manifest);
  assert.deepEqual(parsed.contributions![0]!.when, { op: "defined", key: "editorIsOpen" });
});

test("parseVarinExtensionManifest rejects when on shell", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.shell",
      kind: "shell",
      contractVersion: 1,
      data: {
        contract: "varin-workbench-shell/v1",
        seams: { web: { replacementTargets: [], slots: [] } },
      },
      supports: ["web"],
      replacement: { target: "workbench.shell" },
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  assert.throws(
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parseVarinExtensionManifest rejects when on transition-scene", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.transition",
      kind: "transition-scene",
      contractVersion: 1,
      data: {
        contract: "varin-transition-scene/v1",
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
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parseVarinExtensionManifest rejects invalid when expression", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
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
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("op must be defined"));
    },
  );
});

test("parseVarinContextExpression rejects extra fields on defined", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "defined", key: "a", extra: true }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("unexpected field"));
    },
  );
});

test("parseVarinContextExpression rejects extra fields on equals", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "equals", key: "a", value: 1, extra: true }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("unexpected field"));
    },
  );
});

test("parseVarinContextExpression rejects extra fields on not", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "not", expression: { op: "defined", key: "a" }, extra: true }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("unexpected field"));
    },
  );
});

test("parseVarinContextExpression rejects extra fields on all", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "all", expressions: [], extra: true }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("unexpected field"));
    },
  );
});

test("parseVarinContextExpression rejects NaN value in equals", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "equals", key: "a", value: NaN }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("finite number"));
    },
  );
});

test("parseVarinContextExpression rejects Infinity value in equals", () => {
  assert.throws(
    () => parseVarinContextExpression({ op: "equals", key: "a", value: Infinity }),
    (error: unknown) => {
      if (!(error instanceof VarinContextExpressionError)) return false;
      return error.issues.some((issue) => issue.includes("finite number"));
    },
  );
});
