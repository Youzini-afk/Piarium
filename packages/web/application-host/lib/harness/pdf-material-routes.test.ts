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
      fetchPage: async ({ snapshotId, page, region }) => fetchPage({ snapshotId, page, region }),
    });
    const response = await request(app)
      .get("/api/harness/sessions/session-1/materials/snap-1/page?page=2&x=0&y=4&width=100&height=80")
      .expect(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.body).toEqual(Buffer.from("png"));
    expect(fetchPage).toHaveBeenCalledWith({
      snapshotId: "snap-1",
      page: 2,
      region: { x: 0, y: 4, width: 100, height: 80 },
    });
  });

  it("rejects malformed regions before invoking the material authority", async () => {
    const app = express();
    const fetchPage = vi.fn();
    registerPdfMaterialRoutes(app, { fetchPage });
    await request(app)
      .get("/api/harness/sessions/session-1/materials/snap-1/page?page=1&x=0&width=100")
      .expect(400);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

