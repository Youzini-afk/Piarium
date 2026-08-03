import type { PiAssistantMessage, PiSessionEntry } from '@piarium/protocol';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 350;

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const assistantText = (message: PiAssistantMessage): string => message.content
  .filter((content) => content.type === 'text')
  .map((content) => content.text)
  .join('\n')
  .trim();

export const parseStructuredGenerationText = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  throw new Error('Pi did not return a JSON object');
};

const latestNewAssistant = (
  entries: readonly PiSessionEntry[],
  previousIds: ReadonlySet<string>,
): PiAssistantMessage | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (previousIds.has(entry.id) || entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    if (entry.message.stopReason === 'pending') continue;
    return entry.message;
  }
  return undefined;
};

export const generateStructuredInPiSession = async ({
  cwd,
  instructions,
  schema,
  sessionId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  visiblePrompt,
}: {
  cwd: string;
  instructions?: string;
  schema: Record<string, unknown>;
  sessionId: string;
  timeoutMs?: number;
  visiblePrompt: string;
}): Promise<Record<string, unknown>> => {
  const { client } = await getPiRuntimeConnection();
  await client.request('session.open', { cwd, sessionId });
  const before = await client.request('session.entries', { scope: 'branch', sessionId });
  const previousIds = new Set(before.entries.map((entry) => entry.id));
  const structuredInstructions = [
    instructions?.trim(),
    'Return only one JSON object that conforms to this JSON Schema:',
    JSON.stringify(schema),
    'Do not wrap the JSON in Markdown fences and do not add commentary.',
  ].filter((value): value is string => Boolean(value)).join('\n\n');
  const result = await client.request('agent.prompt', {
    instructions: structuredInstructions,
    sessionId,
    text: visiblePrompt.trim(),
  });
  if (!result.accepted) throw new Error('The Pi runtime did not accept the generation prompt');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await client.request('session.entries', { scope: 'branch', sessionId });
    const message = latestNewAssistant(entries.entries, previousIds);
    if (message) {
      if (message.stopReason === 'error') {
        throw new Error(message.errorMessage || 'Pi generation failed');
      }
      const text = assistantText(message);
      if (text) return parseStructuredGenerationText(text);
    }
    // Event projection can settle just before the final entry is readable.
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for Pi structured generation');
};
