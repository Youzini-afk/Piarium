import {
  intro,
  log,
  outro,
} from "@clack/prompts";

export interface CliConsole {
  error(...values: unknown[]): void;
  log(...values: unknown[]): void;
}

export interface CliOutputMode {
  json: boolean;
  quiet: boolean;
}

export interface CliSuccessMessage {
  human: readonly string[];
  json: Record<string, unknown>;
  quiet: string;
}

const canRenderClack = (output: CliConsole, mode: CliOutputMode): boolean => (
  output === console
  && process.stdout.isTTY === true
  && !mode.json
  && !mode.quiet
);

const singleLine = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();

const quietError = (messages: readonly string[]): string => {
  const details = messages.map(singleLine);
  if (details.length === 0) return "error unknown failure";
  if (details.length === 1) return `error ${details[0]}`;
  return `error ${details.length} issues: ${details.join("; ")}`;
};

export class CliOutput {
  readonly #mode: CliOutputMode;
  readonly #output: CliConsole;

  constructor(mode: CliOutputMode, output: CliConsole) {
    this.#mode = mode;
    this.#output = output;
  }

  success(message: CliSuccessMessage): void {
    if (this.#mode.json) {
      this.#output.log(JSON.stringify({ ok: true, ...message.json }));
      return;
    }
    if (this.#mode.quiet) {
      this.#output.log(singleLine(message.quiet));
      return;
    }
    if (canRenderClack(this.#output, this.#mode)) {
      intro("Piarium extension");
      for (const [index, line] of message.human.entries()) {
        if (index === 0) log.success(line);
        else log.info(line);
      }
      outro("");
      return;
    }
    for (const line of message.human) this.#output.log(line);
  }

  error(command: string | undefined, messages: readonly string[]): void {
    if (this.#mode.json) {
      this.#output.log(JSON.stringify({
        command: command ?? null,
        errors: [...messages],
        ok: false,
      }));
      return;
    }
    if (canRenderClack(this.#output, this.#mode)) {
      for (const message of messages) log.error(message);
      return;
    }
    if (this.#mode.quiet) {
      this.#output.error(quietError(messages));
      return;
    }
    for (const message of messages) this.#output.error(`Error: ${message}`);
  }
}
