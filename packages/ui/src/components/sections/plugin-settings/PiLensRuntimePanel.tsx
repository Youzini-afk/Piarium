import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@piarium/application-client';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  buildPiLensRuntimeCommand,
  observedPiLensRuntimeCommands,
  PI_LENS_RUNTIME_COMMANDS,
  piLensRuntimeCommandName,
  piLensRuntimeState,
  type PiLensRuntimeCommandId,
} from './pi-lens-runtime';

interface PiLensRuntimePanelProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const PI_LENS_RUNTIME_COMMAND_LABEL_KEYS: Record<PiLensRuntimeCommandId, I18nKey> = {
  'lens-toggle': 'settings.piarium.pluginSettings.piLens.runtime.action.toggle',
  'lens-context-toggle': 'settings.piarium.pluginSettings.piLens.runtime.action.context',
  'lens-widget-toggle': 'settings.piarium.pluginSettings.piLens.runtime.action.widget',
  'lens-tdi': 'settings.piarium.pluginSettings.piLens.runtime.action.technicalDebt',
  'lens-map': 'settings.piarium.pluginSettings.piLens.runtime.action.projectMap',
  'lens-health': 'settings.piarium.pluginSettings.piLens.runtime.action.health',
  'lens-perf': 'settings.piarium.pluginSettings.piLens.runtime.action.performance',
  'lens-tools': 'settings.piarium.pluginSettings.piLens.runtime.action.tools',
};

export const PiLensRuntimePanel: React.FC<PiLensRuntimePanelProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const sessionBusy = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.snapshot?.busy === true : false
  ));
  const [commands, setCommands] = React.useState<ReadonlySet<PiLensRuntimeCommandId>>(new Set());
  const [loading, setLoading] = React.useState(sessionId !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState<PiLensRuntimeCommandId | null>(null);
  const generationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    if (!sessionId) {
      setCommands(new Set());
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listPiCommands({ sessionId });
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setCommands(observedPiLensRuntimeCommands(next));
    } catch (cause) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setCommands(new Set());
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    setCommands(new Set());
    setError(null);
    setLoading(sessionId !== null);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [refresh, sessionId, targetKey]);

  const state = piLensRuntimeState({
    commandsChecked: !loading && error === null,
    commandsFailed: error !== null,
    hasActiveSession: sessionId !== null,
    commandNames: commands,
  });

  const run = React.useCallback(async (command: PiLensRuntimeCommandId): Promise<void> => {
    if (!sessionId || sessionBusy || running !== null || !commands.has(command)) return;
    setRunning(command);
    try {
      await executeCommand(sessionId, buildPiLensRuntimeCommand(command));
    } catch (cause) {
      toast.error(t('settings.piarium.pluginSettings.piLens.runtime.commandFailed'), {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRunning(null);
    }
  }, [commands, executeCommand, running, sessionBusy, sessionId, t]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.piLens.runtime.title')}
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="typography-meta text-muted-foreground">
            {t(`settings.piarium.pluginSettings.piLens.runtime.state.${state}` as never)}
          </span>
          <Button type="button" variant="ghost" size="icon" disabled={loading || sessionId === null} onClick={() => void refresh()}>
            <Icon name="refresh" className={loading ? 'size-4 animate-spin' : 'size-4'} />
            <span className="sr-only">{t('settings.piarium.recovery.actions.refresh')}</span>
          </Button>
        </div>
        {state === 'failure' ? <p className="break-words typography-meta text-[var(--status-error)]">{error}</p> : null}
        {state === 'not-observed' ? (
          <p className="typography-meta text-muted-foreground">{t('settings.piarium.pluginSettings.piLens.runtime.notObserved')}</p>
        ) : null}
        {state === 'available' ? (
          <div className="flex flex-wrap gap-2">
            {PI_LENS_RUNTIME_COMMANDS.filter((command) => commands.has(command)).map((command) => (
              <Button
                key={command}
                type="button"
                variant="outline"
                size="sm"
                title={`/${piLensRuntimeCommandName(command)}`}
                disabled={sessionBusy || running !== null}
                onClick={() => void run(command)}
              >
                {running === command ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                {t(PI_LENS_RUNTIME_COMMAND_LABEL_KEYS[command])}
              </Button>
            ))}
          </div>
        ) : null}
        {sessionBusy && state === 'available' ? (
          <p className="typography-meta text-[var(--status-warning)]">{t('settings.piarium.pluginSettings.piLens.runtime.busy')}</p>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};
