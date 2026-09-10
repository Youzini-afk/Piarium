import { describe, expect, it } from "vitest";
import { discoverShells, listWindowsProgramRoots, parseWslDistroList } from "./shell-discovery.js";

const executable = (files: Set<string>) => {
  const normalized = new Set([...files].map((file) => file.replace(/\//g, "\\").toLowerCase()));
  return (filePath: unknown): filePath is string => (
    typeof filePath === "string" && normalized.has(filePath.replace(/\//g, "\\").toLowerCase())
  );
};

describe("listWindowsProgramRoots", () => {
  it("uses the same Program Files and LocalAppData roots as Git discovery", () => {
    expect(listWindowsProgramRoots({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LocalAppData: "C:\\Users\\Ada\\AppData\\Local",
    })).toEqual([
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\Users\\Ada\\AppData\\Local",
    ]);
  });
});

describe("parseWslDistroList", () => {
  it("parses UTF-16LE WSL output and skips blanks", () => {
    const text = "Ubuntu\0\r\n\0docker-desktop\0\r\n\0";
    const buffer = Buffer.from(`\uFEFF${text}`, "utf16le");
    expect(parseWslDistroList(buffer)).toEqual(["Ubuntu", "docker-desktop"]);
  });
});

describe("discoverShells", () => {
  it("prefers usr\\bin\\bash.exe when both launcher and real bash exist", () => {
    const discovered = discoverShells({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
      runtime: {
        isExecutable: executable(new Set([
          "C:\\Program Files\\Git\\bin\\bash.exe",
          "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        ])),
        searchPathFor: () => null,
      },
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    });
    expect(discovered.gitBashPath).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
    expect(discovered.hasBash).toBe(true);
  });

  it("keeps bin\\bash.exe when usr\\bin is missing", () => {
    const discovered = discoverShells({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      runtime: {
        isExecutable: executable(new Set(["C:\\Program Files\\Git\\bin\\bash.exe"])),
        searchPathFor: () => null,
      },
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    });
    expect(discovered.gitBashPath).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("resolves a Git Bash path that contains spaces from PATH", () => {
    const bash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
    const discovered = discoverShells({
      platform: "win32",
      env: {},
      runtime: {
        isExecutable: executable(new Set([bash])),
        searchPathFor: (name) => name === "bash" ? bash : null,
      },
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    });
    expect(discovered.gitBashPath).toBe(bash);
  });

  it("finds bash beside an already-resolved git.exe", () => {
    const discovered = discoverShells({
      platform: "win32",
      env: {},
      runtime: {
        isExecutable: executable(new Set([
          "D:\\Tools\\Git\\cmd\\git.exe",
          "D:\\Tools\\Git\\usr\\bin\\bash.exe",
        ])),
        searchPathFor: () => null,
        resolveGitBinaryForSpawn: () => "D:\\Tools\\Git\\cmd\\git.exe",
      },
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    });
    expect(discovered.gitBashPath).toBe("D:\\Tools\\Git\\usr\\bin\\bash.exe");
  });

  it("omits gitBashPath when no interpreter is executable", () => {
    const discovered = discoverShells({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      runtime: {
        isExecutable: executable(new Set()),
        searchPathFor: () => null,
      },
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0) }),
    });
    expect(discovered.gitBashPath).toBeUndefined();
    expect(discovered.hasBash).toBe(false);
  });

  it("records WSL distros from wsl.exe --list --quiet", () => {
    const discovered = discoverShells({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      runtime: {
        isExecutable: executable(new Set(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"])),
        searchPathFor: (name) => name === "wsl" ? "C:\\Windows\\System32\\wsl.exe" : null,
      },
      spawnSyncFn: (command, args) => {
        expect(command).toBe("C:\\Windows\\System32\\wsl.exe");
        expect(args).toEqual(["--list", "--quiet"]);
        return { status: 0, stdout: Buffer.from("Ubuntu\n") };
      },
    });
    expect(discovered.wslDistros).toEqual(["Ubuntu"]);
    expect(discovered.hasPowerShell).toBe(true);
  });

  it("reports POSIX bash without inventing a Git Bash path", () => {
    const discovered = discoverShells({
      platform: "linux",
      runtime: {
        isExecutable: executable(new Set(["/bin/bash"])),
        searchPathFor: (name) => name === "bash" ? "/bin/bash" : null,
      },
    });
    expect(discovered).toEqual({ hasBash: true, hasPowerShell: false });
  });
});
