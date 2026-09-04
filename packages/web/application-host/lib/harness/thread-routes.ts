import type { Express, Request, RequestHandler, Response } from "express";
import type { ThreadRegistry } from "./thread-registry.js";
import { ThreadRuntimeError, type ThreadRuntime } from "./thread-runtime.js";

export interface HarnessThreadRoutesOptions {
  registry: ThreadRegistry;
  runtime: Pick<ThreadRuntime, "createDiscussion" | "convertDiscussion" | "scopeForSession">;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const threadIdOf = (request: Request): string => String(request.params.threadId ?? "").trim();

const sendError = (response: Response, error: unknown, fallback: string): void => {
  if (error instanceof ThreadRuntimeError) {
    const status = error.code === "invalid-request" ? 400
      : error.code === "not-found" ? 404
      : error.code === "conflict" ? 409
      : 503;
    response.status(status).json({ code: error.code, error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : fallback });
};

export function registerHarnessThreadRoutes(
  app: Express,
  { registry, runtime, requireAuth = noAuth }: HarnessThreadRoutesOptions,
): void {
  app.get("/api/harness/sessions/:sessionId/threads", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const { workspaceId, parent } = await runtime.scopeForSession(sessionId);
      const threads = await registry.listThreads(workspaceId, parent);
      const projected = await Promise.all(threads.map(async (thread) => ({
        thread,
        activeRun: await registry.getActiveRun(workspaceId, thread.id),
      })));
      response.json({ workspaceId, parent, threads: projected });
    } catch (error) {
      sendError(response, error, "Unable to read harness threads");
    }
  });

  app.post("/api/harness/sessions/:sessionId/threads", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const parentSessionId = sessionIdOf(request);
    const entryId = typeof request.body?.entryId === "string" ? request.body.entryId.trim() : "";
    const carryBlocks = request.body?.carryBlocks;
    if (!parentSessionId || !entryId || (carryBlocks !== undefined && typeof carryBlocks !== "boolean")) {
      response.status(400).json({ error: "sessionId, entryId, and an optional boolean carryBlocks are required" });
      return;
    }
    try {
      const created = await runtime.createDiscussion({
        parentSessionId,
        entryId,
        ...(carryBlocks === undefined ? {} : { carryBlocks }),
      });
      response.status(201).json(created);
    } catch (error) {
      sendError(response, error, "Unable to create discussion thread");
    }
  });

  app.post(
    "/api/harness/sessions/:sessionId/threads/:threadId/convert",
    requireAuth,
    async (request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      const parentSessionId = sessionIdOf(request);
      const threadId = threadIdOf(request);
      if (!parentSessionId || !threadId) {
        response.status(400).json({ error: "sessionId and threadId are required" });
        return;
      }
      try {
        response.json(await runtime.convertDiscussion({ parentSessionId, threadId }));
      } catch (error) {
        sendError(response, error, "Unable to convert discussion thread");
      }
    },
  );
}
