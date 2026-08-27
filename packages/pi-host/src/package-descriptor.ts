import { readFileSync } from "node:fs";
import { join } from "node:path";

export function packageNameFromSource(source: string): string {
  const value = source.startsWith("npm:") ? source.slice(4) : source;
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const version = slash === -1 ? -1 : value.indexOf("@", slash);
    return version === -1 ? value : value.slice(0, version);
  }
  if (/^[A-Za-z0-9_.-]+(?:@[^@]+)?$/.test(value)) return value.split("@")[0] ?? value;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.git$/i, "") || value;
}

export function packageManifestFromPath(
  installedPath: string | undefined,
): { name?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const manifest = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      ...(typeof manifest.name === "string" && manifest.name.trim().length > 0
        ? { name: manifest.name.trim() }
        : {}),
      ...(typeof manifest.version === "string" && manifest.version.trim().length > 0
        ? { version: manifest.version.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}
