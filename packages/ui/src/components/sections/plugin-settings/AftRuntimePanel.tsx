import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { getRuntimeKey } from '@piarium/application-client';
import { aftRuntimeState, observedAftStatusCommand } from './aft-runtime';

interface AftRuntimePanelProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

export const AftRuntimePanel: React.FC<AftRuntimePanelProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const [observed, setObserved] = React.useState(false);
  const [loading, setLoading] = React.useState(sessionId !== null);
  const [error, setError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    if (!sessionId) {
      setObserved(false);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const commands = await listPiCommands({ sessionId });
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setObserved(observedAftStatusCommand(commands));
    } catch (cause) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setObserved(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    setObserved(false);
    setError(null);
    setLoading(sessionId !== null);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [refresh, sessionId, targetKey]);

  const state = aftRuntimeState({
    commandsChecked: !loading && error === null,
    commandsFailed: error !== null,
    hasActiveSession: sessionId !== null,
    statusCommandObserved: observed,
  });

  return (
    <div className="space-y-4 border-t border-border/60 pt-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.aft.runtime.title')}
        info={t('settings.piarium.pluginSettings.aft.runtime.description')}
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="typography-meta text-muted-foreground">
            {t(`settings.piarium.pluginSettings.aft.runtime.state.${state}` as never)}
          </span>
          <Button type="button" variant="ghost" size="icon" disabled={loading || sessionId === null} onClick={() => void refresh()}>
            <Icon name="refresh" className={loading ? 'size-4 animate-spin' : 'size-4'} />
            <span className="sr-only">{t('settings.piarium.recovery.actions.refresh')}</span>
          </Button>
        </div>
        {state === 'failure' ? (
          <p className="break-words typography-meta text-[var(--status-error)]">{error}</p>
        ) : null}
        {state === 'not-observed' ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.aft.runtime.notObserved')}
          </p>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};
