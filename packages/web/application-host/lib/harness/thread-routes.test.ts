import { describe, expect, it, vi } from "vitest";
import { registerHarnessThreadRoutes } from "./thread-routes.js";

describe("harness thread routes", () => {
  it("projects the Host registry for one trusted workspace parent", async () => {
    let route: ((request: unknown, response: unknown) => Promise<void>) | undefined;
    const app = {
      get: vi.fn((_path: string, handler: typeof route) => { route = handler; }),
    };
    const thread = { id: "thread-1", brief: "test" };
    registerHarnessThreadRoutes(app as never, {
      registry: {
        listThreads: vi.fn(async () => [thread]),
        getActiveRun: vi.fn(async () => ({ id: "run-1", workerState: "running" })),
      } as never,
    });
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    await route?.({ query: { workspaceId: "workspace-1", parentId: "session-1" } }, { json, setHeader, status });
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(json).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      threads: [{ thread, activeRun: { id: "run-1", workerState: "running" } }],
    });
  });

  it("rejects a malformed scope before reading the registry", async () => {
    let route: ((request: unknown, response: unknown) => Promise<void>) | undefined;
    const app = { get: (_path: string, handler: typeof route) => { route = handler; } };
    const listThreads = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    registerHarnessThreadRoutes(app as never, { registry: { listThreads } as never });
    await route?.({ query: { workspaceId: "workspace-1", parentKind: "other" } }, { json, setHeader, status });
    expect(status).toHaveBeenCalledWith(400);
    expect(listThreads).not.toHaveBeenCalled();
  });
});
