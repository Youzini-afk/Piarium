import React from 'react';
import type { JsonValue, PiSettingsSnapshot, RuntimeContextTarget } from '@piarium/protocol';
import { toast } from '@/components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

const TOOL_KEYS = [
  'bash',
  'grep',
  'get_output',
  'write_to_process',
  'kill_shell',
  'diagnostics',
  'apply_patch',
] as const;

const SHELL_OPTIONS = ['auto', 'git-bash', 'powershell', 'wsl'] as const;

interface HarnessSettings {
  tools?: Record<string, boolean>;
  shell?: string;
  output?: { visibleBytes?: number };
  bash?: { waitMs?: number };
}

function readHarnessSettings(snapshot: PiSettingsSnapshot | null): HarnessSettings {
  const global = (snapshot?.global ?? {}) as Record<string, unknown>;
  const harness = global.harness;
  if (typeof harness === 'object' && harness !== null && !Array.isArray(harness)) {
    return harness as HarnessSettings;
  }
  return {};
}

export const HarnessSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const runtimeTarget = React.useMemo<RuntimeContextTarget>(
    () => ({ cwd: currentDirectory }),
    [currentDirectory],
  );
  const [snapshot, setSnapshot] = React.useState<PiSettingsSnapshot | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void getPiSettings(runtimeTarget).then((result) => {
      if (cancelled) return;
      setSnapshot(result);
      setIsLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [runtimeTarget]);

  const harness = readHarnessSettings(snapshot);
  const tools = harness.tools ?? {};
  const shell = harness.shell ?? 'auto';
  const visibleBytes = harness.output?.visibleBytes ?? 32768;
  const bashWaitMs = harness.bash?.waitMs ?? 30000;

  const saveHarness = React.useCallback(async (newHarness: HarnessSettings) => {
    if (isSaving || !snapshot) return;
    const expectedRevision = snapshot.globalRevision;
    if (!expectedRevision) return;
    setIsSaving(true);
    setError(null);
    try {
      const next = await updatePiSettings(runtimeTarget, 'global', {
        remove: [],
        set: { harness: newHarness as unknown as JsonValue },
      }, expectedRevision);
      setSnapshot(next);
      toast.success(t('settings.common.status.saved'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(t('settings.common.status.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, runtimeTarget, snapshot, t]);

  const handleToolToggle = React.useCallback((toolKey: string, enabled: boolean) => {
    const newTools = { ...tools, [toolKey]: enabled };
    void saveHarness({ ...harness, tools: newTools });
  }, [harness, saveHarness, tools]);

  const handleShellChange = React.useCallback((value: string) => {
    void saveHarness({ ...harness, shell: value });
  }, [harness, saveHarness]);

  const handleVisibleBytesChange = React.useCallback((value: number) => {
    void saveHarness({ ...harness, output: { ...harness.output, visibleBytes: value } });
  }, [harness, saveHarness]);

  const handleBashWaitMsChange = React.useCallback((value: number) => {
    void saveHarness({ ...harness, bash: { ...harness.bash, waitMs: value } });
  }, [harness, saveHarness]);

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.page.harness.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('settings.page.harness.description')}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          {t('settings.page.harness.nextSession')}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tool toggles */}
      <SettingsSection
        title={t('settings.page.harness.section.tools')}
        description={t('settings.page.harness.section.tools.description')}
      >
        <div className="space-y-2">
          {TOOL_KEYS.map((toolKey) => (
            <SettingsCheckboxRow
              key={toolKey}
              checked={tools[toolKey] !== false}
              onChange={(checked) => handleToolToggle(toolKey, checked)}
              label={t(`settings.page.harness.tool.${toolKey}`)}
              description={t(`settings.page.harness.tool.${toolKey}.description`)}
            />
          ))}
        </div>
      </SettingsSection>

      {/* Shell selection */}
      <SettingsSection
        title={t('settings.page.harness.section.shell')}
        description={t('settings.page.harness.section.shell.description')}
      >
        <SettingsFieldRow
          label={t('settings.page.harness.shell.label')}
          description={t('settings.page.harness.shell.description')}
        >
          <Select value={shell} onValueChange={handleShellChange}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={SETTINGS_OPTION_STACK_CLASS}>
              {SHELL_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`settings.page.harness.shell.option.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </SettingsSection>

      {/* Output settings */}
      <SettingsSection
        title={t('settings.page.harness.section.output')}
        description={t('settings.page.harness.section.output.description')}
      >
        <SettingsFieldRow
          label={t('settings.page.harness.output.visibleBytes.label')}
          description={t('settings.page.harness.output.visibleBytes.description')}
        >
          <Select
            value={String(visibleBytes)}
            onValueChange={(v) => handleVisibleBytesChange(parseInt(v, 10))}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={SETTINGS_OPTION_STACK_CLASS}>
              <SelectItem value="8192">8 KB</SelectItem>
              <SelectItem value="16384">16 KB</SelectItem>
              <SelectItem value="32768">32 KB</SelectItem>
              <SelectItem value="65536">64 KB</SelectItem>
              <SelectItem value="131072">128 KB</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </SettingsSection>

      {/* Bash settings */}
      <SettingsSection
        title={t('settings.page.harness.section.bash')}
        description={t('settings.page.harness.section.bash.description')}
      >
        <SettingsFieldRow
          label={t('settings.page.harness.bash.waitMs.label')}
          description={t('settings.page.harness.bash.waitMs.description')}
        >
          <Select
            value={String(bashWaitMs)}
            onValueChange={(v) => handleBashWaitMsChange(parseInt(v, 10))}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={SETTINGS_OPTION_STACK_CLASS}>
              <SelectItem value="5000">5s</SelectItem>
              <SelectItem value="10000">10s</SelectItem>
              <SelectItem value="30000">30s</SelectItem>
              <SelectItem value="60000">60s</SelectItem>
              <SelectItem value="120000">120s</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
};
