import { describe, expect, it } from "vitest";
import {
  createShellIntegrationParser,
  encodeShellIntegrationPayload,
  formatPiariumOscFrame,
  parseShellIntegrationBody,
  piariumShellIntegrationId,
} from "./shell-integration.js";

const osc = (terminalId: string, body: string, generation = 0): string => (
  formatPiariumOscFrame(piariumShellIntegrationId(terminalId, generation), body)
);

describe("shell integration parser", () => {
  it("emits a finished command only when this integration's tagged OSC supplies the command text and exit code", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-1", now: () => 1_000 });
    expect(parser.consume(`${osc("term-1", "C")}${osc("term-1", "D;0")}`)).toEqual([]);
    expect(parser.status()).toBe("ready");
    const finished = parser.consume(`${osc("term-1", `E;${encodeShellIntegrationPayload("echo hi")}`)}${osc("term-1", "D;0")}`);
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

  it("carries tagged OSC sequences across PTY chunks and decodes escaped command text", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-2" });
    expect(parser.consume("\u001b]633;pi;term-2:0;E;echo ")).toEqual([]);
    const finished = parser.consume(`${encodeShellIntegrationPayload("a;b")}\u0007${osc("term-2", "D;2")}`);
    expect(finished[0]).toMatchObject({ command: "echo a;b", exitCode: 2 });
  });

  it("does not invent a command from prompt painting, untagged OSC, or a finished sequence without E", () => {
    const tagged = createShellIntegrationParser({ terminalId: "term-3" });
    expect(tagged.consume(`$ echo hi\r\n${osc("term-3", "A")}${osc("term-3", "D;0")}`)).toEqual([]);
    expect(tagged.status()).toBe("ready");

    const untagged = createShellIntegrationParser({ terminalId: "term-3" });
    expect(untagged.consume("\u001b]633;E;echo alien\u0007\u001b]633;D;0\u0007")).toEqual([]);
    expect(untagged.consume("\u001b]133;D;0\u0007")).toEqual([]);
    expect(untagged.status()).toBe("not-observed");
    expect(parseShellIntegrationBody("D;not-a-number")).toBeNull();
  });

  it("ignores frames tagged for another integration generation", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-4" });
    parser.reset(2);
    expect(parser.consume(`${osc("term-4", "E;old", 1)}${osc("term-4", "D;0", 1)}`)).toEqual([]);
    expect(parser.status()).toBe("not-observed");
  });

  it("resets generation so later command ids cannot collide and stale command state is dropped", () => {
    const parser = createShellIntegrationParser({ terminalId: "term-4" });
    parser.reset(1);
    parser.consume(osc("term-4", "E;one", 1));
    parser.consume(osc("term-4", "C", 1));
    parser.reset(2);
    expect(parser.consume(osc("term-4", "D;0", 2))).toEqual([]);
    const first = parser.consume(`${osc("term-4", "E;one", 1)}${osc("term-4", "D;0", 1)}`);
    expect(first).toEqual([]);
    const second = parser.consume(`${osc("term-4", "E;two", 2)}${osc("term-4", "D;1", 2)}`);
    expect(second[0]?.commandId).toBe("term-4:2:1");
  });
});
