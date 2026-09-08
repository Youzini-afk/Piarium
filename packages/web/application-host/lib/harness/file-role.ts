/**
 * Query-time file role for explore and related (plan 3.15②, D-164).
 *
 * Classification is a decoration of the current path string. It is not stored
 * on the symbol graph — test-root layout and project manifests change, and a
 * persisted role would need its own invalidation.
 */

import type { ExploreQueryDomain, HarnessFileRole, HarnessFileRoleGround } from "@piarium/protocol";

export type ExploreFileRole = HarnessFileRole;
export type FileRoleGround = HarnessFileRoleGround;

export interface FileRoleDecision {
  role: HarnessFileRole;
  ground: HarnessFileRoleGround;
}

const PROJECT_DECLARATION_NAMES = new Set([
  "package.json",
  "package.json5",
  "jsconfig.json",
  "cargo.toml",
  "pyproject.toml",
  "go.mod",
  "go.work",
  "composer.json",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "deno.json",
  "deno.jsonc",
  "bunfig.toml",
]);

function isLockName(base: string): boolean {
  return (
    base === "license"
    || base === "licence"
    || base.startsWith("changelog")
    || base === "bun.lock"
    || base === "package-lock.json"
    || base === "yarn.lock"
    || base === "pnpm-lock.yaml"
    || base.endsWith(".lock")
  );
}

function isTestPath(normalized: string, base: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(base)
    || /(^|\/)tests?\//.test(normalized)
    || /(^|\/)__tests__\//.test(normalized)
  );
}

function isProjectDeclaration(base: string): boolean {
  return PROJECT_DECLARATION_NAMES.has(base) || /^tsconfig(\.[a-z0-9_-]+)?\.json$/.test(base);
}

export function classifyFileRoleDecision(path: string): FileRoleDecision {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (isLockName(base)) return { role: "lock", ground: "filename-pattern" };
  if (normalized.startsWith("docs/") || base.endsWith(".md")) return { role: "docs", ground: "filename-pattern" };
  if (isTestPath(normalized, base)) return { role: "test", ground: "filename-pattern" };
  if (/\.[cm]?[tj]sx?$/.test(base)) return { role: "source", ground: "filename-pattern" };
  if (isProjectDeclaration(base)) return { role: "other", ground: "project-declaration" };
  return { role: "other", ground: "unknown" };
}

export function classifyFileRole(path: string): ExploreFileRole {
  return classifyFileRoleDecision(path).role;
}

/**
 * File-role fit for this question. Structure-source availability must not
 * enter this function (D-148).
 */
export function fileRoleFit(
  role: ExploreFileRole,
  domain: ExploreQueryDomain,
  preferTests: boolean | null,
): number {
  if (domain === "dependency") return role === "lock" ? 2 : role === "docs" ? 0 : -1;
  if (domain === "design") return role === "docs" ? 2 : role === "source" ? 0 : -1;
  if (domain === "implementation") {
    if (role === "lock") return -2;
    if (role === "docs") return -1;
    if (role === "source") return preferTests === true ? 0 : 2;
    if (role === "test") return preferTests === true ? 2 : preferTests === false ? 0 : 1;
    return 0;
  }
  if (preferTests === true) return role === "test" ? 2 : 0;
  if (preferTests === false) return role === "test" ? 0 : role === "source" ? 1 : 0;
  return 0;
}
