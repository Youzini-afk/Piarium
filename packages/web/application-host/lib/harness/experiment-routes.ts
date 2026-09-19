import type { Express, Request, RequestHandler, Response } from "express";
import { once } from "node:events";
import type { ExperimentAttemptState, ExperimentLogsResult } from "@piarium/protocol";
import type { ExperimentService } from "./experiments.js";
import type { ResourceService } from "./resources.js";
import type { SourceService } from "./sources.js";
import type { ThreadRuntime } from "./thread-runtime.js";
import { ThreadRuntimeError } from "./thread-runtime.js";
import { HarnessServiceError } from "./service-error.js";
import type { ThreadRegistry } from "./thread-registry.js";
import { resolveResearchCaller } from "./research-access.js";

/**
 * UI-facing experiment/resource/source routes (7F, D-300).
 *
 * The workbench reads the same durable facts the agent tools manage: the
 * session's owning workspace scopes every lookup, and the caller carries the
 * real session identity — the UI never impersonates a Thread peer. Control
 * actions (cancel/collect) go through the same service methods as the
 * `experiment` tool so semantics stay identical.
 */
export interface HarnessExperimentRoutesOptions {
  runtime: Pick<ThreadRuntime, "scopeForSession">;
  experiments: ExperimentService;
  resources: ResourceService;
  sources: SourceService;
  registry: Pick<ThreadRegistry, "getSessionBinding" | "getThreadById" | "listThreads">;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();
const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const attemptIdOf = (request: Request): string => String(request.params.attemptId ?? "").trim();

const ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "submitted", "queued", "running", "stopping", "completed", "failed", "cancelled", "lost",
]);

const integerQuery = (request: Request, name: string, minimum: number): number | undefined => {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)
    || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new HarnessServiceError("invalid-params", `${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
};

const sendError = (response: Response, error: unknown, fallback: string): void => {
  if (error instanceof HarnessServiceError) {
    const status = error.harnessCode === "invalid-params" ? 400
      : error.harnessCode === "not-found" ? 404
        : error.harnessCode === "denied" || error.harnessCode === "forbidden" ? 403
          : error.harnessCode === "unavailable" || error.harnessCode === "timeout" || error.harnessCode === "expired" ? 503
            : 500;
    response.status(status).json({ code: error.harnessCode, error: error.message });
    return;
  }
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

export function registerHarnessExperimentRoutes(
  app: Express,
  { runtime, registry, experiments, resources, sources, requireAuth = noAuth }: HarnessExperimentRoutesOptions,
): void {
  const callerFor = async (sessionId: string) => {
    const scope = await runtime.scopeForSession(sessionId);
    return resolveResearchCaller(registry, {
      workspaceId: scope.workspaceId,
      executionWorkspaceId: scope.workspaceId,
      sessionId,
      user: true,
    });
  };

  app.get("/api/harness/sessions/:sessionId/experiments", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      if (request.query.state !== undefined && (typeof request.query.state !== "string" || !ATTEMPT_STATES.has(request.query.state))) {
        throw new HarnessServiceError("invalid-params", "Unknown experiment state");
      }
      const state = request.query.state as ExperimentAttemptState | undefined;
      const limit = integerQuery(request, "limit", 0);
      const result = await experiments.list(caller, {
        ...(state ? { state } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to list experiments");
    }
  });

  app.get("/api/harness/sessions/:sessionId/experiments/:attemptId", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    const attemptId = attemptIdOf(request);
    if (!sessionId || !attemptId) {
      response.status(400).json({ error: "sessionId and attemptId are required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      response.json(await experiments.get(caller, attemptId));
    } catch (error) {
      sendError(response, error, "Unable to read experiment attempt");
    }
  });

  app.get("/api/harness/sessions/:sessionId/experiments/:attemptId/logs", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    const attemptId = attemptIdOf(request);
    if (!sessionId || !attemptId) {
      response.status(400).json({ error: "sessionId and attemptId are required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      if (request.query.stream !== undefined && request.query.stream !== "stdout" && request.query.stream !== "stderr") {
        throw new HarnessServiceError("invalid-params", "stream must be stdout or stderr");
      }
      const stream = request.query.stream === "stderr" ? "stderr" : "stdout";
      const offset = integerQuery(request, "offset", 0);
      const maxBytes = integerQuery(request, "maxBytes", 1);
      const result: ExperimentLogsResult = await experiments.logs(caller, {
        attemptId, stream,
        ...(offset !== undefined ? { offset } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      response.json(result);
    } catch (error) {
      sendError(response, error, "Unable to read experiment logs");
    }
  });

  app.get("/api/harness/sessions/:sessionId/experiments/:attemptId/artifacts/:artifactId", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    response.once("close", disconnected);
    try {
      const caller = await callerFor(sessionIdOf(request));
      const artifact = await experiments.readArtifact(caller, attemptIdOf(request), String(request.params.artifactId), controller.signal);
      response.attachment(artifact.name.replaceAll("\\", "/").split("/").at(-1) || "artifact");
      response.type("application/octet-stream");
      if (artifact.byteLength !== undefined) response.setHeader("Content-Length", artifact.byteLength);
      for await (const chunk of artifact.chunks) {
        controller.signal.throwIfAborted();
        if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (response.headersSent || controller.signal.aborted) response.destroy(error instanceof Error ? error : undefined);
      else sendError(response, error, "Unable to read experiment artifact");
    } finally {
      response.off("close", disconnected);
    }
  });

  app.post("/api/harness/sessions/:sessionId/experiments/:attemptId/cancel", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    const attemptId = attemptIdOf(request);
    if (!sessionId || !attemptId) {
      response.status(400).json({ error: "sessionId and attemptId are required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      response.json({ attempt: await experiments.cancel(caller, attemptId) });
    } catch (error) {
      sendError(response, error, "Unable to cancel experiment attempt");
    }
  });

  app.post("/api/harness/sessions/:sessionId/experiments/:attemptId/collect", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    const attemptId = attemptIdOf(request);
    if (!sessionId || !attemptId) {
      response.status(400).json({ error: "sessionId and attemptId are required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      response.json(await experiments.collect(caller, attemptId));
    } catch (error) {
      sendError(response, error, "Unable to collect experiment artifacts");
    }
  });

  app.get("/api/harness/sessions/:sessionId/resources", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      response.json(await resources.list(caller.workspaceId));
    } catch (error) {
      sendError(response, error, "Unable to list machine resources");
    }
  });

  app.get("/api/harness/sessions/:sessionId/sources", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const caller = await callerFor(sessionId);
      const kind = typeof request.query.kind === "string" && request.query.kind.trim()
        ? request.query.kind.trim() : undefined;
      response.json(await sources.list(caller.workspaceId, { ...(kind ? { kind } : {}) }, caller));
    } catch (error) {
      sendError(response, error, "Unable to list research sources");
    }
  });
}
