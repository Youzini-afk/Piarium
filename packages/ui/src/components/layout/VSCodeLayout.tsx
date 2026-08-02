import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { PiChatView } from '@/components/pi-session/PiChatView';
import { PiSessionSidebar } from '@/components/pi-session/PiSessionSidebar';
import { PiSessionSwitcherDropdown } from '@/components/pi-session/PiSessionSwitcherDropdown';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { piSessionTitle } from '@/components/pi-session/sessionPresentation';

const PiSettingsView = lazyWithChunkRecovery(() => import('@/components/views/PiSettingsView').then((module) => ({
  default: module.PiSettingsView,
})));

const EXPANDED_LAYOUT_THRESHOLD = 960;
const SETTINGS_MOBILE_THRESHOLD = 640;

type VSCodeView = 'sessions' | 'chat' | 'settings';

const readVSCodeConfig = () => (
  typeof window === 'undefined'
    ? undefined
    : (window as typeof window & {
        __VSCODE_CONFIG__?: {
          initialSessionId?: unknown;
          viewMode?: unknown;
          workspaceFolder?: unknown;
        };
      }).__VSCODE_CONFIG__
);

const useContainerWidth = (ref: React.RefObject<HTMLDivElement | null>): number => {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

interface VSCodeToolbarProps {
  onBack?: () => void;
  onNewSession?: () => void;
  onOpenAgentManager?: () => void;
  onOpenSettings?: () => void;
  sessionTitle?: string | null;
  title: string;
}

const VSCodeToolbar: React.FC<VSCodeToolbarProps> = ({
  onBack,
  onNewSession,
  onOpenAgentManager,
  onOpenSettings,
  sessionTitle,
  title,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-background px-2">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label={t('vscodeLayout.actions.backToSessionsAria')}
        >
          <Icon name="arrow-left" className="size-4" />
        </button>
      )}
      {sessionTitle ? (
        <PiSessionSwitcherDropdown>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-interactive-hover"
            aria-label={title}
          >
            <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
              {sessionTitle}
            </span>
            <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PiSessionSwitcherDropdown>
      ) : (
        <h1 className="min-w-0 flex-1 truncate px-2 typography-ui-label font-medium text-foreground">{title}</h1>
      )}
      {onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label={t('vscodeLayout.actions.newSessionAria')}
        >
          <Icon name="chat-new" className="size-4" />
        </button>
      )}
      {onOpenAgentManager && (
        <button
          type="button"
          onClick={onOpenAgentManager}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label={t('vscodeLayout.actions.openAgentManagerAria')}
        >
          <Icon name="robot-2" className="size-4" />
        </button>
      )}
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label={t('vscodeLayout.actions.settingsAria')}
        >
          <Icon name="settings-3" className="size-4" />
        </button>
      )}
    </div>
  );
};

