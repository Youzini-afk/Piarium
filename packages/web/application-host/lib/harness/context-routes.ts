import type { Express, Request, RequestHandler, Response } from "express";
import { KnowledgeBlockConflictError, type KnowledgeStore } from "../knowledge/store.js";

export interface HarnessContextRoutesOptions {
  getStore(sessionId: string): Promise<KnowledgeStore | null>;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();

const sessionIdOf = (request: Request): string => String(request.params.sessionId ?? "").trim();
const labelOf = (request: Request): string => String(request.params.label ?? "").trim();

export function registerHarnessContextRoutes(
  app: Express,
  { getStore, requireAuth = noAuth }: HarnessContextRoutesOptions,
): void {
  app.get("/api/harness/sessions/:sessionId/blocks", requireAuth, async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const sessionId = sessionIdOf(request);
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    try {
      const store = await getStore(sessionId);
      if (!store) {
        response.status(404).json({ error: "Session knowledge store is unavailable" });
        return;
      }
      response.json({ sessionId, blocks: await store.getBlocks(sessionId) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Unable to read session blocks" });
    }
  });

  app.put("/api/harness/sessions/:sessionId/blocks/:label", requireAuth, async (request: Request, response: Response) => {
    const sessionId = sessionIdOf(request);
    const label = labelOf(request);
    const content = request.body?.content;
    const expectedUpdatedAt = request.body?.expectedUpdatedAt;
    if (
      !sessionId
      || !label
      || typeof content !== "string"
      || (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "number")
      || (typeof expectedUpdatedAt === "number" && !Number.isFinite(expectedUpdatedAt))
    ) {
      response.status(400).json({ error: "sessionId, label, content, and expectedUpdatedAt are required" });
      return;
    }
    try {
      const store = await getStore(sessionId);
      if (!store) {
        response.status(404).json({ error: "Session knowledge store is unavailable" });
        return;
      }
      response.json({
        sessionId,
        block: await store.upsertBlock({ sessionId, label, content, updatedBy: "user", expectedUpdatedAt }),
      });
    } catch (error) {
      if (error instanceof KnowledgeBlockConflictError) {
        response.status(409).json({ error: error.message, current: error.current });
        return;
      }
      const message = error instanceof Error ? error.message : "Unable to update session block";
      response.status(message.startsWith("Invalid block name:") ? 400 : 500).json({ error: message });
    }
  });
}
