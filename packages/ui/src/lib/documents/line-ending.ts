import type { DocumentLineEnding } from './types';

export const detectLineEnding = (content: string): DocumentLineEnding => {
  if (content.includes('\r\n')) return 'crlf';
  if (content.includes('\r')) return 'cr';
  return 'lf';
};

export const normalizeEditorLineEndings = (content: string): string => (
  content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
);

export const serializeEditorContent = (content: string, lineEnding: DocumentLineEnding): string => {
  const normalized = normalizeEditorLineEndings(content);
  if (lineEnding === 'crlf') return normalized.replace(/\n/g, '\r\n');
  if (lineEnding === 'cr') return normalized.replace(/\n/g, '\r');
  return normalized;
};
