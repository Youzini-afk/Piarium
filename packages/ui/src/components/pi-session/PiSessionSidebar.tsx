import React from 'react';
import type { SessionSummary } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  canUseElectronDesktopIPC,
  invokeDesktop,
  isDesktopLocalOriginActive,
} from '@/lib/desktop';
import {
  openPiSessionFromNavigation,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { cn, formatDirectoryName, getRevealLabelKey } from '@/lib/utils';
import { usePiInteractionStore } from '@/stores/usePiInteractionStore';
import {
  selectActivePiSessions,
  selectArchivedPiSessions,
  type PiSessionAttentionState,
  usePiSessionStore,
} from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
  isSessionPinned,
  useSessionPinnedStore,
} from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import { workspaceEvents } from '@/lib/workspaceEvents';
import {
  buildPiSessionForest,
  collectPiSessionSubtreeIds,
  countPiSessionSubtreeValues,
  filterPiSessionForest,
  groupPiSessionForestByWorkspace,
  piSessionTitle,
  type PiSessionNode,
} from './sessionPresentation';
import { PiSessionActivityDuration } from './PiSessionActivityDuration';
import {
  renderFirstWorkbenchMatch,
  useWorkbenchMatchRenderers,
} from '@/lib/extensions/workbench-registry';

interface PiSessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
  /**
   * Called after an action that should dismiss a transient host, such as the IDE session picker
   * dialog. The mobile switcher keeps its own dismissal, so hosts that stay mounted omit this.
   */
  onRequestClose?: () => void;
}

type ConfirmationState =
  | {
      scope: 'session';
      action: 'archive' | 'delete';
      ids: string[];
      title: string;
    }
  | {
      scope: 'project';
      action: 'archive';
      ids: string[];
      title: string;
    }
  | {
      scope: 'project';
      action: 'remove';
      projectId: string;
      title: string;
    };

