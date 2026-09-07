import type { Express, Request, RequestHandler, Response } from "express";
import type { LanguageSupportAPI } from "@piarium/application-client";
import { LanguageSupportError } from "@piarium/application-client";

const sendError = (res: Response, error: unknown) => {
  if (error instanceof LanguageSupportError) {
    return res.status(error.status ?? 400).json({ error: error.message, reason: error.reason });
  }
  const message = error instanceof Error ? error.message : "Language support request failed";
  return res.status(500).json({ error: message, reason: "failed" });
};

const readBody = (req: Request): Record<string, unknown> => (
  req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {}
);

const stringField = (value: unknown): string => typeof value === "string" ? value : "";

export const registerLanguageSupportRoutes = (app: Express, {
  languageSupport,
  uiAuthController,
}: {
  languageSupport: LanguageSupportAPI;
  uiAuthController?: { requireAuth?: RequestHandler };
}): void => {
  const requireAuth = uiAuthController?.requireAuth ?? ((_req, _res, next) => next());

  app.post("/api/language-support/status", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.getStatus({ workspaceId: stringField(readBody(req).workspaceId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/language-support/install", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.install({ languageId: stringField(readBody(req).languageId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/language-support/cancel", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.cancelInstall({ languageId: stringField(readBody(req).languageId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/language-support/import", requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(await languageSupport.importUserGrammar({
        languageId: stringField(body.languageId),
        path: stringField(body.path),
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });
};
