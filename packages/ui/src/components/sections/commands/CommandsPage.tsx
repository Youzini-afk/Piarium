import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PiCommand = Awaited<ReturnType<typeof listPiCommands>>[number];

type CommandSource = 'extension' | 'prompt' | 'skill' | 'other';

const SOURCE_DETAILS: Readonly<Record<CommandSource, {
  description: string;
  label: string;
}>> = {
  extension: {
    label: 'Extension commands',
    description: 'Registered at runtime by the Pi extensions loaded for this workspace.',
  },
  prompt: {
    label: 'Prompt templates',
    description: 'Native .md prompt templates exposed as slash commands by Pi.',
  },
  skill: {
    label: 'Skills',
    description: 'Active Pi skills exposed with the /skill:name command form.',
  },
  other: {
    label: 'Other commands',
    description: 'Commands reported by the current Pi runtime without a standard source category.',
  },
};

const sourceOf = (command: PiCommand): CommandSource => {
  if (command.source === 'extension' || command.source === 'prompt' || command.source === 'skill') {
    return command.source;
  }
  return 'other';
};

const invocationOf = (command: PiCommand): string => (
  command.name.startsWith('/') ? command.name : `/${command.name}`
);

export const CommandsPage: React.FC = () => {
  const { t } = useI18n();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const [commands, setCommands] = React.useState<PiCommand[]>([]);
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listPiCommands(runtimeTarget);
      if (generation !== generationRef.current) return;
      setCommands(next.slice().sort((left, right) => (
        sourceOf(left).localeCompare(sourceOf(right))
        || left.name.localeCompare(right.name)
      )));
      setLoaded(true);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setCommands([]);
      setLoaded(false);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [runtimeTarget]);

  React.useEffect(() => {
    setCommands([]);
    setLoaded(false);
    void refresh();
  }, [refresh, targetKey]);

  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(normalized)
      || command.description?.toLocaleLowerCase().includes(normalized)
      || command.source?.toLocaleLowerCase().includes(normalized)
    ));
  }, [commands, query]);

  const groups = React.useMemo(() => {
    const result = new Map<CommandSource, PiCommand[]>();
    for (const command of filtered) {
      const source = sourceOf(command);
      const current = result.get(source) ?? [];
      current.push(command);
      result.set(source, current);
    }
    return (['extension', 'prompt', 'skill', 'other'] as const)
      .map((source) => ({ commands: result.get(source) ?? [], source }))
      .filter((group) => group.commands.length > 0);
  }, [filtered]);

  return (
    <SettingsPageLayout
      title={t('settings.page.commands.title')}
      description="The live slash-command catalog for the current Pi workspace or session. Commands are invoked from chat; plugin-owned behavior remains in the plugin."
      headerEnd={(
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      )}
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="commands.catalog"
        title="Available commands"
        description="Piarium reads this catalog from the active Pi runtime. Prompt templates and skills remain editable on their own pages."
        divider={false}
      >
        <div className="max-w-xl">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.view.search.placeholder')}
            aria-label={t('settings.view.search.aria')}
          />
        </div>

        {loadError ? (
          <div className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {loadError}
          </div>
        ) : null}

        {groups.length > 0 ? (
          <div className="mt-5 space-y-5">
            {groups.map((group) => {
              const details = SOURCE_DETAILS[group.source];
              return (
                <section key={group.source} className="space-y-2">
                  <div>
                    <h3 className="typography-ui-label font-medium text-foreground">{details.label}</h3>
                    <p className="mt-0.5 typography-meta text-muted-foreground">{details.description}</p>
                  </div>
                  <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
                    {group.commands.map((command) => (
                      <div
                        key={`${group.source}:${command.name}`}
                        className="min-w-0 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <code className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                            {invocationOf(command)}
                          </code>
                          <span className="shrink-0 rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
                            {group.source}
                          </span>
                        </div>
                        {command.description ? (
                          <p className="mt-2 typography-meta text-muted-foreground">{command.description}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : loaded ? (
          <div className="mt-5 rounded-xl border border-dashed border-border/70 p-5 text-center typography-meta text-muted-foreground">
            {t('chat.commandAutocomplete.empty')}
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center py-8 text-muted-foreground">
            <Icon name="loader-4" className="size-5 animate-spin" />
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
