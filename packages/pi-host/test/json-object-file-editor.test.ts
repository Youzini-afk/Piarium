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
      assert.deepEqual(await editor.read(), { document: {}, exists: false });
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
});
