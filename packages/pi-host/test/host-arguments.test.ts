import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHostArguments, resolveHostRuntimeOptions } from "../src/host-arguments.js";

describe("host arguments", () => {
  it("parses package root and runtime source without a version ceiling", () => {
    const args = parseHostArguments([
      "--package-root",
      "D:\\pi\\package",
      "--runtime-source",
      "system",
      "--agent-dir",
      "D:\\pi\\agent",
      "--worker-role",
      "workspace",
    ]);
    assert.equal(args.packageRoot, "D:\\pi\\package");
    assert.equal(args.runtimeSource, "system");
    assert.equal(args.agentDir, "D:\\pi\\agent");
    assert.equal(args.workerRole, "workspace");
  });

  it("rejects unknown runtime sources instead of inventing a compatible range", () => {
    assert.throws(() => parseHostArguments(["--runtime-source", "compatible"]), /Unknown runtime source/);
  });

  it("defaults to a session worker and rejects unknown worker roles", () => {
    assert.equal(parseHostArguments([]).workerRole, "session");
    assert.throws(() => parseHostArguments(["--worker-role", "everything"]), /worker-role/);
  });

  it("reads package root from the environment when the flag is omitted", () => {
    const previous = process.env.PIARIUM_PI_PACKAGE_ROOT;
    process.env.PIARIUM_PI_PACKAGE_ROOT = "C:\\selected-pi";
    try {
      const runtime = resolveHostRuntimeOptions(parseHostArguments([]));
      assert.equal(runtime.packageRoot, "C:\\selected-pi");
    } finally {
      if (previous === undefined) delete process.env.PIARIUM_PI_PACKAGE_ROOT;
      else process.env.PIARIUM_PI_PACKAGE_ROOT = previous;
    }
  });
});
