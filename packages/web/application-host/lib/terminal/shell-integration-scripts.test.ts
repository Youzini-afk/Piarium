import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POWERSHELL_EXIT_CAPTURE,
  shellIntegrationFamily,
  shellIntegrationLaunch,
} from "./shell-integration-scripts.js";

const powershellPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("shell integration launch", () => {
  it("injects an init file for bash and a script file for PowerShell", () => {
    const bash = shellIntegrationLaunch("/usr/bin/bash", ["-l"], true, "user-bash:1");
    expect(bash?.args).toEqual(["-l", "--init-file", expect.stringContaining("bash-")]);
    expect(bash?.env.PIARIUM_SHELL_INTEGRATION_KIND).toBe("bash");
    expect(bash?.env.PIARIUM_SHELL_INTEGRATION_ID).toBe("user-bash:1");

    const pwsh = shellIntegrationLaunch("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [], false, "term-ps:1");
    expect(pwsh?.args).toEqual([
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      expect.stringMatching(/powershell-.*\.ps1$/),
    ]);
    expect(pwsh?.env.PIARIUM_SHELL_INTEGRATION_ID).toBe("term-ps:1");
  });

  it("uses ZDOTDIR for zsh, does not inject cmd, and does not treat sh as bash", () => {
    const zsh = shellIntegrationLaunch("/bin/zsh", ["-l"], true, "term-zsh:1");
    expect(zsh?.args).toEqual(["-l"]);
    expect(zsh?.env.ZDOTDIR).toEqual(expect.stringContaining("zsh-"));
    expect(zsh?.env.PIARIUM_ZDOTDIR).toBe(zsh?.env.ZDOTDIR);
    expect(shellIntegrationFamily("cmd.exe")).toBeNull();
    expect(shellIntegrationLaunch("cmd.exe", [], false, "x")).toBeNull();
    expect(shellIntegrationFamily("/bin/sh")).toBeNull();
    expect(shellIntegrationFamily("sh.exe")).toBeNull();
    expect(shellIntegrationLaunch("/bin/sh", ["-l"], false, "term-sh:1")).toBeNull();
  });

  it("preserves user Bash PROMPT_COMMAND arrays and DEBUG traps in the injected script", () => {
    const bash = shellIntegrationLaunch("/usr/bin/bash", [], false, "term-bash:1");
    const script = readFileSync(String(bash?.args[1]), "utf8");
    expect(script).toContain('[[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]');
    expect(script).toContain('PROMPT_COMMAND=(__piarium_prompt_command "${PROMPT_COMMAND[@]}")');
    expect(script).toContain("trap -p DEBUG");
    expect(script).toContain('trap \'__piarium_debug_trap; eval "$__piarium_prev_debug"\' DEBUG');
    expect(script).toContain("pi;%s;%s");
  });

  it("materializes zsh env/profile/login files so replacing ZDOTDIR still sources the user tree", () => {
    const zsh = shellIntegrationLaunch("/bin/zsh", ["-l"], true, "term-zsh:2");
    const directory = String(zsh?.env.ZDOTDIR);
    expect(readFileSync(join(directory, ".zshenv"), "utf8")).toContain(".zshenv");
    expect(readFileSync(join(directory, ".zprofile"), "utf8")).toContain(".zprofile");
    expect(readFileSync(join(directory, ".zlogin"), "utf8")).toContain(".zlogin");
    expect(readFileSync(join(directory, ".zshrc"), "utf8")).toContain(".zshrc");
    expect(readFileSync(join(directory, ".zprofile"), "utf8")).not.toContain('source "${ZDOTDIR:-$HOME}/.zshrc"');
  });

  it("does not replace the PowerShell Enter key handler and captures $? before other prompt work", () => {
    const pwsh = shellIntegrationLaunch("powershell.exe", [], false, "term-ps:2");
    const script = readFileSync(String(pwsh?.args[4]), "utf8");
    expect(script).toContain(POWERSHELL_EXIT_CAPTURE);
    expect(script).toContain("Set-PSReadLineOption -AddToHistoryHandler");
    expect(script).toContain("$__PiariumPreviousHistoryHandler");
    expect(script).not.toContain("Set-PSReadLineKeyHandler -Key Enter");
    expect(script.indexOf("$__piarium_success = $?")).toBeLessThan(script.indexOf("if ($global:__PiariumAwaitingFinish)"));
  });

  it("records cmdlet failure, native exit 7, and success from the PowerShell prompt formula", () => {
    if (process.platform !== "win32" || !existsSync(powershellPath)) return;
    const probe = join(tmpdir(), `piarium-missing-${Date.now()}`);
    const result = spawnSync(powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
        Get-Item -LiteralPath '${probe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Out-Null
        ${POWERSHELL_EXIT_CAPTURE}
        $cmdlet = $code
        cmd.exe /c exit 7
        ${POWERSHELL_EXIT_CAPTURE}
        $native = $code
        Write-Output 'ok' | Out-Null
        ${POWERSHELL_EXIT_CAPTURE}
        Write-Output "$cmdlet,$native,$code"
      `,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe("1,7,0");
  });

  it("keeps a custom Bash PROMPT_COMMAND array and DEBUG trap after sourcing the init file", () => {
    const bash = [
      process.env.PIARIUM_TERMINAL_SHELL,
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files/Git/usr/bin/bash.exe",
      "/bin/bash",
    ].find((candidate) => typeof candidate === "string" && existsSync(candidate));
    if (!bash) return;
    const launch = shellIntegrationLaunch(bash, [], false, "term-bash:live");
    const script = String(launch?.args[1]).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const result = spawnSync(bash, [
      "-lc",
      `PROMPT_COMMAND=("echo USER_PROMPT_RAN"); trap 'echo USER_DEBUG_RAN' DEBUG; . "${script.replace(/"/g, '\\"')}"; declare -p PROMPT_COMMAND; trap -p DEBUG`,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("declare -a PROMPT_COMMAND");
    expect(result.stdout).toContain("__piarium_prompt_command");
    expect(result.stdout).toContain("echo USER_PROMPT_RAN");
    expect(result.stdout).toContain("USER_DEBUG_RAN");
  });
});
