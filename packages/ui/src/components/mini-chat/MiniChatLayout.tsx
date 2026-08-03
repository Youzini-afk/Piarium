import React from 'react';
import { Button } from '@/components/ui/button';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { PiChatView } from '@/components/pi-session/PiChatView';
import { PiSessionSwitcherDropdown } from '@/components/pi-session/PiSessionSwitcherDropdown';
import { piSessionTitle } from '@/components/pi-session/sessionPresentation';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel, useGitStore } from '@/stores/useGitStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

type MiniChatMode = 'session' | 'draft';

type MiniChatLayoutProps = {
  mode: MiniChatMode;
  autoOpenDraft?: boolean;
  unavailable?: boolean;
};

const normalizePath = (value: string | null | undefined): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
};

const compactPath = (value: string | null | undefined): string => {
  const path = normalizePath(value);
  if (!path) return '';
  const home = typeof window !== 'undefined' ? normalizePath(window.__PIARIUM_HOME__) : '';
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join('/')}`;
};

const MiniChatHeader: React.FC<{ mode: MiniChatMode }> = ({ mode }) => {
  const { t } = useI18n();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const record = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId] : undefined
  ));
  const summary = usePiSessionStore((state) => (
    state.currentSessionId
      ? state.summaries.find((candidate) => candidate.id === state.currentSessionId)
      : undefined
  ));
  const refreshStats = usePiSessionStore((state) => state.refreshStats);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const runtimeApis = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((state) => state.ensureStatus);
  const [pinned, setPinned] = React.useState(false);
  const macosMajor = typeof window !== 'undefined' ? window.__PIARIUM_MACOS_MAJOR__ ?? 0 : 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const macosHeaderSizeClass = hasMacTrafficLights
    ? macosMajor >= 26
      ? 'h-12'
      : macosMajor <= 15
        ? 'h-14'
        : ''
    : '';
  const snapshot = record?.snapshot;
  const openDirectory = normalizePath(snapshot?.cwd || summary?.cwd || currentDirectory);
  const directoryLabel = compactPath(openDirectory);
  const untitled = t('sessions.sidebar.session.untitled');
  const title = summary
    ? piSessionTitle(summary, untitled)
    : snapshot?.name?.trim()
      || (mode === 'draft' ? t('miniChat.header.newSession') : t('miniChat.header.session'));
  const project = React.useMemo(() => projects
    .map((candidate) => ({ candidate, path: normalizePath(candidate.path) }))
    .filter((entry) => entry.path && (entry.path === openDirectory || openDirectory.startsWith(`${entry.path}/`)))
    .sort((left, right) => right.path.length - left.path.length)[0]?.candidate ?? null, [openDirectory, projects]);
  const projectLabel = project?.label?.trim()
    || project?.path.split(/[\\/]/).filter(Boolean).at(-1)
    || directoryLabel
    || 'Piarium';
  const branchLabel = useGitBranchLabel(openDirectory || null);
  const stats = record?.stats;
  const contextLimit = snapshot?.model?.contextWindow ?? 0;
  const totalTokens = stats?.tokens.total ?? 0;
  const contextPercentage = contextLimit > 0 ? (totalTokens / contextLimit) * 100 : 0;
  const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  React.useEffect(() => {
    if (!isElectronShell()) return;
    void invokeDesktop<{ pinned?: boolean }>('desktop_get_window_pinned').then((result) => {
      if (typeof result?.pinned === 'boolean') setPinned(result.pinned);
    });
  }, []);

  React.useEffect(() => {
    if (!openDirectory) return;
    void ensureGitStatus(openDirectory, runtimeApis.git).catch(() => {});
  }, [ensureGitStatus, openDirectory, runtimeApis.git]);

  React.useEffect(() => {
    if (!currentSessionId || snapshot?.busy) return;
    void refreshStats(currentSessionId).catch(() => {});
  }, [currentSessionId, refreshStats, snapshot?.busy]);

  const handleTogglePinned = React.useCallback(() => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    void invokeDesktop('desktop_set_window_pinned', { pinned: nextPinned }).catch(() => {
      setPinned(!nextPinned);
    });
  }, [pinned]);

  const handleOpenMainApp = React.useCallback(() => {
    const payload = currentSessionId
      ? { sessionId: currentSessionId, directory: openDirectory }
      : { mode: 'draft', directory: openDirectory, projectId: project?.id ?? null };
    void invokeDesktop<{ focused?: boolean }>('desktop_focus_main_window', payload)
      .then((result) => result?.focused === true
        ? invokeDesktop('desktop_close_current_window')
        : null);
  }, [currentSessionId, openDirectory, project?.id]);

  return (
    <header
      className={cn(
        'flex items-center gap-3 bg-background pr-3',
        hasMacTrafficLights ? 'pl-[5.5rem]' : 'pl-3',
        usesFramelessChrome ? 'h-12' : macosHeaderSizeClass || 'min-h-14',
      )}
      style={dragRegionStyle}
    >
      {usesFramelessChrome && windowControlsSide === 'left' ? (
        <WindowsWindowControls visible position="left" />
      ) : null}
      <PiSessionSwitcherDropdown>
        <button
          type="button"
          aria-label={t('sessions.switcher.openAria')}
          style={noDragRegionStyle}
          className="flex min-w-0 max-w-full flex-col items-start rounded-md px-1 py-0.5 text-left transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:bg-interactive-hover/60"
        >
          <span className="max-w-full truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground">
            {title}
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
            <span className="truncate">{projectLabel}</span>
            {branchLabel && branchLabel !== 'HEAD' ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <Icon name="git-branch" className="size-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{branchLabel}</span>
              </span>
            ) : null}
          </span>
        </button>
      </PiSessionSwitcherDropdown>
      <div className="min-w-0 flex-1" />
      {totalTokens > 0 ? (
        <ContextUsageDisplay
          totalTokens={totalTokens}
          percentage={contextPercentage}
          colorPercentage={contextPercentage}
          contextLimit={contextLimit}
          outputLimit={snapshot?.model?.maxTokens ?? 0}
          className="h-9 shrink-0 pl-1 pr-1 typography-ui-label"
          valueClassName="font-semibold leading-none"
          hideIcon
          showPercentIcon
          percentIconClassName="h-4.5 w-4.5"
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleTogglePinned}
        aria-label={pinned ? t('miniChat.actions.unpinAria') : t('miniChat.actions.pinAria')}
        title={pinned ? t('miniChat.actions.unpin') : t('miniChat.actions.pin')}
        style={noDragRegionStyle}
      >
        <Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleOpenMainApp}
        aria-label={t('miniChat.actions.openMainAria')}
        title={t('miniChat.actions.openMain')}
        style={noDragRegionStyle}
      >
        <Icon name="external-link" className="size-4" />
      </Button>
      <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
    </header>
  );
};

export const MiniChatLayout: React.FC<MiniChatLayoutProps> = ({
  mode,
  autoOpenDraft = false,
  unavailable = false,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <MiniChatHeader mode={mode} />
      <main className="min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
            <div className="max-w-sm rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3">
              <div className="font-medium text-foreground">{t('miniChat.unavailable.title')}</div>
              <div className="mt-1 typography-small text-muted-foreground">{t('miniChat.unavailable.description')}</div>
            </div>
          </div>
        ) : (
          <PiChatView active autoOpenDraft={autoOpenDraft} showHeader={false} />
        )}
      </main>
    </div>
  );
};
