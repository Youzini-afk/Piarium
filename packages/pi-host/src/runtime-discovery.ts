import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RuntimeSourceKind } from "@piarium/protocol";

const execFileAsync = promisify(execFile);
const MINIMUM_PI_VERSION = "0.82.1";
const MINIMUM_NODE_VERSION = "22.19.0";
const PACKAGE_MANIFEST = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };
const readBundledPiVersion = (): string => {
  const version = PACKAGE_MANIFEST.dependencies?.["@earendil-works/pi-coding-agent"];
  if (!version) {
    throw new Error("Pi host package manifest does not pin @earendil-works/pi-coding-agent");
  }
  return version;
};
const BUNDLED_PI_VERSION = readBundledPiVersion();

export interface RuntimeCandidate {
  available: boolean;
  command?: string;
  compatible: boolean;
  id: string;
  issue?: string;
  nodePath?: string;
  nodeVersion?: string;
  packageRoot?: string;
  source: RuntimeSourceKind;
  version?: string;
}

export interface CustomRuntimeConfig {
  id?: string;
  nodePath?: string;
  packageRoot: string;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RuntimeDiscoveryOptions {
  commandRunner?: (command: string, args: string[]) => Promise<CommandResult>;
  customRuntimes?: CustomRuntimeConfig[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sourcePaths?: string[];
}

function parseVersion(value: string): string | undefined {
  return value.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

function compareVersions(left: string, right: string): number {
  const [leftCore = "", leftPrerelease] = left.split("-", 2);
  const [rightCore = "", rightPrerelease] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (leftPrerelease === undefined && rightPrerelease !== undefined) return 1;
  if (leftPrerelease !== undefined && rightPrerelease === undefined) return -1;
  if (leftPrerelease === rightPrerelease) return 0;
  const leftIdentifiers = leftPrerelease?.split(".") ?? [];
  const rightIdentifiers = rightPrerelease?.split(".") ?? [];
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index++) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : undefined;
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftIdentifier.localeCompare(rightIdentifier, "en");
  }
  return 0;
}

function isCompatible(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_PI_VERSION) >= 0;
}

function isNodeCompatible(version: string | undefined): boolean {
  return version !== undefined && compareVersions(version, MINIMUM_NODE_VERSION) >= 0;
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      env,
      timeout: 10_000,
      windowsVerbatimArguments:
        process.platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(command),
      windowsHide: true,
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string; stdout?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? failure.message,
      stdout: failure.stdout ?? "",
    };
  }
}

