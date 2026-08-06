import React from 'react';
import type { JsonValue } from '@piarium/protocol';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import {
  asJsonObject,
  readJsonPath,
  validFiniteNumber,
  validStringArray,
  type JsonObject,
} from '@/components/sections/plugin-settings/plugin-config-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
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
  mcpSourceBooleanState,
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

interface SourceFieldProps {
  className?: string;
  disabled: boolean;
  document: JsonObject;
  info?: React.ReactNode;
  label: string;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
}

interface SourceSelectOption {
  label: React.ReactNode;
  value: boolean | string;
}

const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const sourceOptionKey = (value: boolean | string): string => (
  typeof value === 'boolean' ? `boolean:${String(value)}` : `string:${value}`
);

const SourceOptionalBooleanField: React.FC<SourceFieldProps> = ({
  className,
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const value = mcpSourceBooleanState(document, path);
  const selectedLabel = text(`settings.piarium.mcp.structured.sourceValue.${value === 'not-set' ? 'notSet' : value}`);

  return (
    <SettingsFieldRow label={label} info={info} className={className}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'not-set') onRemove(path);
          else onSet(path, next === 'enabled');
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={label}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="not-set">
            {text('settings.piarium.mcp.structured.sourceValue.notSet')}
          </SelectItem>
          <SelectItem value="enabled">
            {text('settings.piarium.mcp.structured.sourceValue.enabled')}
          </SelectItem>
          <SelectItem value="disabled">
            {text('settings.piarium.mcp.structured.sourceValue.disabled')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const SourceOptionalSelectField: React.FC<SourceFieldProps & {
  options: readonly SourceSelectOption[];
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  options,
  path,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const raw = readJsonPath(document, path);
  const selected = options.find((option) => option.value === raw);
  const unsupported = raw !== undefined && selected === undefined;
  const value = selected
    ? sourceOptionKey(selected.value)
    : unsupported
      ? 'unsupported'
      : 'not-set';
  const selectedLabel = selected?.label ?? text(
    unsupported
      ? 'settings.piarium.pluginSettings.field.unsupportedValue'
      : 'settings.piarium.mcp.structured.sourceValue.notSet',
  );

  return (
    <SettingsFieldRow label={label} info={info}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'not-set') {
            onRemove(path);
            return;
          }
          const option = options.find((entry) => sourceOptionKey(entry.value) === next);
          if (option) onSet(path, option.value);
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={label}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {unsupported ? (
            <SelectItem value="unsupported" disabled>
              {text('settings.piarium.pluginSettings.field.unsupportedValue')}
            </SelectItem>
          ) : null}
          <SelectItem value="not-set">
            {text('settings.piarium.mcp.structured.sourceValue.notSet')}
          </SelectItem>
          {options.map((option) => (
            <SelectItem key={sourceOptionKey(option.value)} value={sourceOptionKey(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const SourceStringField: React.FC<SourceFieldProps & {
  placeholder?: string;
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const raw = readJsonPath(document, path);
  return (
    <SettingsFieldRow label={label} info={info} controlClassName="w-full max-w-[24rem]">
      <Input
        value={typeof raw === 'string' ? raw : ''}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          if (next) onSet(path, next);
          else onRemove(path);
        }}
        className="min-w-0 flex-1"
      />
    </SettingsFieldRow>
  );
};

const SourceStringListField: React.FC<SourceFieldProps & {
  placeholder?: string;
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const raw = readJsonPath(document, path);
  const values = typeof raw === 'string' ? [raw] : validStringArray(raw) ?? [];
  return (
    <SettingsFieldRow
      label={label}
      info={info}
      alignEnd={false}
      controlClassName="w-full max-w-[24rem] items-start"
    >
      <Textarea
        value={values.join('\n')}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (next.length > 0) onSet(path, next);
          else onRemove(path);
        }}
        className="min-h-20 min-w-0 flex-1 font-mono"
      />
    </SettingsFieldRow>
  );
};

const SourceOptionalNumberField: React.FC<SourceFieldProps & {
  min?: number;
  unit?: React.ReactNode;
}> = ({
  disabled,
  document,
  info,
  label,
  min,
  onRemove,
  onSet,
  path,
  unit,
}) => {
  const { t } = useI18n();
  const value = validFiniteNumber(readJsonPath(document, path));
  return (
    <SettingsFieldRow label={label} info={info} controlClassName="w-full max-w-[24rem]">
      <NumberInput
        value={value}
        fallbackValue={min}
        disabled={disabled}
        min={min}
        emptyLabel={t('settings.piarium.mcp.structured.sourceValue.notSet' as never)}
        placeholder={t('settings.piarium.mcp.structured.sourceValue.notSet' as never)}
        aria-label={label}
        onClear={() => onRemove(path)}
        onValueChange={(next) => onSet(path, next)}
        containerClassName="w-36"
      />
      {unit ? <span className="typography-meta text-muted-foreground">{unit}</span> : null}
    </SettingsFieldRow>
  );
};

export const McpStructuredConfigEditor: React.FC<McpStructuredConfigEditorProps> = ({
  content,
  disabled,
  onChange,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const document = React.useMemo(() => parseMcpConfigObject(content), [content]);
  const names = React.useMemo(() => mcpServerNames(document), [document]);
  const [newServerName, setNewServerName] = React.useState('');
  const [selectedName, setSelectedName] = React.useState('');

  React.useEffect(() => {
    if (selectedName && names.includes(selectedName)) return;
    setSelectedName(names[0] ?? '');
  }, [names, selectedName]);

  const setValue = React.useCallback((path: readonly string[], value: JsonValue) => {
    onChange(setMcpConfigValue(content, path, value));
  }, [content, onChange]);
  const removeValue = React.useCallback((path: readonly string[]) => {
    onChange(removeMcpConfigValue(content, path));
  }, [content, onChange]);
  const sourceFields = {
    disabled,
    document,
    onRemove: removeValue,
    onSet: setValue,
  };
  const serverPath = ['mcpServers', selectedName] as const;
  const server = asJsonObject(readJsonPath(document, serverPath));
  const transport = selectedName
    ? mcpServerTransport(document, selectedName)
    : 'unconfigured';
  const outputGuard = readJsonPath(document, ['settings', 'outputGuard']);

  const addServer = (): void => {
    const name = newServerName.trim();
    if (!name) return;
    const servers = asJsonObject(readJsonPath(document, ['mcpServers']));
    if (!Object.prototype.hasOwnProperty.call(servers, name)) {
      onChange(setMcpConfigValue(content, ['mcpServers', name], {}));
    }
    setSelectedName(name);
    setNewServerName('');
  };

  const removeServer = (): void => {
    if (!selectedName) return;
    const remaining = names.filter((name) => name !== selectedName);
    onChange(removeMcpConfigValue(content, serverPath));
    setSelectedName(remaining[0] ?? '');
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
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="typography-settings-group-title text-foreground">
          {text('settings.piarium.mcp.structured.title')}
        </h3>
        <p className="typography-meta text-muted-foreground">
          {text('settings.piarium.mcp.structured.description')}
        </p>
      </div>

      <SettingsControlGroup
        title={text('settings.piarium.mcp.structured.servers.title')}
        description={text('settings.piarium.mcp.structured.servers.description')}
        contentClassName="space-y-5"
      >
        <SettingsFieldRow
          label={text('settings.piarium.mcp.structured.editServer')}
          info={text('settings.piarium.mcp.structured.editServer.info')}
        >
          <Select
            value={selectedName}
            disabled={disabled || names.length === 0}
            onValueChange={setSelectedName}
          >
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={text('settings.piarium.mcp.structured.editServer')}
            >
              <SelectValue placeholder={text('settings.piarium.mcp.structured.noServers')} />
            </SelectTrigger>
            <SelectContent>
              {names.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        <SettingsFieldRow
          label={text('settings.piarium.mcp.structured.serverName')}
          info={text('settings.piarium.mcp.structured.addServer.info')}
        >
          <Input
            value={newServerName}
            disabled={disabled}
            aria-label={text('settings.piarium.mcp.structured.serverName')}
            placeholder="github"
            onChange={(event) => setNewServerName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addServer();
            }}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !newServerName.trim()}
            onClick={addServer}
          >
            {text('settings.piarium.mcp.structured.addServer')}
          </Button>
        </SettingsFieldRow>

        {selectedName ? (
          <div className="space-y-5 border-t border-border/60 pt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <code className="block truncate typography-ui-label text-foreground">{selectedName}</code>
                <p className="typography-micro text-muted-foreground">
                  {text('settings.piarium.mcp.structured.selectedSourceOverride')}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={removeServer}
                className="shrink-0 !font-normal text-[var(--status-error)]"
              >
                {text('settings.piarium.recovery.actions.remove')}
              </Button>
            </div>

            <SettingsFieldRow
              label={text('settings.piarium.mcp.structured.transport')}
              description={text('settings.piarium.mcp.structured.transport.info')}
            >
              <Select value={transport} disabled={disabled} onValueChange={selectTransport}>
                <SelectTrigger
                  size="settings"
                  className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                  aria-label={text('settings.piarium.mcp.structured.transport')}
                >
                  <SelectValue>
                    {text(`settings.piarium.mcp.structured.transport.${transport === 'unconfigured'
                      ? 'inherited'
                      : transport === 'stdio'
                        ? 'localCommand'
                        : transport === 'socket'
                          ? 'localSocket'
                          : 'http'}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unconfigured">
                    {text('settings.piarium.mcp.structured.transport.inherited')}
                  </SelectItem>
                  <SelectItem value="stdio">
                    {text('settings.piarium.mcp.structured.transport.localCommand')}
                  </SelectItem>
                  <SelectItem value="http">
                    {text('settings.piarium.mcp.structured.transport.http')}
                  </SelectItem>
                  <SelectItem value="socket">
                    {text('settings.piarium.mcp.structured.transport.localSocket')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsFieldRow>

            {transport === 'stdio' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'command']}
                  label={text('settings.piarium.mcp.structured.server.command')}
                  placeholder="npx"
                />
                <SourceStringListField
                  {...sourceFields}
                  path={[...serverPath, 'args']}
                  label={text('settings.piarium.mcp.structured.server.arguments')}
                  placeholder={'-y\n@modelcontextprotocol/server-github'}
                />
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'cwd']}
                  label={text('settings.piarium.mcp.structured.server.workingDirectory')}
                  placeholder="path/to/working-directory"
                />
              </div>
            ) : null}

            {transport === 'http' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SettingsFieldRow
                  label={text('settings.piarium.mcp.structured.server.url')}
                  description={text('settings.piarium.mcp.structured.urlCredentialReset')}
                  controlClassName="w-full max-w-lg"
                >
                  <Input
                    value={typeof server.url === 'string' ? server.url : ''}
                    disabled={disabled}
                    aria-label={text('settings.piarium.mcp.structured.server.url')}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => setUrl(event.target.value)}
                    className="min-w-0 flex-1"
                  />
                </SettingsFieldRow>
                <SourceOptionalSelectField
                  {...sourceFields}
                  path={[...serverPath, 'auth']}
                  label={text('settings.piarium.mcp.structured.server.authentication')}
                  info={text('settings.piarium.mcp.structured.server.authentication.info')}
                  options={[
                    { value: 'oauth', label: text('settings.piarium.mcp.structured.server.authentication.oauth') },
                    { value: 'bearer', label: text('settings.piarium.mcp.structured.server.authentication.bearer') },
                    { value: false, label: text('settings.piarium.mcp.structured.server.authentication.none') },
                  ]}
                />
              </div>
            ) : null}

            {transport === 'socket' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'socket']}
                  label={text('settings.piarium.mcp.structured.server.socketPath')}
                  placeholder="~/.rmcp-servers/rmcp-mux/sockets/server.sock"
                />
                <p className="typography-meta text-[var(--status-warning)]">
                  {text('settings.piarium.mcp.structured.server.socketWarning')}
                </p>
              </div>
            ) : null}

            <div className="space-y-4 border-t border-border/60 pt-4">
              <SourceOptionalNumberField
                {...sourceFields}
                path={[...serverPath, 'idleTimeout']}
                label={text('settings.piarium.mcp.structured.server.idleTimeout')}
                min={0}
                unit={text('settings.piarium.mcp.structured.unit.minutes')}
              />
              <SourceOptionalNumberField
                {...sourceFields}
                path={[...serverPath, 'requestTimeoutMs']}
                label={text('settings.piarium.mcp.structured.server.requestTimeout')}
                min={0}
                unit={text('settings.piarium.mcp.structured.unit.milliseconds')}
              />
              <SourceOptionalBooleanField
                {...sourceFields}
                path={[...serverPath, 'exposeResources']}
                label={text('settings.piarium.mcp.structured.server.exposeResources')}
                info={text('settings.piarium.mcp.structured.server.exposeResources.info')}
              />
              <SourceOptionalBooleanField
                {...sourceFields}
                path={[...serverPath, 'disabled']}
                label={text('settings.piarium.mcp.structured.server.disabled')}
                info={text('settings.piarium.mcp.structured.server.disabled.info')}
              />
            </div>

            <p className="typography-meta text-muted-foreground">
              {text('settings.piarium.mcp.structured.advancedFields')}
            </p>
          </div>
        ) : (
          <p className="typography-meta text-muted-foreground">
            {text('settings.piarium.mcp.structured.noServers')}
          </p>
        )}
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={text('settings.piarium.mcp.structured.behavior.title')}
        description={text('settings.piarium.mcp.structured.behavior.description')}
        contentClassName="space-y-4"
      >
        <SourceStringListField
          {...sourceFields}
          path={['imports']}
          label={text('settings.piarium.mcp.structured.behavior.imports')}
          info={text('settings.piarium.mcp.structured.behavior.imports.info')}
          placeholder={'cursor\nclaude-code\nclaude-desktop\ncodex\nopencode\nwindsurf\nvscode'}
        />
        <SourceOptionalSelectField
          {...sourceFields}
          path={['settings', 'toolPrefix']}
          label={text('settings.piarium.mcp.structured.behavior.toolPrefix')}
          info={text('settings.piarium.mcp.structured.behavior.toolPrefix.info')}
          options={[
            { value: 'server', label: text('settings.piarium.mcp.structured.behavior.toolPrefix.server') },
            { value: 'short', label: text('settings.piarium.mcp.structured.behavior.toolPrefix.short') },
            { value: 'mcp', label: text('settings.piarium.mcp.structured.behavior.toolPrefix.mcp') },
            { value: 'none', label: text('settings.piarium.mcp.structured.behavior.toolPrefix.none') },
          ]}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'showStatusIcon']}
          label={text('settings.piarium.mcp.structured.behavior.statusIcon')}
          info={text('settings.piarium.mcp.structured.behavior.statusIcon.info')}
        />
        <SourceOptionalSelectField
          {...sourceFields}
          path={['settings', 'mcpFooterStatus']}
          label={text('settings.piarium.mcp.structured.behavior.footerStatus')}
          info={text('settings.piarium.mcp.structured.behavior.footerStatus.info')}
          options={[
            { value: 'full', label: text('settings.piarium.mcp.structured.behavior.footerStatus.full') },
            { value: 'compact', label: text('settings.piarium.mcp.structured.behavior.footerStatus.compact') },
            { value: 'off', label: text('settings.piarium.mcp.structured.behavior.footerStatus.off') },
          ]}
        />
        <SourceOptionalNumberField
          {...sourceFields}
          path={['settings', 'idleTimeout']}
          label={text('settings.piarium.mcp.structured.behavior.idleTimeout')}
          min={0}
          unit={text('settings.piarium.mcp.structured.unit.minutes')}
        />
        <SourceOptionalNumberField
          {...sourceFields}
          path={['settings', 'requestTimeoutMs']}
          label={text('settings.piarium.mcp.structured.behavior.requestTimeout')}
          min={0}
          unit={text('settings.piarium.mcp.structured.unit.milliseconds')}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={text('settings.piarium.mcp.structured.interaction.title')}
        description={text('settings.piarium.mcp.structured.interaction.description')}
        contentClassName="space-y-4"
      >
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'autoAuth']}
          label={text('settings.piarium.mcp.structured.interaction.autoAuth')}
          info={text('settings.piarium.mcp.structured.interaction.autoAuth.info')}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'sampling']}
          label={text('settings.piarium.mcp.structured.interaction.sampling')}
          info={text('settings.piarium.mcp.structured.interaction.sampling.info')}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'samplingAutoApprove']}
          label={text('settings.piarium.mcp.structured.interaction.samplingAutoApprove')}
          info={text('settings.piarium.mcp.structured.interaction.samplingAutoApprove.info')}
        />
        <p className="typography-meta text-[var(--status-warning)]">
          {text('settings.piarium.mcp.structured.interaction.samplingAutoApprove.warning')}
        </p>
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'elicitation']}
          label={text('settings.piarium.mcp.structured.interaction.elicitation')}
          info={text('settings.piarium.mcp.structured.interaction.elicitation.info')}
        />
        {typeof outputGuard === 'object' && outputGuard !== null && !Array.isArray(outputGuard) ? (
          <p className="typography-meta text-muted-foreground">
            {text('settings.piarium.mcp.structured.outputGuardAdvanced')}
          </p>
        ) : (
          <SourceOptionalBooleanField
            {...sourceFields}
            path={['settings', 'outputGuard']}
            label={text('settings.piarium.mcp.structured.interaction.outputGuard')}
            info={text('settings.piarium.mcp.structured.interaction.outputGuard.info')}
          />
        )}
        <p className="typography-meta text-muted-foreground">
          {text('settings.piarium.mcp.structured.rawAdvancedFields')}
        </p>
      </SettingsControlGroup>
    </div>
  );
};
