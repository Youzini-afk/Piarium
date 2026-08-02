import React from 'react';
import { Button } from '@/components/ui/button';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { LocalPiRuntimeCard } from './LocalPiRuntimeCard';

interface LocalSetupScreenProps {
  isFromRecovery?: boolean;
  onBack: () => void;
  onRuntimeAvailable?: () => void;
  onSwitchToRemote?: () => void;
}

export function LocalSetupScreen({
  onBack,
  onRuntimeAvailable,
  isFromRecovery = false,
  onSwitchToRemote,
}: LocalSetupScreenProps) {
  const { t } = useI18n();
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  const handleDragStart = React.useCallback(async (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (event.button !== 0) return;
    if (isDesktopApp) await startDesktopWindowDrag();
  }, [isDesktopApp]);

  return (
    <div
      className="relative flex h-full cursor-default select-none items-center justify-center bg-transparent p-8"
      onMouseDown={handleDragStart}
    >
      <div className="w-full max-w-lg space-y-6">
        <Button
          variant="ghost"
          onClick={onBack}
          className="p-0 text-muted-foreground hover:text-foreground"
        >
          {t('onboarding.common.actions.back')}
        </Button>

        <header className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {t('onboarding.localSetup.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('onboarding.localSetup.description')}
          </p>
        </header>

        <LocalPiRuntimeCard onContinue={() => onRuntimeAvailable?.()} />

        {isFromRecovery && onSwitchToRemote ? (
          <div className="pt-2 text-center">
            <p className="mb-2 text-sm text-muted-foreground">
              {t('onboarding.localSetup.remotePreference')}
            </p>
            <Button variant="link" onClick={onSwitchToRemote}>
              {t('onboarding.localSetup.actions.connectRemoteServer')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
