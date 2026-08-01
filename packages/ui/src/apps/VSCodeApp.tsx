import React from 'react';
import { AgentManagerView } from '@/components/views/agent-manager';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { SyncProvider } from '@/sync/sync-context';
import { SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import { useWideChatLayoutClass } from '@/hooks/useWideChatLayoutClass';

const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));

type VSCodePanelType = 'chat' | 'agentManager' | 'settings';

declare global {
  interface Window {
    __OPENCHAMBER_PANEL_TYPE__?: VSCodePanelType;
  }
}

type VSCodeAppProps = {
  apis: RuntimeAPIs;
};

function useVSCodeConfigBootstrap(enabled: boolean) {
  const [connectionStatus, setConnectionStatus] = React.useState<'connecting' | 'connected' | 'error' | 'disconnected'>(
    () => (typeof window !== 'undefined'
      ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
        'connecting' | 'connected' | 'error' | 'disconnected' | undefined
      : 'connecting') || 'connecting'
  );
  const previousConnectionStatusRef = React.useRef(connectionStatus);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const current = (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
      'connecting' | 'connected' | 'error' | 'disconnected' | undefined;
    if (current === 'connected' || current === 'connecting' || current === 'error' || current === 'disconnected') {
      setConnectionStatus(current);
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string }>).detail;
      const status = detail?.status;
      if (status === 'connected' || status === 'connecting' || status === 'error' || status === 'disconnected') {
        setConnectionStatus(status);
      }
    };

    window.addEventListener('openchamber:connection-status', handler as EventListener);
    return () => window.removeEventListener('openchamber:connection-status', handler as EventListener);
  }, [enabled]);

  React.useEffect(() => {
    const previousConnectionStatus = previousConnectionStatusRef.current;
    previousConnectionStatusRef.current = connectionStatus;

    if (!enabled || connectionStatus !== 'connected') {
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    const shouldRefreshAfterReconnect = previousConnectionStatus !== 'connected';

    const hasCoreConfig = () => {
      const state = useConfigStore.getState();
      return state.isInitialized && state.isConnected && state.providers.length > 0 && state.agents.length > 0;
    };

    const scheduleRetry = () => {
      if (cancelled || attempts >= MAX_ATTEMPTS || hasCoreConfig()) {
        return;
      }
      const delayMs = Math.min(1000 + attempts * 250, 3000);
      retryTimer = window.setTimeout(() => {
        void run();
      }, delayMs);
    };

    const run = async () => {
      if (cancelled) {
        return;
      }

      if (hasCoreConfig()) {
        if (shouldRefreshAfterReconnect) {
          await refreshAfterOpenCodeRestart({
            scopes: ['providers', 'agents'],
            mode: 'active',
            settleAttempts: 6,
          });
        }
        return;
      }

      attempts += 1;
      try {
        await useConfigStore.getState().initializeApp();
      } catch {
        // Retry below; transient failures are expected while OpenCode is restarting.
      }

      scheduleRetry();
    };

    void run();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [connectionStatus, enabled]);
}

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const panelType = typeof window !== 'undefined'
    ? window.__OPENCHAMBER_PANEL_TYPE__
    : 'chat';
  const vscodeWorkspaceFolder = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    const configured = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } })
      .__VSCODE_CONFIG__?.workspaceFolder;
    return typeof configured === 'string' ? configured : '';
  }, []);
  const syncDirectory = currentDirectory || vscodeWorkspaceFolder || '';
  const initialSettingsPage = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const configured = (window as unknown as { __VSCODE_CONFIG__?: { initialSettingsPage?: unknown } })
      .__VSCODE_CONFIG__?.initialSettingsPage;
    return typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : null;
  }, []);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useVSCodeConfigBootstrap(panelType === 'settings' || panelType === 'agentManager');

  React.useEffect(() => {
    if (panelType !== 'settings' || !initialSettingsPage) {
      return;
    }
    setSettingsPage(initialSettingsPage);
  }, [initialSettingsPage, panelType, setSettingsPage]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();

  useWideChatLayoutClass(wideChatLayoutEnabled);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        planModeExperimentalEnabled?: unknown;
      };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      setPlanModeEnabled(enabled);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) {
      return;
    }

    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory={syncDirectory}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <AgentManagerView />
                <OpenCodeUpdateToast />
                <Toaster position="top-center" />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  if (panelType === 'settings') {
    return (
      <ErrorBoundary>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory={syncDirectory}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <React.Suspense fallback={null}>
                  <SettingsView
                    onClose={() => {
                      void apis.vscode?.executeCommand('openchamber.closeSettingsPanel');
                    }}
                    isWindowed
                  />
                </React.Suspense>
                <Toaster />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={syncDirectory}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <VSCodeLayout />
                <OpenCodeUpdateToast />
                <Toaster position="top-center" />
                <ConfigUpdateOverlay />
              </div>
            </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
