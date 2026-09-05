import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { captureGitPathStates, type RunGitFn } from "./git-migration.js";

it("imports Git file permissions as the states this platform actually materializes", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "piarium-git-mode-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["init", "--quiet"]);
    git(["config", "core.autocrlf", "false"]);
    await fs.writeFile(path.join(root, "script.sh"), "echo hello\n");
    if (process.platform !== "win32") await fs.chmod(path.join(root, "script.sh"), 0o755);
    git(["add", "script.sh"]);
    git(["update-index", "--chmod=+x", "script.sh"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    const runGit: RunGitFn = async (args) => {
      const stdoutBuffer = git(args);
      return { stdoutBuffer, stdout: stdoutBuffer.toString("utf8"), stderr: "", exitCode: 0 };
    };
    const captured = await captureGitPathStates(runGit, "HEAD");
    expect(captured.entries.get("script.sh")?.mode).toBe("100755");
    const state = captured.states["script.sh"];
    if (state?.kind !== "regular-file") throw new Error("Git file was not imported as a regular file");
    expect(state.mode).toBe((await fs.stat(path.join(root, "script.sh"))).mode & 0o7777);
  } finally {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
