import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HarnessActorContext } from "@piarium/protocol";
import { createHarnessPathAuthority } from "./path-authority.js";

const actor = (workspaceId = "workspace-1"): HarnessActorContext => ({
  authorityInstanceId: "broker-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId,
  grantedCapabilities: ["write.document"],
});

describe("harness path authority", () => {
  it("returns a canonical resource identity only for paths inside the actor workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-path-"));
    const file = join(root, "file.ts");
    writeFileSync(file, "x");
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    try {
      const relative = await authority.resolve(actor(), "file.ts", { allowMissing: false });
      const absolute = await authority.resolve(actor(), file, { allowMissing: false });
      expect(relative?.canonicalResourceId).toBe(absolute?.canonicalResourceId);
      expect(relative).toMatchObject({ authorityId: "host-1", workspaceId: "workspace-1", inputPath: "file.ts" });
      expect(await authority.resolve(actor(), join(root, "..", "outside.ts"), { allowMissing: true })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("folds Windows dot segments and case through the shared Documents identity rules", async () => {
    const pathModule = path.win32 as unknown as typeof path;
    const fakeFs = {
      realpath: async (value: string) => path.win32.normalize(value).replace(/^d:\\workspace/i, "D:\\Workspace"),
      stat: async () => ({ isDirectory: () => false }),
    };
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root: "D:\\Workspace" }) },
      fsPromises: fakeFs,
      pathModule,
      platform: "win32",
    });
    const first = await authority.resolve(actor(), "D:\\A\\..\\Workspace\\File.ts", { allowMissing: false });
    const second = await authority.resolve(actor(), "d:\\workspace\\file.TS", { allowMissing: false });
    expect(first?.canonicalResourceId).toBe("d:\\workspace\\file.ts");
    expect(second?.canonicalResourceId).toBe(first?.canonicalResourceId);
  });

  it("does not convert document authority failures into an outside-workspace answer", async () => {
    const failure = Object.assign(new Error("registry unreadable"), { code: "EACCES" });
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => { throw failure; } },
      fsPromises: fs.promises,
    });
    await expect(authority.resolve(actor(), "file.ts", { allowMissing: false })).rejects.toBe(failure);
  });

  it("restricts a child actor to its broker-pinned workspace scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-scope-"));
    const allowed = join(root, "packages", "web");
    fs.mkdirSync(allowed, { recursive: true });
    writeFileSync(join(allowed, "inside.ts"), "inside");
    writeFileSync(join(root, "outside.ts"), "outside");
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    const scoped = { ...actor(), workspaceScope: ["packages/web"] };
    try {
      await expect(authority.resolve(scoped, "packages/web/inside.ts", { allowMissing: false })).resolves.not.toBeNull();
      await expect(authority.resolve(scoped, "outside.ts", { allowMissing: false })).resolves.toBeNull();
      await expect(authority.resolve(scoped, "packages/ui/new.ts", { allowMissing: true })).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
