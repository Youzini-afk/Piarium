import { organizeGeneric } from "./generic.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote } from "./text.js";

const FILE_ERROR_PAREN = /^(.+?)\((\d+),(\d+)\):\s+error (TS\d+):\s*(.*)$/;
const FILE_ERROR_PRETTY = /^(.+?):(\d+):(\d+)\s+-\s+error (TS\d+):\s*(.*)$/;
const FILE_ERROR_PLAIN = /^(.+?):(\d+):(\d+):\s+error (TS\d+):\s*(.*)$/;
const TOP_ERROR = /^\s*error (TS\d+):\s*(.*)$/;
const SUMMARY = /^\s*Found\s+\d+\s+errors?\b/;

function isErrorStart(line: string): boolean {
  return FILE_ERROR_PAREN.test(line)
    || FILE_ERROR_PRETTY.test(line)
    || FILE_ERROR_PLAIN.test(line)
    || TOP_ERROR.test(line);
}

export function organizeTsc(output: string, budget: number, exitCode?: number): { text: string; omitted: boolean; recognized: boolean } {
  const lines = output.split("\n");
  const errors: string[] = [];
  const summaries: string[] = [];
  const prompts: string[] = [];
  const context: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isInteractivePrompt(line)) {
      prompts.push(line.trimEnd());
      continue;
    }
    if (SUMMARY.test(line)) {
      summaries.push(line.trimEnd());
      continue;
    }
    if (isErrorStart(line)) {
      const block = [line.trimEnd()];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (isErrorStart(next) || SUMMARY.test(next) || isInteractivePrompt(next)) break;
        block.push(next.trimEnd());
        index += 1;
      }
      errors.push(block.join("\n").trimEnd());
      continue;
    }
    if (line.trim()) context.push(line.trimEnd());
  }

  if (errors.length === 0 && summaries.length === 0) {
    if (exitCode !== undefined && exitCode !== 0) return { ...organizeGeneric(output, budget), recognized: false };
    return { ...organizeGeneric(output, budget), recognized: false };
  }

  const packed = fitBlocks({
    required: [...prompts, ...errors, ...summaries],
    optional: context.length > 0 ? [context.join("\n")] : [],
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}
