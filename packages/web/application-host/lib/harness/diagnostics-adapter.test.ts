import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../lsp/supervisor.js";
import { PIARIUM_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";
import { createLanguageSupervisorDiagnosticsProvider } from "./diagnostics-adapter.js";
import { createLspDiagnosticsService, type DiagnosticsProvider } from "./diagnostics-service.js";
import type { HarnessServiceContext } from "./router.js";

const contextFor = (workspaceId: string): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "host-1",
    sessionId: "session-1",
    workerId: "worker-1",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.lsp"],
  },
  authorizedPaths: [],
  sessionId: "session-1",
  workspaceId,
  signal: new AbortController().signal,
});

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture diagnostics");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("LanguageSupervisor diagnostics adapter", () => {
  it("observes real versioned publications, including a final empty diagnostic list", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const resourceId = "fixture.ts";
      await fs.promises.writeFile(path.join(harness.workspaceRoot, resourceId), "export const fixture = true;\n");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: PIARIUM_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const provider = createLanguageSupervisorDiagnosticsProvider(language, {
        resolveWorkspaceId: async () => harness.identity.workspaceId,
      });
      // Establish the subscription and a clean ready language session.
      await provider.getSnapshot(harness.identity.workspaceId, resourceId);
      await language.syncDocument({
        resource: { workspaceId: harness.identity.workspaceId, resourceId },
        languageId: "typescript",
        documentVersion: 1,
        reason: "open",
        content: "export const fixture = true;\n",
      });
      await waitUntil(async () => (await provider.getSnapshot(harness.identity.workspaceId, resourceId)) !== null);

      const service = createLspDiagnosticsService(provider);
      const broken = await service.handle({
        path: resourceId,
        afterSnapshot: "FIXTURE_ERROR\n",
        waitMs: 1_000,
      }, contextFor(harness.identity.workspaceId));
      expect(broken).toMatchObject({
        status: "ready",
        diagnostics: [expect.objectContaining({ message: "fixture error", severity: "error" })],
      });

      const fixed = await service.handle({
        path: resourceId,
        afterSnapshot: "export const fixture = true;\n",
        waitMs: 1_000,
      }, contextFor(harness.identity.workspaceId));
      expect(fixed).toMatchObject({ status: "ready", diagnostics: [] });
      expect(language.syncedDocumentVersion(harness.identity.workspaceId, "typescript", resourceId)).toBe(3);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("keeps an available server with no publication distinct from an unavailable file type", async () => {
    const silent: DiagnosticsProvider = {
      getDiagnostics: async () => [],
      getSnapshot: async () => null,
      isAvailable: async (_workspaceId, pathValue) => pathValue.endsWith(".ts"),
      syncDocument: async () => ({ status: "synced" }),
    };
    const service = createLspDiagnosticsService(silent);
    await expect(service.handle({ path: "slow.ts", afterSnapshot: "x", waitMs: 10 }, contextFor("workspace")))
      .resolves.toMatchObject({ status: "pending" });
    await expect(service.handle({ path: "README.unknown" }, contextFor("workspace")))
      .resolves.toMatchObject({ status: "unavailable" });
  });
});