async function findCommands(
  name: string,
  platform: NodeJS.Platform,
  runner: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<string[]> {
  const result = await runner(platform === "win32" ? "where.exe" : "which", [name]);
  if (result.exitCode !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function buildVersionInvocation(command: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform !== "win32") return [command, ["--version"]];
  const extension = extname(command).toLowerCase();
  if (extension === ".ps1") {
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        "--version",
      ],
    ];
  }
  if (extension === ".cmd" || extension === ".bat") {
    const escaped = command.replaceAll('"', '""');
    return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${escaped}" --version"`]];
  }
  return [command, ["--version"]];
}

function windowsCommandPriority(command: string): number {
  switch (extname(command).toLowerCase()) {
    case ".exe":
    case ".com":
      return 0;
    case ".cmd":
    case ".bat":
      return 1;
    case ".ps1":
      return 2;
    default:
      return 3;
  }
}

async function inspectSystemPi(
  platform: NodeJS.Platform,
  runner: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<RuntimeCandidate> {
  const commands = await findCommands("pi", platform, runner);
  const command =
    platform === "win32"
      ? commands.toSorted(
          (left, right) => windowsCommandPriority(left) - windowsCommandPriority(right),
        )[0]
      : commands[0];
  if (!command) {
    return {
      available: false,
      compatible: false,
      id: "system",
      issue: "Pi executable was not found on PATH",
      source: "system",
    };
  }
  const [executable, args] = buildVersionInvocation(command, platform);
  const result = await runner(executable, args);
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  return {
    available: result.exitCode === 0 && version !== undefined,
    command,
    compatible: isCompatible(version),
    id: "system",
    ...(result.exitCode === 0 && version
      ? {}
      : { issue: result.stderr.trim() || "Pi version could not be detected" }),
    source: "system",
    ...(version === undefined ? {} : { version }),
  };
}

async function inspectSourcePi(sourcePath: string, index: number): Promise<RuntimeCandidate> {
  const packageRoot = resolve(sourcePath);
  const manifest = join(packageRoot, "packages", "coding-agent", "package.json");
  if (!existsSync(manifest)) {
    return {
      available: false,
      compatible: false,
      id: `source:${index}`,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      issue: "packages/coding-agent/package.json was not found",
      packageRoot,
      source: "source",
    };
  }
  try {
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version : undefined;
    return {
      available: version !== undefined,
      compatible: isCompatible(version) && isNodeCompatible(process.versions.node),
      id: `source:${index}`,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      packageRoot,
      source: "source",
      ...(version === undefined ? { issue: "Pi source manifest has no version" } : { version }),
    };
  } catch (error) {
    return {
      available: false,
      compatible: false,
      id: `source:${index}`,
      issue: error instanceof Error ? error.message : String(error),
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      packageRoot,
      source: "source",
    };
  }
}

async function inspectCustomPi(
  config: CustomRuntimeConfig,
  index: number,
  runner: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<RuntimeCandidate> {
  const packageRoot = resolve(config.packageRoot);
  const nodePath = resolve(config.nodePath ?? process.execPath);
  const manifests = [
    join(packageRoot, "package.json"),
    join(packageRoot, "packages", "coding-agent", "package.json"),
  ];
  let version: string | undefined;
  let manifestIssue: string | undefined;
  const existingManifests = manifests.filter((candidate) => existsSync(candidate));
  if (existingManifests.length === 0) {
    manifestIssue = "Pi package.json was not found";
  } else {
    for (const manifest of existingManifests) {
      try {
        const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name !== "@earendil-works/pi-coding-agent") continue;
        if (typeof parsed.version !== "string") {
          manifestIssue = "Pi package manifest has no version";
        } else {
          version = parsed.version;
          manifestIssue = undefined;
        }
        break;
      } catch (error) {
        manifestIssue = error instanceof Error ? error.message : String(error);
      }
    }
    if (version === undefined && manifestIssue === undefined) {
      manifestIssue = "@earendil-works/pi-coding-agent package manifest was not found";
    }
  }

  const nodeResult = existsSync(nodePath)
    ? await runner(nodePath, ["--version"])
    : { exitCode: 1, stderr: "Custom Node executable was not found", stdout: "" };
  const nodeVersion = parseVersion(`${nodeResult.stdout}\n${nodeResult.stderr}`);
  const issues = [
    manifestIssue,
    nodeResult.exitCode === 0 && nodeVersion
      ? undefined
      : nodeResult.stderr.trim() || "Custom Node version could not be detected",
  ].filter((issue): issue is string => issue !== undefined);
  return {
    available: version !== undefined && nodeResult.exitCode === 0 && nodeVersion !== undefined,
    compatible: isCompatible(version) && isNodeCompatible(nodeVersion),
    id: `custom:${config.id ?? index}`,
    ...(issues.length === 0 ? {} : { issue: issues.join("; ") }),
    nodePath,
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
    packageRoot,
    source: "custom",
    ...(version === undefined ? {} : { version }),
  };
}

export async function discoverPiRuntimes(
  options: RuntimeDiscoveryOptions = {},
): Promise<RuntimeCandidate[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runner =
    options.commandRunner ??
    ((command: string, args: string[]) => defaultCommandRunner(command, args, env));
  const sourcePaths = [
    ...(options.sourcePaths ?? []),
    ...(env.PIARIUM_PI_SOURCE ? [env.PIARIUM_PI_SOURCE] : []),
  ];
  const uniqueSourcePaths = [...new Set(sourcePaths.map((entry) => resolve(entry)))];
  const customRuntimes = [
    ...(options.customRuntimes ?? []),
    ...(env.PIARIUM_PI_CUSTOM_ROOT
      ? [
          {
            ...(env.PIARIUM_PI_CUSTOM_NODE ? { nodePath: env.PIARIUM_PI_CUSTOM_NODE } : {}),
            packageRoot: env.PIARIUM_PI_CUSTOM_ROOT,
          },
        ]
      : []),
  ];
  const bundled: RuntimeCandidate = {
    available: true,
    compatible: isCompatible(BUNDLED_PI_VERSION) && isNodeCompatible(process.versions.node),
    id: "bundled",
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    source: "bundled",
    version: BUNDLED_PI_VERSION,
  };
  return [
    bundled,
    await inspectSystemPi(platform, runner),
    ...(await Promise.all(uniqueSourcePaths.map(inspectSourcePi))),
    ...(await Promise.all(
      customRuntimes.map((config, index) => inspectCustomPi(config, index, runner)),
    )),
  ];
}
