import { spawn } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { PiRuntimeInstallPlan } from "@piarium/protocol";
import { compareVersions } from "@piarium/pi-host/discovery";
import { assertNotDowngrade } from "./runtime-install-plan.js";
import {
  readStandaloneManifest,
  standaloneManifestPath,
  standaloneRuntimeLocations,
  verifyStandalonePayload,
} from "./standalone-runtime.js";

export interface InstallCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RuntimeInstallerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: (executable: string, args: string[]) => Promise<InstallCommandResult>;
  standaloneArchivePath?: string;
  standalonePayloadDir?: string;
}

function formatOutput(result: InstallCommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function commandNeedsWindowsShell(executable: string): boolean {
  return [".cmd", ".bat"].includes(extname(executable).toLowerCase());
}

async function defaultRunCommand(executable: string, args: string[]): Promise<InstallCommandResult> {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      env: process.env,
      shell: process.platform === "win32" && commandNeedsWindowsShell(executable),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      resolveCommand({ exitCode: code ?? 1, stderr, stdout });
    });
  });
}

async function writeUnixPiEntry(commandPath: string, runtimeDir: string): Promise<void> {
  const script = `#!/usr/bin/env bash
DIR=${JSON.stringify(runtimeDir)}
if [ -x "$DIR/bin/node" ]; then
  exec "$DIR/bin/node" "$DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
fi
exec "$DIR/bin/pi" "$@"
`;
  await mkdir(dirname(commandPath), { recursive: true });
  await writeFile(commandPath, script, { encoding: "utf8", mode: 0o755 });
  await chmod(commandPath, 0o755);
}

async function writeWindowsPiEntry(commandPath: string, runtimeDir: string): Promise<void> {
  const script = `@echo off\r
set "DIR=${runtimeDir}"\r
if exist "%DIR%\\bin\\node.exe" (\r
  "%DIR%\\bin\\node.exe" "%DIR%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r
  exit /b %ERRORLEVEL%\r
)\r
"%DIR%\\bin\\pi.exe" %*\r
`;
  await mkdir(dirname(commandPath), { recursive: true });
  await writeFile(commandPath, script, "utf8");
}

export async function ensureUserPathContains(
  binDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    runCommand?: (executable: string, args: string[]) => Promise<InstallCommandResult>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const current = env[pathKey] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  if (current.split(separator).includes(binDir)) return;
  env[pathKey] = current ? `${binDir}${separator}${current}` : binDir;
  if (platform !== "win32") return;
  const run = options.runCommand ?? defaultRunCommand;
  const query = await run("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"]);
  const existing = query.stdout.match(/Path\s+REG_\w+\s+(.+)/i)?.[1]?.trim() ?? "";
  if (existing.split(";").includes(binDir)) return;
  const next = existing ? `${existing};${binDir}` : binDir;
  await run("reg.exe", [
    "add",
    "HKCU\\Environment",
    "/v",
    "Path",
    "/t",
    "REG_EXPAND_SZ",
    "/d",
    next,
    "/f",
  ]);
}

async function installStandalonePayload(
  plan: PiRuntimeInstallPlan,
  options: RuntimeInstallerOptions,
): Promise<InstallCommandResult> {
  const payloadDir = options.standalonePayloadDir;
  if (!payloadDir) {
    return { exitCode: 1, stderr: "Standalone Pi payload is not available", stdout: "" };
  }
  const manifest = readStandaloneManifest(standaloneManifestPath(payloadDir));
  if (plan.currentVersion && compareVersions(plan.currentVersion, manifest.version) >= 0) {
    return {
      exitCode: 0,
      stderr: "",
      stdout: `Keeping installed Pi ${plan.currentVersion}`,
    };
  }
  assertNotDowngrade(plan.currentVersion, manifest.version);
  if (options.standaloneArchivePath) {
    verifyStandalonePayload(options.standaloneArchivePath, manifest.sha256);
  }
  const locations = standaloneRuntimeLocations(options.platform, options.env);
  await mkdir(locations.runtimeDir, { recursive: true });
  const staging = `${locations.runtimeDir}.staging`;
  await rm(staging, { force: true, recursive: true });
  await cp(payloadDir, staging, { dereference: true, recursive: true });
  await rm(locations.runtimeDir, { force: true, recursive: true });
  await cp(staging, locations.runtimeDir, { dereference: true, recursive: true });
  await rm(staging, { force: true, recursive: true });
  if ((options.platform ?? process.platform) === "win32") {
    await writeWindowsPiEntry(locations.commandPath, locations.runtimeDir);
  } else {
    await writeUnixPiEntry(locations.commandPath, locations.runtimeDir);
  }
  await ensureUserPathContains(locations.binDir, options);
  return {
    exitCode: 0,
    stderr: "",
    stdout: `Installed Pi ${manifest.version} to ${locations.runtimeDir}`,
  };
}

export async function executePiInstallPlan(
  plan: PiRuntimeInstallPlan,
  options: RuntimeInstallerOptions = {},
): Promise<InstallCommandResult> {
  if (plan.action === "none" || plan.action === "keep-newer") {
    return { exitCode: 0, stderr: "", stdout: plan.reason };
  }
  if (plan.currentVersion && compareVersions(plan.currentVersion, plan.targetVersion) >= 0) {
    return {
      exitCode: 0,
      stderr: "",
      stdout: `Keeping installed Pi ${plan.currentVersion}`,
    };
  }
  assertNotDowngrade(plan.currentVersion, plan.targetVersion);
  if (plan.manager === "standalone") {
    return installStandalonePayload(plan, options);
  }
  if (!plan.executable || !plan.args) {
    return { exitCode: 1, stderr: plan.reason, stdout: "" };
  }
  const run = options.runCommand ?? defaultRunCommand;
  return run(plan.executable, plan.args);
}

export function describeInstallFailure(result: InstallCommandResult): string {
  return formatOutput(result) || `Pi install failed with exit code ${String(result.exitCode)}`;
}
