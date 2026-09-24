import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerPdfMaterialRoutes } from "./pdf-material-routes.js";

describe("PDF material routes", () => {
  it("returns a pinned page image through the authenticated session route", async () => {
    const app = express();
    const fetchPage = vi.fn(async (input: { snapshotId: string; page: number; region?: unknown }) => ({
      status: "ok" as const,
      url: "https://example.com/paper.pdf",
      finalUrl: "https://example.com/paper.pdf",
      contentType: "application/pdf",
      markdown: "source text",
      bytes: 11,
      fromCache: false,
      rendered: false,
      pageImage: {
        page: input.page,
        mimeType: "image/png" as const,
        data: Buffer.from("png").toString("base64"),
        byteLength: 3,
        ...(input.region ? { region: input.region as never } : {}),
      },
    }));
    registerPdfMaterialRoutes(app, {
      requireAuth: (_request, _response, next) => next(),
      readDocument: async ({ request }) => fetchPage({ snapshotId: request.snapshotId!, page: request.page!, ...(request.region ? { region: request.region } : {}) }),
    });
    const response = await request(app)
      .get("/api/harness/sessions/session-1/materials/snap-1/page?page=2&x=0&y=0.4&width=1&height=0.5")
      .expect(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.body).toEqual(Buffer.from("png"));
    expect(fetchPage).toHaveBeenCalledWith({
      snapshotId: "snap-1",
      page: 2,
      region: { x: 0, y: 0.4, width: 1, height: 0.5 },
    });
  });

  it("rejects malformed regions before invoking the material authority", async () => {
    const app = express();
    const fetchPage = vi.fn();
    registerPdfMaterialRoutes(app, { readDocument: fetchPage });
    await request(app)
      .get("/api/harness/sessions/session-1/materials/snap-1/page?page=1&x=0&width=100")
      .expect(400);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("keeps a posted read alive after its request body finishes and uses the authenticated session", async () => {
    const app = express();
    app.use(express.json());
    const readDocument = vi.fn(async ({ sessionId, request, signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signal.aborted).toBe(false);
      expect(sessionId).toBe("session-1");
      expect(request).toEqual({ path: "paper.pdf", view: "overview" });
      return { status: "failed" as const, url: "", reason: "Example unavailable parser" };
    });
    registerPdfMaterialRoutes(app, { readDocument, requireAuth: (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401) });
    await request(app).post("/api/harness/sessions/session-1/materials/read").send({ path: "paper.pdf" }).expect(401);
    expect(readDocument).not.toHaveBeenCalled();
    const result = await request(app).post("/api/harness/sessions/session-1/materials/read")
      .set("Authorization", "test").send({ path: "paper.pdf", view: "overview" }).expect(200);
    expect(result.body.reason).toBe("Example unavailable parser");
  });
});
