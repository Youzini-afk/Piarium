import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const RUNTIME_SELECTION_FILE = "runtime-selection.json";

export interface PersistedRuntimeSelection {
  selectedId?: string;
  customNodePath?: string;
  customPackageRoot?: string;
}

export type RuntimeSelectionLoadResult =
  | { status: "missing" }
  | { issue: string; status: "malformed" }
  | { selection: PersistedRuntimeSelection; status: "ok" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseSelection(value: unknown, path: string): PersistedRuntimeSelection {
  if (!isRecord(value)) {
    throw new Error(`Runtime selection must be an object: ${path}`);
  }
  const selectedId = value.selectedId;
  const customPackageRoot = value.customPackageRoot;
  const customNodePath = value.customNodePath;
  if (selectedId !== undefined && typeof selectedId !== "string") {
    throw new Error(`Runtime selection selectedId must be a string: ${path}`);
  }
  if (customPackageRoot !== undefined && typeof customPackageRoot !== "string") {
    throw new Error(`Runtime selection customPackageRoot must be a string: ${path}`);
  }
  if (customNodePath !== undefined && typeof customNodePath !== "string") {
    throw new Error(`Runtime selection customNodePath must be a string: ${path}`);
  }
  return {
    ...(selectedId === undefined || selectedId.trim() === "" ? {} : { selectedId }),
    ...(customPackageRoot === undefined || customPackageRoot.trim() === ""
      ? {}
      : { customPackageRoot }),
    ...(customNodePath === undefined || customNodePath.trim() === "" ? {} : { customNodePath }),
  };
}

export function runtimeSelectionPath(dataDir: string): string {
  return join(dataDir, RUNTIME_SELECTION_FILE);
}

export async function loadRuntimeSelection(dataDir: string): Promise<RuntimeSelectionLoadResult> {
  const path = runtimeSelectionPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    return {
      issue: error instanceof Error ? error.message : String(error),
      status: "malformed",
    };
  }
  if (raw.trim() === "") {
    return { issue: `Runtime selection file is empty: ${path}`, status: "malformed" };
  }
  try {
    return { selection: parseSelection(JSON.parse(raw), path), status: "ok" };
  } catch (error) {
    return {
      issue: error instanceof Error ? error.message : String(error),
      status: "malformed",
    };
  }
}

export async function saveRuntimeSelection(
  dataDir: string,
  selection: PersistedRuntimeSelection,
): Promise<void> {
  const path = runtimeSelectionPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(selection, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
