import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

interface LeaseRecord {
  createdAt: string;
  pid: number;
  token: string;
}

export interface FileLeaseOptions {
  pollMs?: number;
  timeoutMs?: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLease(path: string): Promise<LeaseRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseRecord>;
    if (
      typeof value.pid === "number" &&
      typeof value.token === "string" &&
      typeof value.createdAt === "string"
    ) {
      return value as LeaseRecord;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  return undefined;
}

export class FileLease {
  readonly #path: string;
  readonly #token: string;
  #released = false;

  private constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
  }

  static async acquire(path: string, options: FileLeaseOptions = {}): Promise<FileLease> {
    const pollMs = options.pollMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    const token = randomUUID();
    await mkdir(dirname(path), { recursive: true });

    while (true) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          const record: LeaseRecord = {
            createdAt: new Date().toISOString(),
            pid: process.pid,
            token,
          };
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new FileLease(path, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const current = await readLease(path);
      if (current && !processIsAlive(current.pid)) {
        await rm(path, { force: true });
        continue;
      }
      if (!current) {
        const modifiedAt = await stat(path).then(
          (entry) => entry.mtimeMs,
          () => Date.now(),
        );
        const age = Date.now() - modifiedAt;
        if (age > 60_000) {
          await rm(path, { force: true });
          continue;
        }
      }
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for the workspace recovery lease");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readLease(this.#path);
    if (current?.token === this.#token) await rm(this.#path, { force: true });
  }
}
