import { stripControlSequences } from "../shell-supervisor.js";
import { sliceUtf8ByBytes } from "@piarium/protocol";

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
    lines.push(parts.findLast((part) => part.length > 0) ?? "");
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

export function utf8Slice(text: string, start: number, end: number): string {
  if (end <= start) return "";
  const bytes = Buffer.from(text, "utf8");
  let safeStart = Math.min(Math.max(0, start), bytes.length);
  let safeEnd = Math.min(Math.max(safeStart, end), bytes.length);
  while (safeStart < safeEnd && (bytes[safeStart]! & 0xc0) === 0x80) safeStart += 1;
  while (safeEnd > safeStart && safeEnd < bytes.length && (bytes[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1;
  if (safeEnd <= safeStart) return "";
  return sliceUtf8ByBytes(text, safeStart, safeEnd - safeStart).text;
}

function compactBlock(block: string, budget: number): string {
  if (utf8Bytes(block) <= budget) return block;
  if (budget <= 0) return "";

  const marker = "\n[… block content omitted …]\n";
  if (budget <= utf8Bytes(marker)) return utf8Slice(block, 0, budget);
  const room = Math.max(0, budget - utf8Bytes(marker));
  const fullBytes = utf8Bytes(block);
  const headBytes = Math.ceil(room / 2);
  const tailBytes = room - headBytes;
  const head = utf8Slice(block, 0, headBytes);
  const tail = utf8Slice(block, Math.max(0, fullBytes - tailBytes), fullBytes);
  return `${head}${marker}${tail}`;
}

export function fitBlocks(input: {
  required: readonly string[];
  optional?: readonly string[];
  budget: number;
}): { text: string; omitted: number; omittedBytes: number } {
  const budget = Math.max(1, input.budget);
  const required = input.required.filter((block) => block.length > 0);
  const optional = (input.optional ?? []).filter((block) => block.length > 0);
  const fullRequiredBytes = required.reduce((total, block) => total + utf8Bytes(block), 0)
    + Math.max(0, required.length - 1);

  let omitted = 0;
  let omittedBytes = 0;
  if (fullRequiredBytes <= budget) {
    const kept = [...required];
    let used = fullRequiredBytes;
    for (const block of optional) {
      const size = utf8Bytes(block) + (kept.length > 0 ? 1 : 0);
      if (used + size <= budget) {
        kept.push(block);
        used += size;
      } else {
        omitted += 1;
        omittedBytes += utf8Bytes(block);
      }
    }
    return { text: joinBlocks(kept), omitted, omittedBytes };
  }

  // When required blocks overflow, retain a location-bearing fragment from
  // every block before spending the remaining budget on detail. This keeps a
  // later failure or summary visible even when an earlier failure has a very
  // large code frame.
  const separatorBytes = Math.max(0, required.length - 1);
  const contentBudget = Math.max(0, budget - separatorBytes);
  const firstLines = required.map((block) => block.slice(0, block.indexOf("\n") === -1 ? block.length : block.indexOf("\n")));
  const minimumBytes = firstLines.reduce((total, line) => total + utf8Bytes(line), 0);
  const allocations = firstLines.map((line) => utf8Bytes(line));
  let remaining = Math.max(0, contentBudget - minimumBytes);
  if (minimumBytes > contentBudget) {
    // Even the block headings cannot all fit. Treat this required section as
    // one continuous block so separators cannot consume the whole budget.
    const text = compactBlock(joinBlocks(required), budget);
    return {
      text,
      omitted: 1 + optional.length,
      omittedBytes: fullRequiredBytes - utf8Bytes(text)
        + optional.reduce((total, block) => total + utf8Bytes(block), 0),
    };
  } else {
    for (let index = 0; index < required.length && remaining > 0; index += 1) {
      const capacity = Math.max(0, utf8Bytes(required[index]!) - allocations[index]!);
      const added = Math.min(capacity, remaining);
      allocations[index] = allocations[index]! + added;
      remaining -= added;
    }
  }

  const kept: string[] = [];
  for (let index = 0; index < required.length; index += 1) {
    const block = required[index]!;
    const fullBytes = utf8Bytes(block);
    const clipped = compactBlock(block, allocations[index]!);
    if (clipped.length === 0) {
      omitted += 1;
      omittedBytes += fullBytes;
      continue;
    }
    kept.push(clipped);
    const shownBytes = utf8Bytes(clipped);
    if (shownBytes < fullBytes) {
      omitted += 1;
      omittedBytes += fullBytes - shownBytes;
    }
  }
  for (const block of optional) {
    omitted += 1;
    omittedBytes += utf8Bytes(block);
  }
  return { text: joinBlocks(kept), omitted, omittedBytes };
}

export function omissionNote(omitted: number, omittedBytes: number): string {
  if (omitted <= 0) return "";
  return `[omitted ${omitted} block(s), ${omittedBytes} bytes still retained — use get_output with offset/length or the full handle]`;
}
