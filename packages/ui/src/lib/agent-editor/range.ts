export const sliceDocumentRange = (
  buffer: string,
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
): string => {
  const lines = buffer.length === 0 ? [''] : buffer.split('\n');
  const startLine = Math.min(Math.max(1, range.startLine), lines.length);
  const endLine = Math.min(Math.max(startLine, range.endLine), lines.length);
  const start = lines[startLine - 1] ?? '';
  const end = lines[endLine - 1] ?? '';
  const startColumn = Math.min(Math.max(1, range.startColumn), start.length + 1);
  const endColumn = Math.min(Math.max(1, range.endColumn), end.length + 1);
  if (startLine === endLine) return start.slice(startColumn - 1, endColumn - 1);
  const first = start.slice(startColumn - 1);
  const middle = lines.slice(startLine, endLine - 1);
  const last = end.slice(0, endColumn - 1);
  return [first, ...middle, last].join('\n');
};
