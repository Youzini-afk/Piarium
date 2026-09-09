import { organizeGeneric } from "./generic.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote } from "./text.js";

const isStatusPath = (line: string): boolean => (
  /^[ MADRCU?!]{2}\s+\S/.test(line)
  || /^\s+(modified|new file|deleted|renamed|copied|untracked):/i.test(line)
  || /^\s+[MADRCU?!]\s+\S/.test(line)
);

const isStatusHeader = (line: string): boolean => (
  /^(On branch|Your branch|Changes to be committed|Changes not staged|Untracked files|nothing to commit|HEAD detached)/i.test(line.trim())
);

const isDiffHeader = (line: string): boolean => (
  /^(diff --git|index |---|--- |\+\+\+ |\+\+\+ |@@ |commit |Author:|Date:|Merge:)/.test(line)
  || line.startsWith("diff --git")
);

export function organizeGit(output: string, subcommand: string | undefined, budget: number, exitCode?: number): {
  text: string;
  omitted: boolean;
  recognized: boolean;
} {
  if (!subcommand) {
    return { ...organizeGeneric(output, budget), recognized: false };
  }
  if (subcommand === "status") return organizeStatus(output, budget);
  if (subcommand === "diff" || subcommand === "show") return organizeDiff(output, budget);
  if (subcommand === "log") return organizeLog(output, budget);
  if (exitCode !== undefined && exitCode !== 0) return { ...organizeGeneric(output, budget), recognized: false };
  return { ...organizeGeneric(output, budget), recognized: false };
}

function organizeStatus(output: string, budget: number): { text: string; omitted: boolean; recognized: boolean } {
  const headers: string[] = [];
  const paths: string[] = [];
  const prompts: string[] = [];
  let untracked = false;
  for (const line of output.split("\n")) {
    if (/^Untracked files:/i.test(line.trim())) untracked = true;
    else if (isStatusHeader(line) && !/^Untracked files:/i.test(line.trim())) untracked = false;
    if (isInteractivePrompt(line)) prompts.push(line.trimEnd());
    else if (isStatusPath(line)) paths.push(line.trimEnd());
    else if (untracked && /^\s+\S/.test(line) && !/^\s+\(use /i.test(line)) paths.push(line.trimEnd());
    else if (isStatusHeader(line)) headers.push(line.trimEnd());
  }
  if (headers.length === 0 && paths.length === 0) {
    return { ...organizeGeneric(output, budget), recognized: false };
  }
  const packed = fitBlocks({
    required: [...prompts, ...headers, ...paths],
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}

function collectHunks(output: string): { headers: string[]; hunks: string[]; prompts: string[] } {
  const headers: string[] = [];
  const hunks: string[] = [];
  const prompts: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) hunks.push(current.join("\n"));
    current = [];
  };
  for (const line of output.split("\n")) {
    if (isInteractivePrompt(line)) {
      prompts.push(line.trimEnd());
      continue;
    }
    if (line.startsWith("@@ ")) {
      flush();
      current = [line.trimEnd()];
      continue;
    }
    if (current.length > 0 && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
      current.push(line.trimEnd());
      continue;
    }
    if (isDiffHeader(line) || line.startsWith("    ") && headers.length > 0) {
      flush();
      headers.push(line.trimEnd());
      continue;
    }
    if (current.length > 0) current.push(line.trimEnd());
    else if (line.trim()) headers.push(line.trimEnd());
  }
  flush();
  return { headers, hunks, prompts };
}

function organizeDiff(output: string, budget: number): { text: string; omitted: boolean; recognized: boolean } {
  const { headers, hunks, prompts } = collectHunks(output);
  if (headers.length === 0 && hunks.length === 0) {
    return { ...organizeGeneric(output, budget), recognized: false };
  }
  const packed = fitBlocks({
    required: [...prompts, ...hunks, ...headers.filter((line) => /^(commit |Author:|Date:|diff --git)/.test(line))],
    optional: headers.filter((line) => !/^(commit |Author:|Date:|diff --git)/.test(line)),
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}

function organizeLog(output: string, budget: number): { text: string; omitted: boolean; recognized: boolean } {
  const commits: string[] = [];
  const prompts: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) commits.push(current.join("\n"));
    current = [];
  };
  for (const line of output.split("\n")) {
    if (isInteractivePrompt(line)) {
      prompts.push(line.trimEnd());
      continue;
    }
    if (/^commit [0-9a-f]{7,40}\b/.test(line)) {
      flush();
      current = [line.trimEnd()];
      continue;
    }
    if (current.length > 0) current.push(line.trimEnd());
  }
  flush();
  if (commits.length === 0) return { ...organizeGeneric(output, budget), recognized: false };
  const packed = fitBlocks({ required: [...prompts, ...commits], budget });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}
