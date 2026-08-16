import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  assertPiSdkResolvable,
  findSdkPackageDir,
  importerParentURL,
  listMissingPiSdkPackages,
  resolvePiPackageFromCommand,
  resolvePiSdkSpecifier,
} from "../src/pi-sdk-packages.js";

async function writeManifest(directory: string, name: string, extra: Record<string, unknown> = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "0.84.1", type: "module", ...extra }),
  );
}

describe("Pi SDK package resolution", () => {
  it("resolves sibling SDK packages from a coding-agent package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-sdk-"));
    try {
      const codingAgent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      const agentCore = join(root, "node_modules", "@earendil-works", "pi-agent-core");
      const piAi = join(root, "node_modules", "@earendil-works", "pi-ai");
      await writeManifest(codingAgent, "@earendil-works/pi-coding-agent", {
        exports: { ".": "./dist/index.js" },
      });
      await writeManifest(agentCore, "@earendil-works/pi-agent-core", {
        exports: { ".": "./dist/index.js" },
      });
      await writeManifest(piAi, "@earendil-works/pi-ai", {
        exports: {
          ".": "./dist/index.js",
          "./compat": "./dist/compat.js",
          "./providers/*": "./dist/providers/*.js",
        },
      });
      await mkdir(join(codingAgent, "dist"), { recursive: true });
      await mkdir(join(agentCore, "dist"), { recursive: true });
      await mkdir(join(piAi, "dist", "providers"), { recursive: true });
      await writeFile(join(codingAgent, "dist", "index.js"), "export const VERSION = '0.84.1';\n");
      await writeFile(join(agentCore, "dist", "index.js"), "export {};\n");
      await writeFile(join(piAi, "dist", "index.js"), "export {};\n");
      await writeFile(join(piAi, "dist", "compat.js"), "export {};\n");

      assert.equal(findSdkPackageDir(codingAgent, "@earendil-works/pi-coding-agent"), codingAgent);
      assert.equal(findSdkPackageDir(codingAgent, "@earendil-works/pi-agent-core"), agentCore);
      assert.equal(
        resolvePiSdkSpecifier(codingAgent, "@earendil-works/pi-coding-agent"),
        pathToFileURL(join(codingAgent, "dist", "index.js")).href,
      );
      assert.equal(
        resolvePiSdkSpecifier(codingAgent, "@earendil-works/pi-ai/compat"),
        pathToFileURL(join(piAi, "dist", "compat.js")).href,
      );
      await writeFile(join(piAi, "dist", "providers", "all.js"), "export {};\n");
      assert.equal(
        resolvePiSdkSpecifier(codingAgent, "@earendil-works/pi-ai/providers/all"),
        pathToFileURL(join(piAi, "dist", "providers", "all.js")).href,
      );
      assert.deepEqual(listMissingPiSdkPackages(codingAgent), []);
      assert.doesNotThrow(() => assertPiSdkResolvable(codingAgent));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("names the missing SDK module when the package root is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-sdk-missing-"));
    try {
      const codingAgent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      await writeManifest(codingAgent, "@earendil-works/pi-coding-agent");
      assert.deepEqual(listMissingPiSdkPackages(codingAgent), [
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
      ]);
      assert.throws(
        () => assertPiSdkResolvable(codingAgent),
        /@earendil-works\/pi-agent-core, @earendil-works\/pi-ai/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("locates an npm-style global install from the command path", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-sdk-command-"));
    try {
      const prefix = join(root, "npm");
      const codingAgent = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
      await writeManifest(codingAgent, "@earendil-works/pi-coding-agent");
      const command = join(prefix, "pi.cmd");
      await writeFile(command, "@echo off\r\necho 0.84.1\r\n");
      const resolved = resolvePiPackageFromCommand(command);
      assert.equal(resolved.packageRoot, codingAgent);
      assert.equal(resolved.issue, undefined);
      assert.match(importerParentURL(codingAgent, "@earendil-works/pi-coding-agent") ?? "", /piarium-sdk-importer\.mjs$/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
