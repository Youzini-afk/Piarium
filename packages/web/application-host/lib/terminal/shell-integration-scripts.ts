/* eslint-disable no-useless-escape -- bash/zsh templates must emit $ and ${} */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASH_SCRIPT = `if [ -n "\${PIARIUM_SHELL_INTEGRATION:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
export PIARIUM_SHELL_INTEGRATION=1

if ! shopt -q login_shell 2>/dev/null; then
  [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -f "\$HOME/.bashrc" ] && . "\$HOME/.bashrc"
fi

__piarium_escape() {
  printf '%s' "\$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/;/\\\\x3b/g'
}

__piarium_emit() {
  printf '\\033]633;%s\\007' "\$1"
}

__piarium_awaiting=
__piarium_prompt_command() {
  local __piarium_status=\$?
  if [ -n "\$__piarium_awaiting" ]; then
    local __piarium_cmd
    __piarium_cmd=\$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9][0-9]* *//')
    if [ -n "\$__piarium_cmd" ]; then
      __piarium_emit "E;\$(__piarium_escape "\$__piarium_cmd")"
    fi
    __piarium_emit "D;\$__piarium_status"
    __piarium_awaiting=
  fi
  __piarium_emit "P;Cwd=\$(__piarium_escape "\$PWD")"
  __piarium_emit "A"
}

__piarium_debug_trap() {
  [ -n "\${COMP_LINE:-}" ] && return
  [ -n "\$__piarium_awaiting" ] && return
  case "\$BASH_COMMAND" in
    __piarium_prompt_command*|__piarium_debug_trap*) return ;;
  esac
  __piarium_awaiting=1
  __piarium_emit "C"
}

if [ -n "\${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="__piarium_prompt_command; \${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="__piarium_prompt_command"
fi
trap '__piarium_debug_trap' DEBUG
`;

const POWERSHELL_SCRIPT = `if ($env:PIARIUM_SHELL_INTEGRATION) { return }
$env:PIARIUM_SHELL_INTEGRATION = '1'

function global:__PiariumEscape([string]$Value) {
  return (($Value -replace '\\\\', '\\\\\\\\') -replace ';', '\\x3b')
}

function global:__PiariumEmit([string]$Payload) {
  [Console]::Write(("\`e]633;" + $Payload + "\`a"))
}

$__PiariumOriginalPrompt = $function:prompt
function global:prompt {
  $code = 0
  if (-not $?) {
    if (Test-Path variable:global:LASTEXITCODE -ErrorAction SilentlyContinue) {
      $code = [int]$global:LASTEXITCODE
    }
    if ($code -eq 0) { $code = 1 }
  }
  if ($global:__PiariumAwaitingFinish) {
    __PiariumEmit ("D;" + $code)
    $global:__PiariumAwaitingFinish = $false
  }
  __PiariumEmit ("P;Cwd=" + (__PiariumEscape $PWD.Path))
  __PiariumEmit 'A'
  if ($__PiariumOriginalPrompt) { & $__PiariumOriginalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}

if (Get-Module -ListAvailable -Name PSReadLine) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue
  Set-PSReadLineKeyHandler -Key Enter -BriefDescription PiariumCommandStart -ScriptBlock {
    $line = $null
    $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    if ($line) {
      __PiariumEmit ("E;" + (__PiariumEscape $line))
      __PiariumEmit 'C'
      $global:__PiariumAwaitingFinish = $true
    }
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  }
}
`;

const ZSH_SCRIPT = `if [ -n "\${PIARIUM_SHELL_INTEGRATION:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
export PIARIUM_SHELL_INTEGRATION=1
[ -f /etc/zshrc ] && . /etc/zshrc
[ -f "\$HOME/.zshrc" ] && . "\$HOME/.zshrc"

__piarium_escape() {
  printf '%s' "\$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/;/\\\\x3b/g'
}

__piarium_emit() {
  printf '\\033]633;%s\\007' "\$1"
}

__piarium_preexec() {
  __piarium_emit "E;\$(__piarium_escape "\$1")"
  __piarium_emit "C"
}

__piarium_precmd() {
  __piarium_emit "D;\$?"
  __piarium_emit "P;Cwd=\$(__piarium_escape "\$PWD")"
  __piarium_emit "A"
}

autoload -Uz add-zsh-hook 2>/dev/null || true
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook preexec __piarium_preexec
  add-zsh-hook precmd __piarium_precmd
fi
`;

const scriptPath = (name: string, contents: string, encoding: BufferEncoding = "utf8"): string => {
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "piarium-shell-integration");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}-${hash}${name === "powershell" ? ".ps1" : ".sh"}`);
  writeFileSync(file, contents, { encoding });
  return file;
};

export type ShellIntegrationFamily = "bash" | "powershell" | "zsh";

export const shellIntegrationFamily = (executable: string): ShellIntegrationFamily | null => {
  const name = executable.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const id = name.endsWith(".exe") ? name.slice(0, -4) : name;
  if (id === "bash" || id === "sh") return "bash";
  if (id === "zsh") return "zsh";
  if (id === "pwsh" || id === "powershell") return "powershell";
  return null;
};

const materializeZshDotDir = (): string => {
  const hash = createHash("sha256").update(ZSH_SCRIPT).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "piarium-shell-integration", `zsh-${hash}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, ".zshrc"), ZSH_SCRIPT);
  writeFileSync(join(directory, ".zprofile"), 'source "${ZDOTDIR:-$HOME}/.zshrc"\n');
  return directory;
};

export const materializeShellIntegrationScript = (family: ShellIntegrationFamily): string => {
  if (family === "powershell") return scriptPath("powershell", `\ufeff${POWERSHELL_SCRIPT}`, "utf8");
  if (family === "zsh") return join(materializeZshDotDir(), ".zshrc");
  return scriptPath("bash", BASH_SCRIPT);
};

export const shellIntegrationLaunch = (
  executable: string,
  baseArgs: readonly string[],
  loginShell: boolean,
): { args: string[]; env: Record<string, string> } | null => {
  const family = shellIntegrationFamily(executable);
  if (!family) return null;
  const env = {
    PIARIUM_SHELL_INTEGRATION_KIND: family,
    ...(loginShell ? { PIARIUM_LOGIN_SHELL: "1" } : {}),
  };
  if (family === "powershell") {
    return {
      args: [...baseArgs, "-NoExit", "-ExecutionPolicy", "Bypass", "-File", materializeShellIntegrationScript(family)],
      env,
    };
  }
  if (family === "zsh") {
    return {
      args: [...baseArgs],
      env: { ...env, ZDOTDIR: materializeZshDotDir() },
    };
  }
  return {
    args: [...baseArgs, "--init-file", materializeShellIntegrationScript(family)],
    env,
  };
};
