import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePiCommandLayout } from "../src/pi-command-layout.js";

async function writeCodingAgent(packageRoot: string): Promise<void> {
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.1" }),
  );
  await writeFile(join(packageRoot, "dist", "cli.js"), "console.log('0.84.1');\n");
}

describe("resolvePiCommandLayout", () => {
  it("reads an npm Windows cmd shim and the adjacent Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-cmd-shim-"));
    try {
      const codingAgent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      await writeCodingAgent(codingAgent);
      await writeFile(join(root, "node.exe"), "");
      const command = join(root, "pi.cmd");
      await writeFile(
        command,
        [
          "@ECHO off",
          "SET dp0=%~dp0",
          'IF EXIST "%dp0%\\node.exe" SET "_prog=%dp0%\\node.exe"',
          'endLocal & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
          "",
        ].join("\r\n"),
      );
      const resolved = resolvePiCommandLayout(command);
      assert.equal(resolved.packageRoot, codingAgent);
      assert.equal(resolved.nodePath, join(root, "node.exe"));
      assert.equal(resolved.issue, undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("follows a Unix shebang script to the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-shebang-"));
    try {
      const codingAgent = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
      await writeCodingAgent(codingAgent);
      const command = join(root, "bin", "pi");
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(
        command,
        `#!/usr/bin/env node
const basedir = ${JSON.stringify(root)};
// "${join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")}"
`,
      );
      const resolved = resolvePiCommandLayout(command);
      assert.equal(resolved.packageRoot, codingAgent);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads a Windows bat shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-bat-shim-"));
    try {
      const codingAgent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      await writeCodingAgent(codingAgent);
      await writeFile(join(root, "node.exe"), "");
      const command = join(root, "pi.bat");
      await writeFile(
        command,
        [
          "@echo off",
          `"${join(root, "node.exe")}" "${join(codingAgent, "dist", "cli.js")}" %*`,
          "",
        ].join("\r\n"),
      );
      const resolved = resolvePiCommandLayout(command);
      assert.equal(resolved.packageRoot, codingAgent);
      assert.equal(resolved.nodePath, join(root, "node.exe"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads a PowerShell shim and a pnpm-style quoted package path", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-ps1-shim-"));
    try {
      const codingAgent = join(root, "global", "5", "node_modules", "@earendil-works", "pi-coding-agent");
      await writeCodingAgent(codingAgent);
      const command = join(root, "pi.ps1");
      await writeFile(
        command,
        [
          "#!/usr/bin/env pwsh",
          `$basedir = ${JSON.stringify(root)}`,
          `& "$basedir/node.exe" "${join(codingAgent, "dist", "cli.js")}" $args`,
          "",
        ].join("\n"),
      );
      const resolved = resolvePiCommandLayout(command);
      assert.equal(resolved.packageRoot, codingAgent);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resolves a bun-style symlink target when available", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-bun-link-"));
    try {
      const codingAgent = join(root, "install", "global", "node_modules", "@earendil-works", "pi-coding-agent");
      await writeCodingAgent(codingAgent);
      const command = join(root, "bin", "pi");
      await mkdir(join(root, "bin"), { recursive: true });
      await symlink(join(codingAgent, "dist", "cli.js"), command);
      const resolved = resolvePiCommandLayout(command);
      assert.equal(resolved.packageRoot, codingAgent);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
