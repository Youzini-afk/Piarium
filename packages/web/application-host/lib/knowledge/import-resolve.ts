/**
 * Query-time resolution of import specifiers against catalog file paths.
 *
 * Specifiers stay as written on the edge (D-105). Relative specifiers are
 * resolved against the importer directory plus common extensions. Non-relative
 * specifiers and ambiguous relatives stay unresolved and visible (D-135).
 */

export type ImportResolveStatus = "resolved" | "non-relative" | "unresolved-relative";

export type ImportResolveResult =
  | { status: "resolved"; resolvedPath: string }
  | { status: "non-relative" }
  | { status: "unresolved-relative" };

const IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export function normalizeGraphPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function posixJoinResolve(fromDir: string, specifier: string): string {
  const parts = [
    ...(fromDir ? fromDir.split("/").filter((part) => part.length > 0) : []),
    ...specifier.split("/"),
  ];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function typescriptTwins(path: string): string[] {
  if (path.endsWith(".jsx")) return [`${path.slice(0, -4)}.tsx`];
  if (path.endsWith(".mjs")) return [`${path.slice(0, -4)}.mts`];
  if (path.endsWith(".cjs")) return [`${path.slice(0, -4)}.cts`];
  if (path.endsWith(".js")) return [`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`];
  return [];
}

export function resolveImportSpecifier(
  importerPath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): ImportResolveResult {
  if (!isRelativeSpecifier(specifier)) return { status: "non-relative" };
  const importer = normalizeGraphPath(importerPath);
  const slash = importer.lastIndexOf("/");
  const dir = slash === -1 ? "" : importer.slice(0, slash);
  const base = posixJoinResolve(dir, specifier);
  const candidates = new Set<string>([
    base,
    ...IMPORT_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...IMPORT_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ...typescriptTwins(base),
    ...IMPORT_EXTENSIONS.flatMap((ext) => typescriptTwins(`${base}/index${ext}`)),
  ]);
  const hits = [...candidates].filter((path) => knownFiles.has(path));
  if (hits.length === 1) return { status: "resolved", resolvedPath: hits[0]! };
  return { status: "unresolved-relative" };
}
