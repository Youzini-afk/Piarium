export interface PiComposerMentionInsertion {
  cursor: number;
  text: string;
}

export const insertPiComposerMention = (
  text: string,
  cursor: number,
  mention: string,
): PiComposerMentionInsertion => {
  const boundedCursor = Math.min(Math.max(cursor, 0), text.length);
  const beforeCursor = text.slice(0, boundedCursor);
  const at = beforeCursor.lastIndexOf('@');
  const start = at >= 0 && (at === 0 || /\s/.test(beforeCursor[at - 1]))
    ? at
    : boundedCursor;
  const normalizedMention = mention.trim().replace(/^@+/, '');
  const inserted = `@${normalizedMention} `;
  const suffixStart = /[ \t]/.test(text[boundedCursor] ?? '')
    ? boundedCursor + 1
    : boundedCursor;
  return {
    cursor: start + inserted.length,
    text: `${text.slice(0, start)}${inserted}${text.slice(suffixStart)}`,
  };
};
