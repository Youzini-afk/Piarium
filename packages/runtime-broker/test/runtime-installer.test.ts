import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { executePiInstallPlan } from "../src/runtime-installer.js";
import { standaloneRuntimeLocations } from "../src/standalone-runtime.js";

test("spawns the package manager with discrete arguments and no shell string", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const result = await executePiInstallPlan(
    {
      action: "install",
      args: ["install", "-g", "@earendil-works/pi-coding-agent@0.84.1"],
      executable: "C:\\\\npm\\\\npm.cmd",
      manager: "npm",
      reason: "test",
      targetVersion: "0.84.1",
    },
    {
      runCommand: async (executable, args) => {
        calls.push({ executable, args });
        return { exitCode: 0, stderr: "", stdout: "added 1 package" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{
    executable: "C:\\\\npm\\\\npm.cmd",
    args: ["install", "-g", "@earendil-works/pi-coding-agent@0.84.1"],
  }]);
});

test("does not run an install command when the plan keeps a newer Pi", async () => {
  let ran = false;
  const result = await executePiInstallPlan(
    {
      action: "keep-newer",
      currentVersion: "0.99.0",
      reason: "keep",
      targetVersion: "0.84.1",
    },
    {
      runCommand: async () => {
        ran = true;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    },
  );
  assert.equal(ran, false);
  assert.equal(result.exitCode, 0);
});

test("installs a standalone payload to the user-global location and skips a newer copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-standalone-"));
  const payload = join(root, "payload");
  const home = join(root, "home");
  try {
    await mkdir(payload, { recursive: true });
    const manifest = {
      name: "pi-runtime",
      nodeVersion: "22.19.0",
      sha256: createHash("sha256").update("payload").digest("hex"),
      version: "0.84.1",
    };
    await writeFile(join(payload, "pi-runtime.manifest.json"), JSON.stringify(manifest));
    await writeFile(join(payload, "README"), "standalone");
    const env = { LOCALAPPDATA: join(home, "AppData", "Local") };
    const first = await executePiInstallPlan(
      {
        action: "install",
        manager: "standalone",
        reason: "test",
        targetVersion: "0.84.1",
      },
      { env, platform: "win32", standalonePayloadDir: payload },
    );
    assert.equal(first.exitCode, 0);
    const locations = standaloneRuntimeLocations("win32", env);
    assert.match(await readFile(locations.commandPath, "utf8"), /pi-coding-agent/);
    const skipped = await executePiInstallPlan(
      {
        action: "upgrade",
        currentVersion: "0.99.0",
        manager: "standalone",
        reason: "test",
        targetVersion: "0.84.1",
      },
      { env, platform: "win32", standalonePayloadDir: payload },
    );
    assert.equal(skipped.exitCode, 0);
    assert.match(skipped.stdout, /Keeping installed Pi 0\.99\.0/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a standalone archive whose SHA-256 does not match the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-standalone-hash-"));
  try {
    const payload = join(root, "payload");
    await mkdir(payload, { recursive: true });
    await writeFile(
      join(payload, "pi-runtime.manifest.json"),
      JSON.stringify({
        name: "pi-runtime",
        nodeVersion: "22.19.0",
        sha256: "0".repeat(64),
        version: "0.84.1",
      }),
    );
    const archive = join(root, "runtime.tar.gz");
    await writeFile(archive, "tampered");
    await assert.rejects(
      executePiInstallPlan(
        {
          action: "install",
          manager: "standalone",
          reason: "test",
          targetVersion: "0.84.1",
        },
        {
          env: { LOCALAPPDATA: join(root, "AppData", "Local") },
          platform: "win32",
          standaloneArchivePath: archive,
          standalonePayloadDir: payload,
        },
      ),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("registers the user-global bin directory on PATH without touching ~/.pi/agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-standalone-path-"));
  const payload = join(root, "payload");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const registryCalls: string[][] = [];
  try {
    await mkdir(payload, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "sessions.json"), "{\"keep\":true}");
    await writeFile(
      join(payload, "pi-runtime.manifest.json"),
      JSON.stringify({
        name: "pi-runtime",
        nodeVersion: "22.19.0",
        sha256: createHash("sha256").update("payload").digest("hex"),
        version: "0.84.1",
      }),
    );
    const env = {
      HOME: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      Path: "C:\\Windows\\System32",
    };
    const result = await executePiInstallPlan(
      {
        action: "install",
        manager: "standalone",
        reason: "test",
        targetVersion: "0.84.1",
      },
      {
        env,
        platform: "win32",
        runCommand: async (_executable, args) => {
          registryCalls.push(args);
          if (args[0] === "query") {
            return { exitCode: 1, stderr: "ERROR: The system was unable to find the specified registry key or value.", stdout: "" };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        standalonePayloadDir: payload,
      },
    );
    assert.equal(result.exitCode, 0);
    const locations = standaloneRuntimeLocations("win32", env);
    assert.equal(env.Path.startsWith(`${locations.binDir};`), true);
    assert.deepEqual(registryCalls[0], ["query", "HKCU\\Environment", "/v", "Path"]);
    assert.equal(registryCalls[1]?.[0], "add");
    assert.equal(registryCalls[1]?.includes(locations.binDir), true);
    assert.equal(await readFile(join(agentDir, "sessions.json"), "utf8"), "{\"keep\":true}");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
