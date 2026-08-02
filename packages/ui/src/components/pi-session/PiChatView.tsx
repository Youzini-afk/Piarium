import React from 'react';
import type {
  PiSessionMessageEntry,
  RecoveryMode,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { usePiInteractionStore } from '@/stores/usePiInteractionStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  EMPTY_PI_DRAFT,
  piDraftKey,
  readPiDraft,
  type PiDraftState,
  usePiDraftStore,
} from '@/stores/usePiDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { PiComposer } from './PiComposer';
import { PiExtensionUiChrome } from './PiExtensionUiChrome';
import { PiModelSelectorDialog } from './PiModelSelectorDialog';
import { PiTimeline } from './PiTimeline';
import { piSessionTitle } from './sessionPresentation';

interface PiChatViewProps {
  active?: boolean;
  autoOpenDraft?: boolean;
  readOnly?: boolean;
}

export const PiChatView: React.FC<PiChatViewProps> = ({
  active = true,
  readOnly = false,
}) => {
  const { t } = useI18n();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const currentRecord = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
  ));
  const currentSummary = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.summaries.find((summary) => summary.id === state.currentSessionId)
  ));
  const openingSessionId = usePiSessionStore((state) => state.openingSessionId);
  const lastError = usePiSessionStore((state) => state.lastError);
  const createSession = usePiSessionStore((state) => state.createSession);
  const prompt = usePiSessionStore((state) => state.prompt);
  const steer = usePiSessionStore((state) => state.steer);
  const followUp = usePiSessionStore((state) => state.followUp);
  const abort = usePiSessionStore((state) => state.abort);
  const recoverTo = usePiSessionStore((state) => state.recoverTo);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
  const recoveryPreference = useUIStore((state) => state.recoveryPreference);
  const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
  const extensionUi = usePiInteractionStore((state) => (
    currentSessionId === null ? undefined : state.sessions[currentSessionId]
  ));
  const currentDraftKey = currentSessionId === null ? null : piDraftKey(currentSessionId);
  const draft = usePiDraftStore((state) => (
    currentDraftKey === null ? EMPTY_PI_DRAFT : state.drafts[currentDraftKey] ?? EMPTY_PI_DRAFT
  ));
  const setPiDraft = usePiDraftStore((state) => state.setDraft);
  const clearPiDraft = usePiDraftStore((state) => state.clear);
  const [sending, setSending] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [recoveryEntry, setRecoveryEntry] = React.useState<PiSessionMessageEntry | null>(null);
  const [recoveryBusyEntryId, setRecoveryBusyEntryId] = React.useState<string | null>(null);
  const appliedEditorRevisions = React.useRef(new Map<string, number>());
  const untitled = t('sessions.sidebar.session.untitled');
  const updateDraft = React.useCallback((sessionId: string, update: Partial<PiDraftState>) => {
    setPiDraft(sessionId, update);
  }, [setPiDraft]);

  React.useEffect(() => {
    if (!currentSessionId || !extensionUi?.editorText) return;
    const { revision, text } = extensionUi.editorText;
    if (appliedEditorRevisions.current.get(currentSessionId) === revision) return;
    appliedEditorRevisions.current.set(currentSessionId, revision);
    updateDraft(currentSessionId, { text });
  }, [currentSessionId, extensionUi?.editorText, updateDraft]);

  const handleCreate = React.useCallback(async () => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const cwd = activeProject?.path || currentDirectory;
    if (!cwd) return;
    setCreating(true);
    try {
      setDirectory(cwd, { showOverlay: false });
      await createSession(cwd);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [activeProjectId, createSession, currentDirectory, projects, setDirectory]);

  const sendDraft = React.useCallback(async (sessionId: string, currentDraft: PiDraftState) => {
    const snapshot = usePiSessionStore.getState().records[sessionId]?.snapshot;
    if (!snapshot || sending) return;
    const inlineDraftTarget = { directory: snapshot.cwd, sessionKey: sessionId };
    const inlineDraftStore = useInlineCommentDraftStore.getState();
    const inlineDrafts = inlineDraftStore.consumeDrafts(inlineDraftTarget);
    const promptText = appendInlineComments(currentDraft.text, inlineDrafts);
    if (!promptText.trim() && currentDraft.images.length === 0) {
      inlineDraftStore.restoreDrafts(inlineDraftTarget, inlineDrafts);
      return;
    }
    setSending(true);
    try {
      let accepted: boolean;
      if (projectPiSessionActivity(snapshot).isWorking) {
        if (followUpBehavior === 'queue') {
          accepted = await followUp(sessionId, promptText, currentDraft.images);
        } else {
          accepted = await steer(sessionId, promptText, currentDraft.images);
        }
      } else {
        accepted = await prompt(sessionId, promptText, currentDraft.images);
      }
      if (!accepted) throw new Error('The Pi runtime did not accept the prompt');
      clearPiDraft(sessionId);
    } catch (error) {
      inlineDraftStore.restoreDrafts(inlineDraftTarget, inlineDrafts);
      console.error('Failed to send Pi prompt:', error);
      toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
    } finally {
      setSending(false);
    }
  }, [clearPiDraft, followUp, followUpBehavior, prompt, sending, steer, t]);

  const handleSend = React.useCallback(async () => {
    if (!currentSessionId) return;
    await sendDraft(currentSessionId, readPiDraft(currentSessionId));
  }, [currentSessionId, sendDraft]);

  const handleDictationSend = React.useCallback(async (transcript: string) => {
    if (!currentSessionId) return;
    const currentDraft = readPiDraft(currentSessionId);
    const text = [currentDraft.text.trimEnd(), transcript.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    await sendDraft(currentSessionId, { ...currentDraft, text });
  }, [currentSessionId, sendDraft]);

  const runRecovery = React.useCallback(async (
    entry: PiSessionMessageEntry,
    mode: RecoveryMode,
  ) => {
    if (!currentSessionId) return;
    setRecoveryBusyEntryId(entry.id);
    try {
      const result = await recoverTo(currentSessionId, entry.id, mode);
      if (result.editorText !== undefined || result.editorImages !== undefined) {
        updateDraft(currentSessionId, {
          ...(result.editorImages === undefined ? {} : { images: result.editorImages }),
          ...(result.editorText === undefined ? {} : { text: result.editorText }),
        });
      }
      if (result.outcome === 'applied') {
        toast.success(mode === 'conversation'
          ? t('settings.piarium.recovery.preference.conversation.label')
          : t('settings.piarium.recovery.preference.both.label'));
      }
      setRecoveryEntry(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveryBusyEntryId(null);
    }
  }, [currentSessionId, recoverTo, t, updateDraft]);

  const handleRecover = React.useCallback((entry: PiSessionMessageEntry) => {
    if (recoveryPreference === 'ask') {
      setRecoveryEntry(entry);
      return;
    }
    void runRecovery(entry, recoveryPreference);
  }, [recoveryPreference, runRecovery]);

  if (currentSessionId === null) {
    return (
      <div className={cn('flex h-full items-center justify-center bg-background px-6', !active && 'pointer-events-none')}>
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon name="chat-new" className="size-6" />
          </div>
          <h2 className="typography-markdown font-semibold text-foreground">
            {t('chat.emptyState.draftTitle')}
          </h2>
          <p className="mt-2 typography-ui-label text-muted-foreground">
            {t('sessions.sidebar.empty.noSessions.description')}
          </p>
          {!readOnly && (
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 typography-ui-label text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Icon name={creating ? 'loader-4' : 'add'} className={cn('size-4', creating && 'animate-spin')} />
              {t('sessions.sidebar.header.actions.newSession')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!currentRecord?.snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted-foreground">
        <Icon name="loader-4" className="mr-2 size-4 animate-spin" />
        {openingSessionId ? t('sessions.sidebar.group.empty.loadingSessions') : lastError}
      </div>
    );
  }

  const { snapshot } = currentRecord;
  const entries = currentRecord.branchEntries?.entries ?? [];
  const title = extensionUi?.title?.trim() || (currentSummary
    ? piSessionTitle(currentSummary, untitled)
    : snapshot.name?.trim() || untitled);
  const supportsCombinedRecovery = currentRecord.recoveryStatus?.modes.includes('both') === true;

  return (
    <TooltipProvider>
      <div className={cn('flex h-full min-h-0 flex-col bg-background', !active && 'pointer-events-none')}>
        <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate typography-ui-label font-medium text-foreground">{title}</h2>
            <p className="truncate typography-micro text-muted-foreground">{snapshot.cwd}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 typography-micro text-muted-foreground">
            {snapshot.model && (
              <button
                type="button"
                onClick={() => setModelSelectorOpen(true)}
                className="hidden max-w-56 truncate rounded-md bg-muted/40 px-2 py-1 hover:bg-interactive-hover sm:inline"
              >
                {snapshot.model.provider}/{snapshot.model.id}
              </button>
            )}
            <button
              type="button"
              onClick={() => setModelSelectorOpen(true)}
              className="rounded-md bg-muted/40 px-2 py-1 hover:bg-interactive-hover"
            >
              {snapshot.thinkingLevel}
            </button>
            {snapshot.busy && <Icon name="loader-4" className="size-3.5 animate-spin text-primary" />}
          </div>
        </div>

        {entries.length === 0 && !currentRecord.liveAssistant ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div>
              <Icon name="sparkling" className="mx-auto size-7 text-primary" />
              <p className="mt-3 typography-ui-label text-muted-foreground">
                {t('chat.chatInput.placeholder.chat')}
              </p>
            </div>
          </div>
        ) : (
          <PiTimeline
            entries={entries}
            hiddenThinkingLabel={extensionUi?.hiddenThinkingLabel}
            liveAssistant={currentRecord.liveAssistant}
            onRecover={handleRecover}
            recoveryBusyEntryId={recoveryBusyEntryId}
            sessionId={currentSessionId}
            toolExecutions={currentRecord.toolExecutions}
          />
        )}

        <PiExtensionUiChrome placement="aboveEditor" sessionId={currentSessionId} />

        {!readOnly && (
          <PiComposer
            draft={draft.text}
            images={draft.images}
            followUpBehavior={followUpBehavior}
            sending={sending}
            snapshot={snapshot}
            onAbort={async () => { await abort(currentSessionId); }}
            onChangeDraft={(text) => updateDraft(currentSessionId, { text })}
            onChangeImages={(images) => updateDraft(currentSessionId, { images })}
            onSendText={handleDictationSend}
            onSend={handleSend}
          />
        )}
        <PiExtensionUiChrome placement="belowEditor" sessionId={currentSessionId} />
      </div>

      <PiModelSelectorDialog />
      <Dialog open={recoveryEntry !== null} onOpenChange={(open) => { if (!open) setRecoveryEntry(null); }}>
        <DialogContent showCloseButton={false} className="max-w-md gap-5">
          <DialogHeader>
            <DialogTitle>{t('settings.piarium.recovery.preference.aria')}</DialogTitle>
            <DialogDescription>
              {t('settings.piarium.recovery.preference.ask.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => { if (recoveryEntry) void runRecovery(recoveryEntry, 'conversation'); }}
              disabled={recoveryBusyEntryId !== null}
              className="rounded-lg border border-border px-3 py-3 text-left hover:bg-interactive-hover/50 disabled:opacity-50"
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.preference.conversation.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.preference.conversation.description')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => { if (recoveryEntry) void runRecovery(recoveryEntry, 'both'); }}
              disabled={!supportsCombinedRecovery || recoveryBusyEntryId !== null}
              className="rounded-lg border border-border px-3 py-3 text-left hover:bg-interactive-hover/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.preference.both.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.preference.both.description')}
              </span>
            </button>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRecoveryEntry(null)}
              disabled={recoveryBusyEntryId !== null}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 disabled:opacity-50"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
