import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createFsSearchRuntime } from "./search.js";

/**
 * `search.ts` is a shared hot path: the workbench file picker, the language
 * distribution on the settings page, and the cold catalog scan all call it. The
 * ignore lookup used to cost one `git check-ignore` process per directory, so
 * these tests pin the invocation count as much as the filtering (D-140).
 */

interface FakeGit {
  calls: Array<{ args: readonly string[]; cwd: string }>;
}

const fakeSpawn = (git: FakeGit, reply: (args: readonly string[]) => { stdout: string; code: number; stderr?: string }) => (
  (_binary: string, args: readonly string[], options: { cwd: string }) => {
    git.calls.push({ args, cwd: options.cwd });
    const { stdout, code, stderr } = reply(args);
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const on = (event: string, handler: (value?: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    };
    queueMicrotask(() => {
      if (code === 0 && stdout) {
        for (const handler of listeners.get("data") ?? []) handler(Buffer.from(stdout, "utf8"));
      }
      if (stderr) {
        for (const handler of listeners.get("stderr-data") ?? []) handler(Buffer.from(stderr, "utf8"));
      }
      for (const handler of listeners.get("close") ?? []) handler(code);
    });
    return {
      stdout: { on: (event: string, handler: (value?: unknown) => void) => on(event, handler) },
      stderr: { on: (event: string, handler: (value?: unknown) => void) => on(`stderr-${event}`, handler) },
      on: (event: string, handler: (value?: unknown) => void) => on(event, handler),
      kill: () => undefined,
    };
  }
);

const workspace = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "piarium-fs-search-"));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(path.join(root, "build"), { recursive: true });
  mkdirSync(path.join(root, "generated"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const app = 1;\n", "utf8");
  writeFileSync(path.join(root, "src", "deep", "nested.ts"), "export const nested = 1;\n", "utf8");
  writeFileSync(path.join(root, "build", "app.js"), "1;\n", "utf8");
  writeFileSync(path.join(root, "generated", "schema.ts"), "1;\n", "utf8");
  return root;
};

const runtimeFor = (git: FakeGit, reply: (args: readonly string[]) => { stdout: string; code: number; stderr?: string }) => (
  createFsSearchRuntime({
    fsPromises,
    path,
    spawn: fakeSpawn(git, reply),
    resolveGitBinaryForSpawn: () => "git",
  })
);

const listed = (...paths: readonly string[]) => ({ stdout: `${paths.join("\0")}\0`, code: 0 });

describe("searchFilesystemFiles", () => {
  it("applies the catalog ignore policy to individual mutations, including tracked ignored files", async () => {
    const root = workspace();
    const runtime = createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn: () => "git" });
    try {
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(path.join(root, ".gitignore"), "generated/\n");
      expect(await runtime.isSearchableFile(root, "generated/schema.ts")).toBe(false);
      expect(await runtime.isSearchableFile(root, "src/app.ts")).toBe(true);
      expect(await runtime.isSearchableFile(root, "build/app.js")).toBe(false);
      expect(await runtime.isSearchableFile(root, "../outside.ts")).toBe(false);
      execFileSync("git", ["-C", root, "add", "-f", "--", "generated/schema.ts"]);
      expect(await runtime.isSearchableFile(root, "generated/schema.ts")).toBe(true);
    } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
  });

  it("allows ordinary files in non-Git workspaces but does not treat Git failure as permission", async () => {
    const root = workspace();
    try {
      const runtime = createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn: () => "git" });
      expect(await runtime.isSearchableFile(root, "src/app.ts")).toBe(true);
      const broken = runtimeFor({ calls: [] }, () => ({ code: 128, stdout: "" }));
      await expect(broken.isSearchableFile(root, "src/app.ts")).rejects.toThrow(/could not determine/);
    } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
  });
  it("asks git once for the whole tree instead of once per directory", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => listed("src/app.ts", "src/deep/nested.ts"));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: true });

    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.args).toEqual(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    expect(git.calls[0]?.cwd).toBe(root);
    expect(files.enumerationStatus).toBe("complete");
    expect(files.map((file) => file.relativePath).toSorted()).toEqual(["src/app.ts", "src/deep/nested.ts"]);
  });

  it("drops an ignored file and never descends a directory with nothing tracked in it", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => listed("src/app.ts"));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: true });

    // `generated/` is not excluded by name, so only the ignore lookup keeps it out.
    expect(files.map((file) => file.relativePath)).toEqual(["src/app.ts"]);
  });

  it("keeps a tracked file that a gitignore rule also matches", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    // `--cached` reports force-added files, so being listed is the answer.
    const runtime = runtimeFor(git, () => listed("src/app.ts", "generated/schema.ts"));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: true });

    expect(files.map((file) => file.relativePath).toSorted()).toEqual(["generated/schema.ts", "src/app.ts"]);
  });

  it("falls back to an unfiltered walk when the directory is not a Git work tree", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => ({ stdout: "", code: 128, stderr: "fatal: not a git repository" }));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: true });

    expect(git.calls).toHaveLength(1);
    // No rule could be read, so nothing is claimed to be ignored. `build/` is
    // still absent because it is an excluded directory name.
    expect(files.map((file) => file.relativePath).toSorted()).toEqual([
      "generated/schema.ts",
      "src/app.ts",
      "src/deep/nested.ts",
    ]);
    expect(files.enumerationStatus).toBe("complete");
  });

  it("does not run git at all when the caller does not want ignore rules", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => listed("src/app.ts"));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: false });

    expect(git.calls).toEqual([]);
    expect(files.map((file) => file.relativePath)).toContain("generated/schema.ts");
  });

  it("still fuzzy matches and honours the limit over the filtered set", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => listed("src/app.ts", "src/deep/nested.ts"));

    const files = await runtime.searchFilesystemFiles(root, { query: "nested", respectGitignore: true, limit: 1 });

    expect(files.map((file) => file.relativePath)).toEqual(["src/deep/nested.ts"]);
    expect(files.enumerationStatus).toBe("incomplete");
  });

  it("keeps a Git inventory failure distinct from a limited complete walk", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => ({ stdout: "", code: 2, stderr: "fatal: repository unavailable" }));

    const files = await runtime.searchFilesystemFiles(root, { query: "", respectGitignore: true, limit: 1 });

    expect(files.enumerationStatus).toBe("failed");
  });

  it("rejects when the caller aborts", async () => {
    const root = workspace();
    const git: FakeGit = { calls: [] };
    const runtime = runtimeFor(git, () => listed("src/app.ts"));
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.searchFilesystemFiles(root, {
      query: "",
      respectGitignore: true,
      signal: controller.signal,
    })).rejects.toThrow();
    expect(git.calls).toEqual([]);
  });
});
