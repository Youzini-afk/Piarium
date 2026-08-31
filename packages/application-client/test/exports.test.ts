import { test } from "node:test";
import assert from "node:assert/strict";

test("application-client exports RuntimeAPIs type and error classes", async () => {
  const mod = await import("../src/index.js");
  assert.ok(mod.DocumentsError, "DocumentsError should be exported");
  assert.ok(mod.FilesystemError, "FilesystemError should be exported");
  assert.ok(mod.LanguageServicesError, "LanguageServicesError should be exported");
  assert.ok(mod.RunServicesError, "RunServicesError should be exported");
  assert.ok(mod.WorkspaceSearchError, "WorkspaceSearchError should be exported");
});

test("application-client exports DTO types via re-exports", async () => {
  const mod = await import("../src/index.js");
  // These are type-only exports, but the module should load without error
  // and expose the runtime values (error classes, etc.)
  assert.ok(typeof mod.DocumentsError === "function");
  assert.ok(typeof mod.FilesystemError === "function");
});

test("DocumentsError preserves reason and status", async () => {
  const { DocumentsError } = await import("../src/index.js");
  const error = new DocumentsError("test", { reason: "untrusted", status: 403 });
  assert.equal(error.reason, "untrusted");
  assert.equal(error.status, 403);
  assert.equal(error.name, "DocumentsError");
});
