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
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
} from './PluginSettingsPanelShared';
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
import { WebAccessRuntimePanel } from './WebAccessRuntimePanel';

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

const providerOptions = WEB_ACCESS_RESOLVED_PROVIDERS.map((value) => ({
  value,
  label: PROVIDER_EDITORS.find((option) => option.id === value)?.label ?? value,
}));

const WarningNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="typography-meta text-[var(--status-warning)]">{children}</p>
);

const SearchPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const mode = webAccessRoutingMode(fields.draft);
  const providerValue = webAccessProviderValue(fields.draft);
  const providerSelectionPath = webAccessProviderPath(fields.draft);
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
    // A routing-mode change is an explicit routing edit. Normalize the legacy
    // aliases only at that point; untouched documents retain their shape.
    clearProviderOverrides();
    fields.onRemove(['searchRouting']);
    fields.onSet(['provider'], value);
  };
  const setSelectedProvider = (value: JsonValue) => {
    // Changing the provider inside the existing mode is not a routing-mode
    // change. Keep whichever native provider alias the document already uses.
    fields.onSet(providerSelectionPath, value);
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
    ? setJsonPath(fields.draft, providerSelectionPath, providerValue)
    : fields.draft;
  const concurrentFields: WebAccessFields = { ...fields, draft: providerDraft };

  return (
    <div className="space-y-6">
      {(hasSearchProvider && hasProvider) ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.search.precedence')}</PluginRuntimeNote>
      ) : null}
      {(hasRouting && (hasSearchProvider || hasProvider)) ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.search.ignored')}</PluginRuntimeNote>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.search.title')}
        info={t('settings.piarium.pluginSettings.webAccess.search.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['webSearch', 'enabled']}
          label={t('settings.piarium.pluginSettings.webAccess.search.enabled')}
          info={t('settings.piarium.pluginSettings.webAccess.search.enabledDescription')}
          defaultValue
        />
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.webAccess.search.routingMode')}
          info={t('settings.piarium.pluginSettings.webAccess.search.routingModeDescription')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={mode} disabled={fields.disabled} onValueChange={(value) => setMode(value as WebAccessRoutingMode)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.webAccess.search.routingMode')}
            >
              <SelectValue>
                {t(`settings.piarium.pluginSettings.webAccess.search.routingMode.${mode}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(['auto', 'single', 'concurrent', 'all', 'fallback'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.piarium.pluginSettings.webAccess.search.routingMode.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        {mode === 'single' ? (
          <SettingsFieldRow
            label={t('settings.piarium.pluginSettings.webAccess.search.provider')}
            info={t('settings.piarium.pluginSettings.webAccess.search.providerDescription')}
            controlClassName="w-full max-w-lg"
          >
            <Select value={singleProvider} disabled={fields.disabled} onValueChange={setSelectedProvider}>
              <SelectTrigger
                size="settings"
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={t('settings.piarium.pluginSettings.webAccess.search.provider')}
              >
                <SelectValue>
                  {providerOptions.find((option) => option.value === singleProvider)?.label ?? singleProvider}
                </SelectValue>
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
            path={providerSelectionPath}
            label={t('settings.piarium.pluginSettings.webAccess.search.concurrentProviders')}
            info={t('settings.piarium.pluginSettings.webAccess.search.concurrentProvidersDescription')}
            placeholder="openai"
          />
        ) : null}
        {mode === 'fallback' ? (
          <>
            <PluginStringListField
              {...fields}
              path={['searchRouting', 'providers']}
              label={t('settings.piarium.pluginSettings.webAccess.search.fallbackProviders')}
              info={t('settings.piarium.pluginSettings.webAccess.search.fallbackProvidersDescription')}
              placeholder="openai"
            />
            <PluginStringListField
              {...fields}
              path={['searchRouting', 'fallbackOn']}
              label={t('settings.piarium.pluginSettings.webAccess.search.fallbackKinds')}
              info={t('settings.piarium.pluginSettings.webAccess.search.fallbackKindsDescription')}
              placeholder="transient"
            />
          </>
        ) : null}

        <PluginSelectField
          {...fields}
          path={['workflow']}
          label={t('settings.piarium.pluginSettings.webAccess.search.workflow')}
          info={t('settings.piarium.pluginSettings.webAccess.search.workflowDescription')}
          defaultValue="summary-review"
          options={[
            { value: 'summary-review', label: t('settings.piarium.pluginSettings.webAccess.search.workflow.summaryReview') },
            { value: 'auto-summary', label: t('settings.piarium.pluginSettings.webAccess.search.workflow.autoSummary') },
            { value: 'none', label: t('settings.piarium.pluginSettings.webAccess.search.workflow.none') },
          ]}
        />
        <PluginStringField
          {...fields}
          path={['summaryModel']}
          label={t('settings.piarium.pluginSettings.webAccess.search.summaryModel')}
          info={t('settings.piarium.pluginSettings.webAccess.search.summaryModelDescription')}
          placeholder="provider/model"
        />
      </SettingsControlGroup>
    </div>
  );
};

const CredentialField: React.FC<{
  configKey: string;
  fields: WebAccessFields;
  providerLabel: string;
}> = ({ configKey, fields, providerLabel }) => {
  const { t } = useI18n();
  return (
    <PluginStringField
      {...fields}
      path={[configKey]}
      label={t('settings.piarium.pluginSettings.webAccess.providers.credentialSource', { provider: providerLabel })}
      info={t('settings.piarium.pluginSettings.webAccess.providers.credentialDescription')}
      inputType="password"
      autoComplete="new-password"
      placeholder={t('settings.piarium.pluginSettings.webAccess.providers.credentialPlaceholder')}
    />
  );
};

const ProvidersPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const [provider, setProvider] = React.useState<ProviderEditor>('openai');
  const providerLabel = PROVIDER_EDITORS.find((option) => option.id === provider)?.label ?? provider;
  const credentials = CREDENTIAL_KEYS[provider] ?? [];
  const endpointInfo = t('settings.piarium.pluginSettings.webAccess.providers.endpointDescription');
  const modelInfo = t('settings.piarium.pluginSettings.webAccess.providers.modelDescription');

  return (
    <div className="space-y-6">
      <WarningNote>{t('settings.piarium.pluginSettings.webAccess.providers.secretNote')}</WarningNote>
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.providers.title')}
        info={t('settings.piarium.pluginSettings.webAccess.providers.description')}
        contentClassName="space-y-4"
      >
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.webAccess.providers.editor')}
          info={t('settings.piarium.pluginSettings.webAccess.providers.editorDescription')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={provider} disabled={fields.disabled} onValueChange={(value) => setProvider(value as ProviderEditor)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.webAccess.providers.editor')}
            >
              <SelectValue>{providerLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_EDITORS.map((option) => (
                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        {credentials.map((configKey) => (
          <CredentialField key={configKey} fields={fields} configKey={configKey} providerLabel={providerLabel} />
        ))}
        {credentials.length > 0 ? <WarningNote>{t('settings.piarium.pluginSettings.webAccess.providers.credentialCommandWarning')}</WarningNote> : null}

        {provider === 'openai' ? (
          <>
            <PluginStringField
              {...fields}
              path={['openaiResponsesUrl']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.endpoint')}
              info={endpointInfo}
              inputType="url"
              placeholder="https://api.openai.com/v1/responses"
            />
            <PluginStringField
              {...fields}
              path={['openaiSearchModel']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.model')}
              info={modelInfo}
              placeholder="model-id"
            />
          </>
        ) : null}
        {provider === 'gemini' ? (
          <>
            <PluginStringField
              {...fields}
              path={['geminiBaseUrl']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.endpoint')}
              info={endpointInfo}
              inputType="url"
              placeholder="https://generativelanguage.googleapis.com"
            />
            <PluginStringField
              {...fields}
              path={['searchModel']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.model')}
              info={modelInfo}
              defaultValue="gemini-3.6-flash"
            />
          </>
        ) : null}
        {provider === 'serpdive' ? (
          <PluginSelectField
            {...fields}
            path={['serpdiveModel']}
            label={t('settings.piarium.pluginSettings.webAccess.providers.model')}
            info={t('settings.piarium.pluginSettings.webAccess.providers.serpdiveCost')}
            defaultValue="krill"
            options={[
              { value: 'krill', label: t('settings.piarium.pluginSettings.webAccess.providers.serpdive.krill') },
              { value: 'mako', label: t('settings.piarium.pluginSettings.webAccess.providers.serpdive.mako') },
              { value: 'moby', label: t('settings.piarium.pluginSettings.webAccess.providers.serpdive.moby') },
            ]}
          />
        ) : null}
        {provider === 'searxng' ? (
          <PluginStringField
            {...fields}
            path={['searxngBaseUrl']}
            label={t('settings.piarium.pluginSettings.webAccess.providers.endpoint')}
            info={endpointInfo}
            inputType="url"
            placeholder="https://search.example.com"
          />
        ) : null}
        {provider === 'firecrawl' ? (
          <>
            <PluginStringField
              {...fields}
              path={['firecrawlBaseUrl']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.endpoint')}
              info={endpointInfo}
              inputType="url"
              placeholder="https://crawl.example.com"
            />
            <PluginBooleanField
              {...fields}
              path={['firecrawlFreshScrape']}
              label={t('settings.piarium.pluginSettings.webAccess.providers.firecrawlFreshScrape')}
              info={t('settings.piarium.pluginSettings.webAccess.providers.firecrawlFreshScrapeDescription')}
              defaultValue={false}
            />
            <WarningNote>{t('settings.piarium.pluginSettings.webAccess.providers.firecrawlRisk')}</WarningNote>
          </>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};

const BrowserCuratorPanel: React.FC<PanelProps> = ({ fields }) => {
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
      {ignoredShape ? <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.browserCurator.ignoredShape')}</PluginRuntimeNote> : null}
      {remoteEnabled ? (
        <WarningNote>{t(broadBind
          ? 'settings.piarium.pluginSettings.webAccess.curator.remoteBroadWarning'
          : 'settings.piarium.pluginSettings.webAccess.curator.remoteWarning')}</WarningNote>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.browserCurator.title')}
        info={t('settings.piarium.pluginSettings.webAccess.browserCurator.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['allowBrowserCookies']}
          label={t('settings.piarium.pluginSettings.webAccess.browserCurator.cookies')}
          info={t('settings.piarium.pluginSettings.webAccess.browserCurator.cookiesDescription')}
          defaultValue={false}
        />
        <WarningNote>{t('settings.piarium.pluginSettings.webAccess.browserCurator.cookiesWarning')}</WarningNote>
        <PluginStringField
          {...fields}
          path={['chromeProfile']}
          label={t('settings.piarium.pluginSettings.webAccess.browserCurator.profile')}
          info={t('settings.piarium.pluginSettings.webAccess.browserCurator.profileDescription')}
          placeholder="Profile 2"
        />

        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.webAccess.browserCurator.mode')}
          info={t('settings.piarium.pluginSettings.webAccess.browserCurator.modeDescription')}
          controlClassName="w-full max-w-lg"
        >
          <Select value={mode} disabled={fields.disabled} onValueChange={(value) => setMode(value as WebAccessCuratorMode)}>
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.webAccess.browserCurator.mode')}
            >
              <SelectValue>
                {t(`settings.piarium.pluginSettings.webAccess.browserCurator.mode.${mode}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">{t('settings.piarium.pluginSettings.webAccess.browserCurator.mode.local')}</SelectItem>
              <SelectItem value="derived">{t('settings.piarium.pluginSettings.webAccess.browserCurator.mode.derived')}</SelectItem>
              <SelectItem value="custom">{t('settings.piarium.pluginSettings.webAccess.browserCurator.mode.custom')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        {mode === 'custom' ? (
          <>
            <PluginStringField
              {...fields}
              path={['curatorRemote', 'host']}
              label={t('settings.piarium.pluginSettings.webAccess.browserCurator.host')}
              info={t('settings.piarium.pluginSettings.webAccess.browserCurator.hostDescription')}
              allowEmpty
              placeholder="pi.example.net"
            />
            <PluginStringField
              {...fields}
              path={['curatorRemote', 'bind']}
              label={t('settings.piarium.pluginSettings.webAccess.browserCurator.bind')}
              info={t('settings.piarium.pluginSettings.webAccess.browserCurator.bindDescription')}
              allowEmpty
              placeholder="100.101.102.103"
            />
          </>
        ) : null}
        <PluginNumberField
          {...fields}
          path={['curatorTimeoutSeconds']}
          label={t('settings.piarium.pluginSettings.webAccess.browserCurator.timeout')}
          info={t('settings.piarium.pluginSettings.webAccess.browserCurator.timeoutDescription')}
          defaultValue={remoteEnabled ? 60 : 20}
          min={1}
          max={600}
          unit="s"
        />
        <PluginBooleanField
          {...fields}
          path={['autoOpenBrowser']}
          label={t('settings.piarium.pluginSettings.webAccess.browserCurator.autoOpen')}
          info={t('settings.piarium.pluginSettings.webAccess.browserCurator.autoOpenDescription')}
          defaultValue={!remoteEnabled}
        />
      </SettingsControlGroup>
    </div>
  );
};

const ContentPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.content.title')}
        info={t('settings.piarium.pluginSettings.webAccess.content.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['githubClone', 'enabled']}
          label={t('settings.piarium.pluginSettings.webAccess.content.github')}
          info={t('settings.piarium.pluginSettings.webAccess.content.githubDescription')}
          defaultValue
        />
        <PluginBooleanField
          {...fields}
          path={['youtube', 'enabled']}
          label={t('settings.piarium.pluginSettings.webAccess.content.youtube')}
          info={t('settings.piarium.pluginSettings.webAccess.content.youtubeDescription')}
          defaultValue
        />
        <PluginBooleanField
          {...fields}
          path={['video', 'enabled']}
          label={t('settings.piarium.pluginSettings.webAccess.content.video')}
          info={t('settings.piarium.pluginSettings.webAccess.content.videoDescription')}
          defaultValue
        />
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.content.pdfNote')}</PluginRuntimeNote>
      </SettingsControlGroup>
    </div>
  );
};

const SafetyPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.safety.title')}
        info={t('settings.piarium.pluginSettings.webAccess.safety.description')}
        contentClassName="space-y-4"
      >
        <PluginStringListField
          {...fields}
          path={['fetchContent', 'domainPolicy', 'allow']}
          label={t('settings.piarium.pluginSettings.webAccess.safety.domainAllow')}
          info={t('settings.piarium.pluginSettings.webAccess.safety.domainAllowDescription')}
          placeholder="example.com"
        />
        <PluginStringListField
          {...fields}
          path={['fetchContent', 'domainPolicy', 'deny']}
          label={t('settings.piarium.pluginSettings.webAccess.safety.domainDeny')}
          info={t('settings.piarium.pluginSettings.webAccess.safety.domainDenyDescription')}
          placeholder="blocked.example.com"
        />
        <PluginStringListField
          {...fields}
          path={['ssrf', 'allowRanges']}
          label={t('settings.piarium.pluginSettings.webAccess.safety.ssrfRanges')}
          info={t('settings.piarium.pluginSettings.webAccess.safety.ssrfRangesDescription')}
          placeholder="198.18.0.0/15"
        />
        <PluginBooleanField
          {...fields}
          path={['ssrf', 'trustEnvProxy']}
          label={t('settings.piarium.pluginSettings.webAccess.safety.proxyTrust')}
          info={t('settings.piarium.pluginSettings.webAccess.safety.proxyTrustDescription')}
          defaultValue={false}
        />
      </SettingsControlGroup>
      <WarningNote>{t('settings.piarium.pluginSettings.webAccess.safety.warning')}</WarningNote>
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
  const issue = React.useMemo(() => webAccessDraftIssue(controller.draft), [controller.draft]);
  const fields: WebAccessFields = {
    // Keep structured controls read-only while the raw editor contains invalid
    // JSON. A semantic validation issue still allows the user to correct the
    // value through the form; only the Save action is blocked until valid.
    disabled: !controller.loaded
      || controller.loading
      || controller.saving
      || controller.rawError !== null,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };
  const panelLabelKeys = {
    routing: 'settings.piarium.pluginSettings.webAccess.panel.search',
    providers: 'settings.piarium.pluginSettings.webAccess.panel.providers',
    curator: 'settings.piarium.pluginSettings.webAccess.panel.browserCurator',
    content: 'settings.piarium.pluginSettings.webAccess.panel.content',
    security: 'settings.piarium.pluginSettings.webAccess.panel.safety',
  } as const;
  const panelOptions = (['routing', 'providers', 'curator', 'content', 'security'] as const).map((value) => ({
    value,
    label: t(panelLabelKeys[value]),
  }));

  return (
    <div className="space-y-7">
      <PluginConfigSource controller={controller} />
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.runtimeNote')}</PluginRuntimeNote>

      <div className="space-y-3">
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

      {panel === 'routing' ? <SearchPanel fields={fields} /> : null}
      {panel === 'providers' ? <ProvidersPanel fields={fields} /> : null}
      {panel === 'curator' ? <BrowserCuratorPanel fields={fields} /> : null}
      {panel === 'content' ? <ContentPanel fields={fields} /> : null}
      {panel === 'security' ? <SafetyPanel fields={fields} /> : null}

      <PluginAdvancedDraftEditor controller={controller} />
      <PluginDraftFooter
        controller={controller}
        blocked={issue !== null}
        blockedMessage={issue
          ? t('settings.piarium.pluginSettings.webAccess.validation.invalidValue', {
            field: t('settings.piarium.pluginSettings.webAccess.validation.setting'),
          })
          : undefined}
      />

      <WebAccessRuntimePanel runtimeTarget={runtimeTarget} />
    </div>
  );
};
