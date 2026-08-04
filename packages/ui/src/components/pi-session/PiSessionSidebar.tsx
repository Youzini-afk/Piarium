import React from 'react';
import type { SessionSummary } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { normalizePath } from '@/lib/pathNormalization';
import { startPiSessionDraftFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
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
import {
  buildPiSessionForest,
  collectPiSessionSubtreeIds,
  filterPiSessionForest,
  piSessionTitle,
  type PiSessionNode,
} from './sessionPresentation';

interface PiSessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
}

interface SessionGroup {
  forest: PiSessionNode[];
  id: string;
  label: string;
  path: string;
}

interface ConfirmationState {
  action: 'archive' | 'delete';
  ids: string[];
  title: string;
}

const isPathWithin = (path: string, root: string): boolean => {
  if (path === root) return true;
  const prefix = root === '/' ? '/' : `${root}/`;
  return path.startsWith(prefix);
};

const groupSessionForest = (
  forest: PiSessionNode[],
  projects: Array<{ id: string; label?: string | null; path: string }>,
): SessionGroup[] => {
  const normalizedProjects = projects
    .map((project) => ({ ...project, normalizedPath: normalizePath(project.path) }))
    .filter((project): project is typeof project & { normalizedPath: string } => (
      project.normalizedPath !== null
    ))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length);
  const groups = new Map<string, SessionGroup>();

  for (const node of forest) {
    const { session } = node;
    const cwd = normalizePath(session.cwd) ?? session.cwd;
    const project = normalizedProjects.find((candidate) => (
      isPathWithin(cwd, candidate.normalizedPath)
    ));
    const id = project ? `project:${project.id}` : `directory:${cwd}`;
    const existing = groups.get(id);
    if (existing) {
      existing.forest.push(node);
      continue;
    }
    groups.set(id, {
      forest: [node],
      id,
      label: project?.label?.trim()
        || formatDirectoryName(project?.normalizedPath ?? cwd, null)
        || project?.normalizedPath
        || cwd,
      path: project?.normalizedPath ?? cwd,
    });
  }

  const projectOrder = new Map(projects.map((project, index) => [`project:${project.id}`, index]));
  return [...groups.values()].sort((left, right) => {
    const leftOrder = projectOrder.get(left.id);
    const rightOrder = projectOrder.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
};

interface SessionRowProps {
  attentionBySession: Readonly<Record<string, PiSessionAttentionState>>;
  busySessionIds: ReadonlySet<string>;
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
  const isBusy = props.busySessionIds.has(session.id);
  const attention = props.attentionBySession[session.id];
  const archived = session.archivedAt !== undefined;
  const pendingRenameRef = React.useRef(false);

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
          <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" />
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
            <span className="shrink-0 typography-micro text-muted-foreground/70 group-hover/session:hidden">
              {timeLabel}
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
}) => {
  const { t } = useI18n();
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
  const openSession = usePiSessionStore((state) => state.openSession);
  const renameSession = usePiSessionStore((state) => state.renameSession);
  const archiveSession = usePiSessionStore((state) => state.archiveSession);
  const unarchiveSession = usePiSessionStore((state) => state.unarchiveSession);
  const deleteSession = usePiSessionStore((state) => state.deleteSession);
  const records = usePiSessionStore((state) => state.records);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const togglePinned = useSessionPinnedStore((state) => state.toggle);
  const clearPinnedSession = useSessionPinnedStore((state) => state.clearPinnedSession);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const [query, setQuery] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);
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

  const groups = React.useMemo(() => {
    const source = showArchived ? archivedSessions : activeSessions;
    const forest = buildPiSessionForest(source, isPinned);
    return groupSessionForest(forest, projects).map((group) => {
      return {
        ...group,
        forest: filterPiSessionForest(group.forest, query, untitled),
      };
    }).filter((group) => group.forest.length > 0);
  }, [activeSessions, archivedSessions, isPinned, projects, query, showArchived, untitled]);

  const busySessionIds = React.useMemo(() => new Set(
    Object.values(records)
      .filter((record) => record.snapshot?.busy)
      .map((record) => record.sessionId),
  ), [records]);

  const selectProjectForPath = React.useCallback((cwd: string) => {
    const normalizedCwd = normalizePath(cwd);
    if (!normalizedCwd) return;
    const project = projects
      .map((candidate) => ({ candidate, path: normalizePath(candidate.path) }))
      .filter((entry): entry is { candidate: typeof projects[number]; path: string } => entry.path !== null)
      .filter((entry) => isPathWithin(normalizedCwd, entry.path))
      .sort((left, right) => right.path.length - left.path.length)[0]?.candidate;
    if (project && project.id !== activeProjectId) setActiveProjectIdOnly(project.id);
  }, [activeProjectId, projects, setActiveProjectIdOnly]);

  const handleSelect = React.useCallback(async (session: SessionSummary) => {
    try {
      selectProjectForPath(session.cwd);
      setDirectory(session.cwd, { showOverlay: false });
      await openSession({ sessionId: session.id });
      setActiveMainTab('chat');
      if (mobileVariant) setSessionSwitcherOpen(false);
    } catch (error) {
      console.error('Failed to open Pi session:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [mobileVariant, openSession, selectProjectForPath, setActiveMainTab, setDirectory, setSessionSwitcherOpen]);

  const handleCreate = React.useCallback(async () => {
    try {
      await startPiSessionDraftFromNavigation({ projectId: activeProjectId });
      if (mobileVariant) setSessionSwitcherOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [activeProjectId, mobileVariant, setSessionSwitcherOpen]);

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
      const results = await Promise.allSettled(confirmation.ids.map((sessionId) => (
        confirmation.action === 'archive'
          ? archiveSession(sessionId)
          : deleteSession(sessionId)
      )));
      if (confirmation.action === 'delete') {
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
      } else {
        toast.success(confirmation.action === 'archive'
          ? t('sessions.sidebar.session.archive.success')
          : t('sessions.sidebar.session.delete.success'));
      }
      setConfirmation(null);
    } finally {
      setActionPending(false);
    }
  }, [archiveSession, clearPinnedSession, confirmation, deleteSession, runtimeKey, summaries, t]);

  const visibleCount = React.useMemo(() => {
    const countNodes = (nodes: PiSessionNode[]): number => nodes.reduce(
      (count, node) => count + 1 + countNodes(node.children),
      0,
    );
    return groups.reduce((count, group) => count + countNodes(group.forest), 0);
  }, [groups]);

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
            onClick={() => void handleCreate()}
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
            groups.map((group) => (
              <section key={group.id} className="mb-3">
                <div className="flex min-w-0 items-center gap-2 px-1.5 py-1.5 text-muted-foreground">
                  <Icon name={showArchived ? 'archive' : 'folder'} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate typography-micro font-medium uppercase tracking-wide">
                    {group.label}
                  </span>
                  <span className="typography-micro opacity-70">{group.forest.length}</span>
                </div>
                <div className="space-y-0.5">
                  {group.forest.map((node) => (
                    <PiSessionRow
                      key={node.session.id}
                      node={node}
                      attentionBySession={attentionBySession}
                      busySessionIds={busySessionIds}
                      currentSessionId={currentSessionId}
                      editingId={editingId}
                      editingName={editingName}
                      expandedIds={expandedIds}
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
                        action: 'archive',
                        ids: collectPiSessionSubtreeIds(summaries, selected.session.id),
                        title: piSessionTitle(selected.session, untitled),
                      })}
                      onDelete={(selected) => setConfirmation({
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
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === 'archive'
                ? t('sessions.sidebar.dialogs.archiveSession.title')
                : t('sessions.sidebar.dialogs.deleteSession.title')}
            </DialogTitle>
            <DialogDescription>
              {confirmation && confirmation.ids.length > 1
                ? confirmation.action === 'archive'
                  ? confirmation.ids.length === 2
                    ? t('sessions.sidebar.dialogs.archiveSession.withOneSubtask', {
                        count: 1,
                        sessionTitle: confirmation.title,
                      })
                    : t('sessions.sidebar.dialogs.archiveSession.withManySubtasks', {
                        count: confirmation.ids.length - 1,
                        sessionTitle: confirmation.title,
                      })
                  : confirmation.ids.length === 2
                    ? t('sessions.sidebar.dialogs.deleteSession.withOneSubtask', {
                        count: 1,
                        sessionTitle: confirmation.title,
                      })
                    : t('sessions.sidebar.dialogs.deleteSession.withManySubtasks', {
                        count: confirmation.ids.length - 1,
                        sessionTitle: confirmation.title,
                      })
                : confirmation?.action === 'archive'
                  ? t('sessions.sidebar.dialogs.archiveSession.single', {
                      sessionTitle: confirmation?.title ?? untitled,
                    })
                  : t('sessions.sidebar.dialogs.deleteSession.single', {
                      sessionTitle: confirmation?.title ?? untitled,
                    })}
            </DialogDescription>
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
              {confirmation?.action === 'archive'
                ? t('sessions.sidebar.bulkActions.archive')
                : t('sessions.sidebar.bulkActions.delete')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
