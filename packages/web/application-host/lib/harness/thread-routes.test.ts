import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerHarnessThreadRoutes } from "./thread-routes.js";
import { ThreadRuntimeError } from "./thread-runtime.js";

describe("harness thread routes", () => {
  it("projects the Host registry from an authoritative session scope", async () => {
    const app = express();
    const thread = { id: "thread-1", brief: "test" };
    registerHarnessThreadRoutes(app, {
      registry: {
        listThreads: vi.fn(async () => [thread]),
        getActiveRun: vi.fn(async () => ({ id: "run-1", workerState: "running" })),
      } as never,
      runtime: {
        scopeForSession: vi.fn(async () => ({
          workspaceId: "workspace-1",
          parent: { kind: "session", id: "session-1" },
          snapshot: {},
        })),
      } as never,
    });
    const response = await request(app).get("/api/harness/sessions/session-1/threads").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      threads: [{ thread, activeRun: { id: "run-1", workerState: "running" } }],
    });
  });

  it("creates and converts discussions without accepting a caller-supplied workspace identity", async () => {
    const app = express();
    app.use(express.json());
    const created = {
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "session-1" },
      thread: { id: "thread-1", kind: "discussion" },
      activeRun: { id: "run-1", sessionId: "child-1" },
    };
    const createDiscussion = vi.fn(async () => created);
    const convertDiscussion = vi.fn(async () => ({
      ...created,
      thread: { id: "thread-1", kind: "implementation" },
      activeRun: { id: "run-2", sessionId: "child-1" },
    }));
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: { createDiscussion, convertDiscussion } as never,
    });

    const createResponse = await request(app)
      .post("/api/harness/sessions/session-1/threads")
      .send({ entryId: "entry-1", carryBlocks: false, workspaceId: "spoofed" })
      .expect(201);
    expect(createResponse.body).toEqual(created);
    expect(createDiscussion).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      entryId: "entry-1",
      carryBlocks: false,
    });

    await request(app)
      .post("/api/harness/sessions/session-1/threads/thread-1/convert")
      .send({ workspaceId: "spoofed" })
      .expect(200);
    expect(convertDiscussion).toHaveBeenCalledWith({ parentSessionId: "session-1", threadId: "thread-1" });
  });

  it("keeps stale fork points distinct from malformed input", async () => {
    const app = express();
    app.use(express.json());
    registerHarnessThreadRoutes(app, {
      registry: {} as never,
      runtime: {
        createDiscussion: vi.fn(async () => {
          throw new ThreadRuntimeError("conflict", "message left the branch");
        }),
      } as never,
    });
    await request(app)
      .post("/api/harness/sessions/session-1/threads")
      .send({ entryId: "entry-old" })
      .expect(409, { code: "conflict", error: "message left the branch" });
  });

  it("runs UI authentication before exposing thread metadata", async () => {
    const app = express();
    const listThreads = vi.fn();
    registerHarnessThreadRoutes(app, {
      registry: { listThreads } as never,
      runtime: { scopeForSession: vi.fn() } as never,
      requireAuth: (_req, res) => { res.status(401).json({ error: "auth required" }); },
    });
    await request(app)
      .get("/api/harness/sessions/session-1/threads")
      .expect(401);
    expect(listThreads).not.toHaveBeenCalled();
  });
});
