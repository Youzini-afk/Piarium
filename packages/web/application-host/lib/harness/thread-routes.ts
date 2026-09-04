import type { Express, Request, Response } from "express";
import type { ThreadParent } from "@piarium/protocol";
import type { ThreadRegistry } from "./thread-registry.js";

export interface HarnessThreadRoutesOptions {
  registry: ThreadRegistry;
}

const queryString = (request: Request, key: string): string => {
  const value = request.query[key];
  return typeof value === "string" ? value.trim() : "";
};

export function registerHarnessThreadRoutes(app: Express, { registry }: HarnessThreadRoutesOptions): void {
  app.get("/api/harness/threads", async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const workspaceId = queryString(request, "workspaceId");
    const parentId = queryString(request, "parentId");
    const parentKind = queryString(request, "parentKind") || "session";
    if (!workspaceId || !parentId || (parentKind !== "session" && parentKind !== "thread")) {
      response.status(400).json({ error: "workspaceId, parentId, and a valid parentKind are required" });
      return;
    }
    const parent: ThreadParent = { kind: parentKind, id: parentId };
    try {
      const threads = await registry.listThreads(workspaceId, parent);
      const projected = await Promise.all(threads.map(async (thread) => ({
        thread,
        activeRun: await registry.getActiveRun(workspaceId, thread.id),
      })));
      response.json({ workspaceId, parent, threads: projected });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : "Unable to read harness threads",
      });
    }
  });
}
