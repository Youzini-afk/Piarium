import React from 'react';
import type {
  JsonValue,
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  PiToolCall,
  PiToolResultMessage,
  PiUserContent,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';

interface PiTimelineProps {
  entries: PiSessionEntry[];
  hiddenThinkingLabel?: string;
  liveAssistant?: PiAssistantMessage;
  onRecover(entry: PiSessionMessageEntry): void;
  recoveryBusyEntryId?: string | null;
  sessionId: string;
  toolExecutions: Record<string, PiToolExecutionState>;
}

const imageUrl = (content: Extract<PiUserContent, { type: 'image' }>): string => (
  `data:${content.mimeType};base64,${content.data}`
);

const jsonText = (value: JsonValue): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

const PiUserContentView: React.FC<{
  content: string | PiUserContent[];
  messageId: string;
  variant?: 'assistant' | 'tool';
}> = ({ content, messageId, variant = 'assistant' }) => {
  const parts: PiUserContent[] = typeof content === 'string'
    ? [{ text: content, type: 'text' }]
    : content;
  return (
    <>
      {parts.map((part, index) => (
        part.type === 'text' ? (
          <MarkdownRenderer
            key={`${messageId}:text:${index}`}
            content={part.text}
            messageId={`${messageId}:text:${index}`}
            variant={variant}
            enableFileReferences
          />
        ) : (
          <a
            key={`${messageId}:image:${index}`}
            href={imageUrl(part)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block w-fit max-w-full overflow-hidden rounded-lg border border-border/70 bg-background"
          >
            <img
              src={imageUrl(part)}
              alt={part.mimeType}
              className="max-h-[32rem] max-w-full object-contain"
            />
          </a>
        )
      ))}
    </>
  );
};

const ToolResultContent: React.FC<{
  messageId: string;
  result: PiToolResultMessage;
}> = ({ messageId, result }) => (
  <div className="space-y-2">
    <PiUserContentView content={result.content} messageId={messageId} variant="tool" />
    {result.details !== undefined && (
      <details className="group/details">
        <summary className="cursor-pointer select-none typography-micro text-muted-foreground hover:text-foreground">
          details
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
          {jsonText(result.details)}
        </pre>
      </details>
    )}
  </div>
);

const PiToolCard: React.FC<{
  call: PiToolCall;
  execution?: PiToolExecutionState;
  result?: PiToolResultMessage;
}> = ({ call, execution, result }) => {
  const status = result
    ? (result.isError ? 'error' : 'success')
    : execution?.status ?? 'running';
  const transientOutput = execution?.result ?? execution?.partialResult;
  return (
    <details
      className={cn(
        'group',
        'my-2 overflow-hidden rounded-lg border bg-muted/20',
        status === 'error' ? 'border-[var(--status-error)]/40' : 'border-border/70',
      )}
      open={status === 'running'}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 typography-ui-label text-foreground [&::-webkit-details-marker]:hidden">
        <Icon
          name={status === 'running' ? 'loader-4' : status === 'error' ? 'error-warning' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            status === 'running' && 'animate-spin text-primary',
            status === 'error' && 'text-[var(--status-error)]',
            status === 'success' && 'text-[var(--status-success)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono">{call.name}</span>
        <span className="typography-micro text-muted-foreground">{status}</span>
        <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-border/60 px-3 py-2">
        <div>
          <p className="mb-1 typography-micro font-medium text-muted-foreground">arguments</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
            {jsonText(call.arguments)}
          </pre>
        </div>
        {result ? (
          <ToolResultContent messageId={`tool-result:${call.id}`} result={result} />
        ) : transientOutput !== undefined ? (
          <div>
            <p className="mb-1 typography-micro font-medium text-muted-foreground">output</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
              {jsonText(transientOutput)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
};

const MetaEntry: React.FC<{
  children: React.ReactNode;
  icon: React.ComponentProps<typeof Icon>['name'];
}> = ({ children, icon }) => (
  <div className="mx-auto flex w-fit max-w-full items-start gap-2 rounded-md bg-muted/30 px-3 py-1.5 typography-meta text-muted-foreground">
    <Icon name={icon} className="mt-0.5 size-3.5 shrink-0" />
    <div className="min-w-0 break-words">{children}</div>
  </div>
);

const AssistantMessage: React.FC<{
  entryId: string;
  executionById: Record<string, PiToolExecutionState>;
  hiddenThinkingLabel?: string;
  message: PiAssistantMessage;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  streaming?: boolean;
}> = ({ entryId, executionById, hiddenThinkingLabel, message, resultByCallId, streaming = false }) => (
  <div className="max-w-full">
    {message.content.map((content, index) => {
      if (content.type === 'text') {
        return (
          <MarkdownRenderer
            key={`${entryId}:text:${index}`}
            content={content.text}
            messageId={`${entryId}:text:${index}`}
            isStreaming={streaming}
            enableFileReferences
          />
        );
      }
      if (content.type === 'thinking') {
        return (
          <details key={`${entryId}:thinking:${index}`} className="my-2 rounded-lg border border-border/60 bg-muted/15">
            <summary className="cursor-pointer select-none px-3 py-2 typography-meta text-muted-foreground">
              {hiddenThinkingLabel || 'Thinking'}{content.redacted ? ' (redacted)' : ''}
            </summary>
            {!content.redacted && (
              <div className="border-t border-border/60 px-3 py-2 text-muted-foreground">
                <MarkdownRenderer
                  content={content.thinking}
                  messageId={`${entryId}:thinking:${index}`}
                  isStreaming={streaming}
                  variant="reasoning"
                />
              </div>
            )}
          </details>
        );
      }
      return (
        <PiToolCard
          key={`${entryId}:tool:${content.id}`}
          call={content}
          execution={executionById[content.id]}
          result={resultByCallId.get(content.id)}
        />
      );
    })}
    {message.errorMessage && (
      <div className="mt-2 rounded-md bg-[var(--status-error)]/10 px-3 py-2 typography-meta text-[var(--status-error)]">
        {message.errorMessage}
      </div>
    )}
  </div>
);

export const PiTimeline: React.FC<PiTimelineProps> = ({
  entries,
  hiddenThinkingLabel,
  liveAssistant,
  onRecover,
  recoveryBusyEntryId,
  sessionId,
  toolExecutions,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(true);
  const resultByCallId = React.useMemo(() => {
    const results = new Map<string, PiToolResultMessage>();
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message.role === 'toolResult') {
        results.set(entry.message.toolCallId, entry.message);
      }
    }
    return results;
  }, [entries]);
  const knownToolCallIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      for (const content of entry.message.content) {
        if (content.type === 'toolCall') ids.add(content.id);
      }
    }
    if (liveAssistant) {
      for (const content of liveAssistant.content) {
        if (content.type === 'toolCall') ids.add(content.id);
      }
    }
    return ids;
  }, [entries, liveAssistant]);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTailRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, liveAssistant, toolExecutions]);

  const renderedEntries = entries.filter((entry) => {
    if (entry.type === 'custom_message' && !entry.display) return false;
    if (entry.type === 'message' && entry.message.role === 'custom' && !entry.message.display) return false;
    if (
      entry.type === 'message'
      && entry.message.role === 'toolResult'
      && knownToolCallIds.has(entry.message.toolCallId)
    ) return false;
    return true;
  });

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        {renderedEntries.map((entry) => {
          if (entry.type === 'message') {
            const { message } = entry;
            if (message.role === 'user') {
              return (
                <article key={entry.id} className="group/message ml-auto max-w-[min(85%,48rem)]" style={{ contentVisibility: 'auto' }}>
                  <div className="rounded-2xl rounded-br-md bg-primary/10 px-4 py-3 text-foreground">
                    <PiUserContentView content={message.content} messageId={entry.id} />
                  </div>
                  <div className="mt-1 flex h-6 items-center justify-end opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onRecover(entry)}
                          disabled={recoveryBusyEntryId !== null && recoveryBusyEntryId !== undefined}
                          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                          aria-label={t('chat.messageBody.actions.revertAria')}
                        >
                          <Icon
                            name={recoveryBusyEntryId === entry.id ? 'loader-4' : 'history'}
                            className={cn('size-3.5', recoveryBusyEntryId === entry.id && 'animate-spin')}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('chat.messageBody.actions.revert')}</TooltipContent>
                    </Tooltip>
                  </div>
                </article>
              );
            }
            if (message.role === 'assistant') {
              return (
                <article key={entry.id} className="mr-auto w-full max-w-[52rem]" style={{ contentVisibility: 'auto' }}>
                  <AssistantMessage
                    entryId={entry.id}
                    executionById={toolExecutions}
                    hiddenThinkingLabel={hiddenThinkingLabel || t('chat.reasoningTrace.thinking')}
                    message={message}
                    resultByCallId={resultByCallId}
                  />
                </article>
              );
            }
            if (message.role === 'toolResult') {
              return (
                <article key={entry.id} className="mr-auto w-full max-w-[52rem] rounded-lg border border-border/60 bg-muted/15 px-3 py-2" style={{ contentVisibility: 'auto' }}>
                  <div className="mb-2 flex items-center gap-2 typography-ui-label text-foreground">
                    <Icon name={message.isError ? 'error-warning' : 'check'} className="size-3.5" />
                    <span className="font-mono">{message.toolName}</span>
                  </div>
                  <ToolResultContent messageId={entry.id} result={message} />
                </article>
              );
            }
            if (message.role === 'bashExecution') {
              return (
                <article key={entry.id} className="w-full rounded-lg border border-border/60 bg-muted/15" style={{ contentVisibility: 'auto' }}>
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 typography-ui-label text-foreground">
                    <Icon name="terminal" className="size-3.5" />
                    <code className="min-w-0 flex-1 break-all">{message.command}</code>
                    {message.cancelled ? <span>cancelled</span> : message.exitCode !== undefined ? <span>exit {message.exitCode}</span> : null}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono typography-meta text-foreground">{message.output}</pre>
                  {message.truncated && (
                    <p className="border-t border-border/60 px-3 py-1.5 typography-micro text-[var(--status-warning)]">
                      Output was truncated by Pi; the complete output path is shown below when available.
                    </p>
                  )}
                  {message.fullOutputPath && (
                    <p className="border-t border-border/60 px-3 py-1.5 break-all font-mono typography-micro text-muted-foreground">
                      {message.fullOutputPath}
                    </p>
                  )}
                </article>
              );
            }
            if (message.role === 'custom') {
              return (
                <MetaEntry key={entry.id} icon="plug-2">
                  <strong>{message.customType}</strong>
                  <PiUserContentView content={message.content} messageId={entry.id} />
                </MetaEntry>
              );
            }
            if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
              return (
                <article key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2" style={{ contentVisibility: 'auto' }}>
                  <div className="mb-1 flex items-center gap-2 typography-meta font-medium text-muted-foreground">
                    <Icon name="contract-up-down" className="size-3.5" />
                    {message.role === 'branchSummary' ? 'Branch summary' : `Compaction · ${message.tokensBefore} tokens`}
                  </div>
                  <MarkdownRenderer content={message.summary} messageId={entry.id} />
                </article>
              );
            }
            return (
              <MetaEntry key={entry.id} icon="error-warning">
                <strong>{message.originalRole}</strong>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(message.data)}</pre>
              </MetaEntry>
            );
          }

          if (entry.type === 'custom_message') {
            return (
              <MetaEntry key={entry.id} icon="plug-2">
                <strong>{entry.customType}</strong>
                <PiUserContentView content={entry.content} messageId={entry.id} />
              </MetaEntry>
            );
          }
          if (entry.type === 'compaction' || entry.type === 'branch_summary') {
            return (
              <article key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2" style={{ contentVisibility: 'auto' }}>
                <div className="mb-1 flex items-center gap-2 typography-meta font-medium text-muted-foreground">
                  <Icon name="contract-up-down" className="size-3.5" />
                  {entry.type === 'compaction' ? `Compaction · ${entry.tokensBefore} tokens` : 'Branch summary'}
                </div>
                <MarkdownRenderer content={entry.summary} messageId={entry.id} />
              </article>
            );
          }
          if (entry.type === 'model_change') {
            return <MetaEntry key={entry.id} icon="sparkling">Model: {entry.provider}/{entry.modelId}</MetaEntry>;
          }
          if (entry.type === 'thinking_level_change') {
            return <MetaEntry key={entry.id} icon="brain">Thinking: {entry.thinkingLevel}</MetaEntry>;
          }
          if (entry.type === 'session_info') {
            return <MetaEntry key={entry.id} icon="pencil-ai">Session name: {entry.name ?? 'Untitled'}</MetaEntry>;
          }
          if (entry.type === 'label') {
            return <MetaEntry key={entry.id} icon="target">{entry.label ?? 'Label'} → {entry.targetId}</MetaEntry>;
          }
          if (entry.type === 'custom') {
            return (
              <details key={entry.id} className="mx-auto max-w-full rounded-md bg-muted/30 px-3 py-1.5 typography-meta text-muted-foreground">
                <summary className="cursor-pointer select-none">Extension state · {entry.customType}</summary>
                {entry.data !== undefined && (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono typography-micro text-foreground">{jsonText(entry.data)}</pre>
                )}
              </details>
            );
          }
          return (
            <MetaEntry key={entry.id} icon="error-warning">
              <strong>{entry.originalType}</strong>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{jsonText(entry.data)}</pre>
            </MetaEntry>
          );
        })}

        {liveAssistant && (
          <article className="mr-auto w-full max-w-[52rem]" aria-live="polite">
            <AssistantMessage
              entryId={`live:${sessionId}`}
              executionById={toolExecutions}
              hiddenThinkingLabel={hiddenThinkingLabel || t('chat.reasoningTrace.thinking')}
              message={liveAssistant}
              resultByCallId={resultByCallId}
              streaming
            />
          </article>
        )}
      </div>
    </div>
  );
};
