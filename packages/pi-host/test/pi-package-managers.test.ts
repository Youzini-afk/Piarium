import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  detectOwningPackageManager,
  detectPackageManagers,
  globalInstallArguments,
} from "../src/pi-package-managers.js";

describe("package manager detection", () => {
  it("prefers a Windows .exe over cmd and PowerShell shims", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-pm-"));
    try {
      const cmd = join(root, "npm.cmd");
      const exe = join(root, "npm.exe");
      const bare = join(root, "npm");
      await writeFile(cmd, "");
      await writeFile(exe, "");
      await writeFile(bare, "");
      const detected = await detectPackageManagers({
        findCommands: async (name) => {
          if (name === "npm.cmd") return [cmd];
          if (name === "npm") return [bare];
          if (name === "npm.exe") return [exe];
          return [];
        },
        platform: "win32",
      });
      assert.deepEqual(detected, [{ kind: "npm", executable: exe }]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("detects bun, npm, and pnpm in that order when all are present", async () => {
    const detected = await detectPackageManagers({
      findCommands: async (name) => {
        if (name === "bun") return ["/home/you/.bun/bin/bun"];
        if (name === "npm") return ["/usr/bin/npm"];
        if (name === "pnpm") return ["/home/you/.local/share/pnpm/pnpm"];
        return [];
      },
      platform: "linux",
    });
    assert.deepEqual(
      detected.map((entry) => entry.kind),
      ["bun", "npm", "pnpm"],
    );
  });

  it("identifies the owning manager from install paths", () => {
    assert.equal(
      detectOwningPackageManager(["C:\\Users\\you\\.bun\\install\\global\\node_modules\\@earendil-works\\pi-coding-agent"]),
      "bun",
    );
    assert.equal(
      detectOwningPackageManager(["C:\\Users\\you\\AppData\\Local\\pnpm\\pi.cmd"]),
      "pnpm",
    );
    assert.equal(
      detectOwningPackageManager(["C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd"]),
      "npm",
    );
  });

  it("builds discrete global install arguments", () => {
    assert.deepEqual(globalInstallArguments("npm", "@earendil-works/pi-coding-agent@0.84.1"), [
      "install",
      "-g",
      "@earendil-works/pi-coding-agent@0.84.1",
    ]);
    assert.deepEqual(globalInstallArguments("bun", "@earendil-works/pi-coding-agent@0.84.1"), [
      "add",
      "-g",
      "@earendil-works/pi-coding-agent@0.84.1",
    ]);
    assert.deepEqual(globalInstallArguments("pnpm", "@earendil-works/pi-coding-agent@0.84.1"), [
      "add",
      "-g",
      "@earendil-works/pi-coding-agent@0.84.1",
    ]);
  });
});
