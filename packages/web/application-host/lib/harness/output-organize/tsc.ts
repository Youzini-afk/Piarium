import { organizeGeneric } from "./generic.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote } from "./text.js";

const FILE_ERROR = /^(.+?)\((\d+),(\d+)\):\s+error (TS\d+):\s*(.*)$/;
const TOP_ERROR = /^\s*error (TS\d+):\s*(.*)$/;
const SUMMARY = /^\s*Found (\d+) error/;

export function organizeTsc(output: string, budget: number, exitCode?: number): { text: string; omitted: boolean; recognized: boolean } {
  const lines = output.split("\n");
  const errors: string[] = [];
  const summaries: string[] = [];
  const prompts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isInteractivePrompt(line)) {
      prompts.push(line.trimEnd());
      continue;
    }
    const file = line.match(FILE_ERROR);
    const top = line.match(TOP_ERROR);
    if (file || top) {
      const block = [line.trimEnd()];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (FILE_ERROR.test(next) || TOP_ERROR.test(next) || SUMMARY.test(next) || isInteractivePrompt(next)) break;
        if (next.trim() === "") break;
        if (/^\s+/.test(next) || next.trimStart().startsWith(".")) {
          block.push(next.trimEnd());
          index += 1;
          continue;
        }
        break;
      }
      errors.push(block.join("\n"));
      continue;
    }
    if (SUMMARY.test(line.trim())) summaries.push(line.trimEnd());
  }

  if (errors.length === 0 && summaries.length === 0) {
    if (exitCode !== undefined && exitCode !== 0) return { ...organizeGeneric(output, budget), recognized: false };
    return { ...organizeGeneric(output, budget), recognized: false };
  }

  const packed = fitBlocks({
    required: [...prompts, ...errors, ...summaries],
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}
