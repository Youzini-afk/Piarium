import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import {
  isEmbeddedSessionChatReady,
  normalizeEmbeddedSessionDirectory,
  readEmbeddedSessionChatConfig,
  type EmbeddedSessionChatConfig,
} from '@/lib/embeddedSessionChat';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useMenuActions } from '@/hooks/useMenuActions';
import { useTraySync } from '@/hooks/useTraySync';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWebNotificationStream } from '@/hooks/useWebNotificationStream';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  canDismissInitialLoading,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { PiariumDiagnosticsDialog } from '@/components/ui/PiariumDiagnosticsDialog';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { subscribeDefaultDirectoryToRuntimeChanges } from '@/lib/directoryPersistence';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { isMobileAppRuntime, useMobileAppViewport } from '@/lib/mobileAppRuntime';
import { PiAppEffects } from '@/apps/PiAppEffects';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';
import { useWideChatLayoutClass } from '@/hooks/useWideChatLayoutClass';
import {
  openPiSessionFromNavigation,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { toast } from '@/components/ui';
import {
  WorkbenchProfileBridge,
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const setPiariumDiagnosticsDialogOpen = useUIStore((s) => s.setPiariumDiagnosticsDialogOpen);
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
      onOpenDiagnostics={() => setPiariumDiagnosticsDialogOpen(true)}
    />
  );
};

const RuntimeInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
        </div>
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const EmbeddedSessionChatContent: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig;
  embeddedBackgroundWorkEnabled: boolean;
}> = ({ embeddedSessionChat, embeddedBackgroundWorkEnabled }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const bootstrapKeyRef = React.useRef<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retryGeneration, retry] = React.useReducer((value: number) => value + 1, 0);

  const expectedDirectory = normalizeEmbeddedSessionDirectory(embeddedSessionChat.directory);

  React.useEffect(() => {
    const bootstrapKey = `${expectedDirectory}\n${embeddedSessionChat.sessionId}`;
    // Skip if this session was already bootstrapped and a session is still
    // active — allows in-place navigation (e.g. "Open subtask") to change
    // currentSessionId without this effect forcing it back. Only re-bootstrap
    // when currentSessionId was cleared (store init, draft, delete/archive,
    // runtime-switch remount).
    if (bootstrapKeyRef.current === bootstrapKey && currentSessionId) {
      return;
    }

    let cancelled = false;
    setLoadError(null);
    void openPiSessionFromNavigation({
      directory: embeddedSessionChat.directory,
      sessionId: embeddedSessionChat.sessionId,
    }).then(() => {
      if (!cancelled) bootstrapKeyRef.current = bootstrapKey;
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [
    currentSessionId,
    embeddedSessionChat.directory,
    embeddedSessionChat.sessionId,
    expectedDirectory,
    retryGeneration,
  ]);

  const isSessionReady = isEmbeddedSessionChatReady({
    embeddedSessionChat,
    currentSessionId,
    currentDirectory,
  });

  if (!isSessionReady) {
    if (loadError) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-md space-y-3">
            <p className="typography-body text-destructive">{loadError}</p>
            <Button type="button" variant="outline" onClick={retry}>Retry</Button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <>
      <PiAppEffects backgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <PiInteractionHost />
      <ChatView readOnly={embeddedSessionChat.readOnly} autoOpenDraft={false} />
      <Toaster />
    </>
  );
};

function App({ apis }: AppProps) {
  React.useEffect(() => {
    markStartupTrace('App:mounted');
    if (startupTraceEnabled()) {
      console.info('[startup-trace] enabled. Run console.table(window.__PIARIUM_STARTUP_TRACE__) after startup.');
    }
  }, []);

  const piCatalogLoaded = usePiSessionStore((state) => state.catalogLoaded);
  const piCatalogLoading = usePiSessionStore((state) => state.catalogLoading);
  const piRuntimeError = usePiSessionStore((state) => state.lastError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const enableMobileAppViewport = React.useMemo(() => isMobileAppRuntime(), []);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  useMobileAppViewport(enableMobileAppViewport);

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      resetAppForRuntimeEndpointChange(detail);
      appReadyDispatchedRef.current = false;
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
    });
  }, []);

  React.useEffect(() => {
    const state = usePiSessionStore.getState();
    if (state.catalogLoaded || state.catalogLoading) return;
    void state.loadCatalog().catch((catalogError) => {
      console.warn('[Piarium] failed to load the Pi session catalog:', catalogError);
    });
  }, [runtimeEndpointEpoch]);

  useWideChatLayoutClass(wideChatLayoutEnabled);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => subscribeDefaultDirectoryToRuntimeChanges(apis), [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, embeddedSessionChat, refreshGitHubAuthStatus]);

  useAppFontEffects();

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';
  const runtimeReady = piCatalogLoaded;

  // Splash dismissal: use the authoritative loading gate from desktopBoot.
  // Desktop shells strictly require a valid boot outcome before dismissing.
  // Non-main outcomes (chooser/recovery) can dismiss without waiting for init.
  React.useEffect(() => {
    if (!canDismissInitialLoading({
      isDesktopShell: isDesktopRuntime,
      runtimeReady,
      bootOutcomeKnown,
      bootViewIsMain,
    })) {
      return;
    }

    const timer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [isDesktopRuntime, runtimeReady, bootOutcomeKnown, bootViewIsMain]);

  // Deterministic malformed handling: update splash text so the user
  // sees a specific error instead of a generic spinner, but do NOT
  // dismiss the splash (that only happens on a valid outcome).
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.textContent = 'Desktop startup failed — please restart the app.';
    }
  }, [isDesktopRuntime, bootInjectionStatus]);

  // Non-desktop fallback: remove splash after 5 seconds even if init stalls.
  React.useEffect(() => {
    if (isDesktopRuntime) {
      return;
    }

    const fallbackTimer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement && !runtimeReady) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
  }, [isDesktopRuntime, runtimeReady]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      const nextVisible = payload?.visible === true;
      setIsEmbeddedVisible(nextVisible);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== 'piarium:embedded-visibility') {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __piariumSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__piariumSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__piariumSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__piariumSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory || isVSCodeRuntime) {
      return;
    }

    if (currentDirectory === embeddedSessionChat.directory) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, isVSCodeRuntime, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'ui-store') {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat || typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      void openPiSessionFromNavigation({ directory, sessionId }).catch((openError) => {
        toast.error('Failed to open Pi session', {
          description: openError instanceof Error ? openError.message : String(openError),
        });
      });
    };

    window.addEventListener('piarium:open-session', handler as EventListener);
    return () => window.removeEventListener('piarium:open-session', handler as EventListener);
  }, [embeddedSessionChat]);

  // Native tray/menu "new session" requests carry optional project and cwd
  // hints and open the Pi pending draft. Creation is deferred until first send.
  React.useEffect(() => {
    if (embeddedSessionChat || typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      void startPiSessionDraftFromNavigation({ directory, projectId }).catch((createError) => {
        toast.error('Failed to create Pi session', {
          description: createError instanceof Error ? createError.message : String(createError),
        });
      });
    };

    window.addEventListener('piarium:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('piarium:open-draft-session', handler as EventListener);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!runtimeReady || isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __piariumAppReady?: boolean }).__piariumAppReady = true;
    window.dispatchEvent(new Event('piarium:app-ready'));
  }, [runtimeReady, isSwitchingDirectory]);

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });
  usePwaInstallPrompt();

  useWindowTitle();

  useRouter({ enabled: !embeddedSessionChat && piCatalogLoaded });

  useMenuActions({ enabled: !embeddedSessionChat });

  useTraySync({ enabled: !embeddedSessionChat });

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__PIARIUM_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached - keep polling but show error
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement && !loadingElement.textContent?.includes('taking longer')) {
          loadingElement.textContent = 'Desktop startup is taking longer than expected...';
        }
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isDesktopShell: isDesktopShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return (
        <ErrorBoundary>
          <div className="h-full text-foreground bg-background">
            <React.Suspense fallback={<div className="h-full" />}>
              <OnboardingScreen
                mode="first-launch"
                localAvailable={bootView.localAvailable !== false}
                onRuntimeAvailable={handleDesktopBootDismiss}
              />
            </React.Suspense>
          </div>
        </ErrorBoundary>
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;

    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-background">
          <React.Suspense fallback={<div className="h-full" />}>
            <OnboardingScreen
              mode="recovery"
              recoveryVariant={recoveryVariant}
              recoveryHostUrl={hostUrl}
              recoveryHostLabel={undefined}
              localAvailable={bootView.localAvailable !== false}
              onRuntimeAvailable={handleDesktopBootDismiss}
            />
          </React.Suspense>
        </div>
      </ErrorBoundary>
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <EmbeddedSessionChatContent
                embeddedSessionChat={embeddedSessionChat}
                embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
              />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  if (!embeddedSessionChat && !piCatalogLoaded && piRuntimeError) {
    return (
      <ErrorBoundary>
        <RuntimeInitializationRecovery
          onRetry={() => { void usePiSessionStore.getState().loadCatalog(); }}
          isRetrying={piCatalogLoading}
        />
      </ErrorBoundary>
    );
  }

  const isBootShell = !piCatalogLoaded && !isDesktopRuntime;

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <FireworksProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
              <PiAppEffects backgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
              <WorkbenchProfileBridge />
              <WorkbenchReplacement
                target={WORKBENCH_REPLACEMENT_TARGETS.shell}
                fallback={<MainLayout />}
              />
              <Toaster />
              {!isBootShell && (
                <>
                  <ConfigUpdateOverlay />
                  <AboutDialogWrapper />
                  <PiariumDiagnosticsDialog />
                </>
              )}
            </div>
          </TooltipProvider>
        </FireworksProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}

export default App;
