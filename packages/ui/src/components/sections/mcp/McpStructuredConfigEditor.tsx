import React from 'react';
import type { JsonValue } from '@piarium/protocol';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
} from '@/components/sections/plugin-settings/PluginConfigFields';
import { asJsonObject, readJsonPath, validStringArray } from '@/components/sections/plugin-settings/plugin-config-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import {
  mcpServerNames,
  mcpServerTransport,
  parseMcpConfigObject,
  removeMcpConfigValue,
  setMcpConfigValue,
  switchMcpServerTransport,
  updateMcpServerUrl,
  type McpServerTransportMode,
} from './mcp-config-model';

interface McpStructuredConfigEditorProps {
  content: string;
  disabled: boolean;
  onChange: (content: string) => void;
}

interface DirectToolsFieldProps {
  disabled: boolean;
  document: ReturnType<typeof parseMcpConfigObject>;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
}

const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const DirectToolsField: React.FC<DirectToolsFieldProps> = ({
  disabled,
  document,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const raw = readJsonPath(document, path);
  const selected = validStringArray(raw);
  const mode = raw === true
    ? 'all'
    : raw === false
      ? 'proxy'
      : selected
        ? 'selected'
        : 'inherit';

  return (
    <SettingsFieldRow label="directTools" alignEnd={false} controlClassName="w-full max-w-lg items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'inherit') onRemove(path);
            else if (next === 'proxy') onSet(path, false);
            else if (next === 'all') onSet(path, true);
            else onSet(path, selected ?? []);
          }}
        >
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label="directTools mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.mcp.structured.directTools.inherit')}</SelectItem>
            <SelectItem value="proxy">{t('settings.piarium.mcp.structured.directTools.proxy')}</SelectItem>
            <SelectItem value="all">{t('settings.piarium.mcp.structured.directTools.all')}</SelectItem>
            <SelectItem value="selected">{t('settings.piarium.mcp.structured.directTools.selected')}</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'selected' ? (
          <Textarea
            value={(selected ?? []).join('\n')}
            disabled={disabled}
            aria-label="directTools selected tools"
            placeholder="search_repositories"
            onChange={(event) => onSet(path, event.target.value
              .split(/\r?\n/)
              .map((entry) => entry.trim())
              .filter(Boolean))}
            className="min-h-20 min-w-0 flex-1 font-mono"
          />
        ) : null}
      </div>
    </SettingsFieldRow>
  );
};

