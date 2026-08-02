import React from 'react';
import type {
  PiSessionEntry,
  PiSessionMessageEntry,
  PiUsage,
} from '@piarium/protocol';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

interface TokenBreakdown {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

const EMPTY_BREAKDOWN: TokenBreakdown = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
};

const nonNegative = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

const usageBreakdown = (usage: PiUsage | undefined): TokenBreakdown => {
  if (!usage) return EMPTY_BREAKDOWN;
  return {
    cacheRead: nonNegative(usage.cacheRead),
    cacheWrite: nonNegative(usage.cacheWrite),
    input: nonNegative(usage.input),
    output: nonNegative(usage.output),
    reasoning: nonNegative(usage.reasoning),
    total: nonNegative(usage.totalTokens),
  };
};

const entryUsage = (entry: PiSessionEntry): PiUsage | undefined => {
  if (entry.type === 'message') {
    const { message } = entry;
    if (message.role === 'assistant' || message.role === 'toolResult') return message.usage;
    return undefined;
  }
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry.usage;
  return undefined;
};

const latestUsage = (entries: PiSessionEntry[]): PiUsage | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const usage = entryUsage(entries[index]);
    if (usage) return usage;
  }
  return undefined;
};

const timestampOf = (entry: PiSessionEntry): number | null => {
  const parsed = Date.parse(entry.timestamp);
  if (Number.isFinite(parsed)) return parsed;
  if (entry.type === 'message' && typeof entry.message.timestamp === 'number') return entry.message.timestamp;
  return null;
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const formatMoney = (value: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  currency: 'USD',
  maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  style: 'currency',
}).format(Number.isFinite(value) && value > 0 ? value : 0);

