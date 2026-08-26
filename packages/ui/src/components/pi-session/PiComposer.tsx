import React from 'react';
import type {
  ImageAttachment,
  SessionSnapshot,
  ThinkingLevel,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
  type CommandInfo,
} from '@/components/chat/CommandAutocomplete';
import {
  SkillAutocomplete,
  type SkillAutocompleteHandle,
} from '@/components/chat/SkillAutocomplete';
import {
  SnippetAutocomplete,
  type SnippetAutocompleteHandle,
} from '@/components/chat/SnippetAutocomplete';
import {
  FileMentionAutocomplete,
  type FileMentionHandle,
} from '@/components/chat/FileMentionAutocomplete';
import {
  resolveAutocompleteTrigger,
  type FileMentionAutocompleteInputSource,
} from '@/components/chat/composer/language/triggers';
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { MAGIC_PROMPT_COMMANDS } from '@/components/chat/composer/submit/slashCommands';
import { getInlineCommentDraftKey, useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getMagicPromptDefinition } from '@/lib/magicPrompts';
import type { Snippet } from '@/types/snippet';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { PiActiveEditorContextSuggestion } from './PiActiveEditorContextSuggestion';
import { EditorContextAttachmentChips } from '@/components/workbench/EditorContextAttachmentChips';
import { PiGoalButton } from './PiGoalControls';
import { WorkbenchContributionSlot } from '@/lib/extensions/workbench-registry';
import { PiComposerModelControls } from './PiComposerModelControls';
import type { PiComposerModelSelection } from './piComposerSessionConfig';
import { insertPiComposerMention } from './piComposerMentions';
import { PiComposerAgentControl } from './PiComposerAgentControl';
import type { PiComposerAgentSelection } from '@/lib/pi-runtime/composerAgent';

interface PiComposerProps {
  active: boolean;
  allowModelInheritance: boolean;
  cwd: string;
  draft: string;
  effectiveModel?: PiComposerModelSelection;
  effectiveThinkingLevel?: ThinkingLevel;
  followUpBehavior: FollowUpBehavior;
  images: ImageAttachment[];
  onAbort?(): Promise<void> | void;
  onChangeAgent(value: PiComposerAgentSelection | undefined): void;
  onChangeDraft(value: string): void;
  onChangeImages(value: ImageAttachment[]): void;
  onChangeModel(value: PiComposerModelSelection | undefined): Promise<void> | void;
  onChangeThinkingLevel(value: ThinkingLevel | undefined): Promise<void> | void;
  onSend(): Promise<void> | void;
  onSendText(value: string): Promise<void> | void;
  selectedModel?: PiComposerModelSelection;
  selectedAgent?: PiComposerAgentSelection;
  selectedThinkingLevel?: ThinkingLevel;
  sending: boolean;
  sessionId?: string | null;
  snapshot?: SessionSnapshot;
}

const attachmentUrl = (attachment: ImageAttachment): string => (
  `data:${attachment.mimeType};base64,${attachment.data}`
);

const fileToAttachment = (file: File): Promise<ImageAttachment> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) {
      reject(new Error(`Could not decode ${file.name}`));
      return;
    }
    resolve({
      data: value.slice(separator + 1),
      mimeType: file.type || 'application/octet-stream',
    });
  };
  reader.readAsDataURL(file);
});

const PIARIUM_COMMANDS: readonly CommandInfo[] = MAGIC_PROMPT_COMMANDS.map((command) => ({
  description: getMagicPromptDefinition(command.visiblePrompt).description,
  id: `piarium:${command.name}`,
  name: command.name,
  source: 'piarium',
}));

type PiComposerAutocomplete = {
  kind: 'command' | 'mention' | 'skill' | 'snippet';
  query: string;
} | null;

