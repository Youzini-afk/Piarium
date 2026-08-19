import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonObjectFileEditor } from "../src/json-object-file-editor.js";

describe("JsonObjectFileEditor", () => {
  it("patches arbitrary plugin settings without dropping concurrent top-level changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-settings-editor-"));
    const agentDir = join(root, "agent");
    const settingsPath = join(agentDir, "settings.json");
    const editor = new JsonObjectFileEditor(settingsPath);
    try {
      await Promise.all([
        editor.update({ workspaceHistory: { enabled: true, maxWorkspaces: 50 } }, []),
        editor.update({ packages: ["npm:pi-workspace-history"] }, []),
      ]);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        packages: ["npm:pi-workspace-history"],
        workspaceHistory: { enabled: true, maxWorkspaces: 50 },
      });

      await editor.update({ literalNull: null }, ["packages"]);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        literalNull: null,
        workspaceHistory: { enabled: true, maxWorkspaces: 50 },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes project settings independently and preserves an invalid file", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-project-settings-"));
    const cwd = join(root, "workspace");
    const projectPath = join(cwd, ".pi", "settings.json");
    const editor = new JsonObjectFileEditor(projectPath);
    try {
      const missing = await editor.read();
      assert.deepEqual(missing.document, {});
      assert.equal(missing.exists, false);
      assert.equal(missing.revision.length, 64);
      await editor.update({ workspaceHistory: { enabled: true } }, []);
      assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
        workspaceHistory: { enabled: true },
      });

      await writeFile(projectPath, "not json", "utf8");
      await assert.rejects(
        editor.update({ workspaceHistory: { enabled: false } }, []),
        /Configuration file is not valid JSON/,
      );
      assert.equal(await readFile(projectPath, "utf8"), "not json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a revisioned update after an external write", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-settings-conflict-"));
    const settingsPath = join(root, "settings.json");
    const editor = new JsonObjectFileEditor(settingsPath);
    try {
      await writeFile(settingsPath, '{"plugin":{"enabled":true}}\n', "utf8");
      const opened = await editor.read();
      await writeFile(settingsPath, '{"plugin":{"enabled":false,"external":true}}\n', "utf8");

      await assert.rejects(
        editor.updateRevisioned(
          { plugin: { enabled: true, local: true } },
          [],
          opened.revision,
        ),
        /changed since it was opened/,
      );
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        plugin: { enabled: false, external: true },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent writer for the same expected revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-settings-cas-"));
    const settingsPath = join(root, "settings.json");
    const editor = new JsonObjectFileEditor(settingsPath);
    try {
      const opened = await editor.read();
      const results = await Promise.allSettled([
        editor.updateRevisioned({ plugin: { writer: "a" } }, [], opened.revision),
        editor.updateRevisioned({ plugin: { writer: "b" } }, [], opened.revision),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
        plugin: { writer: string };
      };
      assert.ok(persisted.plugin.writer === "a" || persisted.plugin.writer === "b");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
