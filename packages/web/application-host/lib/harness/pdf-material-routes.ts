import type { Express, Request, RequestHandler, Response } from "express";
import type { DocumentReadRequest, FetchResult, WebDocumentRegion } from "@varin/protocol";

const noAuth: RequestHandler = (_request, _response, next) => next();

export interface PdfMaterialRouteOptions {
  requireAuth?: RequestHandler;
  readDocument: (input: {
    sessionId: string;
    request: DocumentReadRequest;
    signal: AbortSignal;
  }) => Promise<FetchResult>;
}

const numberParam = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const regionFromQuery = (query: Record<string, unknown>): WebDocumentRegion | undefined => {
  const keys = ["x", "y", "width", "height"] as const;
  if (!keys.some((key) => query[key] !== undefined)) return undefined;
  const values = keys.map((key) => typeof query[key] === "string" ? Number(query[key]) : NaN);
  if (!values.every(Number.isFinite) || values[0]! < 0 || values[1]! < 0 || values[2]! <= 0 || values[3]! <= 0
    || values[0]! + values[2]! > 1 || values[1]! + values[3]! > 1) return undefined;
  return { x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! };
};

export const registerPdfMaterialRoutes = (app: Express, options: PdfMaterialRouteOptions): void => {
  const requireAuth = options.requireAuth ?? noAuth;
  const disconnectedSignal = (request: Request, response: Response): AbortSignal => {
    const abort = new AbortController();
    request.once("aborted", () => abort.abort());
    response.once("close", () => { if (!response.writableEnded) abort.abort(); });
    return abort.signal;
  };
  app.post("/api/harness/sessions/:sessionId/materials/read", requireAuth, async (request, response) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      response.status(400).json({ error: "A document read request is required" });
      return;
    }
    try {
      const result = await options.readDocument({
        sessionId: typeof request.params.sessionId === "string" ? request.params.sessionId : "",
        request: request.body as DocumentReadRequest,
        signal: disconnectedSignal(request, response),
      });
      response.setHeader("Cache-Control", "private, no-store");
      response.json(result);
    } catch (error) {
      if (!response.destroyed) response.status(503).json({ error: error instanceof Error ? error.message : "Document reading is unavailable" });
    }
  });
  app.get("/api/harness/sessions/:sessionId/materials/:snapshotId/page", requireAuth, async (request, response) => {
    const page = numberParam(request.query.page);
    const snapshotId = typeof request.params.snapshotId === "string" ? request.params.snapshotId.trim() : "";
    if (!snapshotId || page === null || page < 1) {
      response.status(400).json({ error: "A snapshotId and one-based page are required" });
      return;
    }
    const region = regionFromQuery(request.query as Record<string, unknown>);
    if (["x", "y", "width", "height"].some((key) => request.query[key] !== undefined) && !region) {
      response.status(400).json({ error: "Invalid page region" });
      return;
    }
    const scale = request.query.scale === undefined ? undefined : Number(request.query.scale);
    if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
      response.status(400).json({ error: "Invalid render scale" });
      return;
    }
    try {
      const result = await options.readDocument({
        sessionId: typeof request.params.sessionId === "string" ? request.params.sessionId : "",
        request: { snapshotId, view: "page-image", page, ...(region ? { region } : {}), ...(scale === undefined ? {} : { scale }) },
        signal: disconnectedSignal(request, response),
      });
      const image = result.status === "ok" ? result.pageImages?.[0] ?? result.pageImage : undefined;
      if (image) {
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("X-Varin-Snapshot-Id", snapshotId);
        response.type(image.mimeType).send(Buffer.from(image.data, "base64"));
        return;
      }
      if (result.status === "snapshot-missing" || result.status === "position-not-found") {
        response.status(404).json({ error: result.status });
        return;
      }
      if (result.status === "blocked") {
        response.status(403).json({ error: result.reason });
        return;
      }
      if (result.status === "page-image-unavailable") {
        response.status(409).json({ error: result.reason });
        return;
      }
      response.status(503).json({ error: result.status });
    } catch {
      response.status(503).json({ error: "Unable to render PDF page" });
    }
  });
};
