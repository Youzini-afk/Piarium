import { describe, expect, it } from "vitest";
import { createOutputStore } from "../output-store.js";
import { createObservationCursorStore } from "../observation-cursors.js";
import { createShellExecService, createShellReadService } from "../harness-services.js";
import type { HarnessServiceHost } from "../service-host.js";
import type { HarnessServiceContext } from "../router.js";
import { identifyFromCommand, organizeShellOutput, utf8Bytes } from "./index.js";
import { SHELL_DISPLAY_BUDGET } from "./text.js";

const VITEST_FAIL = [
  " RUN  v4.1.11",
  "",
  "✓ src/ok.test.ts (2)",
  "RERUN  src/mid.test.ts x1",
  "FAIL src/mid.test.ts",
  "  × math > adds 1ms",
  "    AssertionError: expected 2 to be 1",
  "    - Expected",
  "    + Received",
  "",
  "    - 1",
  "    + 2",
  "",
  "    ❯ src/mid.test.ts:4:10",
  "",
  "✓ src/other.test.ts (8)",
  "",
  " Test Files  1 failed | 2 passed (3)",
  "      Tests  1 failed | 10 passed (11)",
  "   Start at  02:14:18",
  "   Duration  3.42s",
].join("\n");

const VITEST_PASS = [
  " RUN  v4.1.11",
  "✓ a.test.ts (4)",
  "✓ b.test.ts (6)",
  " Test Files  2 passed (2)",
  "      Tests  10 passed (10)",
  "   Duration  1.10s",
].join("\n");

const TSC_FAIL = [
  "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
  "Found 2 errors in 2 files.",
].join("\n");

const ESLINT_FAIL = [
  "src/a.ts",
  "  4:9  error  Unexpected any  @typescript-eslint/no-explicit-any",
  "  8:1  warning  Missing return  consistent-return",
  "",
  "✖ 2 problems (1 error, 1 warning)",
].join("\n");

const GIT_STATUS = [
  "On branch main",
  "Changes not staged for commit:",
  "  modified:   packages/web/src/a.ts",
  "Untracked files:",
  "  docs/new.md",
].join("\n");

const GIT_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " export const x = 1;",
  "+export const y = 2;",
  " export const z = 3;",
].join("\n");

describe("command identification", () => {
  it("recognizes wrappers and combinations without executing them", () => {
    expect(identifyFromCommand("bunx vitest run")?.kind).toBe("vitest");
    expect(identifyFromCommand("npx tsc --noEmit")?.kind).toBe("tsc");
    expect(identifyFromCommand("bun run lint && npx eslint src")?.kind).toBe("eslint");
    expect(identifyFromCommand("git -C repo status")?.gitSubcommand).toBe("status");
    expect(identifyFromCommand("bun run test")?.kind).toBeUndefined();
  });
});

