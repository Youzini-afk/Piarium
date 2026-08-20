import React from 'react';
import { PiAppEffects } from './PiAppEffects';
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
import type { RuntimeAPIs } from '@/lib/api/types';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';

interface VSCodeAppProps {
  apis: RuntimeAPIs;
}

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  useAppFontEffects();
  useWindowTitle();
  useRouter();

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