export const McpStructuredConfigEditor: React.FC<McpStructuredConfigEditorProps> = ({
  content,
  disabled,
  onChange,
}) => {
  const { t } = useI18n();
  const document = React.useMemo(() => parseMcpConfigObject(content), [content]);
  const names = React.useMemo(() => mcpServerNames(document), [document]);
  const [nameInput, setNameInput] = React.useState('');
  const [selectedName, setSelectedName] = React.useState('');
  const listId = React.useId();

  React.useEffect(() => {
    if (selectedName || names.length === 0) return;
    const first = names[0] ?? '';
    setSelectedName(first);
    setNameInput(first);
  }, [names, selectedName]);

  const setValue = React.useCallback((path: readonly string[], value: JsonValue) => {
    onChange(setMcpConfigValue(content, path, value));
  }, [content, onChange]);
  const removeValue = React.useCallback((path: readonly string[]) => {
    onChange(removeMcpConfigValue(content, path));
  }, [content, onChange]);
  const fields = {
    disabled,
    draft: document,
    onRemove: removeValue,
    onSet: setValue,
  };
  const serverPath = ['mcpServers', selectedName] as const;
  const server = asJsonObject(readJsonPath(document, serverPath));
  const transport = selectedName
    ? mcpServerTransport(document, selectedName)
    : 'unconfigured';
  const outputGuard = readJsonPath(document, ['settings', 'outputGuard']);

  const chooseServer = (): void => {
    const name = nameInput.trim();
    if (name) setSelectedName(name);
  };

  const selectTransport = (next: McpServerTransportMode): void => {
    if (!selectedName) return;
    onChange(switchMcpServerTransport(content, selectedName, next));
  };

  const setUrl = (url: string): void => {
    if (!selectedName) return;
    let next = updateMcpServerUrl(content, selectedName, url);
    if (!url) next = removeMcpConfigValue(next, [...serverPath, 'url']);
    onChange(next);
  };

  return (
    <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
      <div className="space-y-1">
        <h3 className="typography-settings-group-title text-foreground">
          {t('settings.piarium.mcp.structured.title')}
        </h3>
        <p className="typography-meta text-muted-foreground">
          {t('settings.piarium.mcp.structured.description')}
        </p>
      </div>

      <SettingsControlGroup
        title={t('settings.piarium.mcp.structured.global.title')}
        description={t('settings.piarium.mcp.structured.global.description')}
        contentClassName="space-y-4"
      >
        <PluginStringListField
          {...fields}
          path={['imports']}
          label="imports"
          placeholder={'cursor\nclaude-code\nclaude-desktop\ncodex\nopencode\nwindsurf\nvscode'}
        />
        <PluginSelectField
          {...fields}
          path={['settings', 'hostConfigDiscovery']}
          label="settings.hostConfigDiscovery"
          defaultValue="off"
          options={[
            { value: 'off', label: 'off' },
            { value: 'prompt', label: 'prompt' },
            { value: 'on', label: 'on' },
          ]}
        />
        <PluginSelectField
          {...fields}
          path={['settings', 'toolPrefix']}
          label="settings.toolPrefix"
          defaultValue="server"
          options={[
            { value: 'server', label: 'server' },
            { value: 'short', label: 'short' },
            { value: 'mcp', label: 'mcp' },
            { value: 'none', label: 'none' },
          ]}
        />
        <PluginBooleanField {...fields} path={['settings', 'showStatusIcon']} label="settings.showStatusIcon" defaultValue />
        <PluginSelectField
          {...fields}
          path={['settings', 'mcpFooterStatus']}
          label="settings.mcpFooterStatus"
          defaultValue="full"
          options={[
            { value: 'full', label: 'full' },
            { value: 'compact', label: 'compact' },
            { value: 'off', label: 'off' },
          ]}
        />
        <PluginNumberField {...fields} path={['settings', 'idleTimeout']} label="settings.idleTimeout" defaultValue={10} min={0} unit="min" />
        <PluginNumberField {...fields} path={['settings', 'requestTimeoutMs']} label="settings.requestTimeoutMs" defaultValue={0} min={0} unit="ms" />
        <PluginBooleanField {...fields} path={['settings', 'directTools']} label="settings.directTools" defaultValue={false} />
        <PluginBooleanField {...fields} path={['settings', 'disableProxyTool']} label="settings.disableProxyTool" defaultValue={false} />
        <PluginBooleanField {...fields} path={['settings', 'autoAuth']} label="settings.autoAuth" defaultValue={false} />
        <PluginBooleanField {...fields} path={['settings', 'sampling']} label="settings.sampling" defaultValue={false} />
        <PluginBooleanField {...fields} path={['settings', 'samplingAutoApprove']} label="settings.samplingAutoApprove" defaultValue={false} />
        <PluginBooleanField {...fields} path={['settings', 'elicitation']} label="settings.elicitation" defaultValue={false} />
        {typeof outputGuard === 'object' && outputGuard !== null && !Array.isArray(outputGuard) ? (
          <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
            {t('settings.piarium.mcp.structured.outputGuardAdvanced')}
          </p>
        ) : (
          <PluginBooleanField {...fields} path={['settings', 'outputGuard']} label="settings.outputGuard" defaultValue />
        )}
        <PluginOptionalBooleanField {...fields} path={['settings', 'trace', 'enabled']} label="settings.trace.enabled" />
        <PluginStringField {...fields} path={['settings', 'trace', 'file']} label="settings.trace.file" placeholder=".pi/mcp-trace.jsonl" />
        <PluginOptionalNumberField {...fields} path={['settings', 'trace', 'maxBytes']} label="settings.trace.maxBytes" min={1} fallbackValue={1} />
        <PluginOptionalNumberField {...fields} path={['settings', 'trace', 'maxEvents']} label="settings.trace.maxEvents" min={1} fallbackValue={1} />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.mcp.structured.servers.title')}
        description={t('settings.piarium.mcp.structured.servers.description')}
        contentClassName="space-y-5"
      >
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label className="typography-settings-field-label text-foreground" htmlFor={`${listId}-input`}>
              {t('settings.piarium.mcp.structured.serverName')}
            </label>
            <Input
              id={`${listId}-input`}
              list={listId}
              value={nameInput}
              disabled={disabled}
              placeholder="github"
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                chooseServer();
              }}
            />
            <datalist id={listId}>
              {names.map((name) => <option key={name} value={name} />)}
            </datalist>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || !nameInput.trim()} onClick={chooseServer}>
            {t('settings.piarium.mcp.structured.editServer')}
          </Button>
        </div>

        {selectedName ? (
          <div className="space-y-5 rounded-lg border border-border/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <code className="min-w-0 truncate typography-ui-label text-foreground">{selectedName}</code>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled || !Object.prototype.hasOwnProperty.call(
                  asJsonObject(readJsonPath(document, ['mcpServers'])),
                  selectedName,
                )}
                onClick={() => removeValue(serverPath)}
                className="shrink-0 !font-normal text-[var(--status-error)]"
              >
                {t('settings.piarium.recovery.actions.remove')}
              </Button>
            </div>

            <SettingsFieldRow label={t('settings.piarium.mcp.structured.transport')} controlClassName="w-full max-w-lg">
              <Select value={transport} disabled={disabled} onValueChange={selectTransport}>
                <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unconfigured">{t('settings.piarium.mcp.structured.transport.partial')}</SelectItem>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">HTTP / SSE</SelectItem>
                  <SelectItem value="socket">rmcp-mux socket</SelectItem>
                </SelectContent>
              </Select>
            </SettingsFieldRow>

            {transport === 'stdio' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <PluginStringField {...fields} path={[...serverPath, 'command']} label="command" placeholder="npx" />
                <PluginStringListField {...fields} path={[...serverPath, 'args']} label="args" placeholder="-y\n@modelcontextprotocol/server-github" />
                <PluginStringField {...fields} path={[...serverPath, 'cwd']} label="cwd" placeholder="path/to/working-directory" />
              </div>
            ) : null}

            {transport === 'http' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SettingsFieldRow
                  label="url"
                  description={t('settings.piarium.mcp.structured.urlCredentialReset')}
                  controlClassName="w-full max-w-lg"
                >
                  <Input
                    value={typeof server.url === 'string' ? server.url : ''}
                    disabled={disabled}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => setUrl(event.target.value)}
                    className="min-w-0 flex-1"
                  />
                </SettingsFieldRow>
                <PluginOptionalSelectField
                  {...fields}
                  path={[...serverPath, 'auth']}
                  label="auth"
                  options={[
                    { value: 'oauth', label: 'oauth' },
                    { value: 'bearer', label: 'bearer' },
                    { value: false, label: t('settings.piarium.pluginSettings.field.disabled') },
                  ]}
                />
              </div>
            ) : null}

            {transport === 'socket' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <PluginStringField {...fields} path={[...serverPath, 'socket']} label="socket" placeholder="~/.rmcp-servers/rmcp-mux/sockets/server.sock" />
              </div>
            ) : null}

            <div className="space-y-4 border-t border-border/60 pt-4">
              <PluginOptionalSelectField
                {...fields}
                path={[...serverPath, 'lifecycle']}
                label="lifecycle"
                options={[
                  { value: 'lazy', label: 'lazy' },
                  { value: 'eager', label: 'eager' },
                  { value: 'keep-alive', label: 'keep-alive' },
                  { value: 'lazy-keep-alive', label: 'lazy-keep-alive' },
                ]}
              />
              <PluginOptionalNumberField {...fields} path={[...serverPath, 'idleTimeout']} label="idleTimeout" min={0} fallbackValue={0} unit="min" />
              <PluginOptionalNumberField {...fields} path={[...serverPath, 'requestTimeoutMs']} label="requestTimeoutMs" min={0} fallbackValue={0} unit="ms" />
              <PluginOptionalBooleanField {...fields} path={[...serverPath, 'exposeResources']} label="exposeResources" />
              <DirectToolsField
                disabled={disabled}
                document={document}
                onRemove={removeValue}
                onSet={setValue}
                path={[...serverPath, 'directTools']}
              />
              <PluginOptionalSelectField
                {...fields}
                path={[...serverPath, 'toolPrefix']}
                label="toolPrefix"
                options={[
                  { value: 'server', label: 'server' },
                  { value: 'short', label: 'short' },
                  { value: 'mcp', label: 'mcp' },
                  { value: 'none', label: 'none' },
                ]}
              />
              <PluginStringListField {...fields} path={[...serverPath, 'includeTools']} label="includeTools" placeholder="tool_name" />
              <PluginStringListField {...fields} path={[...serverPath, 'excludeTools']} label="excludeTools" placeholder="tool_name" />
              <PluginOptionalBooleanField {...fields} path={[...serverPath, 'debug']} label="debug" />
              <PluginOptionalBooleanField {...fields} path={[...serverPath, 'trace']} label="trace" />
              <PluginOptionalBooleanField {...fields} path={[...serverPath, 'disabled']} label="disabled" />
            </div>

            <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
              {t('settings.piarium.mcp.structured.advancedFields')}
            </p>
          </div>
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};