describe("vitest organizer", () => {
  it("keeps a failure block buried in successful logs and real stats", () => {
    const noise = `${"ok line\n".repeat(80)}${VITEST_FAIL}`;
    const organized = organizeShellOutput({ command: "bunx vitest run", output: noise, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("FAIL src/mid.test.ts");
    expect(organized.text).toContain("AssertionError: expected 2 to be 1");
    expect(organized.text).toContain("Tests  1 failed | 10 passed (11)");
    expect(organized.text).not.toContain("RERUN");
    expect(organized.text).not.toMatch(/^✓ /m);
  });

  it("folds success logs and does not invent a pass from exit code", () => {
    const organized = organizeShellOutput({ command: "bun run test", output: VITEST_PASS, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("Test Files  2 passed (2)");
    expect(organized.text).not.toContain("✓ a.test.ts");
  });

  it("does not delete unrecognized vitest-invoked output", () => {
    const organized = organizeShellOutput({
      command: "vitest run",
      output: "downloading browser binaries...\nstill working",
      complete: true,
      exitCode: 0,
    });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("downloading browser binaries");
  });
});

describe("tsc organizer", () => {
  it("keeps file, code, message, and summary", () => {
    const organized = organizeShellOutput({ command: "npx tsc --noEmit", output: TSC_FAIL, complete: true, exitCode: 2 });
    expect(organized.kind).toBe("tsc");
    expect(organized.text).toContain("src/a.ts(12,5): error TS2322");
    expect(organized.text).toContain("Found 2 errors in 2 files.");
  });

  it("does not claim success when exit is non-zero and no errors parsed", () => {
    const organized = organizeShellOutput({
      command: "tsc",
      output: "tsc: something unexpected happened",
      complete: true,
      exitCode: 2,
    });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("something unexpected happened");
    expect(organized.text).not.toMatch(/all passed|no errors/i);
  });
});

describe("eslint organizer", () => {
  it("keeps file, position, rule, severity, and summary", () => {
    const organized = organizeShellOutput({ command: "npx eslint src", output: ESLINT_FAIL, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("eslint");
    expect(organized.text).toContain("src/a.ts:4:9 error Unexpected any @typescript-eslint/no-explicit-any");
    expect(organized.text).toContain("✖ 2 problems (1 error, 1 warning)");
  });
});

describe("git organizer", () => {
  it("keeps status paths and diff hunks instead of treating them as log noise", () => {
    const status = organizeShellOutput({ command: "git status", output: GIT_STATUS, complete: true, exitCode: 0 });
    expect(status.text).toContain("modified:   packages/web/src/a.ts");
    expect(status.text).toContain("docs/new.md");
    const diff = organizeShellOutput({ command: "git diff", output: GIT_DIFF, complete: true, exitCode: 0 });
    expect(diff.text).toContain("+export const y = 2;");
    const unknown = organizeShellOutput({ command: "git stash list", output: "stash@{0}: WIP", complete: true, exitCode: 0 });
    expect(unknown.kind).toBe("generic");
    expect(unknown.text).toContain("stash@{0}: WIP");
  });
});

describe("normalization and budget", () => {
  it("handles ANSI, CRLF, and a dangling fragment as a current observation", () => {
    const organized = organizeShellOutput({
      command: "npx tsc --noEmit",
      output: "src/a.ts(1,1): error TS1234: broken\r\n\x1b[31msrc/b.ts(2,2): error TS1111: more\x1b[0m",
      complete: false,
    });
    expect(organized.partial).toBe(true);
    expect(organized.text).toContain("src/a.ts(1,1): error TS1234");
    expect(organized.text).toContain("src/b.ts(2,2): error TS1111");
    expect(organized.text).not.toContain("\x1b");
  });

  it("states omission when failures exceed the existing display budget", () => {
    const failures = Array.from({ length: 80 }, (_, index) => (
      `FAIL src/f${index}.test.ts\n  AssertionError: case ${index}\n  Expected: ${"x".repeat(400)}\n`
    )).join("");
    const output = `${failures} Test Files  80 failed (80)\n      Tests  80 failed (80)\n   Duration  9s`;
    const organized = organizeShellOutput({ command: "vitest run", output, complete: true, exitCode: 1 });
    expect(organized.omitted).toBe(true);
    expect(organized.text).toContain("FAIL src/f0.test.ts");
    expect(organized.text).toContain("omitted");
    expect(utf8Bytes(organized.text)).toBeLessThanOrEqual(SHELL_DISPLAY_BUDGET);
  });

  it("reports representative before/after display sizes", () => {
    const padded = `${"PASS src/ok.test.ts\n".repeat(40)}${VITEST_FAIL}`;
    const organized = organizeShellOutput({ command: "vitest run", output: padded, complete: true, exitCode: 1 });
    expect(utf8Bytes(padded)).toBe(1166);
    expect(utf8Bytes(organized.text)).toBeLessThan(350);
    expect(organized.text).toContain("AssertionError");
    expect(organized.text).toContain("Tests  1 failed | 10 passed (11)");
  });
});

describe("public bash and get_output chain", () => {
  const context = (): HarnessServiceContext => ({
    actor: {
      authorityInstanceId: "authority",
      sessionId: "s",
      workerId: "w",
      workerGeneration: 1,
      workspaceId: "ws",
      grantedCapabilities: ["process.shell"],
    },
    authorizedPaths: [],
    sessionId: "s",
    workspaceId: "ws",
    signal: new AbortController().signal,
  });

  it("returns organized display from shell.exec while stdout stays raw", async () => {
    const store = createOutputStore();
    const supervisor = {
      exec: async () => ({
        kind: "completed" as const,
        exitCode: 1,
        durationMs: 10,
        cwd: ".",
        stdout: `${"noise\n".repeat(20)}${VITEST_FAIL}`,
        stderr: "",
        handle: null,
        shown: null,
      }),
    };
    const host = {
      outputStore: store,
      observationCursors: createObservationCursorStore(),
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    const result = await createShellExecService(host).handle({ command: "bunx vitest run" }, context());
    if (result.kind !== "completed") throw new Error("expected completed");
    expect(result.stdout).toContain("RERUN");
    expect(result.display).toContain("FAIL src/mid.test.ts");
    expect(result.display).not.toContain("RERUN");
    expect(result.organized?.kind).toBe("vitest");
  });

  it("organizes incremental get_output and keeps explicit paging on raw bytes", async () => {
    const output = `${"ok\n".repeat(5)}${VITEST_FAIL}`;
    const cursors = createObservationCursorStore();
    const supervisor = {
      exec: async () => ({
        kind: "background" as const,
        id: "sh_1",
        waitedMs: 10,
        cwd: ".",
        outputSoFar: "ok\n",
        command: "bunx vitest run",
      }),
      read: async (_id: string, offset = 0, length = 32_768) => {
        const bytes = Buffer.from(output, "utf8");
        const end = Math.min(bytes.length, offset + length);
        return {
          text: bytes.subarray(offset, end).toString("utf8"),
          offset,
          length: end - offset,
          nextOffset: end,
          total: bytes.length,
          eof: end >= bytes.length,
          running: false,
          exitCode: 1,
          command: "bunx vitest run",
        };
      },
    };
    const host = {
      outputStore: createOutputStore(),
      observationCursors: cursors,
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    await createShellExecService(host).handle({ command: "bunx vitest run", waitMs: 10 }, context());
    const incremental = await createShellReadService(host).handle({ id: "sh_1" }, context());
    expect(incremental.text).toContain("RERUN");
    expect(incremental.display).toContain("FAIL src/mid.test.ts");
    expect(incremental.display).not.toContain("RERUN");
    expect(incremental.organized?.kind).toBe("vitest");
    const rawPage = await createShellReadService(host).handle({ id: "sh_1", offset: 0, length: 20 }, context());
    expect(rawPage.text.startsWith("ok\n")).toBe(true);
    expect(rawPage.display).toBeUndefined();
    cursors.dispose();
  });
});