export const PiComposer: React.FC<PiComposerProps> = ({
  active,
  allowModelInheritance,
  cwd,
  draft,
  effectiveModel,
  effectiveThinkingLevel,
  followUpBehavior,
  images,
  onAbort,
  onChangeAgent,
  onChangeDraft,
  onChangeImages,
  onChangeModel,
  onChangeThinkingLevel,
  onSend,
  onSendText,
  selectedModel,
  selectedAgent,
  selectedThinkingLevel,
  sending,
  sessionId,
  snapshot,
}) => {
  const { t } = useI18n();
  const inputRef = React.useRef<ComposerEditorHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const skillRef = React.useRef<SkillAutocompleteHandle>(null);
  const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [autocomplete, setAutocomplete] = React.useState<PiComposerAutocomplete>(null);
  const [confirmedMentions, setConfirmedMentions] = React.useState<ReadonlySet<string>>(() => new Set());
  const [knownAgentNames, setKnownAgentNames] = React.useState<ReadonlySet<string>>(() => new Set());
  const isMobile = useUIStore((state) => state.isMobile);
  const isExpandedInput = useUIStore((state) => state.isExpandedInput);
  const toggleExpandedInput = useUIStore((state) => state.toggleExpandedInput);
  const busy = snapshot ? projectPiSessionActivity(snapshot).isWorking : false;
  const inlineDraftKey = snapshot && sessionId
    ? getInlineCommentDraftKey(getRuntimeKey(), cwd, sessionId)
    : null;
  const inlineDraftCount = useInlineCommentDraftStore((state) => (
    inlineDraftKey ? state.drafts[inlineDraftKey]?.length ?? 0 : 0
  ));
  const canSend = draft.trim().length > 0 || images.length > 0 || inlineDraftCount > 0;
  const footerIconButtonClass = 'flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35';
  const snippets = useSnippetsStore((state) => state.snippets);
  const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
    attachmentFilenames: [],
    confirmedMentions,
    inputMode: 'normal',
    knownAgentNames,
    knownSlashNames: new Set(PIARIUM_COMMANDS.map((command) => command.name.toLowerCase())),
    knownSnippetTriggers: new Set(snippets.flatMap((snippet) => [snippet.name, ...snippet.aliases]).map((value) => value.toLowerCase())),
  }), [confirmedMentions, knownAgentNames, snippets]);
  const modelControls = (
    <div className="flex min-w-0 items-center justify-end gap-2.5">
      <PiComposerModelControls
        active={active}
        allowInherit={allowModelInheritance}
        cwd={cwd}
        disabled={sending}
        effectiveModel={effectiveModel}
        effectiveThinkingLevel={effectiveThinkingLevel}
        onModelChange={onChangeModel}
        onThinkingChange={onChangeThinkingLevel}
        selectedModel={selectedModel}
        selectedThinkingLevel={selectedThinkingLevel}
      />
      <PiComposerAgentControl
        active={active}
        cwd={cwd}
        disabled={sending}
        onChange={onChangeAgent}
        selectedAgent={selectedAgent}
        sessionId={sessionId}
      />
    </div>
  );

  React.useEffect(() => {
    if (autocomplete?.kind === 'command' && !draft.startsWith('/')) setAutocomplete(null);
    if (autocomplete?.kind === 'skill' && !draft.includes('/')) setAutocomplete(null);
    if (autocomplete?.kind === 'snippet' && !draft.includes('#')) setAutocomplete(null);
    if (autocomplete?.kind === 'mention' && !draft.includes('@')) setAutocomplete(null);
  }, [autocomplete?.kind, draft]);

  const addFiles = React.useCallback(async (files: Iterable<File>) => {
    const imageFiles = [...files].filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    try {
      const attachments = await Promise.all(imageFiles.map(fileToAttachment));
      onChangeImages([...images, ...attachments]);
    } catch (error) {
      console.error('Failed to attach image to Pi prompt:', error);
      toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
    }
  }, [images, onChangeImages, t]);

  const queue = snapshot ? [...snapshot.steering, ...snapshot.followUp] : [];

  const insertTranscript = React.useCallback((text: string) => {
    const next = [draft.trimEnd(), text.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    onChangeDraft(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, onChangeDraft]);

  const updateAutocomplete = React.useCallback((
    value: string,
    cursorPosition: number,
    inputSource: FileMentionAutocompleteInputSource = 'manual',
    insertedText?: string,
  ) => {
    const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
      inputMode: 'normal',
      inputSource,
      ...(insertedText === undefined ? {} : { insertedText }),
    });
    if (trigger) {
      setAutocomplete({ kind: trigger.kind, query: trigger.query });
      return;
    }
    setAutocomplete(null);
  }, []);

  const handleCommandSelect = React.useCallback((command: CommandInfo) => {
    const value = `/${command.name} `;
    onChangeDraft(value);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelection(value.length);
    });
  }, [onChangeDraft]);

  const handleSnippetSelect = React.useCallback((_snippet: Snippet, trigger: string) => {
    const input = inputRef.current;
    const cursorPosition = input?.getSelection().end ?? draft.length;
    const hashIndex = draft.slice(0, cursorPosition).lastIndexOf('#');
    const startIndex = hashIndex === -1 ? cursorPosition : hashIndex;
    const value = `${draft.slice(0, startIndex)}#${trigger} ${draft.slice(cursorPosition)}`;
    onChangeDraft(value);
    setAutocomplete(null);
    const nextCursor = startIndex + trigger.length + 2;
    requestAnimationFrame(() => {
      const editor = inputRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(nextCursor);
    });
  }, [draft, onChangeDraft]);

  const handleSkillSelect = React.useCallback((invocation: string) => {
    const input = inputRef.current;
    const cursorPosition = input?.getSelection().end ?? draft.length;
    const slashIndex = draft.slice(0, cursorPosition).lastIndexOf('/');
    const startIndex = slashIndex === -1 ? cursorPosition : slashIndex;
    const value = `${draft.slice(0, startIndex)}/${invocation} ${draft.slice(cursorPosition)}`;
    onChangeDraft(value);
    setAutocomplete(null);
    const nextCursor = startIndex + invocation.length + 2;
    requestAnimationFrame(() => {
      const editor = inputRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(nextCursor);
    });
  }, [draft, onChangeDraft]);

  const applyMention = React.useCallback((mention: string, kind: 'agent' | 'file') => {
    const cursor = inputRef.current?.getSelection().start ?? draft.length;
    const insertion = insertPiComposerMention(draft, cursor, mention);
    if (kind === 'agent') {
      setKnownAgentNames((current) => new Set(current).add(mention.toLowerCase()));
    } else {
      setConfirmedMentions((current) => new Set(current).add(mention));
    }
    onChangeDraft(insertion.text);
    setAutocomplete(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(insertion.cursor);
    });
  }, [draft, onChangeDraft]);

  const handleFileSelect = React.useCallback((file: {
    name: string;
    path: string;
    relativePath?: string;
  }) => {
    const mention = file.relativePath?.trim() || file.path.replace(/\\/g, '/') || file.name;
    applyMention(mention, 'file');
  }, [applyMention]);

  const handleAgentSelect = React.useCallback((agentName: string) => {
    applyMention(agentName, 'agent');
  }, [applyMention]);

  const handleEditorKeyDown = React.useCallback((event: KeyboardEvent): boolean => {
    if (
      autocomplete !== null
      && (event.key === 'Enter'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'Escape'
        || event.key === 'Tab')
    ) {
      if (autocomplete.kind === 'command') commandRef.current?.handleKeyDown(event.key);
      else if (autocomplete.kind === 'skill') skillRef.current?.handleKeyDown(event.key);
      else if (autocomplete.kind === 'snippet') snippetRef.current?.handleKeyDown(event.key);
      else mentionRef.current?.handleKeyDown(event.key);
      return true;
    }
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || isIMECompositionEvent(event)
    ) return false;
    if (canSend && !sending) void onSend();
    return true;
  }, [autocomplete, canSend, onSend, sending]);

  return (
    <div className={cn(
      'bottom-safe-area oc-mobile-composer shrink-0 bg-background pb-4',
      isExpandedInput && 'fixed inset-0 z-40 flex items-end bg-background/95',
    )} data-pi-composer-shell="true">
      <div className={cn('chat-input-column', isExpandedInput && 'flex h-full flex-col justify-end py-6')}>
        {queue.length > 0 && (
          <details className="mb-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none typography-meta text-muted-foreground">
              {t('chat.queuedMessage.title')} · {queue.length}
            </summary>
            <ol className="mt-2 space-y-1 border-t border-border/60 pt-2">
              {queue.map((message, index) => (
                <li key={`${index}:${message}`} className="whitespace-pre-wrap break-words typography-meta text-foreground">
                  {message || t('chat.queuedMessage.empty')}
                </li>
              ))}
            </ol>
          </details>
        )}

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <div key={`${image.mimeType}:${index}`} className="group/image relative overflow-hidden rounded-lg border border-border bg-muted/20">
                <img src={attachmentUrl(image)} alt={image.mimeType} className="size-20 object-cover" />
                <button
                  type="button"
                  onClick={() => onChangeImages(images.filter((_, candidate) => candidate !== index))}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/image:opacity-100 focus:opacity-100"
                  aria-label={t('chat.fileAttachment.actions.removeImage')}
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {snapshot ? <EditorContextAttachmentChips sessionId={snapshot.sessionId} /> : null}
        {snapshot ? <PiActiveEditorContextSuggestion snapshot={snapshot} /> : null}

        <div
          className={cn(
            'relative flex flex-col overflow-visible rounded-2xl border border-border/80 bg-[var(--surface-subtle)] shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] transition-[border-color,box-shadow] focus-within:ring-1 focus-within:ring-primary/50',
            sending && 'opacity-80',
          )}
          data-pi-composer-input-frame="true"
          onDragOver={(event) => {
            if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
        >
          {isMobile ? (
            <div className="flex min-w-0 items-center justify-end border-b border-border/40 px-2 py-1">
              {modelControls}
            </div>
          ) : null}
          <ComposerEditor
            ref={inputRef}
            value={draft}
            onChange={(change) => {
              onChangeDraft(change.value);
              updateAutocomplete(
                change.value,
                change.selection.end,
                change.fromPaste ? 'paste' : 'manual',
                change.insertedText,
              );
            }}
            onSelectionChange={(selection) => {
              updateAutocomplete(draft, selection.end);
            }}
            onPaste={(event) => {
              const files = event.clipboardData ? [...event.clipboardData.files] : [];
              if (!files.some((file) => file.type.startsWith('image/'))) return;
              event.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={handleEditorKeyDown}
            languageContext={languageContext}
            placeholder={t('chat.chatInput.placeholder.chat')}
            className={cn(
              'min-h-[52px] w-full px-3 pb-2 pt-4 typography-markdown text-foreground md:typography-ui-label',
              isExpandedInput ? 'min-h-[40vh]' : 'max-h-[40vh]',
            )}
            maxLines={isExpandedInput ? 24 : 9}
          />

          {autocomplete?.kind === 'command' ? (
            <CommandAutocomplete
              ref={commandRef}
              additionalCommands={PIARIUM_COMMANDS}
              cwd={cwd}
              sessionId={sessionId}
              searchQuery={autocomplete.query}
              onCommandSelect={handleCommandSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'mention' ? (
            <FileMentionAutocomplete
              ref={mentionRef}
              searchQuery={autocomplete.query}
              onAgentSelect={handleAgentSelect}
              onFileSelect={handleFileSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'skill' ? (
            <SkillAutocomplete
              ref={skillRef}
              cwd={cwd}
              sessionId={sessionId}
              searchQuery={autocomplete.query}
              onSkillSelect={handleSkillSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          {autocomplete?.kind === 'snippet' ? (
            <SnippetAutocomplete
              ref={snippetRef}
              searchQuery={autocomplete.query}
              onSnippetSelect={handleSnippetSelect}
              onClose={() => setAutocomplete(null)}
            />
          ) : null}

          <div data-chat-input-footer="true" className="flex items-center justify-between gap-3 px-3 pb-2.5 pt-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files;
                  if (files) void addFiles(files);
                  event.target.value = '';
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className={footerIconButtonClass}
                    aria-label={t('chat.chatInput.actions.addAttachment')}
                  >
                    <Icon name="add-circle" className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('chat.chatInput.actions.attachFiles')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleExpandedInput}
                    className={footerIconButtonClass}
                    aria-label={isExpandedInput
                      ? t('filesView.editor.exitFullscreen')
                      : t('filesView.editor.fullscreen')}
                  >
                    <Icon name={isExpandedInput ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isExpandedInput
                    ? t('filesView.editor.exitFullscreen')
                    : t('filesView.editor.fullscreen')}
                </TooltipContent>
              </Tooltip>
              <WorkbenchContributionSlot
                kind="composer-action"
                slot="chat.composer.actions.leading"
                props={{ cwd, draft, effectiveModel, effectiveThinkingLevel, footerIconButtonClass, images, onChangeAgent, onChangeDraft, onChangeImages, onChangeModel, onChangeThinkingLevel, onSend, selectedAgent, selectedModel, selectedThinkingLevel, sending, sessionId, snapshot }}
              />
              <PiGoalButton footerIconButtonClass={footerIconButtonClass} snapshot={snapshot} />
              {inlineDraftCount > 0 && (
                <span className="truncate px-1 typography-micro text-muted-foreground">
                  {t('chat.piComposer.attachedContext', { count: inlineDraftCount })}
                </span>
              )}
              {busy && (
                <span className="truncate px-1 typography-micro text-muted-foreground">
                  {followUpBehavior === 'queue'
                    ? t('chat.piComposer.queueFollowUp')
                    : t('chat.piComposer.steerCurrentRun')}
                </span>
              )}
            </div>

            <div className="flex min-w-0 shrink-0 items-center justify-end gap-2.5">
              {!isMobile ? modelControls : null}
              <WorkbenchContributionSlot
                kind="composer-action"
                slot="chat.composer.actions.trailing"
                props={{ cwd, draft, effectiveModel, effectiveThinkingLevel, images, onChangeAgent, onChangeDraft, onChangeImages, onChangeModel, onChangeThinkingLevel, onSend, selectedAgent, selectedModel, selectedThinkingLevel, sending, sessionId, snapshot }}
              />
              <ComposerDictation
                disabled={sending}
                footerIconButtonClass={footerIconButtonClass}
                footerPaddingClass="px-3 pb-2.5"
                iconSizeClass="size-4"
                isMobile={isMobile}
                onInsert={insertTranscript}
                onInsertAndSend={onSendText}
                radius="1rem"
                sendIconSizeClass="size-4"
              />
              {busy && onAbort && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void onAbort()}
                      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                      aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                    >
                      <Icon name="stop" className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('chat.chatInput.actions.stopGeneratingAria')}</TooltipContent>
                </Tooltip>
              )}
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={!canSend || sending}
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg transition-colors',
                  canSend && !sending
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'cursor-not-allowed bg-transparent text-muted-foreground/35',
                )}
                aria-label={t('chat.chatInput.actions.sendMessageAria')}
              >
                <Icon name={sending ? 'loader-4' : 'arrow-up'} className={cn('size-4', sending && 'animate-spin')} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
