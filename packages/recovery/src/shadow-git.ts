import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RecoveryFileChange, RecoveryFileChangeKind } from "@piarium/protocol";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const EXCLUDES = [
  ".git/",
  "**/.git/",
  "node_modules/",
  "**/node_modules/",
  ".pi/workspace-history/",
  ".piarium/",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".ssh/",
  ".aws/",
  ".azure/",
  "credentials.json",
  "credentials.*.json",
  "secrets.json",
  "secrets.*.json",
];

interface CommandResult {
  stderr: string;
  stdout: string;
}

function runFile(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    execFile(
      executable,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        encoding: "utf8",
        env: { ...process.env, ...options.env },
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout).trim();
          reject(new Error(detail || error.message, { cause: error }));
          return;
        }
        resolveCommand({ stderr: String(stderr), stdout: String(stdout) });
      },
    );
  });
}

function parseNullList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function changeKind(status: string): RecoveryFileChangeKind {
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
}

export interface ShadowGitStoreOptions {
  cwd: string;
  excludePaths?: string[];
  gitPath?: string;
  root: string;
}

export class ShadowGitStore {
  readonly cwd: string;
  readonly gitPath: string;
  readonly root: string;
  readonly #gitDir: string;
  readonly #extraExcludes: string[];
  #ready = false;
  #version: string | undefined;

  constructor(options: ShadowGitStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.root = resolve(options.root);
    this.gitPath = options.gitPath ?? process.env.PIARIUM_GIT_PATH ?? "git";
    this.#gitDir = join(this.root, ".git");
    this.#extraExcludes = (options.excludePaths ?? []).flatMap((path) => {
      const fromRoot = relative(this.cwd, resolve(path));
      if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return [];
      const escaped = fromRoot.replaceAll("\\", "/").replaceAll(/([*?[\]!#])/g, "\\$1");
      return [`/${escaped}/`];
    });
  }

  async ensure(): Promise<string> {
    if (this.#ready && this.#version) return this.#version;
    if (!this.#ready) {
      const cwdInfo = await stat(this.cwd);
      if (!cwdInfo.isDirectory()) throw new Error("Recovery workspace is not a directory");
      await mkdir(this.root, { recursive: true });
      try {
        await stat(this.#gitDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await runFile(this.gitPath, ["init", "--quiet", this.root]);
      }
      await mkdir(join(this.#gitDir, "info"), { recursive: true });
      await writeFile(
        join(this.#gitDir, "info", "exclude"),
        `${[...EXCLUDES, ...this.#extraExcludes].join("\n")}\n`,
        "utf8",
      );
      this.#ready = true;
    }
    const version = await runFile(this.gitPath, ["--version"]);
    this.#version = version.stdout.trim();
    return this.#version;
  }

  async snapshot(label: string): Promise<string> {
    await this.ensure();
    await this.#validateManagedFiles();
    await this.#run(["add", "-A", "--", "."]);
    const ignored = parseNullList(
      (await this.#run(["ls-files", "-ci", "--exclude-standard", "-z"])).stdout,
    );
    for (let offset = 0; offset < ignored.length; offset += 100) {
      await this.#run([
        "update-index",
        "--force-remove",
        "--",
        ...ignored.slice(offset, offset + 100),
      ]);
    }
    const tree = (await this.#run(["write-tree"])).stdout.trim();
    const head = await this.currentHead();
    if (head) {
      const currentTree = (await this.#run(["rev-parse", `${head}^{tree}`])).stdout.trim();
      if (currentTree === tree) {
        await this.#retain(head);
        return head;
      }
    }
    const commit = (
      await this.#run(["commit-tree", tree, "-m", label], {
        GIT_AUTHOR_EMAIL: "recovery@piarium.local",
        GIT_AUTHOR_NAME: "Piarium Recovery",
        GIT_COMMITTER_EMAIL: "recovery@piarium.local",
        GIT_COMMITTER_NAME: "Piarium Recovery",
      })
    ).stdout.trim();
    await this.#run(["update-ref", "HEAD", commit]);
    await this.#retain(commit);
    return commit;
  }

  async currentHead(): Promise<string | undefined> {
    try {
      return (await this.#run(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    } catch {
      return undefined;
    }
  }

  async diff(fromCommit: string, toCommit: string): Promise<RecoveryFileChange[]> {
    await this.ensure();
    const parts = parseNullList(
      (await this.#run(["diff", "--name-status", "--no-renames", "-z", fromCommit, toCommit, "--"]))
        .stdout,
    );
    const changes: RecoveryFileChange[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const status = parts[index];
      const path = parts[index + 1];
      if (status && path) changes.push({ kind: changeKind(status), path });
    }
    return changes;
  }

  async sameTree(left: string, right: string): Promise<boolean> {
    await this.ensure();
    const [leftTree, rightTree] = await Promise.all([
      this.#run(["rev-parse", `${left}^{tree}`]),
      this.#run(["rev-parse", `${right}^{tree}`]),
    ]);
    return leftTree.stdout.trim() === rightTree.stdout.trim();
  }

  async restore(commit: string): Promise<void> {
    await this.ensure();
    await this.#run(["cat-file", "-e", `${commit}^{commit}`]);
    await this.#run(["reset", "--hard", "--quiet", commit]);
    await this.#run(["clean", "-fdq", "--", "."]);
  }

  async prune(retainedCommits: ReadonlySet<string>): Promise<number> {
    await this.ensure();
    const head = await this.currentHead();
    const retained = new Set(retainedCommits);
    if (head) retained.add(head);
    const references = (
      await this.#run(["for-each-ref", "--format=%(refname)", "refs/piarium/checkpoints"])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    let removed = 0;
    for (const reference of references) {
      const commit = reference.slice(reference.lastIndexOf("/") + 1);
      if (retained.has(commit)) continue;
      await this.#run(["update-ref", "-d", reference]);
      removed++;
    }
    if (removed > 0) {
      await this.#run(["reflog", "expire", "--expire=now", "--all"]);
      await this.#run(["gc", "--prune=now", "--quiet"]);
    }
    return removed;
  }

  async #retain(commit: string): Promise<void> {
    await this.#run(["update-ref", `refs/piarium/checkpoints/${commit}`, commit]);
  }

  async #validateManagedFiles(): Promise<void> {
    const paths = parseNullList(
      (await this.#run(["ls-files", "-co", "--exclude-standard", "-z", "--"])).stdout,
    );
    if (paths.length > MAX_FILES) throw new Error(`Recovery file limit exceeded (${MAX_FILES})`);
    let total = 0;
    for (const path of paths) {
      const absolute = resolve(this.cwd, path);
      const fromRoot = relative(this.cwd, absolute);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(`Recovery path escapes the workspace: ${path}`);
      }
      let info: Stats;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink()) continue;
      if (!info.isFile()) throw new Error(`Unsupported recovery path type: ${path}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`Recovery file exceeds 50 MiB: ${path}`);
      total += info.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("Recovery workspace exceeds 1 GiB");
    }
  }

  #run(args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
    return runFile(
      this.gitPath,
      [
        `--git-dir=${this.#gitDir}`,
        `--work-tree=${this.cwd}`,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.filemode=false",
        "-c",
        "core.excludesFile=",
        "-c",
        "core.quotepath=false",
        ...args,
      ],
      { cwd: this.cwd, ...(env === undefined ? {} : { env }) },
    );
  }
}
