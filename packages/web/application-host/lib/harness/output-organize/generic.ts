import { isInteractivePrompt, joinBlocks, omissionNote, utf8Bytes, utf8Slice } from "./text.js";

export function organizeGeneric(output: string, budget: number): { text: string; omitted: boolean } {
  const collapsed: string[] = [];
  let previous = "";
  for (const line of output.split("\n")) {
    if (line === previous && line.trim() !== "" && !isInteractivePrompt(line)) continue;
    collapsed.push(line);
    previous = line;
  }
  const full = joinBlocks(collapsed);
  if (utf8Bytes(full) <= budget) return { text: full, omitted: false };

  const prompts = collapsed.filter((line) => isInteractivePrompt(line));
  let promptText = joinBlocks(prompts);
  const marker = "…";
  const note = omissionNote(1, utf8Bytes(full));
  // If prompts themselves exceed the display budget, show their actual first
  // and last text too; classifying a line as a prompt must not bypass the budget.
  if (utf8Bytes(promptText) + utf8Bytes(marker) + utf8Bytes(note) + 4 >= budget) promptText = "";
  const body = promptText ? collapsed.filter((line) => !isInteractivePrompt(line)) : collapsed;
  // Reserve the separators around the head, marker, tail, and omission note.
  // The small over-reservation when a side is empty keeps the final display
  // inside the requested byte budget in that degenerate case too.
  const fixedBytes = utf8Bytes(promptText) + (promptText ? 1 : 0) + utf8Bytes(marker) + utf8Bytes(note) + 3;
  const available = Math.max(0, budget - fixedBytes);
  const headBudget = Math.ceil(available / 2);
  const tailBudget = available - headBudget;
  const bodyText = joinBlocks(body);
  const bodyBytes = utf8Bytes(bodyText);
  const head = utf8Slice(bodyText, 0, headBudget);
  const tail = utf8Slice(bodyText, Math.max(0, bodyBytes - tailBudget), bodyBytes);
  const shownBytes = utf8Bytes(joinBlocks([promptText, head, marker, tail]));
  const omittedBytes = Math.max(0, utf8Bytes(full) - shownBytes);
  const finalNote = omissionNote(1, omittedBytes);
  const final = joinBlocks([promptText, head, marker, tail, finalNote]);
  return { text: final, omitted: true };
}
