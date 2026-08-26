import React from 'react';
import type {
  JsonValue,
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  PiToolCall,
  PiToolResultMessage,
  PiUserContent,
  PiUserMessage,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { renderTerminalOutput } from '@/components/chat/message/parts/toolOutput';
import { getApplyPatchFileEntries } from '@/components/chat/message/parts/toolDiffUtils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import type { EditorAPI } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { PatchHunkReview } from '@/components/workbench/PatchHunkReview';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';
import { PiExtensionStatusCard } from './PiExtensionStatusCard';
import {
  renderFirstWorkbenchMatch,
  useWorkbenchMatchRenderers,
} from '@/lib/extensions/workbench-registry';
import {
  parseExtensionStatus,
  parseSubagentNotifications,
  parseSubagentRun,
  piContentText,
  type SubagentNotificationPresentation,
  type SubagentRunPresentation,
  type SubagentStatus,
} from './extensionPresentation';
import { projectPiTimeline } from './piTimelineProjection';

interface PiTimelineProps {
  cwd: string;
  entries: PiSessionEntry[];
  hiddenThinkingLabel?: string;
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  onRecover(entry: PiSessionMessageEntry): void;
  onTogglePinned(entry: PiSessionMessageEntry, pinned: boolean): void;
  pinBusyEntryId?: string | null;
  pinnedEntryIds: ReadonlySet<string>;
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

const formatCount = (value: number): string => new Intl.NumberFormat().format(value);

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
};

const formatToolEnd = (endMs: number): string => (
  endMs > 100_000_000_000
    ? new Date(endMs).toLocaleTimeString()
    : `${formatDuration(endMs)} elapsed`
);

const thinkingPreview = (value: string): string => {
  const normalized = value
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 79).trimEnd()}…`;
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

const RawJsonDetails: React.FC<{
  label?: string;
  value: JsonValue;
}> = ({ label = 'raw details', value }) => (
  <details className="group/details">
    <summary className="cursor-pointer select-none typography-micro text-muted-foreground hover:text-foreground">
      {label}
    </summary>
    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
      {jsonText(value)}
    </pre>
  </details>
);

const statusIcon = (status: SubagentStatus): React.ComponentProps<typeof Icon>['name'] => {
  if (status === 'running') return 'loader-4';
  if (status === 'completed') return 'check';
  if (status === 'failed' || status === 'stopped') return 'error-warning';
  if (status === 'paused') return 'pause';
  if (status === 'detached') return 'share-2';
  return 'time';
};

const statusClass = (status: SubagentStatus): string => {
  if (status === 'running') return 'text-primary';
  if (status === 'completed') return 'text-[var(--status-success)]';
  if (status === 'failed' || status === 'stopped') return 'text-[var(--status-error)]';
  if (status === 'paused' || status === 'detached') return 'text-[var(--status-warning)]';
  return 'text-muted-foreground';
};

const SubagentRunView: React.FC<{
  messageId: string;
  presentation: SubagentRunPresentation;
}> = ({ messageId, presentation }) => (
  <div className="space-y-2 rounded-lg border border-border/60 bg-background/35 p-2.5">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
      <span className="font-medium text-foreground">Agent Task</span>
      <span>{presentation.mode}</span>
      <span>{presentation.agents.length} {presentation.agents.length === 1 ? 'agent' : 'agents'}</span>
      {presentation.toolCount !== undefined && <span>{formatCount(presentation.toolCount)} tools</span>}
      {presentation.tokens !== undefined && <span>{formatCount(presentation.tokens)} tokens</span>}
      {presentation.durationMs !== undefined && <span>{formatDuration(presentation.durationMs)}</span>}
      {presentation.runId && <code className="break-all typography-micro">{presentation.runId}</code>}
    </div>
    <div className="space-y-2">
      {presentation.agents.map((agent) => (
        <details
          key={`${agent.index}:${agent.agent}`}
          className="group/agent rounded-md border border-border/60 bg-muted/15"
          open={agent.status === 'running' || agent.status === 'failed'}
        >
          <summary className="flex cursor-pointer list-none items-start gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
            <Icon
              name={statusIcon(agent.status)}
              className={cn('mt-0.5 size-3.5 shrink-0', statusClass(agent.status), agent.status === 'running' && 'animate-spin')}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono typography-ui-label text-foreground">{agent.agent}</span>
                <span className={cn('typography-micro', statusClass(agent.status))}>{agent.status}</span>
                {agent.model && <span className="typography-micro text-muted-foreground">{agent.model}{agent.thinking ? ` · ${agent.thinking}` : ''}</span>}
              </div>
              {agent.task && <p className="mt-0.5 break-words typography-meta text-muted-foreground">{agent.task}</p>}
            </div>
            <Icon name="arrow-down-s" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/agent:rotate-180" />
          </summary>
          <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
              {agent.toolCount !== undefined && <span>{formatCount(agent.toolCount)} tools</span>}
              {agent.turnCount !== undefined && <span>{formatCount(agent.turnCount)} turns</span>}
              {agent.tokens !== undefined && <span>{formatCount(agent.tokens)} tokens</span>}
              {agent.inputTokens !== undefined && <span>{formatCount(agent.inputTokens)} in</span>}
              {agent.outputTokens !== undefined && <span>{formatCount(agent.outputTokens)} out</span>}
              {agent.durationMs !== undefined && <span>{formatDuration(agent.durationMs)}</span>}
            </div>
            {agent.currentTool && (
              <div className="rounded-md bg-primary/5 px-2 py-1.5 typography-meta text-foreground">
                <span className="text-muted-foreground">Current tool · </span>
                <code>{agent.currentTool}</code>
                {agent.currentToolArgs && <pre className="mt-1 whitespace-pre-wrap break-words font-mono typography-micro">{agent.currentToolArgs}</pre>}
              </div>
            )}
            {agent.currentPath && <p className="break-all font-mono typography-micro text-muted-foreground">{agent.currentPath}</p>}
            {agent.skills.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {agent.skills.map((skill) => <code key={skill} className="rounded bg-muted px-1.5 py-0.5 typography-micro">{skill}</code>)}
              </div>
            )}
            {agent.recentTools.length > 0 && (
              <details>
                <summary className="cursor-pointer typography-micro text-muted-foreground">Recent tools ({agent.recentTools.length})</summary>
                <div className="mt-1 space-y-1">
                  {agent.recentTools.map((tool, index) => (
                    <div key={`${tool.tool}:${index}`} className="rounded bg-background/70 px-2 py-1 font-mono typography-micro">
                      <span>{tool.tool}</span>
                      {tool.endMs !== undefined && <span className="ml-2 text-muted-foreground">{formatToolEnd(tool.endMs)}</span>}
                      {tool.args && <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{tool.args}</pre>}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {agent.recentOutput.length > 0 && (
              <details open={agent.status === 'running'}>
                <summary className="cursor-pointer typography-micro text-muted-foreground">Recent output</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono typography-micro text-foreground">{agent.recentOutput.join('\n')}</pre>
              </details>
            )}
            {agent.finalOutput && (
              <div className="rounded-md bg-background/70 px-2 py-1.5">
                <MarkdownRenderer content={agent.finalOutput} messageId={`${messageId}:subagent:${agent.index}:output`} variant="tool" enableFileReferences />
              </div>
            )}
            {agent.error && <pre className="whitespace-pre-wrap break-words rounded-md bg-[var(--status-error)]/10 p-2 font-mono typography-micro text-[var(--status-error)]">{agent.error}</pre>}
            {agent.sessionFile && <p className="break-all font-mono typography-micro text-muted-foreground">Session · {agent.sessionFile}</p>}
          </div>
        </details>
      ))}
    </div>
    <RawJsonDetails value={presentation.raw} />
  </div>
);

const SubagentNotificationsView: React.FC<{
  content: string | PiUserContent[];
  details?: JsonValue;
  messageId: string;
  notifications: SubagentNotificationPresentation[];
}> = ({ content, details, messageId, notifications }) => (
  <article className="w-full space-y-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2" style={{ contentVisibility: 'auto' }}>
    <div className="flex items-center gap-2 typography-ui-label text-foreground">
      <Icon name="ai-agent" className="size-3.5" />
      <span>Background Agent Task</span>
      {notifications.length > 1 && <span className="typography-micro text-muted-foreground">{notifications.length} completed</span>}
    </div>
    {notifications.map((notification, index) => (
      <div key={`${notification.agent}:${index}`} className="rounded-md border border-border/50 bg-background/45 px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name={statusIcon(notification.status)} className={cn('size-3.5', statusClass(notification.status))} />
          <span className="font-mono typography-ui-label text-foreground">{notification.agent}</span>
          {notification.taskInfo && <span className="typography-micro text-muted-foreground">{notification.taskInfo}</span>}
          <span className={cn('typography-micro', statusClass(notification.status))}>{notification.status}</span>
          {notification.durationMs !== undefined && <span className="typography-micro text-muted-foreground">{formatDuration(notification.durationMs)}</span>}
        </div>
        <div className="mt-1.5">
          <MarkdownRenderer content={notification.resultPreview} messageId={`${messageId}:notification:${index}`} variant="tool" enableFileReferences />
        </div>
        {notification.handoffPath && <p className="mt-1 break-all font-mono typography-micro text-muted-foreground">Handoff · {notification.handoffPath}</p>}
        {notification.sessionValue && <p className="mt-1 break-all font-mono typography-micro text-muted-foreground">{notification.sessionLabel ?? 'Session'} · {notification.sessionValue}</p>}
      </div>
    ))}
    <details>
      <summary className="cursor-pointer typography-micro text-muted-foreground">raw message</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">{piContentText(content)}</pre>
      {details !== undefined && <div className="mt-2"><RawJsonDetails value={details} /></div>}
    </details>
  </article>
);

const ToolResultContent: React.FC<{
  messageId: string;
  result: PiToolResultMessage;
}> = ({ messageId, result }) => {
  const subagentRun = (result.toolName === 'subagent' || result.toolName === 'subagent_wait') && result.details !== undefined
    ? parseSubagentRun(result.details)
    : undefined;
  return (
    <div className="space-y-2">
      <PiUserContentView content={result.content} messageId={messageId} variant="tool" />
      {subagentRun ? (
        <SubagentRunView messageId={messageId} presentation={subagentRun} />
      ) : result.details !== undefined ? (
        <RawJsonDetails label="details" value={result.details} />
      ) : null}
    </div>
  );
};

const PiToolCard: React.FC<{
  call: PiToolCall;
  cwd: string;
  editor?: EditorAPI;
  execution?: PiToolExecutionState;
  result?: PiToolResultMessage;
}> = ({ call, cwd, editor, execution, result }) => {
  const toolRenderers = useWorkbenchMatchRenderers<{
    call: PiToolCall;
    cwd: string;
    editor?: EditorAPI;
    execution?: PiToolExecutionState;
    result?: PiToolResultMessage;
  }>('tool-renderer', 'chat.timeline.tools');
  const workspaceId = useWorkbenchWorkspaceId();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const extensionRendered = renderFirstWorkbenchMatch(toolRenderers, { call, cwd, editor, execution, result });
  if (extensionRendered !== undefined) return <>{extensionRendered}</>;
  const status = result
    ? (result.isError ? 'error' : 'success')
    : execution?.status ?? 'running';
  const transientOutput = execution?.result ?? execution?.partialResult;
  const transientSubagentRun = (call.name === 'subagent' || call.name === 'subagent_wait') && transientOutput !== undefined
    ? parseSubagentRun(transientOutput)
    : undefined;
  const applyPatchFiles = call.name === 'apply_patch'
    ? getApplyPatchFileEntries(result?.details ?? transientOutput)
    : [];
  return (
    <details
      className={cn(
        'group',
        'my-1',
        status === 'error' && 'text-[var(--status-error)]',
      )}
      open={status === 'running'}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-1 py-1.5 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <Icon
          name={status === 'running' ? 'loader-4' : status === 'error' ? 'error-warning' : 'check'}
          className={cn(
            'size-3.5 shrink-0',
            status === 'running' && 'animate-spin text-primary',
            status === 'error' && 'text-[var(--status-error)]',
            status === 'success' && 'text-[var(--status-success)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono font-medium text-foreground">{call.name}</span>
        <span className="typography-micro">{status}</span>
        <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="ml-2 space-y-3 border-l border-border/60 py-2 pl-3">
        <div>
          <p className="mb-1 typography-micro font-medium text-muted-foreground">arguments</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
            {jsonText(call.arguments)}
          </pre>
        </div>
        {result ? (
          <ToolResultContent messageId={`tool-result:${call.id}`} result={result} />
        ) : transientSubagentRun ? (
          <SubagentRunView messageId={`tool-live:${call.id}`} presentation={transientSubagentRun} />
        ) : transientOutput !== undefined ? (
          <div>
            <p className="mb-1 typography-micro font-medium text-muted-foreground">output</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono typography-micro text-foreground">
              {jsonText(transientOutput)}
            </pre>
          </div>
        ) : null}
        {applyPatchFiles.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {applyPatchFiles.map((file) => (
                <button
                  key={file.filePath}
                  type="button"
                  disabled={file.deleted}
                  onClick={() => {
                    const resourceId = resourceIdFromWorkspacePath(cwd, file.filePath)
                      ?? file.filePath.replace(/\\/g, '/');
                    if (workspaceId) {
                      revealResourceInEditor({
                        workspaceId,
                        resourceId,
                        workspaceRoot: cwd,
                        ...(sessionId ? { sessionId } : {}),
                        ...(call.id ? { toolCallId: call.id } : {}),
                        ...(editor ? { editor } : {}),
                      });
                    }
                    if (!editor) return;
                    const absolutePath = toAbsoluteFilePath(cwd, file.filePath);
                    if (file.patch) {
                      void editor.openDiff('', absolutePath, `${file.filePath} (changes)`, { patch: file.patch });
                    } else {
                      void editor.openFile(absolutePath);
                    }
                  }}
                  className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:cursor-default disabled:opacity-50"
                >
                  <Icon name="file-code" className="size-3.5 shrink-0" />
                  <span className="max-w-64 truncate">{file.filePath}</span>
                </button>
              ))}
            </div>
            {applyPatchFiles.map((file) => (
              file.patch ? (
                <PatchHunkReview
                  key={`review:${file.filePath}`}
                  cwd={cwd}
                  filePath={file.filePath}
                  patch={file.patch}
                  {...(editor ? { editor } : {})}
                  {...(sessionId ? { sessionId } : {})}
                  {...(call.id ? { toolCallId: call.id } : {})}
                />
              ) : null
            ))}
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
  cwd: string;
  editor?: EditorAPI;
  entryId: string;
  executionById: Record<string, PiToolExecutionState>;
  hiddenThinkingLabel?: string;
  message: PiAssistantMessage;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  streaming?: boolean;
}> = ({ cwd, editor, entryId, executionById, hiddenThinkingLabel, message, resultByCallId, streaming = false }) => (
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
        const preview = content.redacted ? '' : thinkingPreview(content.thinking);
        return (
          <details
            key={`${entryId}:thinking:${index}`}
            className="group/thinking my-1"
            open={streaming && !content.redacted ? true : undefined}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl py-1.5 pr-2 typography-meta text-muted-foreground hover:bg-muted/25 [&::-webkit-details-marker]:hidden">
              <Icon name="brain" className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium text-foreground/80">
                {hiddenThinkingLabel || 'Thinking'}{content.redacted ? ' (redacted)' : ''}
              </span>
              {!streaming && preview
                ? <span className="min-w-0 flex-1 truncate opacity-75">{preview}</span>
                : <span className="min-w-0 flex-1" />}
              <Icon name="arrow-right-s" className="size-3.5 shrink-0 transition-transform group-open/thinking:rotate-90" />
            </summary>
            {!content.redacted && (
              <div className="ml-2 border-l border-border/60 py-1 pl-3 text-muted-foreground">
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
          cwd={cwd}
          editor={editor}
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
  cwd,
  entries,
  hiddenThinkingLabel,
  liveAssistant,
  liveUser,
  onRecover,
  onTogglePinned,
  pinBusyEntryId,
  pinnedEntryIds,
  recoveryBusyEntryId,
  sessionId,
  toolExecutions,
}) => {
  const { t } = useI18n();
  const { editor } = useRuntimeAPIs();
  const messageRenderers = useWorkbenchMatchRenderers<{
    cwd: string;
    entry: PiSessionEntry;
    sessionId: string;
  }>('message-renderer', 'chat.timeline.entries');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(true);
  const projection = React.useMemo(
    () => projectPiTimeline(entries, liveAssistant, liveUser),
    [entries, liveAssistant, liveUser],
  );

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTailRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, projection.liveAssistant, projection.liveUser, toolExecutions]);

  return (
    <div
      ref={scrollRef}
      data-pi-timeline="true"
      tabIndex={-1}
      onScroll={(event) => {
        const element = event.currentTarget;
        followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-5"
    >
      <div className="chat-message-column flex flex-col gap-3">
        {projection.entries.map((entry) => {
          const extensionRendered = renderFirstWorkbenchMatch(messageRenderers, { cwd, entry, sessionId });
          if (extensionRendered !== undefined) {
            return <React.Fragment key={entry.id}>{extensionRendered}</React.Fragment>;
          }
          if (entry.type === 'message') {
            const { message } = entry;
            if (message.role === 'user') {
              const pinned = pinnedEntryIds.has(entry.id);
              return (
                <article id={`pi-entry-${entry.id}`} key={entry.id} className="group/message ml-auto max-w-[85%]" style={{ contentVisibility: 'auto' }}>
                  <div className="rounded-2xl rounded-br-md border border-primary/5 bg-[var(--chat-user-message-bg)] px-5 py-3 text-foreground">
                    <PiUserContentView content={message.content} messageId={entry.id} />
                  </div>
                  <div className="mt-1 flex h-6 items-center justify-end opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onTogglePinned(entry, !pinned)}
                          disabled={pinBusyEntryId !== null && pinBusyEntryId !== undefined}
                          className={cn(
                            'flex size-6 items-center justify-center rounded hover:bg-interactive-hover hover:text-foreground disabled:opacity-50',
                            pinned ? 'text-[var(--status-info)]' : 'text-muted-foreground',
                          )}
                          aria-label={t(pinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                          aria-pressed={pinned}
                        >
                          <Icon
                            name={pinBusyEntryId === entry.id ? 'loader-4' : pinned ? 'pushpin-2-fill' : 'pushpin-2'}
                            className={cn('size-3.5', pinBusyEntryId === entry.id && 'animate-spin')}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t(pinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                      </TooltipContent>
                    </Tooltip>
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
              const pinned = pinnedEntryIds.has(entry.id);
              return (
                <article id={`pi-entry-${entry.id}`} key={entry.id} className="group/message w-full" style={{ contentVisibility: 'auto' }}>
                  <AssistantMessage
                    cwd={cwd}
                    editor={editor}
                    entryId={entry.id}
                    executionById={toolExecutions}
                    hiddenThinkingLabel={hiddenThinkingLabel || t('chat.reasoningTrace.thinking')}
                    message={message}
                    resultByCallId={projection.resultByCallId}
                  />
                  <div className="mt-1 flex h-6 items-center opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onTogglePinned(entry, !pinned)}
                          disabled={pinBusyEntryId !== null && pinBusyEntryId !== undefined}
                          className={cn(
                            'flex size-6 items-center justify-center rounded hover:bg-interactive-hover hover:text-foreground disabled:opacity-50',
                            pinned ? 'text-[var(--status-info)]' : 'text-muted-foreground',
                          )}
                          aria-label={t(pinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                          aria-pressed={pinned}
                        >
                          <Icon
                            name={pinBusyEntryId === entry.id ? 'loader-4' : pinned ? 'pushpin-2-fill' : 'pushpin-2'}
                            className={cn('size-3.5', pinBusyEntryId === entry.id && 'animate-spin')}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t(pinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </article>
              );
            }
            if (message.role === 'toolResult') {
              return (
                <article key={entry.id} className="w-full rounded-lg border border-border/60 bg-muted/15 px-3 py-2" style={{ contentVisibility: 'auto' }}>
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
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono typography-meta text-foreground">{renderTerminalOutput(message.output)}</pre>
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
              const notifications = message.customType === 'subagent-notify'
                ? parseSubagentNotifications(piContentText(message.content), message.details)
                : undefined;
              if (notifications) {
                return (
                  <SubagentNotificationsView
                    key={entry.id}
                    content={message.content}
                    details={message.details}
                    messageId={entry.id}
                    notifications={notifications}
                  />
                );
              }
              const subagentRun = message.customType === 'subagent-slash-result' && message.details !== undefined
                ? parseSubagentRun(message.details)
                : undefined;
              if (subagentRun) {
                return (
                  <article key={entry.id} className="w-full" style={{ contentVisibility: 'auto' }}>
                    <SubagentRunView messageId={entry.id} presentation={subagentRun} />
                  </article>
                );
              }
              const extensionStatus = parseExtensionStatus(message.customType, message.details);
              if (extensionStatus) {
                return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
              }
              return (
                <MetaEntry key={entry.id} icon="plug-2">
                  <strong>{message.customType}</strong>
                  <PiUserContentView content={message.content} messageId={entry.id} />
                  {message.details !== undefined && <RawJsonDetails value={message.details} />}
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
            const notifications = entry.customType === 'subagent-notify'
              ? parseSubagentNotifications(piContentText(entry.content), entry.details)
              : undefined;
            if (notifications) {
              return (
                <SubagentNotificationsView
                  key={entry.id}
                  content={entry.content}
                  details={entry.details}
                  messageId={entry.id}
                  notifications={notifications}
                />
              );
            }
            const subagentRun = entry.customType === 'subagent-slash-result' && entry.details !== undefined
              ? parseSubagentRun(entry.details)
              : undefined;
            if (subagentRun) {
              return (
                <article key={entry.id} className="w-full" style={{ contentVisibility: 'auto' }}>
                  <SubagentRunView messageId={entry.id} presentation={subagentRun} />
                </article>
              );
            }
            const extensionStatus = parseExtensionStatus(entry.customType, entry.details);
            if (extensionStatus) {
              return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
            }
            return (
              <MetaEntry key={entry.id} icon="plug-2">
                <strong>{entry.customType}</strong>
                <PiUserContentView content={entry.content} messageId={entry.id} />
                {entry.details !== undefined && <RawJsonDetails value={entry.details} />}
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
          if (entry.type === 'label') {
            return <MetaEntry key={entry.id} icon="target">{entry.label ?? 'Label'} → {entry.targetId}</MetaEntry>;
          }
          if (entry.type === 'custom') {
            const extensionStatus = parseExtensionStatus(entry.customType, entry.data);
            if (extensionStatus) {
              return <PiExtensionStatusCard key={entry.id} messageId={entry.id} status={extensionStatus} />;
            }
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

        {projection.liveUser && (
          <article className="ml-auto max-w-[85%]" aria-live="polite">
            <div className="rounded-2xl rounded-br-md border border-primary/5 bg-[var(--chat-user-message-bg)] px-5 py-3 text-foreground">
              <PiUserContentView
                content={projection.liveUser.content}
                messageId={`live-user:${projection.liveUser.timestamp}`}
              />
            </div>
          </article>
        )}

        {projection.liveAssistant && (
          <article className="w-full" aria-live="polite">
            <AssistantMessage
              cwd={cwd}
              editor={editor}
              entryId={`live:${sessionId}`}
              executionById={toolExecutions}
              hiddenThinkingLabel={hiddenThinkingLabel || t('chat.reasoningTrace.thinking')}
              message={projection.liveAssistant}
              resultByCallId={projection.resultByCallId}
              streaming
            />
          </article>
        )}
      </div>
    </div>
  );
};
