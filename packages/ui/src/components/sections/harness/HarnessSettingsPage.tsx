import React from 'react';
import {
  DEFAULT_HARNESS_SETTINGS,
  validatePermissionRule,
  type JsonValue,
  type HarnessWebSearchProvider,
  type PermissionMode,
  type PermissionRule,
  type PiSettingsSnapshot,
  type RuntimeContextTarget,
} from '@piarium/protocol';
import { runtimeFetch } from '@piarium/application-client';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
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
const SEARCH_PROVIDERS = ['brave', 'exa', 'tavily', 'jina', 'searxng'] as const satisfies readonly HarnessWebSearchProvider[];

interface HarnessSettings {
  tools?: Partial<Record<string, boolean>>;
  shell?: string;
  output?: { visibleBytes?: number };
  bash?: { waitMs?: number };
  models?: Record<string, { providerId: string; modelId: string }>;
  memory?: { shadowMode?: boolean };
  web?: {
    maxFetchesPerTurn?: number;
    render?: boolean;
    search?: { provider: HarnessWebSearchProvider; endpoint?: string; credentialRef?: string };
  };
  permissions?: { mode?: PermissionMode; rules?: PermissionRule[] };
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
  const [rulesDraft, setRulesDraft] = React.useState('[]');
  const [rulesIssue, setRulesIssue] = React.useState<string | null>(null);
  const [searchProvider, setSearchProvider] = React.useState<HarnessWebSearchProvider | 'none'>('none');
  const [searchEndpoint, setSearchEndpoint] = React.useState('');
  const [searchApiKey, setSearchApiKey] = React.useState('');
  const [searchCredentialConfigured, setSearchCredentialConfigured] = React.useState(false);
  const [searchStatusLoading, setSearchStatusLoading] = React.useState(false);

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
  const tools = React.useMemo(() => harness.tools ?? DEFAULT_HARNESS_SETTINGS.tools, [harness.tools]);
  const shell = harness.shell ?? DEFAULT_HARNESS_SETTINGS.shell;
  const visibleBytes = harness.output?.visibleBytes ?? DEFAULT_HARNESS_SETTINGS.output.visibleBytes;
  const bashWaitMs = harness.bash?.waitMs ?? DEFAULT_HARNESS_SETTINGS.bash.waitMs;
  const permissionMode = harness.permissions?.mode ?? DEFAULT_HARNESS_SETTINGS.permissions?.mode ?? 'normal';
  const smartAvailable = Boolean(harness.models?.permissionJudge);
  const memoryShadowMode = harness.memory?.shadowMode ?? DEFAULT_HARNESS_SETTINGS.memory.shadowMode;

  React.useEffect(() => {
    setRulesDraft(JSON.stringify(harness.permissions?.rules ?? [], null, 2));
    setRulesIssue(null);
  }, [harness.permissions?.rules, snapshot?.globalRevision]);

  React.useEffect(() => {
    setSearchProvider(harness.web?.search?.provider ?? 'none');
    setSearchEndpoint(harness.web?.search?.endpoint ?? '');
    setSearchApiKey('');
  }, [harness.web?.search?.endpoint, harness.web?.search?.provider, snapshot?.globalRevision]);

