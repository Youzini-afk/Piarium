import React from 'react';
import { PiAppEffects } from './PiAppEffects';
import { AgentManagerView } from '@/components/views/agent-manager';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useAppFontEffects } from './useAppFontEffects';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useUIStore } from '@/stores/useUIStore';

const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then((module) => ({
  default: module.SettingsView,
})));

type VSCodePanelType = 'chat' | 'agentManager' | 'settings';

declare global {
  interface Window {
    __PIARIUM_PANEL_TYPE__?: VSCodePanelType;
  }
}

interface VSCodeAppProps {
  apis: RuntimeAPIs;
}

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const panelType = typeof window === 'undefined' ? 'chat' : window.__PIARIUM_PANEL_TYPE__ || 'chat';
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const initialSettingsPage = React.useMemo(() => {
    if (typeof window === 'undefined') return null;
    const configured = (window as typeof window & {
      __VSCODE_CONFIG__?: { initialSettingsPage?: unknown };
    }).__VSCODE_CONFIG__?.initialSettingsPage;
    return typeof configured === 'string' && configured.trim() ? configured.trim() : null;
  }, []);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (panelType === 'settings' && initialSettingsPage) setSettingsPage(initialSettingsPage);
  }, [initialSettingsPage, panelType, setSettingsPage]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  useAppFontEffects();
  useWindowTitle();
  useRouter();

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <AgentManagerView />
              <Toaster position="top-center" />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  if (panelType === 'settings') {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <PiInteractionHost />
              <React.Suspense fallback={null}>
                <SettingsView
                  isWindowed
                  onClose={() => {
                    void apis.vscode?.executeCommand('piarium.closeSettingsPanel');
                  }}
                />
              </React.Suspense>
              <Toaster position="top-center" />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <FireworksProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <PiAppEffects backgroundWorkEnabled />
              <PiInteractionHost />
              <VSCodeLayout />
              <Toaster position="top-center" />
            </div>
          </TooltipProvider>
        </FireworksProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}
