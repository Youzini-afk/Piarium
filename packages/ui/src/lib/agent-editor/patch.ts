import type { HunkDecision, ParsedPatchHunk, ParsedPatchHunkLine, PatchApplyTextResult } from './types';

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

const splitLines = (text: string): string[] => {
  if (text.length === 0) return [];
  return text.split('\n');
};

const joinLines = (lines: string[]): string => lines.join('\n');

export const parseUnifiedHunks = (patch: string): ParsedPatchHunk[] => {
  const lines = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const hunks: ParsedPatchHunk[] = [];
  let current: ParsedPatchHunk | null = null;
  for (const line of lines) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      if (current) hunks.push(current);
      current = {
        index: hunks.length,
        header: line,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'remove', text: line.slice(1) });
      continue;
    }
    if (line.startsWith(' ') || line.length === 0) {
      current.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  if (current) hunks.push(current);
  return hunks;
};

const oldLines = (hunk: ParsedPatchHunk): string[] => (
  hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text)
);

const newLines = (hunk: ParsedPatchHunk): string[] => (
  hunk.lines.filter((line) => line.kind !== 'remove').map((line) => line.text)
);

const reverseHunk = (hunk: ParsedPatchHunk): ParsedPatchHunk => ({
  ...hunk,
  oldStart: hunk.newStart,
  oldCount: hunk.newCount,
  newStart: hunk.oldStart,
  newCount: hunk.oldCount,
  lines: hunk.lines.map((line): ParsedPatchHunkLine => (
    line.kind === 'add'
      ? { kind: 'remove', text: line.text }
      : line.kind === 'remove'
        ? { kind: 'add', text: line.text }
        : line
  )),
});

const applyOne = (lines: string[], hunk: ParsedPatchHunk): { status: 'applied'; lines: string[] } | { status: 'mismatch' } => {
  const expected = oldLines(hunk);
  const start = hunk.oldCount === 0 ? Math.max(0, hunk.oldStart) : Math.max(0, hunk.oldStart - 1);
  const actual = lines.slice(start, start + expected.length);
  if (actual.length !== expected.length) return { status: 'mismatch' };
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return { status: 'mismatch' };
  }
  const next = [...lines.slice(0, start), ...newLines(hunk), ...lines.slice(start + expected.length)];
  return { status: 'applied', lines: next };
};

export const applyHunkDecisions = (
  original: string,
  hunks: readonly ParsedPatchHunk[],
  decisions: readonly HunkDecision[],
  direction: 'apply' | 'revert' = 'apply',
): PatchApplyTextResult => {
  const selected = hunks
    .map((hunk, index) => ({ hunk, decision: decisions[index] ?? 'reject' }))
    .filter((item) => item.decision === 'accept')
    .map((item) => (direction === 'revert' ? reverseHunk(item.hunk) : item.hunk))
    .sort((left, right) => right.oldStart - left.oldStart || right.index - left.index);
  let lines = splitLines(original);
  for (const hunk of selected) {
    const next = applyOne(lines, hunk);
    if (next.status === 'mismatch') return { status: 'mismatch', hunkIndex: hunk.index };
    lines = next.lines;
  }
  return { status: 'applied', content: joinLines(lines) };
};
