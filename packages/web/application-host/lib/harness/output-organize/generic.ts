import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote, utf8Bytes } from "./text.js";

export function organizeGeneric(output: string, budget: number): { text: string; omitted: boolean } {
  const collapsed: string[] = [];
  let previous = "";
  for (const line of output.split("\n")) {
    if (line === previous && line.trim() !== "" && !isInteractivePrompt(line)) continue;
    collapsed.push(line);
    previous = line;
  }
  const prompts = collapsed.filter((line) => isInteractivePrompt(line));
  const body = collapsed.filter((line) => !isInteractivePrompt(line));
  const packed = fitBlocks({
    required: prompts.length > 0 ? [joinBlocks(prompts)] : [],
    optional: body.length > 0 ? [joinBlocks(body)] : [],
    budget,
  });
  if (utf8Bytes(joinBlocks(collapsed)) <= budget && packed.omitted === 0) {
    return { text: joinBlocks(collapsed), omitted: false };
  }
  if (packed.omitted === 0) return { text: packed.text, omitted: false };
  return { text: joinBlocks([packed.text, omissionNote(packed.omitted, packed.omittedBytes)]), omitted: true };
}
