import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HarnessServiceContext } from "./router.js";
import { createLspNavigationServices } from "./lsp-nav.js";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../lsp/supervisor.js";
import { PIARIUM_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";

const context: HarnessServiceContext = {
  actor: {
    authorityInstanceId: "host-1",
    sessionId: "session-1",
    workerId: "worker-1",
    workerGeneration: 1,
    workspaceId: "workspace-1",
    grantedCapabilities: ["read.lsp"],
  },
  authorizedPaths: [],
  sessionId: "session-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
};

const createDeps = () => {
  const documents = {
    read: vi.fn(async () => ({ status: "ready", content: "export const value = 1;", resource: { workspaceId: "workspace-1", resourceId: "src/a.ts" }, revision: "r1", encoding: "utf-8", bom: false, byteLength: 23, epoch: 1 })),
  };
  const supervisor = {
    hasSyncedDocument: vi.fn(() => false),
    syncedDocumentVersion: vi.fn(() => null),
    syncDocument: vi.fn(async () => ({ status: "synced", documentVersion: 0 })),
    workspaceSymbols: vi.fn(async () => ({
      status: "ready",
      value: [{ name: "value", kind: 13, resource: { workspaceId: "workspace-1", resourceId: "src/a.ts" }, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } }],
    })),
    definition: vi.fn(async () => ({
      status: "ready",
      value: [{ resource: { workspaceId: "workspace-1", resourceId: "src/b.ts" }, targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 7 } } }],
    })),
    references: vi.fn(async () => ({
      status: "ready",
      value: [{ resource: { workspaceId: "workspace-1", resourceId: "src/c.ts" }, range: { start: { line: 8, character: 1 }, end: { line: 8, character: 6 } } }],
    })),
    hover: vi.fn(async () => ({
      status: "ready",
      value: { contents: [{ kind: "markdown", value: "`value: number`" }, { kind: "plaintext", value: "Current value" }] },
    })),
  };
  return { documents, supervisor };
};

describe("LSP navigation services", () => {
  it("opens an unsynced disk document and formats one-based symbol locations", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const result = await services.symbols.handle({ path: "src/a.ts", query: "value" }, context);
    expect(result).toMatchObject({ status: "ready" });
    expect(result.text).toContain("src/a.ts:1:14 — value");
    expect(deps.documents.read).toHaveBeenCalledOnce();
    expect(deps.supervisor.syncDocument).toHaveBeenCalledWith(expect.objectContaining({
      languageId: "typescript",
      documentVersion: 0,
      reason: "open",
    }));
  });

  it("does not overwrite a document already synchronized from an editor buffer", async () => {
    const deps = createDeps();
    deps.supervisor.hasSyncedDocument.mockReturnValue(true);
    deps.supervisor.syncedDocumentVersion.mockReturnValue(7 as never);
    const services = createLspNavigationServices(deps as never);
    await services.hover.handle({ path: "src/a.ts", line: 1, character: 1 }, context);
    expect(deps.documents.read).not.toHaveBeenCalled();
    expect(deps.supervisor.syncDocument).not.toHaveBeenCalled();
  });

  it("uses the path authority resource identity for an absolute input", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const absoluteContext = {
      ...context,
      authorizedPaths: [{
        authorityId: "host-1",
        workspaceId: "workspace-1",
        canonicalResourceId: "/workspace/src/a.ts",
        inputPath: "/workspace/src/a.ts",
        resourceId: "src/a.ts",
      }],
    };
    await services.hover.handle({ path: "/workspace/src/a.ts", line: 1 }, absoluteContext);
    expect(deps.documents.read).toHaveBeenCalledWith({ workspaceId: "workspace-1", resourceId: "src/a.ts" });
  });

  it("converts agent-facing one-based positions to LSP zero-based positions", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    const definition = await services.definition.handle({ path: "src/a.ts", line: 7, character: 3 }, context);
    expect(definition.text).toBe("src/b.ts:5:3");
    expect(deps.supervisor.definition).toHaveBeenCalledWith(expect.objectContaining({
      position: { line: 6, character: 2 },
    }));
    const references = await services.references.handle({ path: "src/a.ts", line: 7 }, context);
    expect(references.text).toContain("1 references\nsrc/c.ts:9:2");
    const hover = await services.hover.handle({ path: "src/a.ts", line: 7 }, context);
    expect(hover.text).toBe("`value: number`\n\nCurrent value");
  });

  it("keeps unsupported files, empty results, and provider failures distinct", async () => {
    const deps = createDeps();
    const services = createLspNavigationServices(deps as never);
    await expect(services.hover.handle({ path: "README.unknown", line: 1 }, context)).resolves.toMatchObject({ status: "unavailable" });
    deps.supervisor.references.mockResolvedValueOnce({ status: "ready", value: [] });
    await expect(services.references.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({ status: "empty" });
    deps.supervisor.definition.mockResolvedValueOnce({ status: "failed", message: "server exited" } as never);
    await expect(services.definition.handle({ path: "src/a.ts", line: 1 }, context)).resolves.toMatchObject({ status: "unavailable", text: "Definition unavailable: server exited" });
  });

  it("serves navigation through a real LanguageSupervisor process", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, "fixture.ts"), "export const fixture = true;\n");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: PIARIUM_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const services = createLspNavigationServices({ documents: harness.authority, supervisor: language });
      const realContext = { ...context, workspaceId: harness.identity.workspaceId, actor: { ...context.actor, workspaceId: harness.identity.workspaceId } };
      await expect(services.hover.handle({ path: "fixture.ts", line: 1, character: 1 }, realContext)).resolves.toMatchObject({
        status: "ready",
        text: "fixture-hover",
      });
      await expect(services.symbols.handle({ path: "fixture.ts", query: "fixture" }, realContext)).resolves.toMatchObject({
        status: "ready",
      });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });
});
