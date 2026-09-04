import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { registerHarnessContextRoutes } from "./context-routes.js";

const TEST_DIR = join(tmpdir(), "piarium-harness-context-routes");

describe("harness context routes", () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "workspace-1",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("requires UI auth and supports conflict-checked session block editing", async () => {
    const app = express();
    app.use(express.json());
    registerHarnessContextRoutes(app, {
      getStore: async (sessionId) => sessionId === "session-1" ? store : null,
      requireAuth: (req, res, next) => {
        if (req.header("x-test-auth") === "yes") next();
        else res.status(401).json({ error: "auth required" });
      },
    });

    await request(app).get("/api/harness/sessions/session-1/blocks").expect(401);
    let openedRevision = 0;
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .set("x-test-auth", "yes")
      .send({ content: "User corrected the current state", expectedUpdatedAt: null })
      .expect(200)
      .expect(({ body }) => {
        expect(body.block).toMatchObject({ label: "progress", updatedBy: "user" });
        openedRevision = body.block.updatedAt;
      });
    await request(app)
      .get("/api/harness/sessions/session-1/blocks")
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => expect(body.blocks).toMatchObject([{ content: "User corrected the current state" }]));
    await store.upsertBlock({
      sessionId: "session-1",
      label: "progress",
      content: "Background update",
      updatedBy: "memory-agent",
    });
    await request(app)
      .put("/api/harness/sessions/session-1/blocks/progress")
      .set("x-test-auth", "yes")
      .send({ content: "Stale editor draft", expectedUpdatedAt: openedRevision })
      .expect(409)
      .expect(({ body }) => expect(body.current).toMatchObject({ content: "Background update" }));
    await expect(store.getBlocks("session-1")).resolves.toMatchObject([{ content: "Background update" }]);
  });
});
