import React from 'react';
import { PiRuntimeAmbiguousRequestError } from '@piarium/runtime-client';
import type {
  ModelDescriptor,
  PiSessionMessageEntry,
  RecoveryMode,
  ThinkingLevel,
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
import { PiariumLogo } from '@/components/ui/PiariumLogo';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { usePiInteractionStore } from '@/stores/usePiInteractionStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  EMPTY_PI_DRAFT,
  piDraftKey,
  piPendingDraftKey,
  readPiDraft,
  readPiPendingDraft,
  type PiDraftState,
  usePiDraftStore,
} from '@/stores/usePiDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import { joinPiDraftInstructions } from '@/lib/pi-runtime/sessionDrafts';
import { recoveryModeForStatus, supportsPiRecoveryAction } from '@/lib/pi-runtime/recovery';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { consumeEditorContextAttachments, restoreEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { projectEditorContextAttachments } from '@/lib/agent-editor/projection';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { AutoReviewBanner } from '@/components/chat/AutoReviewBanner';
import type { ResolvedStarter } from '@/components/chat/useDraftStarters';
import { PiComposer } from './PiComposer';
import { PiAssistBar } from './PiAssistBar';
import { PiExtensionUiChrome } from './PiExtensionUiChrome';
import { PiGoalStrip } from './PiGoalControls';
import { piSessionTitle } from './sessionPresentation';
import { renderPiComposerSubmission } from './piComposerSubmission';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import {
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';
import { getResolvedWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { usePiComposerDefaults } from './usePiComposerDefaults';
import { configurePiComposerSession } from './piComposerSessionConfig';

const LazyPiTimeline = React.lazy(async () => {
  const module = await import('./PiTimeline');
  return { default: module.PiTimeline };
});

const LazyPiWorkStatusPanel = React.lazy(async () => {
  const module = await import('./PiWorkStatusPanel');
  return { default: module.PiWorkStatusPanel };
});

interface PiChatViewProps {
  active?: boolean;
  autoOpenDraft?: boolean;
  readOnly?: boolean;
  showHeader?: boolean;
  showWorkStatus?: boolean;
}

const DRAFT_PROJECT_MARKER = '__PIARIUM_DRAFT_PROJECT__';

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
  if (!projectLabel) return title;
  const projectIndex = title.indexOf(DRAFT_PROJECT_MARKER);
  if (projectIndex === -1) return title;
  return (
    <>
      {title.slice(0, projectIndex)}
      <span className="font-medium">{projectLabel}</span>
      {title.slice(projectIndex + DRAFT_PROJECT_MARKER.length)}
    </>
  );
};

export const PiChatView: React.FC<PiChatViewProps> = ({
  active = true,
  autoOpenDraft = true,
  readOnly = false,
  showHeader = true,
  showWorkStatus = false,
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
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const createSession = usePiSessionStore((state) => state.createSession);
  const prompt = usePiSessionStore((state) => state.prompt);
  const steer = usePiSessionStore((state) => state.steer);
  const followUp = usePiSessionStore((state) => state.followUp);
  const abort = usePiSessionStore((state) => state.abort);
  const mutateFeatures = usePiSessionStore((state) => state.mutateFeatures);
  const recoverTo = usePiSessionStore((state) => state.recoverTo);
  const selectModel = usePiSessionStore((state) => state.selectModel);
  const selectThinking = usePiSessionStore((state) => state.selectThinking);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
  const recoveryPreference = useUIStore((state) => state.recoveryPreference);
  const supportsCombinedRecovery = supportsPiRecoveryAction(
    currentRecord?.recoveryStatus,
    'navigate',
    'both',
  );
  const preferredRecoveryMode = recoveryModeForStatus(
    recoveryPreference,
    currentRecord?.recoveryStatus,
  );
  const extensionUi = usePiInteractionStore((state) => (
    currentSessionId === null ? undefined : state.sessions[currentSessionId]
  ));
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const pendingCwd = activeProject?.path || homeDirectory || currentDirectory || '';
  const pendingWorkspace = React.useMemo(() => (
    activeProject
      ? { id: activeProject.id, kind: 'workspace' as const }
      : { kind: 'unbound' as const }
  ), [activeProject]);
  const pendingDraftOpen = currentSessionId === null && autoOpenDraft && !readOnly && Boolean(pendingCwd);
  const pendingDefaults = usePiComposerDefaults(
    pendingDraftOpen ? pendingCwd : '',
    activeProject?.defaultModel,
  );
  const projectDefaultModel = React.useMemo(() => {
    const parsed = parseModelIdentifier(activeProject?.defaultModel);
    return parsed ? { id: parsed.modelId, provider: parsed.providerId } : undefined;
  }, [activeProject?.defaultModel]);
  const currentDraftKey = currentSessionId === null
    ? pendingDraftOpen && pendingCwd
      ? piPendingDraftKey(pendingCwd, runtimeKey)
      : null
    : piDraftKey(currentSessionId, runtimeKey);
  const draft = usePiDraftStore((state) => (
    currentDraftKey === null ? EMPTY_PI_DRAFT : state.drafts[currentDraftKey] ?? EMPTY_PI_DRAFT
  ));
  const setPiDraft = usePiDraftStore((state) => state.setDraft);
  const setPendingPiDraft = usePiDraftStore((state) => state.setPendingDraft);
  const clearPiDraft = usePiDraftStore((state) => state.clear);
  const transferPendingPiDraft = usePiDraftStore((state) => state.transferPendingDraft);
  const [sending, setSending] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [recoveryEntry, setRecoveryEntry] = React.useState<PiSessionMessageEntry | null>(null);
  const [recoveryBusyEntryId, setRecoveryBusyEntryId] = React.useState<string | null>(null);
  const [pinBusyEntryId, setPinBusyEntryId] = React.useState<string | null>(null);
  const appliedEditorRevisions = React.useRef(new Map<string, number>());
  const untitled = t('sessions.sidebar.session.untitled');
  const updateDraft = React.useCallback((sessionId: string, update: Partial<PiDraftState>) => {
    setPiDraft(sessionId, update, runtimeKey);
  }, [runtimeKey, setPiDraft]);
  const updatePendingDraft = React.useCallback((update: Partial<PiDraftState>) => {
    if (!pendingCwd) return;
    setPendingPiDraft(pendingCwd, update, runtimeKey);
  }, [pendingCwd, runtimeKey, setPendingPiDraft]);

  const configureNewSession = React.useCallback(async (
    initialSnapshot: Awaited<ReturnType<typeof createSession>>,
    config: Pick<PiDraftState, 'model' | 'thinkingLevel'>,
  ) => configurePiComposerSession(
    initialSnapshot,
    config,
    projectDefaultModel,
    { selectModel, selectThinking },
  ), [projectDefaultModel, selectModel, selectThinking]);

  React.useEffect(() => {
    if (!currentSessionId || !extensionUi?.editorText) return;
    const { revision, text } = extensionUi.editorText;
    if (appliedEditorRevisions.current.get(currentSessionId) === revision) return;
    appliedEditorRevisions.current.set(currentSessionId, revision);
    updateDraft(currentSessionId, { text });
  }, [currentSessionId, extensionUi?.editorText, updateDraft]);

  const handleCreate = React.useCallback(async () => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const cwd = activeProject?.path || homeDirectory || currentDirectory;
    if (!cwd) return;
    setCreating(true);
    try {
      setDirectory(cwd, { showOverlay: false });
      const snapshot = await createSession(cwd, undefined, undefined, activeProject
        ? { id: activeProject.id, kind: 'workspace' }
        : { kind: 'unbound' });
      await configureNewSession(snapshot, {});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [activeProjectId, configureNewSession, createSession, currentDirectory, homeDirectory, projects, setDirectory]);

  const sendDraft = React.useCallback(async (
    sessionId: string,
    currentDraft: PiDraftState,
    draftRuntimeKey = runtimeKey,
  ) => {
    const snapshot = usePiSessionStore.getState().records[sessionId]?.snapshot;
    if (!snapshot || sending) return;
    const inlineDraftTarget = { directory: snapshot.cwd, sessionKey: sessionId };
    const inlineDraftStore = useInlineCommentDraftStore.getState();
    let inlineDrafts: ReturnType<typeof inlineDraftStore.consumeDrafts> = [];
    let editorAttachments: ReturnType<typeof consumeEditorContextAttachments> = [];
    let consumedGoalArm: { armed: boolean; objectiveOverride: string | null } = {
      armed: false,
      objectiveOverride: null,
    };
    let startedGoalId: string | null = null;
    setSending(true);
    try {
      const rendered = await renderPiComposerSubmission(currentDraft.text);
      let promptText = rendered.text;
      const instructions = joinPiDraftInstructions(
        currentDraft.instructions,
        rendered.instructions,
      );
      try {
        promptText = await useSnippetsStore.getState().expandText(promptText);
      } catch (error) {
        console.warn('[PiChatView] Failed to expand snippets, sending original text:', error);
      }
      inlineDrafts = inlineDraftStore.consumeDrafts(inlineDraftTarget);
      promptText = appendInlineComments(promptText, inlineDrafts);
      editorAttachments = consumeEditorContextAttachments(
        draftRuntimeKey,
        sessionId,
        getResolvedWorkbenchWorkspaceId(snapshot.cwd),
      );
      promptText = projectEditorContextAttachments(promptText, editorAttachments);
      if (!promptText.trim() && currentDraft.images.length === 0) {
        inlineDraftStore.restoreDrafts(inlineDraftTarget, inlineDrafts);
        restoreEditorContextAttachments(editorAttachments);
        return;
      }
      consumedGoalArm = useSessionGoalArmStore.getState().consume();
      if (consumedGoalArm.armed) {
        const settings = useUIStore.getState();
        const objective = (consumedGoalArm.objectiveOverride || promptText).trim();
        const featureState = await mutateFeatures(sessionId, {
          objective,
          ...(settings.sessionGoalDefaultBudgetEnabled && settings.sessionGoalDefaultBudget > 0
            ? { tokenBudget: settings.sessionGoalDefaultBudget }
            : {}),
          type: 'goal.start',
        }, draftRuntimeKey);
        startedGoalId = featureState.goal?.id ?? null;
      }
      let accepted: boolean;
      if (projectPiSessionActivity(snapshot).isWorking) {
        if (followUpBehavior === 'queue') {
          accepted = await followUp(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
        } else {
          accepted = await steer(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
        }
      } else {
        accepted = await prompt(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
      }
      if (!accepted) throw new Error('The Pi runtime did not accept the prompt');
      clearPiDraft(sessionId, draftRuntimeKey);
    } catch (error) {
      if (inlineDrafts.length > 0) inlineDraftStore.restoreDrafts(inlineDraftTarget, inlineDrafts);
      restoreEditorContextAttachments(editorAttachments);
      if (startedGoalId) {
        await mutateFeatures(
          sessionId,
          { goalId: startedGoalId, type: 'goal.clear' },
          draftRuntimeKey,
        ).catch(() => undefined);
      }
      if (consumedGoalArm.armed) {
        useSessionGoalArmStore.getState().setArmed(true, consumedGoalArm.objectiveOverride);
      }
      console.error('Failed to send Pi prompt:', error);
      toast.error(
        error instanceof PiRuntimeAmbiguousRequestError
          ? t('chat.piComposer.sendResultUnknown')
          : error instanceof Error
            ? error.message
            : t('chat.chatInput.toast.messageSendFailed'),
      );
    } finally {
      setSending(false);
    }
  }, [clearPiDraft, followUp, followUpBehavior, mutateFeatures, prompt, runtimeKey, sending, steer, t]);

  const handleSend = React.useCallback(async () => {
    if (!currentSessionId) return;
    await sendDraft(currentSessionId, readPiDraft(currentSessionId, runtimeKey), runtimeKey);
  }, [currentSessionId, runtimeKey, sendDraft]);

  const handleDictationSend = React.useCallback(async (transcript: string) => {
    if (!currentSessionId) return;
    const currentDraft = readPiDraft(currentSessionId, runtimeKey);
    const text = [currentDraft.text.trimEnd(), transcript.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    const nextDraft = { ...currentDraft, text };
    setPiDraft(currentSessionId, { text }, runtimeKey);
    await sendDraft(currentSessionId, nextDraft, runtimeKey);
  }, [currentSessionId, runtimeKey, sendDraft, setPiDraft]);

  const submitPendingDraft = React.useCallback(async () => {
    if (!pendingCwd || creating || sending) return;
    const draftRuntimeKey = runtimeKey;
    const pendingDraft = readPiPendingDraft(pendingCwd, draftRuntimeKey);
    if (!pendingDraft.text.trim() && pendingDraft.images.length === 0) return;
    setCreating(true);
    try {
      setDirectory(pendingCwd, { showOverlay: false });
      const snapshot = await createSession(pendingCwd, undefined, undefined, pendingWorkspace);
      const transferredDraft = transferPendingPiDraft(
        pendingCwd,
        snapshot.sessionId,
        draftRuntimeKey,
      );
      await configureNewSession(snapshot, transferredDraft);
      await sendDraft(snapshot.sessionId, transferredDraft, draftRuntimeKey);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [configureNewSession, createSession, creating, pendingCwd, pendingWorkspace, runtimeKey, sendDraft, sending, setDirectory, transferPendingPiDraft]);

  const handleCurrentModelChange = React.useCallback(async (
    model: Pick<ModelDescriptor, 'id' | 'provider'> | undefined,
  ) => {
    if (!currentSessionId || !model) return;
    await selectModel(currentSessionId, model);
  }, [currentSessionId, selectModel]);

  const handleCurrentThinkingChange = React.useCallback(async (
    level: ThinkingLevel | undefined,
  ) => {
    if (!currentSessionId || !level) return;
    await selectThinking(currentSessionId, level);
  }, [currentSessionId, selectThinking]);

  const handlePendingDictationSend = React.useCallback(async (transcript: string) => {
    if (!pendingCwd) return;
    const currentDraft = readPiPendingDraft(pendingCwd, runtimeKey);
    const text = [currentDraft.text.trimEnd(), transcript.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    setPendingPiDraft(pendingCwd, { text }, runtimeKey);
    await submitPendingDraft();
  }, [pendingCwd, runtimeKey, setPendingPiDraft, submitPendingDraft]);

  const handlePendingStarterSubmit = React.useCallback(async (starter: ResolvedStarter) => {
    if (!pendingCwd) return;
    setPendingPiDraft(pendingCwd, { text: starter.submitText }, runtimeKey);
    await submitPendingDraft();
  }, [pendingCwd, runtimeKey, setPendingPiDraft, submitPendingDraft]);

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
          instructions: undefined,
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
    if (preferredRecoveryMode === null) {
      setRecoveryEntry(entry);
      return;
    }
    void runRecovery(entry, preferredRecoveryMode);
  }, [preferredRecoveryMode, runRecovery]);

  const handleTogglePinned = React.useCallback(async (
    entry: PiSessionMessageEntry,
    pinned: boolean,
  ) => {
    if (!currentSessionId || pinBusyEntryId) return;
    setPinBusyEntryId(entry.id);
    try {
      await mutateFeatures(currentSessionId, {
        entryId: entry.id,
        pinned,
        type: 'context.set',
      });
      requestAnimationFrame(focusChatInput);
    } catch (error) {
      console.warn('[pi-session] context pin failed:', error);
      toast.error(t('chat.messageBody.actions.contextPinFailed'));
    } finally {
      setPinBusyEntryId(null);
    }
  }, [currentSessionId, mutateFeatures, pinBusyEntryId, t]);

  const pinnedEntryIds = React.useMemo(() => new Set(
    currentRecord?.snapshot?.features.pinnedContext.map((entry) => entry.entryId) ?? [],
  ), [currentRecord?.snapshot?.features.pinnedContext]);

  if (pendingDraftOpen) {
    const projectLabel = activeProject
      ? activeProject.label?.trim() || formatDirectoryName(activeProject.path, null)
      : null;
    const draftTitle = projectLabel
      ? t('chat.emptyState.draftTitleWithProject', { project: DRAFT_PROJECT_MARKER })
      : t('chat.emptyState.draftTitle');
    return (
      <TooltipProvider>
        <div
          className={cn(
            'flex h-full min-h-0 flex-col bg-background',
            !active && 'pointer-events-none',
          )}
          data-pi-pending-draft="true"
          data-pi-draft-cwd={pendingCwd}
        >
          <div className="oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
              {renderDraftTitle(draftTitle, projectLabel)}
            </h1>
            <DraftPresetChips
              className="oc-draft-starters mt-8 max-w-md"
              cwd={pendingCwd}
              sessionId={null}
              onSubmit={(starter) => { void handlePendingStarterSubmit(starter); }}
            />
          </div>
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.chatComposer}
            fallback={(
              <PiComposer
                active={active}
                allowModelInheritance
                cwd={pendingCwd}
                draft={draft.text}
                effectiveModel={draft.model ?? pendingDefaults.model}
                effectiveThinkingLevel={draft.thinkingLevel ?? pendingDefaults.thinkingLevel}
                images={draft.images}
                followUpBehavior={followUpBehavior}
                selectedModel={draft.model}
                selectedThinkingLevel={draft.thinkingLevel}
                sending={creating || sending}
                sessionId={null}
                onChangeDraft={(text) => updatePendingDraft({ text })}
                onChangeImages={(images) => updatePendingDraft({ images })}
                onChangeModel={(model) => updatePendingDraft({ model })}
                onChangeThinkingLevel={(thinkingLevel) => updatePendingDraft({ thinkingLevel })}
                onSendText={handlePendingDictationSend}
                onSend={submitPendingDraft}
              />
            )}
          />
        </div>
      </TooltipProvider>
    );
  }

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
  return (
    <TooltipProvider>
      <div className={cn('@container flex h-full min-h-0 bg-background', !active && 'pointer-events-none')}>
        <div className="flex min-w-0 flex-1 flex-col">
          {showHeader ? <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate typography-ui-label font-medium text-foreground">{title}</h2>
            <p className="truncate typography-micro text-muted-foreground">{snapshot.cwd}</p>
          </div>
          {snapshot.busy ? <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" /> : null}
        </div> : null}

        {entries.length === 0 && !currentRecord.liveAssistant ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <PiariumLogo width={140} height={140} className="mx-auto size-[140px] opacity-20" />
              <p className="mt-4 typography-ui-label text-muted-foreground">
                {t('chat.emptyState.startNewChat')}
              </p>
            </div>
          </div>
        ) : (
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.chatTimeline}
            fallback={(
              <React.Suspense fallback={(
                <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                </div>
              )}>
                <LazyPiTimeline
                  cwd={snapshot.cwd}
                  entries={entries}
                  hiddenThinkingLabel={extensionUi?.hiddenThinkingLabel}
                  liveAssistant={currentRecord.liveAssistant}
                  onRecover={handleRecover}
                  onTogglePinned={handleTogglePinned}
                  pinBusyEntryId={pinBusyEntryId}
                  pinnedEntryIds={pinnedEntryIds}
                  recoveryBusyEntryId={recoveryBusyEntryId}
                  sessionId={currentSessionId}
                  toolExecutions={currentRecord.toolExecutions}
                />
              </React.Suspense>
            )}
          />
        )}

        <PiExtensionUiChrome placement="aboveEditor" sessionId={currentSessionId} />

        <PiAssistBar
          draftEmpty={draft.text.trim().length === 0 && draft.images.length === 0}
          entries={entries}
          onApplySuggestion={(value) => updateDraft(currentSessionId, { text: value })}
          snapshot={snapshot}
        />
        <div className="px-3 sm:px-5">
          <PiGoalStrip snapshot={snapshot} />
        </div>

        <AutoReviewBanner />

        {!readOnly && (
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.chatComposer}
            fallback={(
              <PiComposer
                active={active}
                allowModelInheritance={false}
                cwd={snapshot.cwd}
                draft={draft.text}
                effectiveModel={snapshot.model}
                effectiveThinkingLevel={snapshot.thinkingLevel}
                images={draft.images}
                followUpBehavior={followUpBehavior}
                selectedModel={snapshot.model}
                selectedThinkingLevel={snapshot.thinkingLevel}
                sending={creating || sending}
                sessionId={snapshot.sessionId}
                snapshot={snapshot}
                onAbort={async () => { await abort(currentSessionId); }}
                onChangeDraft={(text) => updateDraft(currentSessionId, { text })}
                onChangeImages={(images) => updateDraft(currentSessionId, { images })}
                onChangeModel={handleCurrentModelChange}
                onChangeThinkingLevel={handleCurrentThinkingChange}
                onSendText={handleDictationSend}
                onSend={handleSend}
              />
            )}
          />
        )}
          <PiExtensionUiChrome placement="belowEditor" sessionId={currentSessionId} />
        </div>
        {showWorkStatus ? (
          <React.Suspense fallback={null}>
            <LazyPiWorkStatusPanel sessionId={currentSessionId} />
          </React.Suspense>
        ) : null}
      </div>

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
              {!supportsCombinedRecovery ? (
                <span className="mt-2 block typography-meta text-[var(--status-warning)]">
                  {t('contextPanel.recovery.combinedUnavailable')}
                </span>
              ) : null}
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
