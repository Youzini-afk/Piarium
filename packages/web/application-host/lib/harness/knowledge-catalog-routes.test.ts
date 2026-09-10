import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { registerHarnessKnowledgeCatalogRoutes } from "./knowledge-catalog-routes.js";

const TEST_DIR = join(tmpdir(), "piarium-harness-knowledge-catalog");

describe("harness knowledge catalog routes", () => {
  let store: KnowledgeStore;
  let userStore: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "workspace-1",
      embedding: null,
    });
    userStore = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "user",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    await userStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const appFor = () => {
    const changed: Array<{ scope: string; workspaceId?: string }> = [];
    const app = express();
    app.use(express.json());
    registerHarnessKnowledgeCatalogRoutes(app, {
      resolveWorkspace: async ({ workspaceId }) => {
        if (workspaceId !== "workspace-1") {
          const error = new Error("Workspace is not registered on this application host");
          (error as { statusCode?: number }).statusCode = 404;
          throw error;
        }
        return { workspaceId };
      },
      getWorkspaceStore: async (workspaceId) => {
        if (workspaceId !== "workspace-1") throw new Error("unexpected store open");
        return store;
      },
      getUserStore: async () => userStore,
      onKnowledgeChanged: (change) => { changed.push(change); },
      requireAuth: (req, res, next) => {
        if (req.header("x-test-auth") === "yes") next();
        else res.status(401).json({ error: "auth required" });
      },
    });
    return { app, changed };
  };

  it("requires auth and a registered Documents workspace before opening a store", async () => {
    const { app } = appFor();
    await request(app).get("/api/harness/knowledge?scope=workspace&workspaceId=workspace-1").expect(401);
    await request(app)
      .get("/api/harness/knowledge?scope=workspace&workspaceId=forged")
      .set("x-test-auth", "yes")
      .expect(404);
    await request(app)
      .get("/api/harness/knowledge?scope=workspace")
      .set("x-test-auth", "yes")
      .expect(400);
  });

  it("lists, edits, retires, and walks a supersede chain without crossing scopes", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use npm",
      trigger: "packages",
    });
    const userId = await userStore.putKnowledge({
      scope: "user",
      status: "accepted",
      content: "Use npm",
      trigger: "packages",
    });
    const { app, changed } = appFor();
    const created = await request(app)
      .post("/api/harness/knowledge/workspace/0/accept")
      .set("x-test-auth", "yes")
      .send({ workspaceId: "workspace-1" })
      .expect(400);
    expect(created.body.error).toMatch(/valid scope/);

    await request(app)
      .get("/api/harness/knowledge?scope=user")
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual([expect.objectContaining({ id: userId, scope: "user" })]);
      });

    const suggestion = await store.putKnowledge({
      scope: "workspace",
      status: "suggested",
      content: "Use bun",
      trigger: "packages",
    });
    await request(app)
      .post(`/api/harness/knowledge/workspace/${suggestion}/accept`)
      .set("x-test-auth", "yes")
      .send({ workspaceId: "workspace-1", supersedes: [oldId] })
      .expect(200);

    await request(app)
      .put(`/api/harness/knowledge/workspace/${suggestion}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        content: "Always use bun",
        trigger: "packages",
        expectedContent: "Use bun",
        expectedTrigger: "packages",
      })
      .expect(200);

    await request(app)
      .put(`/api/harness/knowledge/workspace/${suggestion}`)
      .set("x-test-auth", "yes")
      .send({
        workspaceId: "workspace-1",
        content: "stale",
        trigger: "packages",
        expectedContent: "Use bun",
        expectedTrigger: "packages",
      })
      .expect(409);

    await request(app)
      .get(`/api/harness/knowledge/workspace/${oldId}/chain?workspaceId=workspace-1`)
      .set("x-test-auth", "yes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.chain.chain.map((item: { id: number }) => item.id)).toEqual([oldId, suggestion]);
      });

    await request(app)
      .delete(`/api/harness/knowledge/user/${userId}`)
      .set("x-test-auth", "yes")
      .send({
        expectedContent: "Use npm",
        expectedTrigger: "packages",
        expectedStatus: "accepted",
      })
      .expect(200);

    expect((await userStore.getKnowledge(userId))?.invalidAt).toEqual(expect.any(Number));
    expect((await store.getKnowledge(oldId))?.invalidAt).toEqual(expect.any(Number));
    const current = await store.getKnowledge(suggestion);
    expect(current?.content).toBe("Always use bun");
    expect(current?.invalidAt).toBeUndefined();
    expect(await userStore.recall("Use npm", 5)).toEqual([]);
    expect(changed.map((item) => item.scope)).toEqual(["workspace", "workspace", "user"]);
  });
});
