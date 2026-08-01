export type ChatVirtualLayoutMode = 'standard' | 'wide';

type EstimatePart = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  value?: unknown;
  state?: unknown;
};

type EstimateMessage = {
  info?: {
    role?: unknown;
    clientRole?: unknown;
  };
  parts?: readonly EstimatePart[];
};

type EstimateTurn = {
  userMessage?: EstimateMessage;
  assistantMessages?: readonly EstimateMessage[];
  summaryText?: unknown;
  activityParts?: readonly unknown[];
  changedFiles?: readonly unknown[];
  hasTools?: boolean;
  hasReasoning?: boolean;
};

export type EstimateRenderEntry =
  | {
      kind: 'ungrouped';
      message?: EstimateMessage;
    }
  | {
      kind: 'turn';
      turn?: EstimateTurn;
    };

const DEFAULT_ITEM_SIZE: Record<ChatVirtualLayoutMode, number> = {
  standard: 256,
  wide: 208,
};

const CHARS_PER_LINE: Record<ChatVirtualLayoutMode, number> = {
  standard: 88,
  wide: 116,
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const quantize = (value: number): number => {
  return Math.round(value / 16) * 16;
};

const roleOf = (message?: EstimateMessage): string => {
  const info = message?.info;
  const clientRole = typeof info?.clientRole === 'string' ? info.clientRole : '';
  const role = typeof info?.role === 'string' ? info.role : '';
  return clientRole || role;
};

const directText = (part?: EstimatePart): string => {
  if (!part) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.value === 'string') return part.value;
  return '';
};

const stateText = (part?: EstimatePart): string => {
  const state = part?.state;
  if (!state || typeof state !== 'object') return '';
  const record = state as Record<string, unknown>;
  const metadata = typeof record.metadata === 'object' && record.metadata
    ? record.metadata as Record<string, unknown>
    : null;
  const input = typeof record.input === 'object' && record.input
    ? record.input as Record<string, unknown>
    : null;

  const candidates = [
    record.output,
    metadata?.output,
    metadata?.message,
    input?.command,
  ];

  return candidates
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .join('\n');
};

const wrappedLineCount = (text: string, charsPerLine: number): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
};

const estimateTextHeight = (text: string, charsPerLine: number): number => {
  return wrappedLineCount(text, charsPerLine) * 22;
};

const estimatePartHeight = (part: EstimatePart, mode: ChatVirtualLayoutMode): number => {
  const charsPerLine = CHARS_PER_LINE[mode];
  const type = typeof part.type === 'string' ? part.type : '';
  const text = directText(part);

  if (type === 'text') {
    return clamp(estimateTextHeight(text, charsPerLine) + 12, 24, 520);
  }

  if (type === 'reasoning') {
    return clamp(44 + estimateTextHeight(text, charsPerLine) * 0.55, 44, 240);
  }

  if (type === 'tool') {
    const detailText = stateText(part);
    return clamp(42 + estimateTextHeight(detailText, charsPerLine) * 0.22, 42, 180);
  }

  if (text) {
    return clamp(estimateTextHeight(text, charsPerLine) + 16, 28, 260);
  }

  return 34;
};

export const estimateChatMessageHeight = (
  message: EstimateMessage | undefined,
  mode: ChatVirtualLayoutMode,
): number => {
  const parts = message?.parts ?? [];
  const role = roleOf(message);
  const isUser = role === 'user';
  const base = isUser ? 58 : 74;
  const content = parts.reduce((sum, part) => sum + estimatePartHeight(part, mode), 0);
  return clamp(base + content, isUser ? 72 : 88, isUser ? 420 : 720);
};

export const estimateChatEntryHeight = (
  entry: EstimateRenderEntry,
  mode: ChatVirtualLayoutMode,
): number => {
  if (entry.kind === 'ungrouped') {
    return estimateChatMessageHeight(entry.message, mode);
  }

  const turn = entry.turn;
  if (!turn) return DEFAULT_ITEM_SIZE[mode];

  const userHeight = estimateChatMessageHeight(turn.userMessage, mode);
  const assistantHeight = (turn.assistantMessages ?? [])
    .reduce((sum, message) => sum + estimateChatMessageHeight(message, mode), 0);
  const summaryHeight = typeof turn.summaryText === 'string' && turn.summaryText.trim()
    ? clamp(estimateTextHeight(turn.summaryText, CHARS_PER_LINE[mode]) * 0.45 + 28, 28, 140)
    : 0;
  const activityHeight = Math.min((turn.activityParts?.length ?? 0) * 24, 180);
  const changedFilesHeight = Math.min((turn.changedFiles?.length ?? 0) * 20, 120);
  const flagsHeight = (turn.hasTools ? 20 : 0) + (turn.hasReasoning ? 20 : 0);

  return clamp(
    24 + userHeight + assistantHeight + summaryHeight + activityHeight + changedFilesHeight + flagsHeight,
    112,
    980,
  );
};

export const estimateVirtualizedChatItemSize = (
  entries: readonly EstimateRenderEntry[],
  mode: ChatVirtualLayoutMode,
): number => {
  if (entries.length === 0) {
    return DEFAULT_ITEM_SIZE[mode];
  }

  const sizes = entries
    .map((entry) => estimateChatEntryHeight(entry, mode))
    .sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  const median = sizes.length % 2 === 0
    ? ((sizes[mid - 1] ?? DEFAULT_ITEM_SIZE[mode]) + (sizes[mid] ?? DEFAULT_ITEM_SIZE[mode])) / 2
    : sizes[mid] ?? DEFAULT_ITEM_SIZE[mode];
  const p75 = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.75))] ?? median;

  // Bias slightly above the median so the initial virtual scrollHeight is not
  // the pathological 40px-per-turn default, without letting one huge markdown
  // block dominate every unmeasured row.
  return clamp(quantize(median * 0.72 + p75 * 0.28), 112, 640);
};
