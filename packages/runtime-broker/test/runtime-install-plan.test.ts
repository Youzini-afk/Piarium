import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNotDowngrade, planPiInstall } from "../src/runtime-install-plan.js";

test("plans a global install with the first available package manager", () => {
  const plan = planPiInstall({
    managers: [{ kind: "npm", executable: "C:\\\\npm\\\\npm.cmd" }],
    targetVersion: "0.84.1",
  });
  assert.equal(plan.action, "install");
  assert.equal(plan.manager, "npm");
  assert.deepEqual(plan.args, ["install", "-g", "@earendil-works/pi-coding-agent@0.84.1"]);
  assert.equal(plan.executable, "C:\\\\npm\\\\npm.cmd");
});

test("upgrades an older install with the owning package manager and never emits a lower version", () => {
  const plan = planPiInstall({
    current: {
      commandPath: "C:\\\\Users\\\\you\\\\.bun\\\\bin\\\\pi",
      packageRoot: "C:\\\\Users\\\\you\\\\.bun\\\\install\\\\global\\\\node_modules\\\\@earendil-works\\\\pi-coding-agent",
      version: "0.80.0",
    },
    managers: [
      { kind: "npm", executable: "C:\\\\npm\\\\npm.cmd" },
      { kind: "bun", executable: "C:\\\\Users\\\\you\\\\.bun\\\\bin\\\\bun.exe" },
    ],
    targetVersion: "0.84.1",
  });
  assert.equal(plan.action, "upgrade");
  assert.equal(plan.manager, "bun");
  assert.deepEqual(plan.args, ["add", "-g", "@earendil-works/pi-coding-agent@0.84.1"]);
  assert.equal(plan.args?.some((arg) => arg.includes("@0.80.0")), false);
});

test("keeps a newer installed Pi without scheduling an install", () => {
  const plan = planPiInstall({
    current: { version: "0.99.0" },
    managers: [{ kind: "npm", executable: "npm" }],
    targetVersion: "0.84.1",
  });
  assert.equal(plan.action, "keep-newer");
  assert.equal(plan.executable, undefined);
  assert.equal(plan.args, undefined);
});

test("skips a repeated install of the same version", () => {
  const plan = planPiInstall({
    current: { version: "0.84.1" },
    managers: [{ kind: "npm", executable: "npm" }],
    targetVersion: "0.84.1",
  });
  assert.equal(plan.action, "none");
});

test("refuses to install a lower version over a newer one", () => {
  assert.throws(() => assertNotDowngrade("0.99.0", "0.84.1"), /Refusing to install/);
});
