import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { MiniChatLayout } from '@/components/mini-chat/MiniChatLayout';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAppFontEffects } from './useAppFontEffects';
import { useMiniChatKeyboardShortcuts } from '@/hooks/useMiniChatKeyboardShortcuts';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type MiniChatMode = 'session' | 'draft';

type MiniChatConfig = {
  mode: MiniChatMode;
  sessionId: string | null;
  directory: string | null;
  projectId: string | null;
};

type ElectronMiniChatAppProps = {
  apis: RuntimeAPIs;
};

const readMiniChatConfig = (): MiniChatConfig => {
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const mode = params.get('mode') === 'session' ? 'session' : 'draft';
  return {
    mode,
    sessionId: params.get('sessionId')?.trim() || null,
    directory: params.get('directory')?.trim() || null,
    projectId: params.get('projectId')?.trim() || null,
  };
};

const MiniChatBootstrap: React.FC<{
  config: MiniChatConfig;
  onReady(): void;
  onUnavailable(value: boolean): void;
}> = ({ config, onReady, onUnavailable }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const createSession = usePiSessionStore((state) => state.createSession);
  const loadCatalog = usePiSessionStore((state) => state.loadCatalog);
  const openSession = usePiSessionStore((state) => state.openSession);
  const bootstrappedRef = React.useRef(false);

  React.useEffect(() => {
    const project = config.projectId
      ? projects.find((candidate) => candidate.id === config.projectId)
      : null;
    if (config.projectId && !config.directory && !project && !currentDirectory) return;
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const bootstrap = async () => {
      const cwd = config.directory || project?.path || currentDirectory;
      if (project) setActiveProjectIdOnly(project.id);
      if (cwd) setDirectory(cwd, { showOverlay: false });
      try {
        if (config.mode === 'session' && config.sessionId) {
          await openSession({
            sessionId: config.sessionId,
            ...(cwd ? { cwd } : {}),
          });
        } else if (cwd) {
          await createSession(cwd);
        }
        if (cwd) await loadCatalog(cwd).catch(() => undefined);
        onUnavailable(false);
        onReady();
      } catch (error) {
        console.error('Failed to bootstrap Pi mini chat:', error);
        onUnavailable(true);
        onReady();
      }
    };
    void bootstrap();
  }, [config, createSession, currentDirectory, loadCatalog, onReady, onUnavailable, openSession, projects, setActiveProjectIdOnly, setDirectory]);

  React.useEffect(() => {
    const onOpenSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId || usePiSessionStore.getState().currentSessionId === sessionId) return;
      const directory = typeof detail?.directory === 'string' ? detail.directory.trim() : '';
      if (directory) setDirectory(directory, { showOverlay: false });
      onUnavailable(false);
      void openSession({ sessionId, ...(directory ? { cwd: directory } : {}) })
        .then(() => onReady())
        .catch((error) => {
          console.error('Failed to switch Pi mini chat session:', error);
          onUnavailable(true);
        });
    };
    window.addEventListener('openchamber:open-session', onOpenSession);
    return () => window.removeEventListener('openchamber:open-session', onOpenSession);
  }, [onReady, onUnavailable, openSession, setDirectory]);

  React.useEffect(() => {
    if (!currentSessionId) return;
    const snapshot = usePiSessionStore.getState().records[currentSessionId]?.snapshot;
    if (snapshot?.cwd && snapshot.cwd !== currentDirectory) {
      setDirectory(snapshot.cwd, { showOverlay: false });
    }
  }, [currentDirectory, currentSessionId, setDirectory]);

  return null;
};

const MiniChatPresencePublisher: React.FC = () => {
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const directory = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId]?.snapshot?.cwd ?? null : null
  ));

  React.useEffect(() => {
    if (!currentSessionId || !directory || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    const isViewed = () => (
      document.visibilityState === 'visible'
      && typeof document.hasFocus === 'function'
      && document.hasFocus()
    );
    const postPresence = (viewed: boolean) => {
      channel.postMessage({
        type: 'mini-chat-session-presence',
        sessionId: currentSessionId,
        directory,
        viewed,
      });
    };
    const postCurrentPresence = () => postPresence(isViewed());
    postCurrentPresence();
    const interval = window.setInterval(postCurrentPresence, 5_000);
    window.addEventListener('focus', postCurrentPresence);
    window.addEventListener('blur', postCurrentPresence);
    document.addEventListener('visibilitychange', postCurrentPresence);
    const handleBeforeUnload = () => postPresence(false);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', postCurrentPresence);
      window.removeEventListener('blur', postCurrentPresence);
      document.removeEventListener('visibilitychange', postCurrentPresence);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      postPresence(false);
      channel.close();
    };
  }, [currentSessionId, directory]);

  return null;
};

export function ElectronMiniChatApp({ apis }: ElectronMiniChatAppProps) {
  const config = React.useMemo(() => readMiniChatConfig(), []);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useAppFontEffects();
  useMiniChatKeyboardShortcuts();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <TooltipProvider delayDuration={300} skipDelayDuration={150}>
          <div className="h-full bg-background text-foreground">
            <ElectronMiniChatContent config={config} />
            <PiInteractionHost />
            <Toaster />
          </div>
        </TooltipProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}

const ElectronMiniChatContent: React.FC<{ config: MiniChatConfig }> = ({ config }) => {
  const [ready, setReady] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const splashDismissedRef = React.useRef(false);
  const markReady = React.useCallback(() => setReady(true), []);
  const markUnavailable = React.useCallback((value: boolean) => setUnavailable(value), []);

  React.useEffect(() => {
    if (!ready || splashDismissedRef.current) return;
    splashDismissedRef.current = true;
    const element = document.getElementById('initial-loading');
    if (!element) return;
    element.classList.add('fade-out');
    const timer = window.setTimeout(() => element.remove(), 300);
    return () => window.clearTimeout(timer);
  }, [ready]);

  return (
    <>
      <MiniChatBootstrap
        config={config}
        onReady={markReady}
        onUnavailable={markUnavailable}
      />
      <MiniChatPresencePublisher />
      <MiniChatLayout
        mode={config.mode}
        autoOpenDraft={config.mode === 'draft'}
        unavailable={unavailable}
      />
    </>
  );
};
