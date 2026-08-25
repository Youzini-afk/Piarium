import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
} from "@piarium/extension-builtins";
import { ApplicationExtensionRuntime } from "../src/application-runtime.js";

test("the built-in TypeScript language extension materializes lazily and unregisters when disabled", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-builtin-language-"));
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    piariumVersion: "1.2.3",
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  runtime.capabilities.register("workspace.language", async (method, params) => {
    calls.push({ method, params });
    return { status: method === "registerProvider" ? "registered" : "unregistered" };
  });
  try {
    const started = await runtime.start();
    const entry = started.catalog.extensions.find((candidate) => (
      candidate.manifest.id === PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID
    ));
    assert.equal(entry?.desired.enabled, true);
    assert.equal(entry?.integrity, undefined);
    assert.equal(calls.length, 0);

    await runtime.activateForEvent("workspace-match");
    const registration = calls.find((call) => call.method === "registerProvider")?.params as {
      args?: string[];
      command?: string;
      initializationOptions?: { tsserver?: { fallbackPath?: string } };
      languageIds?: string[];
      providerId?: string;
    } | undefined;
    assert.equal(registration?.providerId, "piarium.typescript-language");
    assert.deepEqual(registration?.languageIds, ["javascript", "javascriptreact", "typescript", "typescriptreact"]);
    assert.match(registration?.args?.[0] ?? "", /typescript-language-server\.mjs$/);
    assert.match(registration?.initializationOptions?.tsserver?.fallbackPath ?? "", /typescript[\\/]lib[\\/]tsserver\.js$/);
    assert.ok(registration?.command);
    const active = await runtime.state();
    const activeEntry = active.catalog.extensions.find((candidate) => (
      candidate.manifest.id === PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID
    ));
    assert.match(activeEntry?.integrity ?? "", /^sha256-[0-9a-f]{64}$/);

    await runtime.setEnabled(
      PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
      false,
      active.catalog.revision,
    );
    assert.equal(calls.at(-1)?.method, "unregisterProvider");
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(dataDir, { force: true, recursive: true });
  }
});
