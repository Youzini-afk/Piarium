import React from 'react';
import type { SessionSummary } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  selectActivePiSessions,
  type PiSessionAttentionState,
  usePiSessionStore,
} from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore, isSessionPinned } from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { buildPiSessionForest, piSessionTitle, type PiSessionNode } from './sessionPresentation';

interface PiSessionSwitcherDropdownProps {
  align?: 'start' | 'center' | 'end';
  children: React.ReactElement;
}

const SwitcherNode: React.FC<{
  attentionBySession: Readonly<Record<string, PiSessionAttentionState>>;
  busySessionIds: ReadonlySet<string>;
  currentSessionId: string | null;
  depth: number;
  node: PiSessionNode;
  onSelect(session: SessionSummary): void;
  untitled: string;
}> = ({ attentionBySession, busySessionIds, currentSessionId, depth, node, onSelect, untitled }) => {
  const { session } = node;
  const timestamp = Date.parse(session.updatedAt);
  const attention = attentionBySession[session.id];
  const icon = busySessionIds.has(session.id)
    ? <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" />
    : attention?.kind === 'error'
      ? <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
      : attention
        ? <Icon name="notification-3" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
        : <Icon name={depth > 0 ? 'ai-agent' : 'chat-4'} className="size-3.5 shrink-0 text-muted-foreground" />;
  return (
    <>
      <DropdownMenuItem
        onClick={() => onSelect(session)}
        className={cn('min-w-0 gap-2', currentSessionId === session.id && 'bg-interactive-active')}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate typography-ui-label text-foreground">
            {piSessionTitle(session, untitled)}
          </span>
          <span className="block truncate typography-micro text-muted-foreground">{session.cwd}</span>
        </span>
        <span className="shrink-0 typography-micro text-muted-foreground">
          {formatSessionCompactDateLabel(Number.isFinite(timestamp) ? timestamp : Date.now())}
        </span>
      </DropdownMenuItem>
      {node.children.map((child) => (
        <SwitcherNode
          key={child.session.id}
          attentionBySession={attentionBySession}
          busySessionIds={busySessionIds}
          currentSessionId={currentSessionId}
          depth={depth + 1}
          node={child}
          onSelect={onSelect}
          untitled={untitled}
        />
      ))}
    </>
  );
};

export const PiSessionSwitcherDropdown: React.FC<PiSessionSwitcherDropdownProps> = ({
  align = 'start',
  children,
}) => {
  const { t } = useI18n();
  const sessions = usePiSessionStore(selectActivePiSessions);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const attentionBySession = usePiSessionStore((state) => state.attentionBySession);
  const records = usePiSessionStore((state) => state.records);
  const openSession = usePiSessionStore((state) => state.openSession);
  const createSession = usePiSessionStore((state) => state.createSession);
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const untitled = t('sessions.sidebar.session.untitled');
  const forest = React.useMemo(() => buildPiSessionForest(
    sessions,
    (session) => isSessionPinned(pinnedIds, session.cwd, session.id),
  ), [pinnedIds, sessions]);
  const busySessionIds = React.useMemo(() => new Set(
    Object.values(records)
      .filter((record) => record.snapshot?.busy)
      .map((record) => record.sessionId),
  ), [records]);

  const select = React.useCallback(async (session: SessionSummary) => {
    try {
      const cwd = normalizePath(session.cwd);
      if (cwd) {
        const project = projects
          .map((candidate) => ({ candidate, path: normalizePath(candidate.path) }))
          .filter((entry): entry is { candidate: typeof projects[number]; path: string } => entry.path !== null)
          .filter((entry) => cwd === entry.path || cwd.startsWith(`${entry.path}/`))
          .sort((left, right) => right.path.length - left.path.length)[0]?.candidate;
        if (project && project.id !== activeProjectId) setActiveProjectIdOnly(project.id);
      }
      setDirectory(session.cwd, { showOverlay: false });
      await openSession({ sessionId: session.id });
      setActiveMainTab('chat');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [activeProjectId, openSession, projects, setActiveMainTab, setActiveProjectIdOnly, setDirectory]);

  const create = React.useCallback(async () => {
    const project = projects.find((candidate) => candidate.id === activeProjectId);
    const cwd = project?.path || currentDirectory;
    if (!cwd) return;
    try {
      setDirectory(cwd, { showOverlay: false });
      await createSession(cwd);
      setActiveMainTab('chat');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [activeProjectId, createSession, currentDirectory, projects, setActiveMainTab, setDirectory]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[min(70vh,42rem)] min-w-[22rem] overflow-y-auto">
        <DropdownMenuItem onClick={() => void create()}>
          <Icon name="chat-new" className="mr-2 size-4" />
          {t('sessions.sidebar.header.actions.newSession')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {forest.length === 0 ? (
          <DropdownMenuItem disabled>{t('sessions.sidebar.empty.noSessions.title')}</DropdownMenuItem>
        ) : forest.map((node) => (
          <SwitcherNode
            key={node.session.id}
            attentionBySession={attentionBySession}
            busySessionIds={busySessionIds}
            currentSessionId={currentSessionId}
            depth={0}
            node={node}
            onSelect={(session) => void select(session)}
            untitled={untitled}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
