import { organizeGeneric } from "./generic.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote } from "./text.js";

const isFail = (line: string): boolean => /^(FAIL\s|FAIL\t)/.test(line);
const isPass = (line: string): boolean => /^(PASS\s|PASS\t)/.test(line);
const isSummary = (line: string): boolean => (
  /^(Test Files|Tests\b|Test Suites:|Snapshots:|Time:|Duration |Start at |Ran all test suites)/.test(line)
);
const isNoise = (line: string): boolean => (
  line.startsWith("RERUN")
  || /^[·.•]+$/.test(line.replace(/\s/g, ""))
  || /^(✓|✔)\s/.test(line)
  || /^[.\s]+$/.test(line)
);

export function organizeVitest(output: string, budget: number): { text: string; omitted: boolean; recognized: boolean } {
  const lines = output.split("\n");
  const failures: string[] = [];
  const summaries: string[] = [];
  const passes: string[] = [];
  const prompts: string[] = [];
  const context: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]!.trimStart();
    if (isInteractivePrompt(lines[index]!)) {
      prompts.push(lines[index]!.trimEnd());
      index += 1;
      continue;
    }
    if (isFail(trimmed)) {
      const block: string[] = [];
      const start = trimmed;
      while (index < lines.length) {
        const current = lines[index]!;
        const currentTrimmed = current.trimStart();
        if (
          block.length > 0
          && (isFail(currentTrimmed) || isPass(currentTrimmed) || isSummary(currentTrimmed))
          && currentTrimmed !== start
        ) {
          break;
        }
        if (!isNoise(currentTrimmed) || isFail(currentTrimmed)) block.push(current.trimEnd());
        index += 1;
      }
      if (block.length > 0) failures.push(block.join("\n"));
      continue;
    }
    if (isSummary(trimmed)) summaries.push(lines[index]!.trimEnd());
    else if (isPass(trimmed)) passes.push(lines[index]!.trimEnd());
    else if (!isNoise(trimmed) && trimmed.length > 0) context.push(lines[index]!.trimEnd());
    index += 1;
  }

  if (failures.length === 0 && summaries.length === 0 && passes.length === 0) {
    return { ...organizeGeneric(output, budget), recognized: false };
  }

  const packed = fitBlocks({
    required: [...prompts, ...failures, ...summaries],
    optional: summaries.length > 0 ? context : [...context, ...passes],
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}
