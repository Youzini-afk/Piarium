import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  buildRtkCommand,
  rtkCommandObserved,
  rtkRuntimeState,
  type RtkRuntimeAction,
} from './rtk-runtime';

interface RtkRuntimePanelProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const ACTIONS: readonly RtkRuntimeAction[] = ['show', 'verify', 'stats', 'clear-stats'];

export const RtkRuntimePanel: React.FC<RtkRuntimePanelProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const sessionBusy = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.snapshot?.busy === true : false
  ));
  const [commandObserved, setCommandObserved] = React.useState(false);
  const [loading, setLoading] = React.useState(sessionId !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [runningAction, setRunningAction] = React.useState<RtkRuntimeAction | null>(null);
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    if (!sessionId) {
      setCommandObserved(false);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const commands = await listPiCommands({ sessionId });
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setCommandObserved(rtkCommandObserved(commands));
    } catch (cause) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setCommandObserved(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [sessionId, targetKey]);

  React.useEffect(() => {
    setCommandObserved(false);
    setError(null);
    setLoading(sessionId !== null);
    setRunningAction(null);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [refresh, sessionId, targetKey]);

  const state = rtkRuntimeState({
    commandObserved,
    commandsChecked: !loading && error === null,
    commandsFailed: error !== null,
    hasActiveSession: sessionId !== null,
  });

  const runAction = React.useCallback(async (action: RtkRuntimeAction): Promise<void> => {
    if (!sessionId || sessionBusy || runningAction !== null || !commandObserved) return;
    const generation = generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setRunningAction(action);
    try {
      await executeCommand(sessionId, buildRtkCommand(action));
    } catch (cause) {
      if (
        generation === generationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) {
        toast.error(t('settings.piarium.pluginSettings.rtk.runtime.commandFailed'), {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setRunningAction(null);
    }
  }, [commandObserved, executeCommand, runningAction, sessionBusy, sessionId, t, targetKey]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.rtk.runtime.title')}
        info={t('settings.piarium.pluginSettings.rtk.runtime.description')}
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="typography-meta text-muted-foreground">
            {t(`settings.piarium.pluginSettings.rtk.runtime.state.${state}` as never)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={loading || sessionId === null}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" className={loading ? 'size-4 animate-spin' : 'size-4'} />
            <span className="sr-only">{t('settings.piarium.recovery.actions.refresh')}</span>
          </Button>
        </div>
        {state === 'failure' ? (
          <p className="break-words typography-meta text-[var(--status-error)]">{error}</p>
        ) : null}
        {state === 'not-observed' ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.rtk.runtime.notObserved')}
          </p>
        ) : null}
        {state === 'available' ? (
          <div className="flex flex-wrap gap-2">
            {ACTIONS.map((action) => (
              <Button
                key={action}
                type="button"
                variant="outline"
                size="sm"
                title={buildRtkCommand(action)}
                disabled={sessionBusy || runningAction !== null}
                onClick={() => void runAction(action)}
              >
                {runningAction === action ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                {t(`settings.piarium.pluginSettings.rtk.runtime.action.${action}` as never)}
              </Button>
            ))}
          </div>
        ) : null}
        {sessionBusy && state === 'available' ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.piarium.pluginSettings.rtk.runtime.busy')}
          </p>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};