const formatDateTime = (
  timestamp: number | null,
  timeFormatPreference: TimeFormatPreference,
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return formatDateTimeForPreference(timestamp, timeFormatPreference, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const contentText = (entry: PiSessionMessageEntry): string => {
  const { message } = entry;
  if (message.role === 'toolResult') return `${message.toolName}${message.isError ? ' (error)' : ''}`;
  if (message.role === 'bashExecution') return message.command;
  if (message.role === 'branchSummary' || message.role === 'compactionSummary') return message.summary;
  if (message.role === 'unknown') return message.originalRole;
  if ('content' in message) {
    if (typeof message.content === 'string') return message.content;
    return message.content
      .map((content) => {
        if (content.type === 'text') return content.text;
        if (content.type === 'thinking') return content.thinking;
        if (content.type === 'toolCall') return `${content.name}(${JSON.stringify(content.arguments)})`;
        if (content.type === 'image') return `[image: ${content.mimeType}]`;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
};

const entryLabel = (entry: PiSessionEntry): string => {
  if (entry.type === 'message') {
    const snippet = contentText(entry).replace(/\s+/g, ' ').trim();
    return snippet ? `${entry.message.role}: ${snippet}` : entry.message.role;
  }
  if (entry.type === 'custom_message') return `${entry.customType}: ${typeof entry.content === 'string' ? entry.content : ''}`;
  if (entry.type === 'model_change') return `model: ${entry.provider}/${entry.modelId}`;
  if (entry.type === 'thinking_level_change') return `thinking: ${entry.thinkingLevel}`;
  if (entry.type === 'session_info') return `session: ${entry.name ?? 'Untitled'}`;
  if (entry.type === 'custom') return `extension: ${entry.customType}`;
  return entry.type;
};

export const ContextPanelContent: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const record = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
  ));
  const summary = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.summaries.find((candidate) => candidate.id === state.currentSessionId)
  ));
  const refreshStats = usePiSessionStore((state) => state.refreshStats);
  const refreshEntries = usePiSessionStore((state) => state.refreshEntries);
  const [expandedEntries, setExpandedEntries] = React.useState<Record<string, boolean>>({});
  const [copiedEntryId, setCopiedEntryId] = React.useState<string | null>(null);
  const copyResetTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!currentSessionId) return;
    void refreshStats(currentSessionId).catch(() => undefined);
    if (!record?.branchEntries) void refreshEntries(currentSessionId).catch(() => undefined);
  }, [currentSessionId, record?.branchEntries, refreshEntries, refreshStats]);

  React.useEffect(() => {
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setExpandedEntries({});
    setCopiedEntryId(null);
  }, [currentSessionId]);

  React.useEffect(() => () => {
    if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current);
  }, []);

  const copyEntry = React.useCallback(async (entryId: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (!result.ok) {
      setCopiedEntryId(null);
      return;
    }
    setCopiedEntryId(entryId);
    if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current);
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedEntryId((current) => current === entryId ? null : current);
      copyResetTimeoutRef.current = null;
    }, 2_000);
  }, []);

  if (!currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {t('contextSidebar.empty.openSession')}
      </div>
    );
  }

  const entries = record?.branchEntries?.entries ?? [];
  const stats = record?.stats;
  const usage = latestUsage(entries);
  const tokens = usageBreakdown(usage);
  const contextLimit = record?.snapshot?.model?.contextWindow ?? null;
  const usagePercent = contextLimit && contextLimit > 0
    ? Math.min(100, (tokens.total / contextLimit) * 100)
    : 0;
  const cacheInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cacheHitPercent = cacheInput > 0 ? (tokens.cacheRead / cacheInput) * 100 : null;
  const sessionTitle = record?.snapshot?.name?.trim()
    || summary?.name?.trim()
    || summary?.firstMessage?.split(/\r?\n/).find((line) => line.trim())?.trim()
    || t('contextSidebar.session.untitled');
  const createdAt = summary ? Date.parse(summary.createdAt) : null;
  const lastActivityAt = summary ? Date.parse(summary.updatedAt) : null;
  const model = record?.snapshot?.model;
  const segments = [
    { color: 'var(--status-success)', key: 'input', label: t('contextSidebar.tokens.input'), value: tokens.input },
    { color: 'var(--primary-base)', key: 'output', label: t('contextSidebar.tokens.output'), value: tokens.output },
    { color: 'var(--status-warning)', key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: tokens.cacheRead },
    { color: 'var(--surface-muted-foreground)', key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: tokens.cacheWrite },
  ];
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">
        <div className="mb-6">
          <h2 className="truncate typography-ui-header font-semibold text-foreground">{sessionTitle}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>{model ? `${model.provider} / ${model.name || model.id}` : '-'}</span>
            {Number.isFinite(createdAt) && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(createdAt, timeFormatPreference)}</span>
              </>
            )}
            {Number.isFinite(lastActivityAt) && lastActivityAt !== createdAt && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(lastActivityAt, timeFormatPreference)}</span>
              </>
            )}
          </div>
        </div>

        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="typography-micro text-muted-foreground">{t('contextSidebar.section.context')}</span>
            <span className="typography-micro tabular-nums text-muted-foreground/70">
              {formatNumber(tokens.total)}{contextLimit ? ` / ${formatNumber(contextLimit)}` : ''}
            </span>
          </div>
          <div className="mt-2.5 flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {usagePercent > 0 && (
              <div
                className="rounded-full transition-all duration-300"
                style={{
                  backgroundColor: usagePercent > 80 ? 'var(--status-warning)' : 'var(--primary-base)',
                  width: `${Math.max(0.5, usagePercent)}%`,
                }}
              />
            )}
          </div>
          <div className="mt-1.5 typography-micro font-medium tabular-nums text-foreground/80">
            {t('contextSidebar.context.percentUsed', { percent: usagePercent.toFixed(1) })}
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2">
          {[
            { label: t('contextSidebar.stats.messages'), value: formatNumber(stats?.totalMessages ?? entries.filter((entry) => entry.type === 'message').length) },
            { label: t('contextSidebar.stats.user'), value: formatNumber(stats?.userMessages ?? 0) },
            { label: t('contextSidebar.stats.assistant'), value: formatNumber(stats?.assistantMessages ?? 0) },
            { label: t('contextSidebar.stats.cost'), value: formatMoney(stats?.cost ?? 0) },
          ].map((item) => (
            <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="mb-2.5 typography-micro text-muted-foreground">{t('contextSidebar.section.lastAssistantMessage')}</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
            {[
              { label: t('contextSidebar.tokens.input'), value: tokens.input, suffix: '' },
              { label: t('contextSidebar.tokens.output'), value: tokens.output, suffix: '' },
              { label: t('contextSidebar.tokens.reasoning'), value: tokens.reasoning, suffix: '' },
              { label: t('contextSidebar.tokens.cacheRead'), value: tokens.cacheRead, suffix: '' },
              { label: t('contextSidebar.tokens.cacheWrite'), value: tokens.cacheWrite, suffix: '' },
              { label: t('contextSidebar.tokens.cacheHit'), value: cacheHitPercent, suffix: '%' },
            ].map((item) => (
              <div key={item.label}>
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                  {item.value === null ? '-' : `${item.suffix ? item.value.toFixed(1) : formatNumber(item.value)}${item.suffix}`}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {segments.map((segment) => segment.value > 0 && segmentTotal > 0 ? (
              <div
                key={segment.key}
                style={{ backgroundColor: segment.color, width: `${(segment.value / segmentTotal) * 100}%` }}
              />
            ) : null)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {segments.map((segment) => (
              <div key={segment.key} className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
                <span className="typography-micro text-muted-foreground/70">
                  {segment.label} <span className="tabular-nums">{segmentTotal > 0 ? ((segment.value / segmentTotal) * 100).toFixed(0) : '0'}%</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="typography-micro text-muted-foreground">{t('contextSidebar.section.rawMessages')}</div>
          <div className="mt-2.5 space-y-1">
            {[...entries].reverse().map((entry) => {
              const expanded = expandedEntries[entry.id] === true;
              const copied = copiedEntryId === entry.id;
              const json = expanded ? JSON.stringify(entry, null, 2) : '';
              const timestamp = timestampOf(entry);
              return (
                <div key={entry.id} className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70">
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
                    aria-expanded={expanded}
                    onClick={() => setExpandedEntries((current) => ({ ...current, [entry.id]: !expanded }))}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-2 whitespace-nowrap typography-micro">
                      <span className="min-w-0 truncate text-muted-foreground">{entryLabel(entry)}</span>
                      <span className="text-right text-muted-foreground">{formatDateTime(timestamp, timeFormatPreference)}</span>
                    </div>
                  </button>
                  {expanded && (
                    <div className="border-t border-[var(--surface-subtle)] p-0">
                      <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
                        <div className="absolute right-2 top-1 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              void copyEntry(entry.id, json);
                            }}
                            aria-label={copied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copyJson')}
                            title={copied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
                          >
                            <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
                          </button>
                        </div>
                        <WorkerHighlightedCode
                          language="json"
                          code={json}
                          style={{ background: 'transparent', margin: 0 }}
                          codeStyle={{ fontSize: 'var(--text-micro)', lineHeight: '1.35', padding: '0.75rem' }}
                          wrap
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