  React.useEffect(() => {
    if (searchProvider === 'none') {
      setSearchCredentialConfigured(false);
      setSearchStatusLoading(false);
      return;
    }
    const controller = new AbortController();
    setSearchStatusLoading(true);
    void runtimeFetch(`/api/harness/web-search/credentials/${searchProvider}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Unable to read search credential status (${response.status})`);
      const value = await response.json() as { configured?: unknown };
      if (!controller.signal.aborted) setSearchCredentialConfigured(value.configured === true);
    }).catch((statusError) => {
      if (!controller.signal.aborted) {
        setSearchCredentialConfigured(false);
        setError(statusError instanceof Error ? statusError.message : String(statusError));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setSearchStatusLoading(false);
    });
    return () => controller.abort();
  }, [searchProvider]);

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

  const handlePermissionModeChange = React.useCallback((value: string) => {
    if (value === 'smart' && !smartAvailable) return;
    void saveHarness({
      ...harness,
      permissions: { ...harness.permissions, mode: value as PermissionMode },
    });
  }, [harness, saveHarness, smartAvailable]);

  const handlePermissionRulesSave = React.useCallback(() => {
    try {
      const parsed = JSON.parse(rulesDraft) as unknown;
      if (!Array.isArray(parsed)) throw new Error(t('settings.page.harness.permissions.rules.arrayError'));
      const rules = parsed.map((rule, index) => validatePermissionRule(
        rule as PermissionRule,
        `permission[${index}]`,
      ));
      setRulesIssue(null);
      void saveHarness({
        ...harness,
        permissions: { ...harness.permissions, rules },
      });
    } catch (ruleError) {
      setRulesIssue(ruleError instanceof Error ? ruleError.message : String(ruleError));
    }
  }, [harness, rulesDraft, saveHarness, t]);

  const handleMemoryShadowChange = React.useCallback((enabled: boolean) => {
    void saveHarness({
      ...harness,
      memory: { ...harness.memory, shadowMode: enabled },
    });
  }, [harness, saveHarness]);

  const handleSearchSave = React.useCallback(async () => {
    if (searchProvider === 'none') {
      const web = { ...harness.web };
      delete web.search;
      const next = { ...harness };
      if (Object.keys(web).length > 0) next.web = web;
      else delete next.web;
      await saveHarness(next);
      return;
    }
    if (searchProvider === 'searxng' && !searchEndpoint.trim()) {
      setError(t('settings.page.harness.web.search.endpointRequired'));
      return;
    }
    if (searchProvider !== 'searxng' && !searchCredentialConfigured && !searchApiKey.trim()) {
      setError(t('settings.page.harness.web.search.apiKeyRequired'));
      return;
    }
    const credentialRef = `piarium-web-search-${searchProvider}`;
    if (searchApiKey.trim()) {
      const response = await runtimeFetch(`/api/harness/web-search/credentials/${searchProvider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: searchApiKey.trim() }),
      });
      if (!response.ok) throw new Error(`Unable to save search credential (${response.status})`);
      setSearchCredentialConfigured(true);
      setSearchApiKey('');
    }
    await saveHarness({
      ...harness,
      web: {
        ...harness.web,
        search: {
          provider: searchProvider,
          ...(searchProvider === 'searxng' && searchEndpoint.trim() ? { endpoint: searchEndpoint.trim() } : {}),
          ...((searchProvider !== 'searxng' || searchCredentialConfigured || searchApiKey.trim()) ? { credentialRef } : {}),
        },
      },
    });
  }, [harness, saveHarness, searchApiKey, searchCredentialConfigured, searchEndpoint, searchProvider, t]);

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

      <SettingsSection
        title={t('settings.page.harness.section.permissions')}
        description={t('settings.page.harness.section.permissions.description')}
      >
        <div className="space-y-4">
          <SettingsFieldRow
            label={t('settings.page.harness.permissions.mode.label')}
            description={t('settings.page.harness.permissions.mode.description')}
          >
            <Select value={permissionMode} onValueChange={handlePermissionModeChange}>
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={SETTINGS_OPTION_STACK_CLASS}>
                <SelectItem value="normal">{t('settings.page.harness.permissions.mode.normal')}</SelectItem>
                <SelectItem value="accept-edits">{t('settings.page.harness.permissions.mode.accept-edits')}</SelectItem>
                <SelectItem value="bypass">{t('settings.page.harness.permissions.mode.bypass')}</SelectItem>
                <SelectItem value="smart" disabled={!smartAvailable}>
                  {t('settings.page.harness.permissions.mode.smart')}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsFieldRow>
          {!smartAvailable ? (
            <p className="text-xs text-muted-foreground">{t('settings.page.harness.permissions.smartUnavailable')}</p>
          ) : null}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground" htmlFor="harness-permission-rules">
              {t('settings.page.harness.permissions.rules.label')}
            </label>
            <p className="text-xs text-muted-foreground">{t('settings.page.harness.permissions.rules.description')}</p>
            <textarea
              id="harness-permission-rules"
              value={rulesDraft}
              spellCheck={false}
              onChange={(event) => setRulesDraft(event.target.value)}
              className="min-h-40 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
            {rulesIssue ? <p className="text-xs text-destructive">{rulesIssue}</p> : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{t('settings.page.harness.permissions.coexistence')}</p>
              <Button type="button" size="sm" onClick={handlePermissionRulesSave} disabled={isSaving}>
                {t('settings.page.harness.permissions.rules.save')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.page.harness.section.memory')}
        description={t('settings.page.harness.section.memory.description')}
      >
        <SettingsCheckboxRow
          checked={memoryShadowMode}
          onChange={handleMemoryShadowChange}
          label={t('settings.page.harness.memory.shadow.label')}
          description={t('settings.page.harness.memory.shadow.description')}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.page.harness.section.web')}
        description={t('settings.page.harness.section.web.description')}
      >
        <div className="space-y-4">
          <SettingsFieldRow
            label={t('settings.page.harness.web.search.provider')}
            description={t('settings.page.harness.web.search.provider.description')}
          >
            <Select value={searchProvider} onValueChange={(value) => setSearchProvider(value as HarnessWebSearchProvider | 'none')}>
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} size={SETTINGS_SELECT_SIZE}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={SETTINGS_OPTION_STACK_CLASS}>
                <SelectItem value="none">{t('settings.page.harness.web.search.none')}</SelectItem>
                {SEARCH_PROVIDERS.map((provider) => <SelectItem key={provider} value={provider}>{provider === 'searxng' ? 'SearXNG' : provider[0]!.toUpperCase() + provider.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
          {searchProvider === 'searxng' ? (
            <SettingsFieldRow
              label={t('settings.page.harness.web.search.endpoint')}
              description={t('settings.page.harness.web.search.endpoint.description')}
            >
              <Input
                value={searchEndpoint}
                onChange={(event) => setSearchEndpoint(event.target.value)}
                placeholder="http://127.0.0.1:8080"
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
          ) : null}
          {searchProvider !== 'none' ? (
            <SettingsFieldRow
              label={t('settings.page.harness.web.search.apiKey')}
              description={t('settings.page.harness.web.search.apiKey.description')}
            >
              <div className="space-y-1.5">
                <Input
                  type="password"
                  autoComplete="off"
                  value={searchApiKey}
                  onChange={(event) => setSearchApiKey(event.target.value)}
                  placeholder={searchCredentialConfigured
                    ? t('settings.page.harness.web.search.configured')
                    : t('settings.page.harness.web.search.notConfigured')}
                  className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                />
                <p className="text-xs text-muted-foreground">
                  {searchStatusLoading
                    ? t('common.loading')
                    : t(searchCredentialConfigured
                        ? 'settings.page.harness.web.search.configured'
                        : 'settings.page.harness.web.search.notConfigured')}
                </p>
              </div>
            </SettingsFieldRow>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('settings.page.harness.web.search.restart')}</p>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || searchStatusLoading}
              onClick={() => {
                void handleSearchSave().catch((saveError) => {
                  const message = saveError instanceof Error ? saveError.message : String(saveError);
                  setError(message);
                  toast.error(t('settings.common.status.saveFailed'));
                });
              }}
            >
              {t('settings.page.harness.web.search.save')}
            </Button>
          </div>
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
