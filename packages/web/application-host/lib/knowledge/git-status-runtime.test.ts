import { describe, expect, it, vi } from "vitest";
import { createGitStatusObserver } from "./git-status-runtime.js";

describe("Git status observer adapter", () => {
  it("resolves the containing Documents workspace before publishing", async () => {
    const observe = vi.fn();
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async (scope) => scope === "/workspace/repo" ? "workspace-1" : null,
      observe,
    });
    observer("/workspace/repo", { current: "main", files: [{ path: "a.ts" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledWith({ workspaceId: "workspace-1", branch: "main", changed: 1 });

    observer("/outside", { current: "main", files: [] });
    observer("/workspace/repo", { isGitRepository: false, files: [] });
    await Promise.resolve();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("reports workspace-resolution failures without throwing into the route", async () => {
    const onError = vi.fn();
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async () => { throw new Error("registry unavailable"); },
      observe: vi.fn(),
      onError,
    });
    expect(() => observer("/workspace", { current: "main", files: [] })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "registry unavailable" }));
  });
});
