import { cp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safePackageRoot = join(root, "node_modules", "brace-expansion");
const nestedPackageRoot = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "brace-expansion",
);
const checkOnly = process.argv.includes("--check");
const minimumVersion = [5, 0, 8];

async function readVersion(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.version !== "string") {
    throw new Error(`Missing package version in ${packageRoot}`);
  }
  return manifest.version;
}

function isAtLeast(version, minimum) {
  const [core, prerelease] = version.split("-", 2);
  const parsed = core.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    const actual = parsed[index] ?? 0;
    if (actual > minimum[index]) return true;
    if (actual < minimum[index]) return false;
  }
  return prerelease === undefined;
}

const safeVersion = await readVersion(safePackageRoot);
if (!isAtLeast(safeVersion, minimumVersion)) {
  throw new Error(`Piarium's locked brace-expansion copy is unsafe: ${safeVersion}`);
}

let nestedVersion;
try {
  nestedVersion = await readVersion(nestedPackageRoot);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (nestedVersion !== undefined && !isAtLeast(nestedVersion, minimumVersion)) {
  if (checkOnly) {
    throw new Error(
      `Pi's npm shrinkwrap restored vulnerable brace-expansion ${nestedVersion}; run npm install to repair it`,
    );
  }
  await rm(nestedPackageRoot, { force: true, recursive: true });
  await cp(safePackageRoot, nestedPackageRoot, { recursive: true });
  nestedVersion = await readVersion(nestedPackageRoot);
  process.stdout.write(`Repaired Pi dependency brace-expansion ${nestedVersion}\n`);
}

if (nestedVersion !== undefined && !isAtLeast(nestedVersion, minimumVersion)) {
  throw new Error(`Pi's resolved brace-expansion copy is unsafe: ${nestedVersion}`);
}
