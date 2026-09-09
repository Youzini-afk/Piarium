import { stripControlSequences } from "../shell-supervisor.js";

export const SHELL_DISPLAY_BUDGET = 32_768;
export const SHELL_DISPLAY_CHROME = 512;

export const organizeBudget = (budget = SHELL_DISPLAY_BUDGET): number => (
  Math.max(1, budget - SHELL_DISPLAY_CHROME)
);

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
export const stripAnsi = stripControlSequences;

/** Normalize CRLF and CR progress overwrites without deleting the last visible segment. */
export function normalizeShellText(text: string): string {
  const stripped = stripAnsi(text);
  const lines: string[] = [];
  for (const rawLine of stripped.split(/\r\n|\n/)) {
    const parts = rawLine.split("\r");
    lines.push(parts[parts.length - 1] ?? "");
  }
  return lines.join("\n");
}

export function isInteractivePrompt(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    /\(y\/n\)/i.test(trimmed)
    || /\[y\/n\]/i.test(trimmed)
    || /\[Y\/n\]/.test(trimmed)
    || /password:/i.test(trimmed)
    || /passphrase:/i.test(trimmed)
    || /^\?\s/.test(trimmed)
    || /Continue\?/i.test(trimmed)
  );
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.length > 0).join("\n");
}

export function fitBlocks(input: {
  required: readonly string[];
  optional?: readonly string[];
  budget: number;
}): { text: string; omitted: number; omittedBytes: number } {
  const optional = input.optional ?? [];
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  let omittedBytes = 0;
  const push = (block: string, required: boolean): boolean => {
    const size = utf8Bytes(block) + (kept.length > 0 ? 1 : 0);
    if (used + size <= input.budget) {
      kept.push(block);
      used += size;
      return true;
    }
    if (required && kept.length === 0) {
      const raw = Buffer.from(block, "utf8");
      const slice = raw.subarray(0, Math.max(0, input.budget - 80));
      const clipped = `${slice.toString("utf8").replace(/\uFFFD$/u, "")}\n[omitted remainder of this block]`;
      kept.push(clipped);
      used = utf8Bytes(clipped);
      omitted += 1;
      omittedBytes += raw.byteLength - utf8Bytes(clipped);
      return false;
    }
    omitted += 1;
    omittedBytes += utf8Bytes(block);
    return false;
  };
  for (const block of input.required) {
    if (!push(block, true)) {
      for (const rest of optional) {
        omitted += 1;
        omittedBytes += utf8Bytes(rest);
      }
      return { text: joinBlocks(kept), omitted, omittedBytes };
    }
  }
  for (const block of optional) push(block, false);
  return { text: joinBlocks(kept), omitted, omittedBytes };
}

export function omissionNote(omitted: number, omittedBytes: number): string {
  if (omitted <= 0) return "";
  return `[omitted ${omitted} block(s), ${omittedBytes} bytes still retained — use get_output with offset/length or the full handle]`;
}
