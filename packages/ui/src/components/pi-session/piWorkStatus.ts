import type { PiSessionEntry, SessionSnapshot } from '@piarium/protocol';

export const piWorkStatusQueueCount = (snapshot: SessionSnapshot): number => (
  snapshot.pendingMessageCount + snapshot.steering.length + snapshot.followUp.length
);

const contentText = (content: string | Array<{ type: string; text?: string }>): string => {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is { type: 'text'; text: string } => (
      part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
};

export const piWorkStatusEntryPreview = (entry: PiSessionEntry | undefined): string | null => {
  if (!entry) return null;
  let text = '';
  if (entry.type === 'message') {
    if (entry.message.role === 'user') text = contentText(entry.message.content);
    if (entry.message.role === 'assistant') {
      text = entry.message.content
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    }
  }
  if (entry.type === 'custom_message') text = contentText(entry.content);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
};

