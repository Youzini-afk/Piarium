import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STANDALONE_RUNTIME_MANIFEST = "pi-runtime.manifest.json";

export interface StandaloneRuntimeManifest {
  name: "pi-runtime";
  nodeVersion: string;
  sha256: string;
  version: string;
}

export interface StandaloneRuntimeLocations {
  binDir: string;
  commandPath: string;
  runtimeDir: string;
}

export function standaloneRuntimeLocations(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneRuntimeLocations {
  if (platform === "win32") {
    const root = join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Pi");
    const binDir = join(root, "bin");
    return {
      binDir,
      commandPath: join(binDir, "pi.cmd"),
      runtimeDir: join(root, "runtime"),
    };
  }
  const runtimeDir = join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi", "runtime");
  const binDir = join(env.XDG_BIN_HOME || join(homedir(), ".local", "bin"));
  return {
    binDir,
    commandPath: join(binDir, "pi"),
    runtimeDir,
  };
}

export function readStandaloneManifest(path: string): StandaloneRuntimeManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StandaloneRuntimeManifest>;
  if (parsed.name !== "pi-runtime" || typeof parsed.version !== "string" || typeof parsed.sha256 !== "string") {
    throw new Error(`Invalid standalone Pi runtime manifest: ${path}`);
  }
  return {
    name: "pi-runtime",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "",
    sha256: parsed.sha256,
    version: parsed.version,
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyStandalonePayload(archivePath: string, expectedSha256: string): void {
  const actual = sha256File(archivePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`Standalone Pi runtime SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

export function standaloneManifestPath(payloadDir: string): string {
  return resolve(payloadDir, STANDALONE_RUNTIME_MANIFEST);
}

export function standalonePayloadLooksPresent(payloadDir: string): boolean {
  return existsSync(standaloneManifestPath(payloadDir));
}
