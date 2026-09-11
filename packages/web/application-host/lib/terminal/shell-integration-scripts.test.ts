import { describe, expect, it } from "vitest";
import { shellIntegrationFamily, shellIntegrationLaunch } from "./shell-integration-scripts.js";

describe("shell integration launch", () => {
  it("injects an init file for bash and a script file for PowerShell", () => {
    const bash = shellIntegrationLaunch("/usr/bin/bash", ["-l"], true);
    expect(bash?.args).toEqual(["-l", "--init-file", expect.stringContaining("bash-")]);
    expect(bash?.env.PIARIUM_SHELL_INTEGRATION_KIND).toBe("bash");

    const pwsh = shellIntegrationLaunch("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [], false);
    expect(pwsh?.args).toEqual([
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      expect.stringMatching(/powershell-.*\.ps1$/),
    ]);
  });

  it("uses ZDOTDIR for zsh and does not inject cmd", () => {
    const zsh = shellIntegrationLaunch("/bin/zsh", ["-l"], true);
    expect(zsh?.args).toEqual(["-l"]);
    expect(zsh?.env.ZDOTDIR).toEqual(expect.stringContaining("zsh-"));
    expect(shellIntegrationFamily("cmd.exe")).toBeNull();
    expect(shellIntegrationLaunch("cmd.exe", [], false)).toBeNull();
  });
});
