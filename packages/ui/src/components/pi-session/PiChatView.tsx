import React from 'react';
import type {
  WorkspaceCombinedRecoveryOperation,
  WorkspaceCombinedRecoveryPlan,
} from '@piarium/extension-contract';
import { PiRuntimeAmbiguousRequestError } from '@piarium/runtime-client';
import { runtimeFetch } from '@piarium/application-client';
import type {
  ModelDescriptor,
  PiSessionMessageEntry,
  PiUserMessage,
  ThinkingLevel,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PiariumLogo } from '@/components/ui/PiariumLogo';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { usePiInteractionStore } from '@/stores/usePiInteractionStore';
import {
  isPiSessionWorkerReady,
  usePiSessionStore,
  type PiSessionSubmissionMode,
} from '@/stores/usePiSessionStore';
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
import { renderPiComposerSubmission } from './piComposerSubmission';
import {
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';
import { getResolvedWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { usePiComposerDefaults } from './usePiComposerDefaults';
import { configurePiComposerSession } from './piComposerSessionConfig';
import { renderPiComposerAgentInvocation } from '@/lib/pi-runtime/composerAgent';
import { projectPiMessageHistory } from './piMessageHistory';
import { projectPiAssistantWaiting } from './piAssistantWaiting';
import { PiRecoveryDialog } from './PiRecoveryDialog';
import { parsePiLocalCommand } from './piLocalCommands';
import { shouldOpenRecoveryDialog } from './piRecoveryPolicy';
import { HarnessThreadsPanel } from './HarnessThreadsPanel';
import { HarnessThreadStateProvider } from './HarnessThreadState';
import { parseHarnessThreadMutation } from './harnessThreadPresentation';

const LazyPiTimeline = React.lazy(async () => {
  const module = await import('./PiTimeline');
  return { default: module.PiTimeline };
});

const LazyPiTreeDialog = React.lazy(async () => {
  const module = await import('./PiTreeDialog');
  return { default: module.PiTreeDialog };
});

interface PiChatViewProps {
  active?: boolean;
  autoOpenDraft?: boolean;
  readOnly?: boolean;
}

const DRAFT_PROJECT_MARKER = '__PIARIUM_DRAFT_PROJECT__';
const EMPTY_PI_MESSAGE_HISTORY: readonly string[] = [];

const pendingUserMessage = (draft: PiDraftState): PiUserMessage => ({
  content: draft.images.length === 0
    ? draft.text
    : [
        ...(draft.text ? [{ text: draft.text, type: 'text' as const }] : []),
        ...draft.images.map((image) => ({ ...image, type: 'image' as const })),
      ],
  role: 'user',
  timestamp: Date.now(),
});

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

const PiTimelineHydrationSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="flex min-h-0 flex-1 flex-col bg-background"
    aria-busy="true"
    aria-label={label}
    data-pi-conversation-hydrating="true"
  >
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-10 sm:px-10">
      <div className="ml-auto h-16 w-[min(72%,34rem)] animate-pulse rounded-2xl rounded-br-md bg-muted/45" />
      <div className="w-[min(88%,46rem)] space-y-3">
        <div className="h-3 w-24 animate-pulse rounded bg-muted/45" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted/35" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted/30" />
      </div>
      <div className="ml-auto h-12 w-[min(58%,28rem)] animate-pulse rounded-2xl rounded-br-md bg-muted/30" />
    </div>
  </div>
);

const PiComposerHydrationSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="bottom-safe-area shrink-0 bg-background pb-4" aria-busy="true" aria-label={label}>
    <div className="chat-input-column">
      <div className="flex h-[7.5rem] animate-pulse flex-col justify-between rounded-2xl border border-border/60 bg-[var(--surface-subtle)]/70 p-3">
        <div className="h-3 w-1/2 rounded bg-muted/40" />
        <div className="flex items-center justify-between">
          <div className="h-7 w-28 rounded-lg bg-muted/35" />
          <div className="flex items-center gap-2">
            <div className="h-7 w-24 rounded-lg bg-muted/35" />
            <div className="size-8 rounded-lg bg-muted/45" />
          </div>
        </div>
      </div>
    </div>
  </div>
);

