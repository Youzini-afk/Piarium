import { describe, expect, it } from "vitest";
import {
  createShellIntegrationParser,
  encodeShellIntegrationPayload,
  parseShellIntegrationBody,
} from "./shell-integration.js";

const osc = (body: string): string => `\u001b]633;${body}\u0007`;

describe("shell integration parser", () => {
  it("emits a finished command only when OSC supplies the command text and exit code", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-1", now: () => 1_000 });
    expect(parser.consume(`${osc("C")}${osc("D;0")}`)).toEqual([]);
    expect(parser.status()).toBe("ready");
    const finished = parser.consume(`${osc(`E;${encodeShellIntegrationPayload("echo hi")}`)}${osc("D;0")}`);
    expect(finished).toEqual([
      expect.objectContaining({
        command: "echo hi",
        commandId: "term-1:0:1",
        exitCode: 0,
        integration: "osc-633",
        terminalId: "term-1",
      }),
    ]);
  });

  it("carries OSC sequences across PTY chunks and decodes escaped command text", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-2" });
    expect(parser.consume("\u001b]633;E;echo ")).toEqual([]);
    const finished = parser.consume(`${encodeShellIntegrationPayload("a;b")}\u0007${osc("D;2")}`);
    expect(finished[0]).toMatchObject({ command: "echo a;b", exitCode: 2 });
  });

  it("does not invent a command from prompt painting or a finished sequence without E", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-3" });
    expect(parser.consume(`$ echo hi\r\n${osc("A")}${osc("D;0")}`)).toEqual([]);
    expect(parseShellIntegrationBody("D;not-a-number")).toBeNull();
  });

  it("resets generation so later command ids cannot collide", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-4" });
    parser.reset(1);
    const first = parser.consume(`${osc("E;one")}${osc("D;0")}`);
    parser.reset(2);
    const second = parser.consume(`${osc("E;two")}${osc("D;1")}`);
    expect(first[0]?.commandId).toBe("term-4:1:1");
    expect(second[0]?.commandId).toBe("term-4:2:1");
  });
});
