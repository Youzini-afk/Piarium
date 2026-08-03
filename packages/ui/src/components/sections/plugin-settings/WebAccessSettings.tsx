import React from 'react';
import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsFieldRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
} from './PluginConfigFields';
import {
  hasJsonPath,
  readJsonPath,
  setJsonPath,
  type JsonObject,
} from './plugin-config-model';
import { PluginDraftFooter, PluginRuntimeNote } from './PluginSettingsPanelShared';
import { useTextObjectDraft } from './usePluginConfigDraft';
import {
  WEB_ACCESS_RESOLVED_PROVIDERS,
  webAccessCuratorMode,
  webAccessCuratorRemoteEnabled,
  webAccessDraftIssue,
  webAccessProviderPath,
  webAccessProviderValue,
  webAccessRoutingMode,
  type WebAccessCuratorMode,
  type WebAccessPanel,
  type WebAccessRoutingMode,
} from './web-access-config-model';

interface WebAccessSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface WebAccessFields {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
}

interface PanelProps {
  fields: WebAccessFields;
}

type ProviderEditor = typeof PROVIDER_EDITORS[number]['id'];

const WEB_ACCESS_PATHS = ['web-search.json'] as const;
const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const PROVIDER_EDITORS = [
  { id: 'openai', label: 'OpenAI / Codex' },
  { id: 'brave', label: 'Brave' },
  { id: 'exa', label: 'Exa' },
  { id: 'parallel', label: 'Parallel' },
  { id: 'tinyfish', label: 'TinyFish' },
  { id: 'search1api', label: 'Search1API' },
  { id: 'searchinfinity', label: 'Searchinfinity' },
  { id: 'querit', label: 'Querit' },
  { id: 'tavily', label: 'Tavily' },
  { id: 'serpdive', label: 'SERPdive' },
  { id: 'anysearch', label: 'AnySearch' },
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'gemini', label: 'Gemini API / Web' },
  { id: 'searxng', label: 'SearXNG' },
  { id: 'firecrawl', label: 'Firecrawl' },
] as const;

const CREDENTIAL_KEYS: Partial<Record<ProviderEditor, readonly string[]>> = {
  openai: ['openaiApiKey'],
  brave: ['braveApiKey'],
  exa: ['exaApiKey'],
  parallel: ['parallelApiKey'],
  tinyfish: ['tinyfishApiKey'],
  search1api: ['search1apiApiKey'],
  searchinfinity: ['searchinfinityApiKey'],
  querit: ['queritApiKey'],
  tavily: ['tavilyApiKey'],
  serpdive: ['serpdiveApiKey'],
  anysearch: ['anysearchApiKey'],
  perplexity: ['perplexityApiKey'],
  gemini: ['geminiApiKey', 'cloudflareApiKey'],
  firecrawl: ['firecrawlApiKey'],
};

const providerOptions = WEB_ACCESS_RESOLVED_PROVIDERS.map((value) => ({ value, label: value }));

const RoutingPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const mode = webAccessRoutingMode(fields.draft);
  const providerValue = webAccessProviderValue(fields.draft);
  const providerPath = webAccessProviderPath(fields.draft);
  const singleProvider = typeof providerValue === 'string'
    && (WEB_ACCESS_RESOLVED_PROVIDERS as readonly string[]).includes(providerValue.trim().toLowerCase())
    ? providerValue.trim().toLowerCase()
    : 'openai';
  const hasSearchProvider = hasJsonPath(fields.draft, ['searchProvider']);
  const hasProvider = hasJsonPath(fields.draft, ['provider']);
  const hasRouting = hasJsonPath(fields.draft, ['searchRouting']);

  const clearProviderOverrides = () => {
    fields.onRemove(['searchProvider']);
    fields.onRemove(['provider']);
  };
  const setCanonicalProvider = (value: JsonValue) => {
    clearProviderOverrides();
    fields.onSet(['provider'], value);
  };
  const setMode = (next: WebAccessRoutingMode) => {
    if (next === 'auto') {
      if (hasRouting) setCanonicalProvider('auto');
      else clearProviderOverrides();
      return;
    }
    if (next === 'fallback') {
      clearProviderOverrides();
      if (!hasJsonPath(fields.draft, ['searchRouting', 'providers'])) {
        fields.onSet(['searchRouting', 'providers'], ['openai', 'exa']);
      }
      if (!hasJsonPath(fields.draft, ['searchRouting', 'fallbackOn'])) {
        fields.onSet(['searchRouting', 'fallbackOn'], ['transient', 'quota', 'network']);
      }
      return;
    }
    if (next === 'all') {
      setCanonicalProvider('all');
      return;
    }
    if (next === 'concurrent') {
      setCanonicalProvider(Array.isArray(providerValue) ? providerValue : [singleProvider, 'exa']);
      return;
    }
    setCanonicalProvider(singleProvider);
  };

  const providerDraft = Array.isArray(providerValue)
    ? setJsonPath(fields.draft, ['provider'], providerValue)
    : fields.draft;
  const concurrentFields: WebAccessFields = {
    ...fields,
    draft: providerDraft,
    onRemove: (path) => {
      if (path.length === 1 && path[0] === 'provider') setMode('auto');
      else fields.onRemove(path);
    },
    onSet: (path, value) => {
      if (path.length === 1 && path[0] === 'provider') setCanonicalProvider(value);
      else fields.onSet(path, value);
    },
  };

  return (
    <div className="space-y-6">
      {(hasSearchProvider && hasProvider) ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.routing.precedence')}</PluginRuntimeNote>
      ) : null}
      {(hasRouting && (hasSearchProvider || hasProvider)) ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.routing.ignored')}</PluginRuntimeNote>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.routing.title')}
        description={t('settings.piarium.pluginSettings.webAccess.routing.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['webSearch', 'enabled']}
          label="webSearch.enabled"
          description={t('settings.piarium.pluginSettings.webAccess.routing.enabledDescription')}
          defaultValue
        />
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.webAccess.routing.mode')}
          description={t('settings.piarium.pluginSettings.webAccess.routing.modeDescription')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={mode} disabled={fields.disabled} onValueChange={(value) => setMode(value as WebAccessRoutingMode)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.webAccess.routing.mode')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['auto', 'single', 'concurrent', 'all', 'fallback'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.piarium.pluginSettings.webAccess.routing.mode.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        {mode === 'single' ? (
          <SettingsFieldRow
            label={providerPath[0]}
            description={t('settings.piarium.pluginSettings.webAccess.routing.providerDescription')}
            controlClassName="w-full max-w-lg"
          >
            <Select value={singleProvider} disabled={fields.disabled} onValueChange={setCanonicalProvider}>
              <SelectTrigger
                size="settings"
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={providerPath[0]}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        ) : null}
        {mode === 'concurrent' ? (
          <PluginStringListField
            {...concurrentFields}
            path={['provider']}
            label="provider"
            description={t('settings.piarium.pluginSettings.webAccess.routing.concurrentDescription')}
            placeholder="openai"
          />
        ) : null}
        {mode === 'fallback' ? (
          <>
            <PluginStringListField
              {...fields}
              path={['searchRouting', 'providers']}
              label="searchRouting.providers"
              description={t('settings.piarium.pluginSettings.webAccess.routing.fallbackProviders')}
              placeholder="openai"
            />
            <PluginStringListField
              {...fields}
              path={['searchRouting', 'fallbackOn']}
              label="searchRouting.fallbackOn"
              description={t('settings.piarium.pluginSettings.webAccess.routing.fallbackKinds')}
              placeholder="transient"
            />
          </>
        ) : null}

        <PluginSelectField
          {...fields}
          path={['workflow']}
          label="workflow"
          defaultValue="summary-review"
          options={[
            { value: 'summary-review', label: 'summary-review' },
            { value: 'auto-summary', label: 'auto-summary' },
            { value: 'none', label: 'none' },
          ]}
        />
        <PluginStringField {...fields} path={['summaryModel']} label="summaryModel" placeholder="provider/model" />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.webAccess.tools.title')}
        description={t('settings.piarium.pluginSettings.webAccess.tools.description')}
        contentClassName="space-y-4"
      >
        <PluginStringField {...fields} path={['toolNames', 'webSearch']} label="toolNames.webSearch" defaultValue="web_search" />
        <PluginStringField {...fields} path={['toolNames', 'sourceCheck']} label="toolNames.sourceCheck" defaultValue="source_check" />
        <PluginStringField {...fields} path={['toolNames', 'fetchContent']} label="toolNames.fetchContent" defaultValue="fetch_content" />
        <PluginStringField {...fields} path={['toolNames', 'getSearchContent']} label="toolNames.getSearchContent" defaultValue="get_search_content" />
      </SettingsControlGroup>
    </div>
  );
};

