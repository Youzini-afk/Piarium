/**
 * Parse FinalTerm/VS Code OSC 133/633 command lifecycle sequences.
 * Command text and exit codes come only from those sequences — never from
 * prompt painting or raw PTY text.
 */

export type ShellIntegrationSequence =
  | { kind: "prompt-start" }
  | { kind: "command-start" }
  | { kind: "command-executed" }
  | { kind: "command-finished"; exitCode: number }
  | { kind: "command-line"; command: string }
  | { kind: "cwd"; cwd: string };

export type TerminalCommandObservation = {
  command: string;
  commandId: string;
  cwd?: string;
  endedAt: number;
  exitCode: number;
  integration: "osc-633";
  startedAt?: number;
  terminalId: string;
};

export type ShellIntegrationStatus = "not-observed" | "ready";

/* eslint-disable no-control-regex -- OSC 133/633 frames use ESC and BEL */
const OSC_START = /\u001b\](?:133|633);/u;
const ST_OR_BEL = /\u0007|\u001b\\|\u009c/u;

export const decodeShellIntegrationPayload = (value: string): string => {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const hex = value.slice(index + 1, index + 4);
    if (/^x[0-9a-fA-F]{2}$/u.test(hex)) {
      decoded += String.fromCharCode(Number.parseInt(hex.slice(1), 16));
      index += 3;
      continue;
    }
    decoded += value[index + 1] ?? "";
    index += 1;
  }
  return decoded;
};

export const encodeShellIntegrationPayload = (value: string): string => (
  value.replace(/\\/gu, "\\\\").replace(/;/gu, "\\x3b")
);

export const parseShellIntegrationBody = (body: string): ShellIntegrationSequence | null => {
  if (body === "A") return { kind: "prompt-start" };
  if (body === "B") return { kind: "command-start" };
  if (body === "C") return { kind: "command-executed" };
  if (body === "D") return { kind: "command-finished", exitCode: 0 };
  if (body.startsWith("D;")) {
    const code = Number.parseInt(body.slice(2), 10);
    if (!Number.isInteger(code)) return null;
    return { kind: "command-finished", exitCode: code };
  }
  if (body.startsWith("E;")) {
    return { kind: "command-line", command: decodeShellIntegrationPayload(body.slice(2)) };
  }
  if (body.startsWith("P;")) {
    for (const part of body.slice(2).split(";")) {
      if (part.startsWith("Cwd=")) {
        return { kind: "cwd", cwd: decodeShellIntegrationPayload(part.slice(4)) };
      }
    }
  }
  return null;
};

const consumeOscChunk = (
  pending: string,
  data: string,
): { pending: string; sequences: ShellIntegrationSequence[] } => {
  const input = `${pending}${data}`;
  const sequences: ShellIntegrationSequence[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const match = OSC_START.exec(input.slice(cursor));
    if (!match || match.index === undefined) {
      const tail = input.slice(Math.max(cursor, input.length - 8));
      return { pending: /\u001b(?:\](?:1(?:3(?:3)?)?)?)?$/u.test(tail) ? tail : "", sequences };
    }
    const absolute = cursor + match.index;
    const bodyStart = absolute + match[0].length;
    const rest = input.slice(bodyStart);
    const end = rest.search(ST_OR_BEL);
    if (end < 0) return { pending: input.slice(absolute), sequences };
    const terminator = rest[end] === "\u001b" ? 2 : 1;
    const parsed = parseShellIntegrationBody(rest.slice(0, end));
    if (parsed) sequences.push(parsed);
    cursor = bodyStart + end + terminator;
  }
  return { pending: "", sequences };
};

export function createShellIntegrationParser(options: {
  now?: () => number;
  terminalId: string;
}): {
  consume(data: string): TerminalCommandObservation[];
  reset(generation: number): void;
  status(): ShellIntegrationStatus;
} {
  const now = options.now ?? Date.now;
  let pending = "";
  let generation = 0;
  let sequence = 0;
  let status: ShellIntegrationStatus = "not-observed";
  let cwd: string | undefined;
  let command: string | undefined;
  let startedAt: number | undefined;
  let awaitingFinish = false;

  const finish = (exitCode: number, endedAt: number): TerminalCommandObservation | null => {
    if (!awaitingFinish || typeof command !== "string" || command.length === 0) {
      awaitingFinish = false;
      command = undefined;
      startedAt = undefined;
      return null;
    }
    sequence += 1;
    const observation: TerminalCommandObservation = {
      command,
      commandId: `${options.terminalId}:${generation}:${sequence}`,
      endedAt,
      exitCode,
      integration: "osc-633",
      terminalId: options.terminalId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
    awaitingFinish = false;
    command = undefined;
    startedAt = undefined;
    return observation;
  };

  return {
    consume(data: string) {
      const parsed = consumeOscChunk(pending, data);
      pending = parsed.pending;
      const finished: TerminalCommandObservation[] = [];
      for (const item of parsed.sequences) {
        status = "ready";
        if (item.kind === "cwd") {
          cwd = item.cwd;
          continue;
        }
        if (item.kind === "command-line") {
          command = item.command;
          awaitingFinish = true;
          startedAt = startedAt ?? now();
          continue;
        }
        if (item.kind === "command-start" || item.kind === "command-executed") {
          awaitingFinish = true;
          startedAt = startedAt ?? now();
          continue;
        }
        if (item.kind === "command-finished") {
          const observation = finish(item.exitCode, now());
          if (observation) finished.push(observation);
        }
      }
      return finished;
    },
    reset(nextGeneration: number) {
      generation = nextGeneration;
      sequence = 0;
      pending = "";
      status = "not-observed";
      cwd = undefined;
      command = undefined;
      startedAt = undefined;
      awaitingFinish = false;
    },
    status: () => status,
  };
}
