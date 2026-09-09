import { organizeGeneric } from "./generic.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote } from "./text.js";

type Issue = {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  rule?: string;
};

const STYLISH = /^\s+(\d+):(\d+)\s+(error|warning|off)\s+(.+?)(?:\s+(\S+))?$/;
const UNIX = /^(.+?):(\d+):(\d+):\s+(.+?)\s+\[(error|warning)\/(.+)\]$/;
const SUMMARY = /^✖\s+\d+\s+problem/;

const formatIssue = (issue: Issue): string => {
  const rule = issue.rule ? ` ${issue.rule}` : "";
  return `${issue.file}:${issue.line}:${issue.column} ${issue.severity} ${issue.message}${rule}`;
};

const parseJson = (output: string): { issues: Issue[]; summary: string } | undefined => {
  const trimmed = output.trimStart();
  if (!trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Array<{
      filePath?: string;
      messages?: Array<{ line?: number; column?: number; severity?: number; message?: string; ruleId?: string | null }>;
    }>;
    if (!Array.isArray(parsed) || !parsed.some((row) => row.filePath && row.messages)) return undefined;
    const issues: Issue[] = [];
    let errors = 0;
    let warnings = 0;
    for (const file of parsed) {
      for (const message of file.messages ?? []) {
        const severity = message.severity === 2 ? "error" : "warning";
        if (severity === "error") errors += 1;
        else warnings += 1;
        issues.push({
          file: file.filePath ?? "<unknown>",
          line: message.line ?? 0,
          column: message.column ?? 0,
          severity,
          message: message.message ?? "",
          ...(message.ruleId ? { rule: message.ruleId } : {}),
        });
      }
    }
    return { issues, summary: `✖ ${errors + warnings} problems (${errors} errors, ${warnings} warnings)` };
  } catch {
    return undefined;
  }
};

export function organizeEslint(output: string, budget: number): { text: string; omitted: boolean; recognized: boolean } {
  const json = parseJson(output);
  const issues: Issue[] = json?.issues ?? [];
  const prompts: string[] = [];
  const summaries: string[] = json?.summary ? [json.summary] : [];
  if (!json) {
    let currentFile: string | undefined;
    for (const line of output.split("\n")) {
      if (isInteractivePrompt(line)) {
        prompts.push(line.trimEnd());
        continue;
      }
      const trimmed = line.trim();
      if (SUMMARY.test(trimmed)) {
        summaries.push(trimmed);
        continue;
      }
      const unix = trimmed.match(UNIX);
      if (unix) {
        issues.push({
          file: unix[1]!,
          line: Number(unix[2]),
          column: Number(unix[3]),
          severity: unix[5]!,
          message: unix[4]!,
          ...(unix[6] ? { rule: unix[6] } : {}),
        });
        continue;
      }
      const stylish = line.match(STYLISH);
      if (stylish && currentFile) {
        issues.push({
          file: currentFile,
          line: Number(stylish[1]),
          column: Number(stylish[2]),
          severity: stylish[3]!,
          message: stylish[4]!.trim(),
          ...(stylish[5] ? { rule: stylish[5] } : {}),
        });
        continue;
      }
      if (trimmed && !trimmed.startsWith("✖") && !/^\d+:\d+/.test(trimmed) && !trimmed.startsWith("[")) {
        currentFile = trimmed;
      }
    }
  }

  if (issues.length === 0 && summaries.length === 0) {
    return { ...organizeGeneric(output, budget), recognized: false };
  }

  const packed = fitBlocks({
    required: [...prompts, ...issues.map(formatIssue), ...summaries],
    budget,
  });
  const note = omissionNote(packed.omitted, packed.omittedBytes);
  return {
    text: joinBlocks(note ? [packed.text, note] : [packed.text]),
    omitted: packed.omitted > 0,
    recognized: true,
  };
}
