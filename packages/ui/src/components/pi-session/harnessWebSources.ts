import type { PiSessionEntry } from '@piarium/protocol';
import type { WebSource } from '@/stores/useWebSourcesStore';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const fallbackTitle = (url: string): string => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

export const projectHarnessWebSources = (
  sessionId: string,
  entries: readonly PiSessionEntry[],
): Array<Omit<WebSource, 'id' | 'pinned'>> => entries.flatMap((entry) => {
  if (entry.type !== 'message' || entry.message.role !== 'toolResult') return [];
  const message = entry.message;
  const tool = message.toolName;
  if (tool !== 'webfetch' && tool !== 'websearch') return [];
  const details = message.details;
  if (!isRecord(details)) return [];
  const sources = details.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source) => {
    if (!isRecord(source) || typeof source.url !== 'string' || !source.url.trim()) return [];
    const url = source.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    } catch {
      return [];
    }
    return [{
      sessionId,
      url,
      title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : fallbackTitle(url),
      fetchedAt: message.timestamp,
      toolCallId: message.toolCallId,
      tool,
    }];
  });
});