export const VSCodeLayout: React.FC = () => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const viewMode = readVSCodeConfig()?.viewMode === 'editor' ? 'editor' : 'sidebar';
  const initialSessionId = React.useMemo(() => {
    const value = readVSCodeConfig()?.initialSessionId;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }, []);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const summaries = usePiSessionStore((state) => state.summaries);
  const currentRecord = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId] : undefined
  ));
  const loadCatalog = usePiSessionStore((state) => state.loadCatalog);
  const openSession = usePiSessionStore((state) => state.openSession);
  const createSession = usePiSessionStore((state) => state.createSession);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const bootstrappedEditor = React.useRef(false);
  const [currentView, setCurrentView] = React.useState<VSCodeView>('sessions');
  const viewBeforeSettings = React.useRef<VSCodeView>('sessions');

  const currentSummary = currentSessionId
    ? summaries.find((summary) => summary.id === currentSessionId)
    : undefined;
  const untitled = t('sessions.sidebar.session.untitled');
  const sessionTitle = currentSummary
    ? piSessionTitle(currentSummary, untitled)
    : currentRecord?.snapshot?.name?.trim() || (currentSessionId ? untitled : null);

  const resolveCwd = React.useCallback(() => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const configured = readVSCodeConfig()?.workspaceFolder;
    return activeProject?.path
      || currentDirectory
      || (typeof configured === 'string' ? configured.trim() : '');
  }, [activeProjectId, currentDirectory, projects]);

  const handleNewSession = React.useCallback(async () => {
    const cwd = resolveCwd();
    if (!cwd) {
      toast.error('Open a workspace folder before creating a Pi session.');
      return;
    }
    try {
      setDirectory(cwd, { showOverlay: false });
      await createSession(cwd);
      setCurrentView('chat');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [createSession, resolveCwd, setDirectory]);

  React.useEffect(() => {
    if (currentSessionId) setCurrentView('chat');
    else if (viewMode === 'sidebar' && currentView === 'chat') setCurrentView('sessions');
  }, [currentSessionId, currentView, viewMode]);

  React.useEffect(() => {
    if (viewMode !== 'editor' || bootstrappedEditor.current) return;
    bootstrappedEditor.current = true;
    void (async () => {
      try {
        await loadCatalog();
        if (initialSessionId) {
          await openSession({ sessionId: initialSessionId });
          return;
        }
        const cwd = resolveCwd();
        if (!cwd) throw new Error('Open a workspace folder before creating a Pi session.');
        setDirectory(cwd, { showOverlay: false });
        await createSession(cwd);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [createSession, initialSessionId, loadCatalog, openSession, resolveCwd, setDirectory, viewMode]);

  React.useEffect(() => {
    if (!runtimeApis.vscode) return;
    void runtimeApis.vscode.executeCommand('openchamber.setActiveSession', currentSessionId, sessionTitle);
    if (viewMode === 'editor' && currentSessionId && sessionTitle) {
      void runtimeApis.vscode.executeCommand('openchamber.updateSessionEditorTitle', currentSessionId, sessionTitle);
    }
  }, [currentSessionId, runtimeApis.vscode, sessionTitle, viewMode]);

  React.useEffect(() => {
    const handler = (event: Event) => {
      const view = (event as CustomEvent<{ view?: VSCodeView }>).detail?.view;
      if (!view) return;
      if (view === 'settings' && currentView !== 'settings') viewBeforeSettings.current = currentView;
      setCurrentView(view);
    };
    window.addEventListener('piarium:vscode:navigate', handler as EventListener);
    return () => window.removeEventListener('piarium:vscode:navigate', handler as EventListener);
  }, [currentView]);

  const openSettings = React.useCallback(() => {
    viewBeforeSettings.current = currentView;
    setCurrentView('settings');
  }, [currentView]);
  const openAgentManager = React.useCallback(() => {
    void runtimeApis.vscode?.openAgentManager();
  }, [runtimeApis.vscode]);
  const expanded = viewMode === 'sidebar' && width >= EXPANDED_LAYOUT_THRESHOLD;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      {viewMode === 'editor' ? (
        <ErrorBoundary>
          <PiChatView active />
        </ErrorBoundary>
      ) : currentView === 'settings' ? (
        <React.Suspense fallback={null}>
          <PiSettingsView
            forceMobile={width > 0 && width < SETTINGS_MOBILE_THRESHOLD}
            onClose={() => setCurrentView(viewBeforeSettings.current)}
          />
        </React.Suspense>
      ) : expanded ? (
        <div className="flex min-h-0 flex-1">
          <aside className="h-full w-72 shrink-0 border-r border-border/70">
            <PiSessionSidebar />
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            <VSCodeToolbar
              title={sessionTitle || t('vscodeLayout.title.chat')}
              sessionTitle={sessionTitle}
              onNewSession={() => void handleNewSession()}
              onOpenAgentManager={openAgentManager}
              onOpenSettings={openSettings}
            />
            <div className="min-h-0 flex-1">
              <ErrorBoundary><PiChatView active /></ErrorBoundary>
            </div>
          </section>
        </div>
      ) : currentView === 'sessions' ? (
        <>
          <VSCodeToolbar
            title={t('vscodeLayout.title.sessions')}
            onNewSession={() => void handleNewSession()}
            onOpenAgentManager={openAgentManager}
            onOpenSettings={openSettings}
          />
          <div className="min-h-0 flex-1">
            <PiSessionSidebar mobileVariant />
          </div>
        </>
      ) : (
        <>
          <VSCodeToolbar
            title={sessionTitle || t('vscodeLayout.title.chat')}
            sessionTitle={sessionTitle}
            onBack={() => setCurrentView('sessions')}
            onNewSession={() => void handleNewSession()}
            onOpenAgentManager={openAgentManager}
            onOpenSettings={openSettings}
          />
          <div className={cn('min-h-0 flex-1', !currentSessionId && 'bg-background')}>
            <ErrorBoundary><PiChatView active /></ErrorBoundary>
          </div>
        </>
      )}
    </div>
  );
};
