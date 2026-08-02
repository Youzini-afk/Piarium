import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PiSettingsFileEditor } from "../src/settings-file-editor.js";

describe("PiSettingsFileEditor", () => {
  it("patches arbitrary plugin settings without dropping concurrent top-level changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-settings-editor-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const editor = new PiSettingsFileEditor({ agentDir, cwd });
    try {
      await Promise.all([
        editor.update(
          "global",
          { workspaceHistory: { enabled: true, maxWorkspaces: 50 } },
          [],
        ),
        editor.update("global", { packages: ["npm:pi-workspace-history"] }, []),
      ]);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
        packages: ["npm:pi-workspace-history"],
        workspaceHistory: { enabled: true, maxWorkspaces: 50 },
      });

      await editor.update("global", { literalNull: null }, ["packages"]);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
        literalNull: null,
        workspaceHistory: { enabled: true, maxWorkspaces: 50 },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes project settings independently and preserves an invalid file", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-project-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const editor = new PiSettingsFileEditor({ agentDir, cwd });
    try {
      await editor.update("project", { workspaceHistory: { enabled: true } }, []);
      const projectPath = join(cwd, ".pi", "settings.json");
      assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
        workspaceHistory: { enabled: true },
      });

      await writeFile(projectPath, "not json", "utf8");
      await assert.rejects(
        editor.update("project", { workspaceHistory: { enabled: false } }, []),
        /Settings file is not valid JSON/,
      );
      assert.equal(await readFile(projectPath, "utf8"), "not json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