const CredentialField: React.FC<{ configKey: string; fields: WebAccessFields }> = ({ configKey, fields }) => {
  const { t } = useI18n();
  return (
    <PluginStringField
      {...fields}
      path={[configKey]}
      label={configKey}
      description={t('settings.piarium.pluginSettings.webAccess.providers.credentialDescription')}
      inputType="password"
      autoComplete="new-password"
      placeholder="$ENV_NAME | !secret command"
    />
  );
};

const ProvidersPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const [provider, setProvider] = React.useState<ProviderEditor>('openai');
  const credentials = CREDENTIAL_KEYS[provider] ?? [];
  return (
    <div className="space-y-6">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.providers.secretNote')}</PluginRuntimeNote>
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.providers.title')}
        description={t('settings.piarium.pluginSettings.webAccess.providers.description')}
        contentClassName="space-y-4"
      >
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.webAccess.providers.editor')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={provider} disabled={fields.disabled} onValueChange={(value) => setProvider(value as ProviderEditor)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.webAccess.providers.editor')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_EDITORS.map((option) => (
                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        {credentials.map((configKey) => (
          <CredentialField key={configKey} fields={fields} configKey={configKey} />
        ))}

        {provider === 'openai' ? (
          <>
            <PluginStringField {...fields} path={['openaiResponsesUrl']} label="openaiResponsesUrl" inputType="url" placeholder="https://api.openai.com/v1/responses" />
            <PluginStringField {...fields} path={['openaiSearchModel']} label="openaiSearchModel" placeholder="model-id" />
          </>
        ) : null}
        {provider === 'gemini' ? (
          <>
            <PluginStringField {...fields} path={['geminiBaseUrl']} label="geminiBaseUrl" inputType="url" placeholder="https://generativelanguage.googleapis.com" />
            <PluginStringField {...fields} path={['searchModel']} label="searchModel" defaultValue="gemini-3.6-flash" />
          </>
        ) : null}
        {provider === 'serpdive' ? (
          <PluginSelectField
            {...fields}
            path={['serpdiveModel']}
            label="serpdiveModel"
            description={t('settings.piarium.pluginSettings.webAccess.providers.serpdiveCost')}
            defaultValue="krill"
            options={[
              { value: 'krill', label: 'krill · free' },
              { value: 'mako', label: 'mako · 1 credit' },
              { value: 'moby', label: 'moby · 1.5 credits' },
            ]}
          />
        ) : null}
        {provider === 'searxng' ? (
          <PluginStringField {...fields} path={['searxngBaseUrl']} label="searxngBaseUrl" inputType="url" placeholder="https://search.example.com" />
        ) : null}
        {provider === 'firecrawl' ? (
          <>
            <PluginStringField {...fields} path={['firecrawlBaseUrl']} label="firecrawlBaseUrl" inputType="url" placeholder="https://crawl.example.com" />
            <PluginSelectField
              {...fields}
              path={['firecrawlApiVersion']}
              label="firecrawlApiVersion"
              defaultValue="v2"
              options={[
                { value: 'v1', label: 'v1' },
                { value: 'v2', label: 'v2' },
              ]}
            />
            <PluginBooleanField
              {...fields}
              path={['firecrawlFreshScrape']}
              label="firecrawlFreshScrape"
              description={t('settings.piarium.pluginSettings.webAccess.providers.firecrawlRisk')}
              defaultValue={false}
            />
          </>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};

const CuratorPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const mode = webAccessCuratorMode(fields.draft);
  const remoteEnabled = webAccessCuratorRemoteEnabled(fields.draft);
  const remoteValue = readJsonPath(fields.draft, ['curatorRemote']);
  const bind = readJsonPath(fields.draft, ['curatorRemote', 'bind']);
  const broadBind = mode === 'derived'
    || (mode === 'custom' && (typeof bind !== 'string' || !bind.trim() || bind.trim() === '0.0.0.0'));
  const ignoredShape = hasJsonPath(fields.draft, ['curatorRemote'])
    && remoteValue !== false
    && remoteValue !== true
    && (typeof remoteValue !== 'object' || remoteValue === null || Array.isArray(remoteValue));

  const setMode = (next: WebAccessCuratorMode) => {
    if (next === 'local') fields.onRemove(['curatorRemote']);
    else if (next === 'derived') fields.onSet(['curatorRemote'], true);
    else if (mode !== 'custom') fields.onSet(['curatorRemote'], {
      bind: '127.0.0.1',
      host: 'localhost',
    });
  };

  return (
    <div className="space-y-6">
      {ignoredShape ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.curator.ignoredShape')}</PluginRuntimeNote>
      ) : null}
      {remoteEnabled ? (
        <PluginRuntimeNote>{t(broadBind
          ? 'settings.piarium.pluginSettings.webAccess.curator.remoteBroadWarning'
          : 'settings.piarium.pluginSettings.webAccess.curator.remoteWarning')}</PluginRuntimeNote>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.curator.title')}
        description={t('settings.piarium.pluginSettings.webAccess.curator.description')}
        contentClassName="space-y-4"
      >
        <SettingsFieldRow
          label="curatorRemote"
          description={t('settings.piarium.pluginSettings.webAccess.curator.remoteDescription')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={mode} disabled={fields.disabled} onValueChange={(value) => setMode(value as WebAccessCuratorMode)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label="curatorRemote"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">{t('settings.piarium.pluginSettings.webAccess.curator.mode.local')}</SelectItem>
              <SelectItem value="derived">{t('settings.piarium.pluginSettings.webAccess.curator.mode.derived')}</SelectItem>
              <SelectItem value="custom">{t('settings.piarium.pluginSettings.webAccess.curator.mode.custom')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        {mode === 'custom' ? (
          <>
            <PluginStringField {...fields} path={['curatorRemote', 'host']} label="curatorRemote.host" allowEmpty placeholder="pi.example.net" />
            <PluginStringField {...fields} path={['curatorRemote', 'bind']} label="curatorRemote.bind" allowEmpty placeholder="100.101.102.103" />
          </>
        ) : null}
        <PluginNumberField
          {...fields}
          path={['curatorTimeoutSeconds']}
          label="curatorTimeoutSeconds"
          defaultValue={remoteEnabled ? 60 : 20}
          min={1}
          max={600}
          unit="s"
        />
        <PluginBooleanField
          {...fields}
          path={['autoOpenBrowser']}
          label="autoOpenBrowser"
          defaultValue={!remoteEnabled}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.webAccess.browser.title')}
        description={t('settings.piarium.pluginSettings.webAccess.browser.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['allowBrowserCookies']}
          label="allowBrowserCookies"
          description={t('settings.piarium.pluginSettings.webAccess.browser.cookieWarning')}
          defaultValue={false}
        />
        <PluginStringField {...fields} path={['chromeProfile']} label="chromeProfile" placeholder="Profile 2" />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.webAccess.shortcuts.title')}
        description={t('settings.piarium.pluginSettings.webAccess.shortcuts.description')}
        contentClassName="space-y-4"
      >
        <PluginStringField {...fields} path={['shortcuts', 'curate']} label="shortcuts.curate" defaultValue="ctrl+shift+s" />
        <PluginStringField {...fields} path={['shortcuts', 'activity']} label="shortcuts.activity" defaultValue="ctrl+shift+w" />
      </SettingsControlGroup>
    </div>
  );
};

const ContentPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.content.github.title')}
        description={t('settings.piarium.pluginSettings.webAccess.content.github.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['githubClone', 'enabled']} label="githubClone.enabled" defaultValue />
        <PluginNumberField {...fields} path={['githubClone', 'maxRepoSizeMB']} label="githubClone.maxRepoSizeMB" defaultValue={350} unit="MiB" />
        <PluginNumberField {...fields} path={['githubClone', 'cloneTimeoutSeconds']} label="githubClone.cloneTimeoutSeconds" defaultValue={30} unit="s" />
        <PluginStringField {...fields} path={['githubClone', 'clonePath']} label="githubClone.clonePath" defaultValue="/tmp/pi-github-repos" />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.webAccess.content.media.title')}
        description={t('settings.piarium.pluginSettings.webAccess.content.media.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['youtube', 'enabled']} label="youtube.enabled" defaultValue />
        <PluginStringField {...fields} path={['youtube', 'preferredModel']} label="youtube.preferredModel" defaultValue="gemini-3.6-flash" />
        <PluginBooleanField {...fields} path={['video', 'enabled']} label="video.enabled" defaultValue />
        <PluginStringField {...fields} path={['video', 'preferredModel']} label="video.preferredModel" defaultValue="gemini-3.6-flash" />
        <PluginNumberField {...fields} path={['video', 'maxSizeMB']} label="video.maxSizeMB" defaultValue={50} unit="MiB" />
        <PluginNumberField {...fields} path={['pdf', 'maxSizeMB']} label="pdf.maxSizeMB" defaultValue={20} max={50} unit="MiB" />
      </SettingsControlGroup>
    </div>
  );
};

const SecurityPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.security.note')}</PluginRuntimeNote>
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.security.domains.title')}
        description={t('settings.piarium.pluginSettings.webAccess.security.domains.description')}
        contentClassName="space-y-4"
      >
        <PluginStringListField {...fields} path={['fetchContent', 'domainPolicy', 'allow']} label="fetchContent.domainPolicy.allow" placeholder="example.com" />
        <PluginStringListField {...fields} path={['fetchContent', 'domainPolicy', 'deny']} label="fetchContent.domainPolicy.deny" placeholder="blocked.example.com" />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.webAccess.security.ssrf.title')}
        description={t('settings.piarium.pluginSettings.webAccess.security.ssrf.description')}
        contentClassName="space-y-4"
      >
        <PluginStringListField {...fields} path={['ssrf', 'allowRanges']} label="ssrf.allowRanges" placeholder="198.18.0.0/15" />
        <PluginBooleanField {...fields} path={['ssrf', 'trustEnvProxy']} label="ssrf.trustEnvProxy" defaultValue={false} />
      </SettingsControlGroup>
    </div>
  );
};

export const WebAccessSettings: React.FC<WebAccessSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const [panel, setPanel] = React.useState<WebAccessPanel>('routing');
  const controller = useTextObjectDraft({
    format: 'json',
    paths: WEB_ACCESS_PATHS,
    root: 'agent',
    runtimeTarget,
    targetKey,
  });
  const fields: WebAccessFields = {
    disabled: !controller.loaded || controller.loading || controller.saving,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };
  const issue = React.useMemo(() => webAccessDraftIssue(controller.draft), [controller.draft]);
  const panelOptions = (['routing', 'providers', 'curator', 'content', 'security'] as const).map((value) => ({
    value,
    label: t(`settings.piarium.pluginSettings.webAccess.panel.${value}`),
  }));

  return (
    <div className="space-y-7">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.runtimeNote')}</PluginRuntimeNote>
      <div className="space-y-3 rounded-lg border border-border/60 px-4 py-4">
        <div className="space-y-1">
          <h3 className="typography-settings-group-title text-foreground">
            {t('settings.piarium.pluginSettings.webAccess.workspace.title')}
          </h3>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.webAccess.workspace.description')}
          </p>
        </div>
        <SettingsChipGroup
          value={panel}
          options={panelOptions}
          onChange={setPanel}
          aria-label={t('settings.piarium.pluginSettings.webAccess.workspace.navigation')}
        />
      </div>

      {panel === 'routing' ? <RoutingPanel fields={fields} /> : null}
      {panel === 'providers' ? <ProvidersPanel fields={fields} /> : null}
      {panel === 'curator' ? <CuratorPanel fields={fields} /> : null}
      {panel === 'content' ? <ContentPanel fields={fields} /> : null}
      {panel === 'security' ? <SecurityPanel fields={fields} /> : null}

      <PluginDraftFooter
        controller={controller}
        blocked={issue !== null}
        blockedMessage={issue
          ? t('settings.piarium.pluginSettings.webAccess.validation.invalidValue', { field: issue.field })
          : undefined}
      />
    </div>
  );
};