const collectPiSessionForestIds = (nodes: readonly PiSessionNode[]): string[] => {
  const ids: string[] = [];
  const visit = (node: PiSessionNode): void => {
    ids.push(node.session.id);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return ids;
};

interface SessionRowProps {
  attentionBySession: Readonly<Record<string, PiSessionAttentionState>>;
  currentSessionId: string | null;
  editingId: string | null;
  editingName: string;
  expandedIds: ReadonlySet<string>;
  node: PiSessionNode;
  onArchive(node: PiSessionNode): void;
  onBeginRename(session: SessionSummary): void;
  onCancelRename(): void;
  onChangeEditingName(value: string): void;
  onCommitRename(session: SessionSummary): void;
  onCopyId(session: SessionSummary): void;
  onDelete(node: PiSessionNode): void;
  onOpenMiniChat(session: SessionSummary): void;
  onSelect(session: SessionSummary): void;
  onToggleExpanded(sessionId: string): void;
  onTogglePinned(session: SessionSummary): void;
  onUnarchive(session: SessionSummary): void;
  pendingDialogCountBySession: Readonly<Record<string, number>>;
  pinnedIds: Set<string>;
  untitled: string;
}

const PiSessionRow: React.FC<SessionRowProps> = (props) => {
  const { t } = useI18n();
  const { node } = props;
  const { session } = node;
  const title = piSessionTitle(session, props.untitled);
  const hasChildren = node.children.length > 0;
  const expanded = props.expandedIds.has(session.id);
  const pinned = isSessionPinned(props.pinnedIds, session.cwd, session.id);
  const timestamp = Date.parse(session.updatedAt);
  const timeLabel = formatSessionCompactDateLabel(Number.isFinite(timestamp) ? timestamp : Date.now());
  const isCurrent = props.currentSessionId === session.id;
  const sessionRecord = usePiSessionStore((state) => state.records[session.id]);
  const isBusy = sessionRecord?.snapshot?.busy ?? false;
  const pendingDialogCount = countPiSessionSubtreeValues(
    node,
    props.pendingDialogCountBySession,
    hasChildren && !expanded,
  );
  const attention = props.attentionBySession[session.id];
  const archived = session.archivedAt !== undefined;
  const pendingRenameRef = React.useRef(false);
  const decorationRenderers = useWorkbenchMatchRenderers<{
    attention?: PiSessionAttentionState;
    busy: boolean;
    current: boolean;
    pinned: boolean;
    session: SessionSummary;
  }>('session-decoration', 'sessions.navigator.row.decorations');
  const extensionDecoration = renderFirstWorkbenchMatch(decorationRenderers, {
    attention,
    busy: isBusy,
    current: isCurrent,
    pinned,
    session,
  });

  return (
    <div>
      <div
        className={cn(
          'group/session flex min-h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors',
          isCurrent ? 'bg-interactive-active text-foreground' : 'hover:bg-interactive-hover/60 hover:text-foreground',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => props.onToggleExpanded(session.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Collapse child sessions' : 'Expand child sessions'}
          >
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}

        {isBusy ? (
          <span
            className="mx-[3px] size-2 shrink-0 rounded-full bg-primary"
            aria-label={t('sessions.sidebar.session.status.active')}
            title={t('sessions.sidebar.session.status.active')}
          />
        ) : attention?.kind === 'error' ? (
          <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
        ) : attention ? (
          <Icon name="notification-3" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
        ) : pinned ? (
          <Icon name="pushpin" className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Icon name="chat-4" className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}

        {props.editingId === session.id ? (
          <Input
            autoFocus
            value={props.editingName}
            onChange={(event) => props.onChangeEditingName(event.target.value)}
            onBlur={() => props.onCommitRename(session)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                props.onCancelRename();
              }
            }}
            className="h-6 min-w-0 flex-1 px-1.5 py-0 typography-ui-label"
          />
        ) : (
          <button
            type="button"
            onClick={() => props.onSelect(session)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1 truncate typography-ui-label font-normal">{title}</span>
            {extensionDecoration}
            {pendingDialogCount > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[var(--status-info)]/10 px-1 py-0.5 typography-micro text-[var(--status-info)]"
                title={t('chat.questionCard.inputNeeded')}
                aria-label={t('chat.questionCard.inputNeeded')}
              >
                <Icon name="question" className="size-3" />
                <span>{pendingDialogCount}</span>
              </span>
            ) : null}
            <span className="shrink-0 group-hover/session:hidden">
              {isBusy && sessionRecord?.activityStartedAt !== undefined ? (
                <PiSessionActivityDuration startedAt={sessionRecord.activityStartedAt} />
              ) : attention && sessionRecord?.settledActivityDurationMs !== undefined ? (
                <PiSessionActivityDuration
                  durationMs={sessionRecord.settledActivityDurationMs}
                  error={attention.kind === 'error'}
                />
              ) : (
                <span className="typography-micro text-muted-foreground/70">{timeLabel}</span>
              )}
            </span>
          </button>
        )}

        <DropdownMenu
          onOpenChangeComplete={(open) => {
            if (!open && pendingRenameRef.current) {
              pendingRenameRef.current = false;
              props.onBeginRename(session);
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hidden size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground group-hover/session:flex data-[popup-open]:flex"
              aria-label={t('sessions.sidebar.session.menu.label')}
            >
              <Icon name="more-2" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={() => { pendingRenameRef.current = true; }}>
              <Icon name="pencil-ai" className="mr-2 size-4" />
              {t('sessions.sidebar.session.menu.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onCopyId(session)}>
              <Icon name="file-copy" className="mr-2 size-4" />
              {t('sessions.sidebar.session.menu.copyId')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onTogglePinned(session)}>
              <Icon name={pinned ? 'unpin' : 'pushpin'} className="mr-2 size-4" />
              {pinned
                ? t('sessions.sidebar.session.menu.unpin')
                : t('sessions.sidebar.session.menu.pin')}
            </DropdownMenuItem>
            {canUseElectronDesktopIPC() ? (
              <DropdownMenuItem onClick={() => props.onOpenMiniChat(session)}>
                <Icon name="chat-new" className="mr-2 size-4" />
                {t('sessions.sidebar.session.menu.openMiniChatWindow')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {archived ? (
              <DropdownMenuItem onClick={() => props.onUnarchive(session)}>
                <Icon name="inbox-unarchive" className="mr-2 size-4" />
                {t('sessions.sidebar.session.menu.restore')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => props.onArchive(node)}>
                <Icon name="inbox-archive" className="mr-2 size-4" />
                {t('sessions.sidebar.bulkActions.archive')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => props.onDelete(node)}
              className="text-destructive focus:text-destructive"
            >
              <Icon name="delete-bin" className="mr-2 size-4" />
              {t('sessions.sidebar.bulkActions.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {hasChildren && expanded && (
        <div className="ml-3 border-l border-border/60 pl-1">
          {node.children.map((child) => (
            <PiSessionRow key={child.session.id} {...props} node={child} />
          ))}
        </div>
      )}
    </div>
  );
};

export const PiSessionSidebar: React.FC<PiSessionSidebarProps> = ({
  isVisible = true,
  mobileVariant = false,
  onRequestClose,
}) => {
  const { t } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const summaries = usePiSessionStore((state) => state.summaries);
  const activeSessions = usePiSessionStore(selectActivePiSessions);
  const archivedSessions = usePiSessionStore(selectArchivedPiSessions);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const attentionBySession = usePiSessionStore((state) => state.attentionBySession);
  const catalogLoaded = usePiSessionStore((state) => state.catalogLoaded);
  const catalogLoading = usePiSessionStore((state) => state.catalogLoading);
  const lastError = usePiSessionStore((state) => state.lastError);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const loadCatalog = usePiSessionStore((state) => state.loadCatalog);
  const renameSession = usePiSessionStore((state) => state.renameSession);
  const archiveSession = usePiSessionStore((state) => state.archiveSession);
  const unarchiveSession = usePiSessionStore((state) => state.unarchiveSession);
  const deleteSession = usePiSessionStore((state) => state.deleteSession);
  const pendingDialogs = usePiInteractionStore((state) => state.dialogs);
  const pendingDialogCountBySession = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const dialog of pendingDialogs) {
      counts[dialog.sessionId] = (counts[dialog.sessionId] ?? 0) + 1;
    }
    return counts;
  }, [pendingDialogs]);
  const projects = useProjectsStore((state) => state.projects);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const togglePinned = useSessionPinnedStore((state) => state.toggle);
  const clearPinnedSession = useSessionPinnedStore((state) => state.clearPinnedSession);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const [query, setQuery] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
  const [collapsedGroupIds, setCollapsedGroupIds] = React.useState<Set<string>>(() => new Set());
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  const [confirmation, setConfirmation] = React.useState<ConfirmationState | null>(null);
  const [actionPending, setActionPending] = React.useState(false);
  const untitled = t('sessions.sidebar.session.untitled');

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, runtimeKey]);

  const isPinned = React.useCallback((session: SessionSummary) => (
    isSessionPinned(pinnedIds, session.cwd, session.id)
  ), [pinnedIds]);

  const workspaceGroups = React.useMemo(() => {
    const source = showArchived ? archivedSessions : activeSessions;
    const forest = buildPiSessionForest(source, isPinned);
    return groupPiSessionForestByWorkspace(forest, projects, isPinned, {
      includeEmptyProjects: !showArchived,
    }).map((group) => {
      const label = group.project?.label?.trim()
        || (group.path ? formatDirectoryName(group.path, null) || group.path : null)
        || t('sessions.sidebar.grouping.recent');
      return { ...group, label };
    });
  }, [activeSessions, archivedSessions, isPinned, projects, showArchived, t]);

  const groups = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return workspaceGroups.flatMap((group) => {
      const groupMatches = normalizedQuery.length > 0
        && `${group.label}\n${group.path ?? ''}`.toLocaleLowerCase().includes(normalizedQuery);
      const filteredForest = groupMatches
        ? group.forest
        : filterPiSessionForest(group.forest, query, untitled);
      if (normalizedQuery.length > 0 && !groupMatches && filteredForest.length === 0) return [];
      return [{
        ...group,
        forest: filteredForest,
      }];
    });
  }, [query, untitled, workspaceGroups]);

  const handleSelect = React.useCallback(async (session: SessionSummary) => {
    if (mobileVariant) setSessionSwitcherOpen(false);
    onRequestClose?.();
    try {
      await openPiSessionFromNavigation({ directory: session.cwd, sessionId: session.id });
    } catch (error) {
      console.error('Failed to open Pi session:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [mobileVariant, onRequestClose, setSessionSwitcherOpen]);

  const handleCreate = React.useCallback(async (projectId: string | null) => {
    try {
      await startPiSessionDraftFromNavigation({ projectId });
      if (mobileVariant) setSessionSwitcherOpen(false);
      onRequestClose?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [mobileVariant, onRequestClose, setSessionSwitcherOpen]);

  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) setSessionSwitcherOpen(false);
    onRequestClose?.();
    setSettingsDialogOpen(true);
  }, [mobileVariant, onRequestClose, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const handleOpenProjectSettings = React.useCallback((projectId: string) => {
    setSettingsProjectsSelectedId(projectId);
    setSettingsPage('projects');
    if (mobileVariant) setSessionSwitcherOpen(false);
    onRequestClose?.();
    setSettingsDialogOpen(true);
  }, [
    mobileVariant,
    onRequestClose,
    setSessionSwitcherOpen,
    setSettingsDialogOpen,
    setSettingsPage,
    setSettingsProjectsSelectedId,
  ]);

  const canRevealProject = Boolean(files.revealPath)
    && (runtime.platform === 'vscode' || isDesktopLocalOriginActive());

  const handleRevealProject = React.useCallback(async (path: string) => {
    if (!files.revealPath) return;
    try {
      const result = await files.revealPath(path);
      if (!result.success) throw new Error('reveal-failed');
    } catch {
      toast.error(t('sessions.sidebar.project.reveal.error'));
    }
  }, [files, t]);

  const handleOpenMiniChat = React.useCallback((session: SessionSummary) => {
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
      directory: session.cwd,
      sessionId: session.id,
    }).catch((error) => {
      console.warn('[pi-session-sidebar] failed to open mini chat window', error);
    });
  }, []);

  const commitRename = React.useCallback(async (session: SessionSummary) => {
    if (editingId !== session.id) return;
    const nextName = editingName.trim();
    setEditingId(null);
    if (!nextName || nextName === piSessionTitle(session, untitled)) return;
    try {
      await renameSession(session.id, nextName);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [editingId, editingName, renameSession, untitled]);

  const runConfirmation = React.useCallback(async () => {
    if (!confirmation) return;
    setActionPending(true);
    try {
      if (confirmation.scope === 'project' && confirmation.action === 'remove') {
        removeProject(confirmation.projectId);
        toast.success(t('mobile.sessions.toast.projectRemoved', { label: confirmation.title }));
        setConfirmation(null);
        return;
      }

      const results = await Promise.allSettled(confirmation.ids.map((sessionId) => (
        confirmation.action === 'archive'
          ? archiveSession(sessionId)
          : deleteSession(sessionId)
      )));
      if (confirmation.scope === 'session' && confirmation.action === 'delete') {
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled' || result.value !== true) return;
          const sessionId = confirmation.ids[index];
          const summary = summaries.find((candidate) => candidate.id === sessionId);
          if (sessionId && summary) clearPinnedSession(runtimeKey, summary.cwd, sessionId);
        });
      }
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        toast.error(failed.length === 1
          ? (confirmation.action === 'archive'
              ? t('sessions.sidebar.session.archive.error')
              : t('sessions.sidebar.session.delete.error'))
          : t('sessions.sidebar.dialogs.deleteResult.tryAgain'));
      } else if (confirmation.scope === 'project') {
        toast.success(confirmation.ids.length === 1
          ? t('sessions.sidebar.bulkActions.archivedSingle', { count: 1 })
          : t('sessions.sidebar.bulkActions.archivedPlural', { count: confirmation.ids.length }));
      } else {
        toast.success(confirmation.action === 'archive'
          ? t('sessions.sidebar.session.archive.success')
          : t('sessions.sidebar.session.delete.success'));
      }
      setConfirmation(null);
    } finally {
      setActionPending(false);
    }
  }, [archiveSession, clearPinnedSession, confirmation, deleteSession, removeProject, runtimeKey, summaries, t]);

  const visibleCount = React.useMemo(() => {
    const countNodes = (nodes: PiSessionNode[]): number => nodes.reduce(
      (count, node) => count + 1 + countNodes(node.children),
      0,
    );
    return groups.reduce((count, group) => count + countNodes(group.forest), 0);
  }, [groups]);

  const confirmationCopy = (() => {
    if (!confirmation) {
      return { title: '', description: '', actionLabel: '' };
    }
    if (confirmation.scope === 'project' && confirmation.action === 'remove') {
      return {
        title: t('sessions.sidebar.dialogs.removeProject.title'),
        description: t('sessions.sidebar.dialogs.removeProject.description', {
          projectTitle: confirmation.title,
        }),
        actionLabel: t('sessions.sidebar.project.actions.remove'),
      };
    }
    if (confirmation.scope === 'project') {
      return {
        title: t('sessions.sidebar.dialogs.archiveSessions.title'),
        description: confirmation.ids.length === 1
          ? t('sessions.sidebar.dialogs.archiveSessions.singleDescription', { count: 1 })
          : t('sessions.sidebar.dialogs.archiveSessions.pluralDescription', {
              count: confirmation.ids.length,
            }),
        actionLabel: t('sessions.sidebar.bulkActions.archive'),
      };
    }
    if (confirmation.ids.length > 1) {
      const count = confirmation.ids.length - 1;
      return confirmation.action === 'archive'
        ? {
            title: t('sessions.sidebar.dialogs.archiveSession.title'),
            description: t(count === 1
              ? 'sessions.sidebar.dialogs.archiveSession.withOneSubtask'
              : 'sessions.sidebar.dialogs.archiveSession.withManySubtasks', {
              count,
              sessionTitle: confirmation.title,
            }),
            actionLabel: t('sessions.sidebar.bulkActions.archive'),
          }
        : {
            title: t('sessions.sidebar.dialogs.deleteSession.title'),
            description: t(count === 1
              ? 'sessions.sidebar.dialogs.deleteSession.withOneSubtask'
              : 'sessions.sidebar.dialogs.deleteSession.withManySubtasks', {
              count,
              sessionTitle: confirmation.title,
            }),
            actionLabel: t('sessions.sidebar.bulkActions.delete'),
          };
    }
    return confirmation.action === 'archive'
      ? {
          title: t('sessions.sidebar.dialogs.archiveSession.title'),
          description: t('sessions.sidebar.dialogs.archiveSession.single', {
            sessionTitle: confirmation.title || untitled,
          }),
          actionLabel: t('sessions.sidebar.bulkActions.archive'),
        }
      : {
          title: t('sessions.sidebar.dialogs.deleteSession.title'),
          description: t('sessions.sidebar.dialogs.deleteSession.single', {
            sessionTitle: confirmation.title || untitled,
          }),
          actionLabel: t('sessions.sidebar.bulkActions.delete'),
        };
  })();

  return (
    <TooltipProvider>
      <div
        className={cn(
          'flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground',
          !isVisible && 'pointer-events-none',
        )}
        aria-hidden={!isVisible}
      >
        <div className="flex shrink-0 items-center gap-1 px-2.5 pt-1.5">
          <button
            type="button"
            onClick={() => void handleCreate(null)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <Icon name="chat-new" className="size-4 shrink-0" />
            <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowArchived((current) => !current)}
                className={cn(
                  'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                  showArchived && 'bg-interactive-active text-foreground',
                )}
                aria-label={t('sessions.sidebar.nav.archive')}
              >
                <Icon name="archive" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sessions.sidebar.nav.archive')}</TooltipContent>
          </Tooltip>
          {!runtime.isVSCode ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => workspaceEvents.requestDirectoryDialog()}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  aria-label={t('sessions.sidebar.header.actions.addProject')}
                >
                  <Icon name="folder-add" className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('sessions.sidebar.header.actions.addProject')}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => void loadCatalog()}
                disabled={catalogLoading}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
                aria-label={t('sessions.sidebar.group.empty.retry')}
              >
                <Icon name="refresh" className={cn('size-4', catalogLoading && 'animate-spin')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sessions.sidebar.group.empty.retry')}</TooltipContent>
          </Tooltip>
        </div>

        <div className="shrink-0 px-2.5 py-2">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sessions.sidebar.header.search.placeholder')}
              className="h-8 pl-8 pr-8 typography-ui-label"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                aria-label={t('sessions.sidebar.header.search.clear')}
              >
                <Icon name="close" className="size-3.5" />
              </button>
            )}
          </div>
          {query && (
            <p className="mt-1 px-1 typography-micro text-muted-foreground">
              {visibleCount === 1
                ? t('sessions.sidebar.header.search.matchCountSingle', { count: visibleCount })
                : t('sessions.sidebar.header.search.matchCountPlural', { count: visibleCount })}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {catalogLoading && summaries.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-6 typography-ui-label text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('sessions.sidebar.group.empty.loadingSessions')}
            </div>
          ) : lastError && !catalogLoaded ? (
            <button
              type="button"
              onClick={() => void loadCatalog()}
              className="w-full rounded-md px-2 py-6 text-left typography-ui-label text-[var(--status-error)] hover:bg-[var(--status-error)]/5"
            >
              <span className="block">{t('sessions.sidebar.group.empty.loadFailed')}</span>
              <span className="mt-1 block typography-micro opacity-80">{lastError}</span>
            </button>
          ) : groups.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <p className="typography-ui-label text-foreground">
                {query
                  ? t('sessions.sidebar.empty.noMatches.title')
                  : showArchived
                    ? t('sessions.sidebar.group.empty.noArchivedSessions')
                    : t('sessions.sidebar.empty.noSessions.title')}
              </p>
              <p className="mt-1 typography-meta text-muted-foreground">
                {query
                  ? t('sessions.sidebar.empty.noMatches.description')
                  : showArchived
                    ? t('sessions.sidebar.grouping.archivedDescription')
                    : t('sessions.sidebar.empty.noSessions.description')}
              </p>
            </div>
          ) : (
            groups.map((group) => {
              const expanded = query.trim().length > 0 || !collapsedGroupIds.has(group.id);
              const sourceGroup = workspaceGroups.find((candidate) => candidate.id === group.id);
              const projectSessionIds = sourceGroup ? collectPiSessionForestIds(sourceGroup.forest) : [];
              const project = group.project;
              const projectIndex = project
                ? projects.findIndex((candidate) => candidate.id === project.id)
                : -1;
              const canManageProject = project !== null && !runtime.isVSCode;
              const groupHeaderContent = (
                <>
                  <button
                    type="button"
                    onClick={() => setCollapsedGroupIds((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })}
                    className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-expanded={expanded}
                    aria-label={t(expanded
                      ? 'sessions.sidebar.group.collapseAria'
                      : 'sessions.sidebar.group.expandAria', { label: group.label })}
                  >
                    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 opacity-70" />
                    <Icon
                      name={showArchived ? 'archive' : group.id === 'recent' ? 'history' : 'folder'}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">
                      {group.label}
                    </span>
                  </button>
                  <span className="shrink-0 typography-micro opacity-70">{group.forest.length}</span>
                  {!showArchived ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => void handleCreate(group.project?.id ?? null)}
                          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-70 hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 group-hover/workspace:opacity-100"
                          aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
                        >
                          <Icon name="add" className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </>
              );
              return (
                <section key={group.id} className="group/workspace mb-2">
                {project ? (
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={(
                        <div
                          className="flex min-w-0 select-none items-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground"
                          aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        />
                      )}
                    >
                      {groupHeaderContent}
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-52">
                      {canManageProject ? (
                        <>
                          <ContextMenuItem
                            disabled={projectIndex <= 0}
                            onClick={() => {
                              if (projectIndex > 0) reorderProjects(projectIndex, 0);
                            }}
                          >
                            <Icon name="pushpin" className="mr-2 size-4" />
                            {t('sessions.sidebar.project.actions.pin')}
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => handleOpenProjectSettings(project.id)}>
                            <Icon name="pencil-ai" className="mr-2 size-4" />
                            {t('sessions.sidebar.project.actions.edit')}
                          </ContextMenuItem>
                        </>
                      ) : null}
                      {canRevealProject ? (
                        <>
                          {canManageProject ? <ContextMenuSeparator /> : null}
                          <ContextMenuItem onClick={() => void handleRevealProject(project.path)}>
                            <Icon name="folder-open" className="mr-2 size-4" />
                            {t(getRevealLabelKey())}
                          </ContextMenuItem>
                        </>
                      ) : null}
                      {!showArchived ? (
                        <>
                          {(canManageProject || canRevealProject) ? <ContextMenuSeparator /> : null}
                          <ContextMenuItem
                            disabled={projectSessionIds.length === 0}
                            onClick={() => setConfirmation({
                              scope: 'project',
                              action: 'archive',
                              ids: projectSessionIds,
                              title: group.label,
                            })}
                          >
                            <Icon name="inbox-archive" className="mr-2 size-4" />
                            {t('sessions.sidebar.project.actions.archiveChats')}
                          </ContextMenuItem>
                        </>
                      ) : null}
                      {canManageProject ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => setConfirmation({
                              scope: 'project',
                              action: 'remove',
                              projectId: project.id,
                              title: group.label,
                            })}
                            className="text-destructive focus:text-destructive"
                          >
                            <Icon name="close" className="mr-2 size-4" />
                            {t('sessions.sidebar.project.actions.remove')}
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </ContextMenuContent>
                  </ContextMenu>
                ) : (
                  <div className="flex min-w-0 items-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground">
                    {groupHeaderContent}
                  </div>
                )}
                {expanded ? <div className="space-y-0.5 pl-2">
                  {group.forest.map((node) => (
                    <PiSessionRow
                      key={node.session.id}
                      node={node}
                      attentionBySession={attentionBySession}
                      currentSessionId={currentSessionId}
                      editingId={editingId}
                      editingName={editingName}
                      expandedIds={expandedIds}
                      pendingDialogCountBySession={pendingDialogCountBySession}
                      pinnedIds={pinnedIds}
                      untitled={untitled}
                      onSelect={(session) => void handleSelect(session)}
                      onToggleExpanded={(sessionId) => setExpandedIds((current) => {
                        const next = new Set(current);
                        if (next.has(sessionId)) next.delete(sessionId);
                        else next.add(sessionId);
                        return next;
                      })}
                      onBeginRename={(session) => {
                        setEditingId(session.id);
                        setEditingName(piSessionTitle(session, untitled));
                      }}
                      onCancelRename={() => setEditingId(null)}
                      onChangeEditingName={setEditingName}
                      onCommitRename={(session) => void commitRename(session)}
                      onCopyId={(session) => {
                        void copyTextToClipboard(session.id).then((result) => {
                          if (result.ok) toast.success(t('sessions.sidebar.session.menu.copied'));
                          else toast.error(result.error);
                        });
                      }}
                      onTogglePinned={(session) => togglePinned({
                        directory: session.cwd,
                        sessionId: session.id,
                      })}
                      onArchive={(selected) => setConfirmation({
                        scope: 'session',
                        action: 'archive',
                        ids: collectPiSessionSubtreeIds(summaries, selected.session.id),
                        title: piSessionTitle(selected.session, untitled),
                      })}
                      onDelete={(selected) => setConfirmation({
                        scope: 'session',
                        action: 'delete',
                        ids: collectPiSessionSubtreeIds(summaries, selected.session.id),
                        title: piSessionTitle(selected.session, untitled),
                      })}
                      onOpenMiniChat={handleOpenMiniChat}
                      onUnarchive={(session) => {
                        void unarchiveSession(session.id).then(() => {
                          toast.success(t('sessions.sidebar.session.unarchive.success'));
                        }).catch(() => {
                          toast.error(t('sessions.sidebar.session.unarchive.error'));
                        });
                      }}
                    />
                  ))}
                </div> : null}
                </section>
              );
            })
          )}
        </div>

        <div className="shrink-0 border-t border-border/60 px-2.5 py-2 pb-[max(0.5rem,var(--oc-safe-area-bottom-visual,0px))]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenSettings}
            className="w-full justify-start font-normal normal-case text-muted-foreground"
            aria-label={t('sessions.sidebar.footer.actions.settings')}
          >
            <Icon name="settings-3" className="size-4" />
            <span className="truncate">{t('sessions.sidebar.footer.actions.settings')}</span>
          </Button>
        </div>
      </div>

      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{confirmationCopy.title}</DialogTitle>
            <DialogDescription>{confirmationCopy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmation(null)}
              disabled={actionPending}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 disabled:opacity-50"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void runConfirmation()}
              disabled={actionPending}
              className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {actionPending && <Icon name="loader-4" className="size-3.5 animate-spin" />}
              {confirmationCopy.actionLabel}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
