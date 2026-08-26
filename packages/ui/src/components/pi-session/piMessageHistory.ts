import type { PiSessionEntry, PiUserContent } from '@piarium/protocol';

const userContentText = (content: string | PiUserContent[]): string => (
  typeof content === 'string'
    ? content
    : content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
);

export const projectPiMessageHistory = (entries: readonly PiSessionEntry[]): string[] => (
  [...entries].reverse().flatMap((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'user') return [];
    const text = userContentText(entry.message.content).trim();
    return text ? [text] : [];
  })
);