export const PiChatView: React.FC<PiChatViewProps> = ({
  active = true,
  autoOpenDraft = true,
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
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const createSession = usePiSessionStore((state) => state.createSession);
  const openSession = usePiSessionStore((state) => state.openSession);
  const beginSubmission = usePiSessionStore((state) => state.beginSubmission);
  const clearQueue = usePiSessionStore((state) => state.clearQueue);
  const clearSubmission = usePiSessionStore((state) => state.clearSubmission);
  const prompt = usePiSessionStore((state) => state.prompt);
  const steer = usePiSessionStore((state) => state.steer);
  const followUp = usePiSessionStore((state) => state.followUp);
  const forkSession = usePiSessionStore((state) => state.forkSession);
  const abort = usePiSessionStore((state) => state.abort);
  const mutateFeatures = usePiSessionStore((state) => state.mutateFeatures);
  const refreshEntries = usePiSessionStore((state) => state.refreshEntries);
  const recoverTo = usePiSessionStore((state) => state.recoverTo);
  const selectModel = usePiSessionStore((state) => state.selectModel);
  const selectThinking = usePiSessionStore((state) => state.selectThinking);
  const updateSubmission = usePiSessionStore((state) => state.updateSubmission);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
  const recoveryPreference = useUIStore((state) => state.recoveryPreference);
  const treeDialogOpen = useUIStore((state) => state.isTimelineDialogOpen);
  const setTreeDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
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
  const [creating, setCreating] = React.useState(false);
  const [recoveryEntry, setRecoveryEntry] = React.useState<PiSessionMessageEntry | null>(null);
  const [recoveryPlan, setRecoveryPlan] = React.useState<WorkspaceCombinedRecoveryPlan | null>(null);
  const [recoveryBusyEntryId, setRecoveryBusyEntryId] = React.useState<string | null>(null);
  const [forkBusyEntryId, setForkBusyEntryId] = React.useState<string | null>(null);
  const [threadBusyEntryId, setThreadBusyEntryId] = React.useState<string | null>(null);
  const [treeInitialQuery, setTreeInitialQuery] = React.useState('');
  const appliedEditorRevisions = React.useRef(new Map<string, number>());
  const submission = currentRecord?.submission;
  const sending = submission?.status === 'preparing' || submission?.status === 'dispatching';
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
    const record = usePiSessionStore.getState().records[sessionId];
    const snapshot = record?.snapshot;
    if (
      !snapshot
      || record.submission?.status === 'preparing'
      || record.submission?.status === 'dispatching'
    ) return;
    const activity = projectPiSessionActivity(snapshot);
    const submissionMode: PiSessionSubmissionMode = activity.isWorking
      ? (followUpBehavior === 'queue' ? 'followUp' : 'steer')
      : 'prompt';
    const submissionId = beginSubmission(
      sessionId,
      pendingUserMessage(currentDraft),
      submissionMode,
    );
    const inlineDraftTarget = { directory: snapshot.cwd, sessionKey: sessionId };
    const inlineDraftStore = useInlineCommentDraftStore.getState();
    let inlineDrafts: ReturnType<typeof inlineDraftStore.consumeDrafts> = [];
    let editorAttachments: ReturnType<typeof consumeEditorContextAttachments> = [];
    let consumedGoalArm: { armed: boolean; objectiveOverride: string | null } = {
      armed: false,
      objectiveOverride: null,
    };
    let startedGoalId: string | null = null;
    let draftCleared = false;
    try {
      const rendered = await renderPiComposerSubmission(currentDraft.text);
      let promptText = rendered.text;
      let instructions = joinPiDraftInstructions(
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
      if (currentDraft.agent) {
        promptText = renderPiComposerAgentInvocation(
          promptText,
          currentDraft.agent,
          instructions,
        );
        instructions = undefined;
      }
      if (!promptText.trim() && currentDraft.images.length === 0) {
        inlineDraftStore.restoreDrafts(inlineDraftTarget, inlineDrafts);
        restoreEditorContextAttachments(editorAttachments);
        clearSubmission(sessionId, submissionId);
        return;
      }
      if (currentDraft.agent && currentDraft.images.length > 0) {
        throw new Error(t('chat.piComposer.agent.imageUnsupported'));
      }
      updateSubmission(sessionId, submissionId, {
        dispatchedText: promptText,
        status: 'dispatching',
      });
      clearPiDraft(sessionId, draftRuntimeKey);
      draftCleared = true;
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
      if (activity.isWorking) {
        if (followUpBehavior === 'queue') {
          accepted = await followUp(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
        } else {
          accepted = await steer(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
        }
      } else {
        accepted = await prompt(sessionId, promptText, currentDraft.images, instructions, draftRuntimeKey);
      }
      if (!accepted) throw new Error('The Pi runtime did not accept the prompt');
      updateSubmission(sessionId, submissionId, { status: 'accepted' });
    } catch (error) {
      const ambiguous = error instanceof PiRuntimeAmbiguousRequestError;
      updateSubmission(sessionId, submissionId, {
        error: error instanceof Error ? error.message : String(error),
        status: ambiguous ? 'uncertain' : 'failed',
      });
      if (!ambiguous) {
        if (draftCleared) setPiDraft(sessionId, currentDraft, draftRuntimeKey);
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
      }
      console.error('Failed to send Pi prompt:', error);
      toast.error(
        error instanceof PiRuntimeAmbiguousRequestError
          ? t('chat.piComposer.sendResultUnknown')
          : error instanceof Error
            ? error.message
            : t('chat.chatInput.toast.messageSendFailed'),
      );
    }
  }, [beginSubmission, clearPiDraft, clearSubmission, followUp, followUpBehavior, mutateFeatures, prompt, runtimeKey, setPiDraft, steer, t, updateSubmission]);

  const handleSend = React.useCallback(async () => {
    if (!currentSessionId) return;
    const currentDraft = readPiDraft(currentSessionId, runtimeKey);
    const command = parsePiLocalCommand(currentDraft.text);
    if (command?.kind === 'tree') {
      if (currentDraft.images.length > 0) {
        toast.error(t('chat.timeline.attachmentsUnsupported'));
        return;
      }
      clearPiDraft(currentSessionId, runtimeKey);
      setTreeInitialQuery(command.query);
      setTreeDialogOpen(true);
      return;
    }
    await sendDraft(currentSessionId, currentDraft, runtimeKey);
  }, [clearPiDraft, currentSessionId, runtimeKey, sendDraft, setTreeDialogOpen, t]);

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

  const runConversationRecovery = React.useCallback(async (entry: PiSessionMessageEntry) => {
    if (!currentSessionId) return;
    setRecoveryBusyEntryId(entry.id);
    try {
      const result = await recoverTo(currentSessionId, entry.id, 'conversation');
      if (result.editorText !== undefined || result.editorImages !== undefined) {
        updateDraft(currentSessionId, {
          ...(result.editorImages === undefined ? {} : { images: result.editorImages }),
          ...(result.editorText === undefined ? {} : { text: result.editorText }),
          instructions: undefined,
        });
      }
      if (result.outcome === 'applied') {
        toast.success(t('settings.piarium.recovery.preference.conversation.label'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setRecoveryBusyEntryId(null);
    }
  }, [currentSessionId, recoverTo, t, updateDraft]);

  const handleCombinedRecoveryResult = React.useCallback(async (
    operation: WorkspaceCombinedRecoveryOperation,
  ) => {
    if (!currentSessionId) return;
    if (operation.state === 'complete') {
      if (operation.editorText !== undefined || operation.editorImages !== undefined) {
        updateDraft(currentSessionId, {
          ...(operation.editorImages === undefined ? {} : { images: operation.editorImages }),
          ...(operation.editorText === undefined ? {} : { text: operation.editorText }),
          instructions: undefined,
        });
      }
      await refreshEntries(currentSessionId).catch(() => undefined);
      toast.success(t('chat.recoveryDialog.completed'));
    }
    setRecoveryBusyEntryId(null);
  }, [currentSessionId, refreshEntries, t, updateDraft]);

  const runCombinedRecovery = React.useCallback(async (entry: PiSessionMessageEntry) => {
    if (!currentSessionId || currentRecord?.snapshot?.workspace?.kind !== 'workspace') return;
    setRecoveryBusyEntryId(entry.id);
    try {
      const workspace = currentRecord.snapshot.workspace;
      const prepared = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().prepareCombinedRecovery({
          entryId: entry.id,
          sessionId: currentSessionId,
          workspaceId: workspace.authorityId ?? workspace.id,
        }),
      );
      if (shouldOpenRecoveryDialog(recoveryPreference, prepared.plan)) {
        setRecoveryPlan(prepared.plan);
        setRecoveryEntry(entry);
        return;
      }
      const applied = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().applyCombinedRecovery({
          confirmedConflicts: [],
          conflictPolicy: 'abort',
          expectedRevision: prepared.plan.revision,
          operationId: prepared.plan.id,
        }),
      );
      await handleCombinedRecoveryResult(applied.operation);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setRecoveryBusyEntryId(null);
    }
  }, [currentRecord?.snapshot, currentSessionId, handleCombinedRecoveryResult, recoveryPreference]);

  const handleRecover = React.useCallback((entry: PiSessionMessageEntry) => {
    if (recoveryPreference === 'conversation' || currentRecord?.snapshot?.workspace?.kind !== 'workspace') {
      void runConversationRecovery(entry);
      return;
    }
    void runCombinedRecovery(entry);
  }, [currentRecord?.snapshot?.workspace?.kind, recoveryPreference, runCombinedRecovery, runConversationRecovery]);

  const handleFork = React.useCallback(async (entry: PiSessionMessageEntry) => {
    if (!currentSessionId || forkBusyEntryId) return;
    setForkBusyEntryId(entry.id);
    try {
      await forkSession(currentSessionId, entry.id, 'at');
    } catch (error) {
      console.warn('[pi-session] fork failed:', error);
      toast.error(error instanceof Error ? error.message : t('chat.messageBody.actions.forkFailed'));
    } finally {
      setForkBusyEntryId(null);
    }
  }, [currentSessionId, forkBusyEntryId, forkSession, t]);

  const handleOpenThread = React.useCallback(async (
    entry: PiSessionMessageEntry,
    options: { carryBlocks: boolean },
  ) => {
    const parentSessionId = currentSessionId;
    const parentSnapshot = currentRecord?.snapshot;
    if (!parentSessionId || !parentSnapshot || parentSnapshot.workspace?.kind !== 'workspace' || threadBusyEntryId) return;
    setThreadBusyEntryId(entry.id);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId: entry.id, carryBlocks: options.carryBlocks }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : t('chat.messageBody.actions.openThreadFailed'),
        );
      }
      const created = parseHarnessThreadMutation(body);
      const childSessionId = created.activeRun?.sessionId;
      if (!childSessionId) throw new Error(t('chat.messageBody.actions.openThreadFailed'));
      // Do not steal focus if the user navigated elsewhere while the child
      // session was being created. The thread remains visible in session state.
      if (usePiSessionStore.getState().currentSessionId !== parentSessionId) return;
      await openSession({
        cwd: parentSnapshot.cwd,
        sessionId: childSessionId,
        ...(created.thread.model ? { model: created.thread.model } : {}),
        ...(created.thread.manifest.scope.length > 0 ? { scope: created.thread.manifest.scope } : {}),
        tools: created.thread.manifest.tools,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('chat.messageBody.actions.openThreadFailed'));
    } finally {
      setThreadBusyEntryId(null);
    }
  }, [currentRecord?.snapshot, currentSessionId, openSession, t, threadBusyEntryId]);

  const sentMessageHistory = React.useMemo(() => (
    projectPiMessageHistory(currentRecord?.branchEntries?.entries ?? [])
  ), [currentRecord?.branchEntries?.entries]);
  const transientUser = currentRecord?.liveUser ?? (
    submission?.mode === 'prompt'
      ? submission.message
      : undefined
  );
  const assistantWaiting = React.useMemo(() => {
    return projectPiAssistantWaiting({
      ...(currentRecord?.liveUser ? { liveUser: currentRecord.liveUser } : {}),
      ...(currentRecord?.snapshot ? { snapshot: currentRecord.snapshot } : {}),
      ...(submission ? { submission } : {}),
    });
  }, [currentRecord?.liveUser, currentRecord?.snapshot, submission]);
  const sessionOpening = openingSessionId !== null && openingSessionId === currentSessionId;

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
                messageHistory={EMPTY_PI_MESSAGE_HISTORY}
                followUpBehavior={followUpBehavior}
                selectedAgent={draft.agent}
                selectedModel={draft.model}
                selectedThinkingLevel={draft.thinkingLevel}
                sending={creating || sending}
                sessionId={null}
                workspace={pendingWorkspace}
                onChangeAgent={(agent) => updatePendingDraft({ agent })}
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

  if (!currentRecord?.branchEntries && lastError && !sessionOpening) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center">
          <h2 className="typography-ui-label font-semibold text-foreground">
            {t('chat.container.sessionLoadError.title')}
          </h2>
          <p className="mt-2 typography-meta text-muted-foreground">
            {t('chat.container.sessionLoadError.description')}
          </p>
          <button
            type="button"
            onClick={() => void refreshEntries(currentSessionId).catch((error) => {
              toast.error(error instanceof Error ? error.message : String(error));
            })}
            className="mt-4 inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover"
          >
            {t('chat.container.sessionLoadError.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!currentRecord?.branchEntries) {
    return (
      <TooltipProvider>
        <div className="flex h-full min-h-0 flex-col bg-background">
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.chatTimeline}
            fallback={(
              <PiTimelineHydrationSkeleton
                label={t('sessions.sidebar.group.empty.loadingSessions')}
              />
            )}
          />
          {!readOnly ? (
            <WorkbenchReplacement
              target={WORKBENCH_REPLACEMENT_TARGETS.chatComposer}
              fallback={(
                <PiComposerHydrationSkeleton
                  label={t('sessions.sidebar.group.empty.loadingSessions')}
                />
              )}
            />
          ) : null}
        </div>
      </TooltipProvider>
    );
  }

  const snapshot = currentRecord.snapshot;
  const entries = currentRecord.branchEntries.entries;
  const previewOnly = !isPiSessionWorkerReady(currentRecord);
  const sessionCwd = snapshot?.cwd ?? currentSummary?.cwd ?? currentDirectory;
  const threadWorkspaceId = snapshot?.workspace?.kind === 'workspace'
    ? snapshot.workspace.authorityId ?? snapshot.workspace.id
    : null;
  return (
    <TooltipProvider>
      <HarnessThreadStateProvider parentSessionId={currentSessionId} workspaceId={threadWorkspaceId}>
      <div className={cn('@container relative flex h-full min-h-0 bg-background', !active && 'pointer-events-none')}>
        <div className="flex min-w-0 flex-1 flex-col">
        <WorkbenchReplacement
          target={WORKBENCH_REPLACEMENT_TARGETS.chatTimeline}
          fallback={entries.length === 0 && !currentRecord.liveAssistant && !transientUser ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
              <div className="max-w-md">
                <PiariumLogo width={140} height={140} className="mx-auto size-[140px] opacity-20" />
                <p className="mt-4 typography-ui-label text-muted-foreground">
                  {t('chat.emptyState.startNewChat')}
                </p>
              </div>
            </div>
          ) : (
              <React.Suspense fallback={(
                <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                </div>
              )}>
                <LazyPiTimeline
                  key={`${runtimeKey}:${currentSessionId}`}
                  {...(assistantWaiting ? { assistantWaiting } : {})}
                  cwd={sessionCwd}
                  entries={entries}
                  hiddenThinkingLabel={extensionUi?.hiddenThinkingLabel}
                  leafId={currentRecord.branchEntries.leafId}
                  liveAssistant={currentRecord.liveAssistant}
                  liveUser={transientUser}
                  liveUserStatus={currentRecord.liveUser ? undefined : submission?.status}
                  forkBusyEntryId={forkBusyEntryId}
                  onFork={previewOnly ? undefined : handleFork}
                  onOpenThread={previewOnly || !threadWorkspaceId ? undefined : handleOpenThread}
                  onRecover={previewOnly ? undefined : handleRecover}
                  recoveryBusyEntryId={recoveryBusyEntryId}
                  sessionId={currentSessionId}
                  threadBusyEntryId={threadBusyEntryId}
                  toolExecutions={currentRecord.toolExecutions}
                />
              </React.Suspense>
          )}
        />

        <section className="shrink-0" data-pi-composer-region="true">
        {!previewOnly ? <PiExtensionUiChrome placement="aboveEditor" sessionId={currentSessionId} /> : null}

        {!previewOnly && snapshot ? (
          <>
            <PiAssistBar
              draftEmpty={draft.text.trim().length === 0 && draft.images.length === 0}
              entries={entries}
              onApplySuggestion={(value) => updateDraft(currentSessionId, { text: value })}
              snapshot={snapshot}
            />
            <div className="px-3 sm:px-5">
              <PiGoalStrip snapshot={snapshot} />
            </div>
          </>
        ) : null}

        {!previewOnly ? (
          <div className="chat-input-column">
            <AutoReviewBanner />
          </div>
        ) : null}

        {!readOnly && previewOnly ? (
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.chatComposer}
            fallback={(
              <PiComposerHydrationSkeleton label={t('sessions.sidebar.group.empty.loadingSessions')} />
            )}
          />
        ) : !readOnly && snapshot ? (
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
                messageHistory={sentMessageHistory}
                followUpBehavior={followUpBehavior}
                selectedAgent={draft.agent}
                selectedModel={snapshot.model}
                selectedThinkingLevel={snapshot.thinkingLevel}
                sending={creating || sending || sessionOpening}
                sessionId={snapshot.sessionId}
                snapshot={snapshot}
                workspace={snapshot.workspace}
                onAbort={async () => { await abort(currentSessionId); }}
                onClearQueue={async () => { await clearQueue(currentSessionId); }}
                onChangeAgent={(agent) => updateDraft(currentSessionId, { agent })}
                onChangeDraft={(text) => updateDraft(currentSessionId, { text })}
                onChangeImages={(images) => updateDraft(currentSessionId, { images })}
                onChangeModel={handleCurrentModelChange}
                onChangeThinkingLevel={handleCurrentThinkingChange}
                onSendText={handleDictationSend}
                onSend={handleSend}
              />
            )}
          />
        ) : null}
          {!previewOnly ? <PiExtensionUiChrome placement="belowEditor" sessionId={currentSessionId} /> : null}
        </section>
        </div>
        {threadWorkspaceId ? (
          <HarnessThreadsPanel
            fallbackCwd={sessionCwd}
            parentSessionId={currentSessionId}
            workspaceId={threadWorkspaceId}
          />
        ) : null}
      </div>

      {treeDialogOpen && currentSessionId && snapshot ? (
        <React.Suspense fallback={null}>
          <LazyPiTreeDialog
            busy={projectPiSessionActivity(snapshot).isWorking}
            initialQuery={treeInitialQuery}
            onFork={handleFork}
            onOpenChange={(open) => {
              setTreeDialogOpen(open);
              if (!open) setTreeInitialQuery('');
            }}
            onRecover={handleRecover}
            open
            sessionId={currentSessionId}
          />
        </React.Suspense>
      ) : null}

      {recoveryEntry && recoveryPlan && currentSessionId && snapshot?.workspace?.kind === 'workspace' ? (
        <PiRecoveryDialog
          open
          plan={recoveryPlan}
          onClose={() => {
            setRecoveryEntry(null);
            setRecoveryPlan(null);
            setRecoveryBusyEntryId(null);
          }}
          onCombinedResult={handleCombinedRecoveryResult}
          onConversationOnly={() => runConversationRecovery(recoveryEntry)}
        />
      ) : null}
      </HarnessThreadStateProvider>
    </TooltipProvider>
  );
};
