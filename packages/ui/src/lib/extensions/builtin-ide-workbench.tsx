import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  PIARIUM_WORKBENCH_SLOTS,
} from '@piarium/extension-contract';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { HelpDialog } from '@/components/ui/HelpDialog';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { SidebarFilesTree } from '@/components/layout/SidebarFilesTree';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { PiRecoveryPanel } from '@/components/layout/PiRecoveryPanel';
import { ChatView } from '@/components/views/ChatView';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { MultiRunLauncher } from '@/components/multirun';
import { WorkspaceOverlays } from '@/components/workspace/WorkspaceOverlays';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { invokeDesktop, isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { workbenchExtensionDisplayName } from './workbench-profile-label';
import {
  WorkbenchContributionSlot,
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
} from './workbench-registry';
import { usePiariumExtensionCatalog } from './catalog-store';
import { useWorkbenchWorkspaceId } from './workbench-workspace';
import {
  DEFAULT_IDE_WORKBENCH_LAYOUT,
  flushPersistedIdeWorkbenchLayout,
  IDE_LAYOUT_NODE_IDS,
  patchIdeWorkbenchLayout,
  projectIdeWorkbenchLayout,
  retryIdeWorkbenchLayout,
  updateIdeLayoutNode,
  type IdeWorkbenchActivityId,
  type IdeWorkbenchLayoutProjection,
  type IdeWorkbenchSecondaryId,
} from '@/lib/workbench/ide-layout';
import { useIdeWorkbenchLayout } from '@/lib/workbench/useIdeWorkbenchLayout';
import { showWorkbenchPanel } from '@/lib/workbench/editors/panels';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import type { FileSearchResult, WorkspaceContentSearchHit } from '@/lib/api/types';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import { IdeRunPanel } from '@/components/workbench/IdeRunPanel';
import { EditorWorkbenchArea } from '@/components/workbench/EditorWorkbenchArea';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';

const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((module) => ({ default: module.GitView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then((module) => ({ default: module.SettingsWindow })));
const FleetPage = lazyWithChunkRecovery(() => import('@/components/sections/fleet').then((module) => ({ default: module.FleetPage })));

type SearchMode = 'files' | 'content';

type FileSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: FileSearchResult[] }
  | { status: 'failure'; message: string };

type ContentSearchViewState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'empty' }
  | { status: 'ready'; hits: WorkspaceContentSearchHit[] }
  | { status: 'failure'; message: string };

const IdeSearchResults: React.FC<{
  mode: SearchMode;
  fileHits: FileSearchResult[];
  contentHits: WorkspaceContentSearchHit[];
  onOpenFile: (path: string) => void;
  onOpenContent: (hit: WorkspaceContentSearchHit) => void;
}> = ({ mode, fileHits, contentHits, onOpenFile, onOpenContent }) => {
  const parentRef = React.useRef<HTMLDivElement | null>(null);
  const count = mode === 'files' ? fileHits.length : contentHits.length;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => mode === 'files' ? 36 : 52,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className="h-full overflow-auto p-2">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const fileHit = mode === 'files' ? fileHits[row.index] : undefined;
          const contentHit = mode === 'content' ? contentHits[row.index] : undefined;
          return (
            <div
              key={fileHit?.path ?? (contentHit ? `${contentHit.resource.resourceId}:${contentHit.line}:${contentHit.column}` : row.key)}
              className="absolute left-0 top-0 w-full"
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              {fileHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-9 w-full justify-start truncate text-left" onClick={() => onOpenFile(fileHit.path)}>
                  {fileHit.path}
                </Button>
              ) : contentHit ? (
                <Button type="button" variant="ghost" size="sm" className="h-[52px] w-full justify-start text-left" onClick={() => onOpenContent(contentHit)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{contentHit.resource.resourceId}:{contentHit.line}</span>
                    <span className="truncate text-muted-foreground">{contentHit.preview}</span>
                  </span>
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ACTIVITIES: ReadonlyArray<{ id: IdeWorkbenchActivityId; icon: IconName; labelKey: I18nKey; ariaKey: I18nKey }> = [
  { id: 'explorer', icon: 'folder-3', labelKey: 'workbench.ide.activity.explorer', ariaKey: 'workbench.ide.activity.explorerAria' },
  { id: 'search', icon: 'search', labelKey: 'workbench.ide.activity.search', ariaKey: 'workbench.ide.activity.searchAria' },
  { id: 'git', icon: 'git-branch', labelKey: 'workbench.ide.activity.git', ariaKey: 'workbench.ide.activity.gitAria' },
  { id: 'run', icon: 'play', labelKey: 'workbench.ide.activity.run', ariaKey: 'workbench.ide.activity.runAria' },
  { id: 'extensions', icon: 'plug', labelKey: 'workbench.ide.activity.extensions', ariaKey: 'workbench.ide.activity.extensionsAria' },
];

const SECONDARY_VIEWS: ReadonlyArray<{ id: IdeWorkbenchSecondaryId; labelKey: I18nKey }> = [
  { id: 'agent', labelKey: 'workbench.ide.secondary.agent' },
  { id: 'context', labelKey: 'workbench.ide.secondary.context' },
  { id: 'fleet', labelKey: 'workbench.ide.secondary.fleet' },
  { id: 'recovery', labelKey: 'workbench.ide.secondary.recovery' },
];

const IdeSearchPanel: React.FC<{ directory: string | undefined }> = ({ directory }) => {
  const { t } = useI18n();
  const files = useRuntimeAPIs().files;
  const workspaceSearch = useRuntimeAPIs().workspaceSearch;
  const workspaceId = useWorkbenchWorkspaceId();
  const [mode, setMode] = React.useState<SearchMode>('files');
  const [query, setQuery] = React.useState('');
  const [fileState, setFileState] = React.useState<FileSearchViewState>({ status: 'idle' });
  const [contentState, setContentState] = React.useState<ContentSearchViewState>({ status: 'idle' });

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'files') return undefined;
    if (!directory || !normalized) {
      setFileState({ status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setFileState({ status: 'searching' });
      void files.search({ directory, query: normalized }, { signal: controller.signal })
        .then((hits) => {
          if (cancelled || controller.signal.aborted) return;
          setFileState(hits.length === 0 ? { status: 'empty' } : { status: 'ready', hits });
        })
        .catch((error) => {
          if (cancelled) return;
          setFileState({
            status: 'failure',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [directory, files, mode, query]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (mode !== 'content') return undefined;
    if (!directory || !workspaceId || !normalized) {
      setContentState({ status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setContentState({ status: 'searching' });
      void workspaceSearch.searchContent(
        { workspaceId, query: normalized },
        {
          signal: controller.signal,
          onBatch: (hits) => {
            if (cancelled || hits.length === 0) return;
            setContentState((current) => ({
              status: 'ready',
              hits: current.status === 'ready' ? [...current.hits, ...hits] : [...hits],
            }));
          },
        },
      ).then((result) => {
        if (cancelled) return;
        if (result.status === 'cancelled') return;
        if (result.status === 'failure') {
          setContentState({ status: 'failure', message: result.message });
          return;
        }
        if (result.status === 'empty') {
          setContentState({ status: 'empty' });
          return;
        }
        setContentState({ status: 'ready', hits: result.hits });
      }).catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setContentState({
          status: 'failure',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [directory, mode, query, workspaceId, workspaceSearch]);

  const openFileHit = (path: string) => {
    if (!directory || !workspaceId) return;
    const resourceId = resourceIdFromWorkspacePath(directory, path);
    if (resourceId) openWorkbenchEditor(workspaceId, resourceId);
  };

  const openContentHit = (hit: WorkspaceContentSearchHit) => {
    if (!directory || !workspaceId) return;
    openWorkbenchEditor(workspaceId, hit.resource.resourceId);
  };

  const activeState = mode === 'files' ? fileState : contentState;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 p-2">
        <div className="flex gap-1">
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'files'}
            onClick={() => setMode('files')}
          >
            {t('workbench.ide.search.filesTab')}
          </Button>
          <Button
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={mode === 'content'}
            onClick={() => setMode('content')}
          >
            {t('workbench.ide.search.contentTab')}
          </Button>
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t(mode === 'files' ? 'workbench.ide.search.placeholder' : 'workbench.ide.search.contentPlaceholder')}
          aria-label={t(mode === 'files' ? 'workbench.ide.search.filesAria' : 'workbench.ide.search.contentAria')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden typography-ui">
        {!directory || (mode === 'content' && !workspaceId) ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.noWorkspace' : 'workbench.ide.search.contentNoWorkspace')}
          </p>
        ) : activeState.status === 'searching' ? (
          <p className="p-2 text-muted-foreground">{t('workbench.ide.search.searching')}</p>
        ) : activeState.status === 'failure' ? (
          <p className="p-2 text-[color:var(--status-error)]">
            {t(mode === 'files' ? 'workbench.ide.search.failed' : 'workbench.ide.search.contentFailed', { message: activeState.message })}
          </p>
        ) : activeState.status === 'empty' ? (
          <p className="p-2 text-muted-foreground">
            {t(mode === 'files' ? 'workbench.ide.search.empty' : 'workbench.ide.search.contentEmpty')}
          </p>
        ) : (fileState.status === 'ready' && mode === 'files') || (contentState.status === 'ready' && mode === 'content') ? (
          <IdeSearchResults
            mode={mode}
            fileHits={fileState.status === 'ready' ? fileState.hits : []}
            contentHits={contentState.status === 'ready' ? contentState.hits : []}
            onOpenFile={openFileHit}
            onOpenContent={openContentHit}
          />
        ) : null}
      </div>
    </div>
  );
};

const IdeExtensionsPanel: React.FC = () => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const extensions = catalog.snapshot?.catalog.extensions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setSettingsPage('extensions');
            setSettingsDialogOpen(true);
          }}
        >
          {t('workbench.ide.extensions.openSettings')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 typography-ui">
        {extensions.length === 0 ? (
          <p className="text-muted-foreground">{t('workbench.ide.extensions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {extensions.map((entry) => (
              <li key={entry.manifest.id} className="truncate text-foreground">
                {workbenchExtensionDisplayName(entry, t)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export const IdeWorkbenchShell: React.FC<Record<string, unknown>> = () => {
  const { t } = useI18n();
  useUpdatePolling();
  const workspaceId = useWorkbenchWorkspaceId();
  const directory = useEffectiveDirectory();
  const projectActionsContext = useProjectActionsContext();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const branchLabel = useGitBranchLabel(directory || null);
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setCommandPaletteOpen = useUIStore((state) => state.setCommandPaletteOpen);
  const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
  const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
  const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
  const [settingsWindowMounted, setSettingsWindowMounted] = React.useState(isSettingsDialogOpen);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const layoutState = useIdeWorkbenchLayout(workspaceId);
  const layoutDocument = layoutState?.document ?? DEFAULT_IDE_WORKBENCH_LAYOUT;
  const layout = React.useMemo(() => projectIdeWorkbenchLayout(layoutDocument), [layoutDocument]);
  const mainAreaRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (isSettingsDialogOpen) setSettingsWindowMounted(true);
  }, [isSettingsDialogOpen]);

  React.useEffect(() => workspaceEvents.onDirectoryRequest(() => {
    setDirectoryDialogOpen(true);
  }), []);

  const patchLayout = React.useCallback((patch: Partial<Pick<
    IdeWorkbenchLayoutProjection,
    'activity' | 'primaryVisible' | 'secondaryView' | 'secondaryVisible'
  >>) => {
    if (!workspaceId) return;
    patchIdeWorkbenchLayout(workspaceId, (document) => {
      let next = document;
      const primary = next.nodes[IDE_LAYOUT_NODE_IDS.primary];
      if (primary?.kind === 'stack' && (patch.activity !== undefined || patch.primaryVisible !== undefined)) {
        next = updateIdeLayoutNode(next, {
          ...primary,
          ...(patch.activity !== undefined ? { activeViewId: patch.activity } : {}),
          ...(patch.primaryVisible !== undefined ? { visible: patch.primaryVisible } : {}),
        });
      }
      const secondary = next.nodes[IDE_LAYOUT_NODE_IDS.secondary];
      if (secondary?.kind === 'stack' && (patch.secondaryView !== undefined || patch.secondaryVisible !== undefined)) {
        next = updateIdeLayoutNode(next, {
          ...secondary,
          ...(patch.secondaryView !== undefined ? { activeViewId: patch.secondaryView } : {}),
          ...(patch.secondaryVisible !== undefined ? { visible: patch.secondaryVisible } : {}),
        });
      }
      return next;
    });
  }, [workspaceId]);

  const startResize = React.useCallback((side: 'primary' | 'secondary') => (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const size = mainAreaRef.current?.clientWidth ?? 0;
    const startWeights = layout.mainWeights;
    const onMove = (moveEvent: MouseEvent) => {
      if (!workspaceId || size <= 0) return;
      const delta = (moveEvent.clientX - startX) / size;
      patchIdeWorkbenchLayout(workspaceId, (document) => {
        const rootNode = document.nodes[IDE_LAYOUT_NODE_IDS.root];
        if (!rootNode || rootNode.kind !== 'split' || rootNode.weights.length !== 3) return document;
        const [primaryWeight, centerWeight, secondaryWeight] = startWeights;
        const weights = side === 'primary'
          ? [Math.max(0, primaryWeight + delta), Math.max(0, centerWeight - delta), secondaryWeight]
          : [primaryWeight, Math.max(0, centerWeight + delta), Math.max(0, secondaryWeight - delta)];
        if (weights.every((weight) => weight === 0)) return document;
        return updateIdeLayoutNode(document, { ...rootNode, weights });
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (workspaceId) void flushPersistedIdeWorkbenchLayout(workspaceId);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [layout.mainWeights, workspaceId]);

  const workspaceLabel = directory
    ? formatDirectoryName(directory, homeDirectory)
    : t('workbench.ide.status.noWorkspace');
  const showPrimarySidebar = layout.primaryVisible;

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  return (
    <DiffWorkerProvider>
      <div
        data-page-scroll-lock="true"
        className="flex h-[100dvh] min-h-0 flex-col bg-background"
      >
        <CommandPalette />
        <PiInteractionHost />
        <HelpDialog />
        <WorkspaceOverlays />
        <WorkbenchContributionSlot kind="panel" slot="workbench.overlay" />
        <DirectoryExplorerDialog
          open={directoryDialogOpen}
          onOpenChange={setDirectoryDialogOpen}
        />

        <header
          className="app-region-drag flex h-12 shrink-0 items-center gap-2 border-b border-border px-2"
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.button !== 0) return;
            if (target.closest('.app-region-no-drag')) return;
            if (target.closest('button, a, input, select, textarea')) return;
            if (isDesktopShell()) void startDesktopWindowDrag();
          }}
        >
          {usesFramelessChrome && windowControlsSide === 'left' ? (
            <WindowsWindowControls visible position="left" />
          ) : null}
          {usesFramelessChrome ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="app-region-no-drag"
              aria-label={t('header.actions.openAppMenuAria')}
              onClick={handleOpenWindowsAppMenu}
            >
              <Icon name="menu-2" className="size-4" />
            </Button>
          ) : null}
          {projectActionsContext ? (
            <div className="app-region-no-drag">
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
              />
            </div>
          ) : null}
          <div className="min-w-0 truncate typography-ui-label text-foreground">{workspaceLabel}</div>
          <div className="ml-auto flex app-region-no-drag items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('workbench.ide.commandPaletteAria')}
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  <Icon name="command" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workbench.ide.commandPalette')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('workbench.ide.settingsAria')}
                  onClick={() => setSettingsDialogOpen(true)}
                >
                  <Icon name="settings-3" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workbench.ide.settings')}</TooltipContent>
            </Tooltip>
            {usesFramelessChrome && windowControlsSide === 'right' ? (
              <WindowsWindowControls visible position="right" />
            ) : null}
          </div>
        </header>

        {layoutState?.errorMessage ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-1 typography-meta text-status-warning">
            <Icon name="error-warning" className="size-3.5" />
            <span className="min-w-0 truncate" title={layoutState.errorMessage}>{layoutState.errorMessage}</span>
            {workspaceId ? (
              <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => retryIdeWorkbenchLayout(workspaceId)}>
                {t('startup.initRecovery.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div ref={mainAreaRef} className="flex min-h-0 flex-1 overflow-hidden">
          {layout.activityVisible ? (
          <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-2" aria-label={t('workbench.ide.title')}>
            {ACTIVITIES.map((item) => (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t(item.ariaKey)}
                    aria-pressed={layout.activity === item.id && layout.primaryVisible}
                    className={cn(layout.activity === item.id && layout.primaryVisible && 'bg-[var(--interactive-selection)]')}
                    onClick={() => {
                      if (layout.activity === item.id) {
                        patchLayout({ primaryVisible: !layout.primaryVisible });
                        return;
                      }
                      patchLayout({ activity: item.id, primaryVisible: true });
                    }}
                  >
                    <Icon name={item.icon} className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
              </Tooltip>
            ))}
            <WorkbenchContributionSlot kind="view" slot={PIARIUM_WORKBENCH_SLOTS.activityItems} />
            <div className="mt-auto flex flex-col gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={layout.secondaryVisible ? t('workbench.ide.sidebar.hideSecondary') : t('workbench.ide.sidebar.showSecondary')}
                    aria-pressed={layout.secondaryVisible}
                    onClick={() => patchLayout({ secondaryVisible: !layout.secondaryVisible })}
                  >
                    <Icon name="robot-2" className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {layout.secondaryVisible ? t('workbench.ide.sidebar.hideSecondary') : t('workbench.ide.sidebar.showSecondary')}
                </TooltipContent>
              </Tooltip>
            </div>
          </nav>
          ) : null}

          {showPrimarySidebar ? (
            <>
              <aside
                className="flex min-h-0 min-w-0 flex-col border-r border-border bg-sidebar"
                style={{ flex: `${layout.mainWeights[0]} 1 0%` }}
              >
                <WorkbenchContributionSlot kind="view" slot={PIARIUM_WORKBENCH_SLOTS.primarySidebarViews} />
                {layout.activity === 'explorer' ? <SidebarFilesTree openTarget="editor" /> : null}
                {layout.activity === 'search' ? <IdeSearchPanel directory={directory} /> : null}
                {layout.activity === 'git' ? (
                  <React.Suspense fallback={null}>
                    <GitView isActive />
                  </React.Suspense>
                ) : null}
                {layout.activity === 'run' ? <IdeRunPanel /> : null}
                {layout.activity === 'extensions' ? <IdeExtensionsPanel /> : null}
              </aside>
              <div
                role="separator"
                aria-orientation="vertical"
                className="w-1 shrink-0 cursor-col-resize bg-border/40 hover:bg-interactive-hover"
                onMouseDown={startResize('primary')}
              />
            </>
          ) : null}

          <div
            className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
            style={{ flex: `${layout.mainWeights[1]} 1 0%` }}
          >
            <main className="relative min-h-0 flex-1 overflow-hidden">
              <EditorWorkbenchArea />
              {isMultiRunLauncherOpen ? (
                <div className="absolute inset-0 z-10 bg-background">
                  <ErrorBoundary>
                    <MultiRunLauncher
                      isWindowed
                      initialPrompt={multiRunLauncherPrefillPrompt}
                      onCreated={() => setMultiRunLauncherOpen(false)}
                      onCancel={() => setMultiRunLauncherOpen(false)}
                    />
                  </ErrorBoundary>
                </div>
              ) : null}
              <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
              <ErrorBoundary><ArchiveView /></ErrorBoundary>
              <ErrorBoundary><WorktreesView /></ErrorBoundary>
            </main>
          </div>

          {layout.secondaryVisible ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                className="w-1 shrink-0 cursor-col-resize bg-border/40 hover:bg-interactive-hover"
                onMouseDown={startResize('secondary')}
              />
              <aside
                className="flex min-h-0 min-w-0 flex-col border-l border-border bg-sidebar"
                style={{ flex: `${layout.mainWeights[2]} 1 0%` }}
              >
                <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-1 py-1">
                  {SECONDARY_VIEWS.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-pressed={layout.secondaryView === item.id}
                      className={cn(layout.secondaryView === item.id && 'bg-[var(--interactive-selection)]')}
                      onClick={() => patchLayout({ secondaryView: item.id })}
                    >
                      {t(item.labelKey)}
                    </Button>
                  ))}
                </div>
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <WorkbenchContributionSlot kind="view" slot={PIARIUM_WORKBENCH_SLOTS.secondarySidebarViews} />
                  <div className={cn('h-full min-h-0', layout.secondaryView !== 'agent' && 'hidden')}>
                    <ErrorBoundary>
                      <ChatView active={layout.secondaryView === 'agent'} showWorkStatus />
                    </ErrorBoundary>
                  </div>
                  {layout.secondaryView === 'context' ? (
                    <WorkbenchReplacement
                      target={WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer}
                      fallback={<ProjectContextPanel />}
                    />
                  ) : null}
                  {layout.secondaryView === 'fleet' ? (
                    <React.Suspense fallback={null}><FleetPage /></React.Suspense>
                  ) : null}
                  {layout.secondaryView === 'recovery' ? <PiRecoveryPanel /> : null}
                </div>
              </aside>
            </>
          ) : null}
        </div>

        {layout.statusVisible ? (
        <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border px-3 typography-micro text-muted-foreground">
          <span className="truncate">{workspaceLabel}</span>
          <span className="truncate">{branchLabel || t('workbench.ide.status.noBranch')}</span>
          {workspaceId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => showWorkbenchPanel(workspaceId, 'terminal')}
            >
              {t('workbench.panel.terminal')}
            </Button>
          ) : null}
          <WorkbenchContributionSlot kind="view" slot={PIARIUM_WORKBENCH_SLOTS.statusItems} />
        </footer>
        ) : null}

        {settingsWindowMounted ? (
          <WorkbenchReplacement
            target={WORKBENCH_REPLACEMENT_TARGETS.settings}
            fallback={(
              <React.Suspense fallback={null}>
                <SettingsWindow
                  open={isSettingsDialogOpen}
                  onOpenChange={setSettingsDialogOpen}
                />
              </React.Suspense>
            )}
          />
        ) : null}
      </div>
    </DiffWorkerProvider>
  );
};
