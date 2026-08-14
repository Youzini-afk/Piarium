import React from 'react';
import type { PiCommandDescriptor, RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

interface ContextModeSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const CONTEXT_MODE_COMMANDS = new Set(['ctx-stats', 'ctx-doctor']);

export const ContextModeSettings: React.FC<ContextModeSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const [commands, setCommands] = React.useState<PiCommandDescriptor[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setError(null);
    try {
      const next = await listPiCommands(runtimeTarget);
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setCommands(next.filter((command) => CONTEXT_MODE_COMMANDS.has(command.name.replace(/^\//, ''))));
    } catch (cause) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) setLoading(false);
    }
  }, [runtimeTarget]);

  React.useEffect(() => {
    setCommands([]);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [refresh, targetKey]);

  const run = async (name: string): Promise<void> => {
    if (!sessionId) return;
    setRunning(name);
    setError(null);
    try {
      await executeCommand(sessionId, `/${name.replace(/^\//, '')}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-3">
        <div className="min-w-0">
          <div className="typography-ui font-medium">
            {t('settings.piarium.pluginSettings.contextMode.runtime.title')}
          </div>
          <div className="mt-1 typography-meta text-muted-foreground">
            {loading
              ? t('settings.piarium.pluginSettings.status.runtime.checking')
              : commands.length > 0
                ? t('settings.piarium.pluginSettings.contextMode.runtime.available')
                : t('settings.piarium.pluginSettings.contextMode.runtime.unavailable')}
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" className={loading ? 'size-4 animate-spin' : 'size-4'} />
          <span className="sr-only">{t('settings.piarium.recovery.actions.refresh')}</span>
        </Button>
      </div>
      {commands.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {commands.map((command) => {
            const name = command.name.replace(/^\//, '');
            return (
              <Button
                key={name}
                type="button"
                variant="outline"
                size="sm"
                disabled={!sessionId || running !== null}
                onClick={() => void run(name)}
              >
                {running === name ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                /{name}
              </Button>
            );
          })}
        </div>
      ) : null}
      {!sessionId && commands.length > 0 ? (
        <div className="typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.contextMode.runtime.sessionRequired')}
        </div>
      ) : null}
      {error ? <div className="typography-meta text-[var(--status-error)]">{error}</div> : null}
    </div>
  );
};
