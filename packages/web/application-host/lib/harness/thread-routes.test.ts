import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerHarnessThreadRoutes } from "./thread-routes.js";

describe("harness thread routes", () => {
  it("projects the Host registry for one trusted workspace parent", async () => {
    let route: ((request: unknown, response: unknown) => Promise<void>) | undefined;
    const app = {
      get: vi.fn((_path: string, ...handlers: Array<typeof route>) => { route = handlers[handlers.length - 1]; }),
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
    const app = { get: (_path: string, ...handlers: Array<typeof route>) => { route = handlers[handlers.length - 1]; } };
    const listThreads = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    registerHarnessThreadRoutes(app as never, { registry: { listThreads } as never });
    await route?.({ query: { workspaceId: "workspace-1", parentKind: "other" } }, { json, setHeader, status });
    expect(status).toHaveBeenCalledWith(400);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("runs UI authentication before exposing thread metadata", async () => {
    const app = express();
    const listThreads = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: { listThreads } as never,
      requireAuth: (_req, res) => { res.status(401).json({ error: "auth required" }); },
    });
    await request(app)
      .get("/api/harness/threads?workspaceId=workspace-1&parentId=session-1")
      .expect(401);
    expect(listThreads).not.toHaveBeenCalled();
  });
});
