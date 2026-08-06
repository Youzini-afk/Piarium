import React from 'react';
import { json } from '@codemirror/lang-json';
import type {
  PackageDescriptor,
  PiConfigTextDocumentSnapshot,
  PiConfigTextRoot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n, type I18nParams } from '@/lib/i18n';
import {
  getPiConfigTextDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import {
  findPiPackage,
  listPiPackages,
} from '@/lib/pi-runtime/packages';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  mcpServerCommandArgument,
  parseMcpAdapterStatus,
  type McpAdapterServerSnapshot,
  type McpAdapterServerStatus,
} from './mcpAdapterStatus';
import { McpStructuredConfigEditor } from './McpStructuredConfigEditor';
import {
  canLeaveMcpConfigSource,
  mcpServerNames,
  mcpServerSourceConflicts,
  parseMcpConfigObject,
  prepareMcpConfigForSave,
} from './mcp-config-model';

const MCP_PACKAGE_SOURCE = 'npm:pi-mcp-adapter';

interface McpConfigTarget {
  displayPath: string;
  id: string;
  nameKey: string;
  path: string;
  precedence: number;
  root: PiConfigTextRoot;
}

const MCP_CONFIG_TARGETS: McpConfigTarget[] = [
  {
    displayPath: '~/.config/mcp/mcp.json',
    id: 'shared-global',
    nameKey: 'settings.piarium.mcp.config.source.sharedGlobal',
    path: '.config/mcp/mcp.json',
    precedence: 1,
    root: 'home',
  },
  {
    displayPath: '~/.agents/mcp.json',
    id: 'agents-global',
    nameKey: 'settings.piarium.mcp.config.source.agentsGlobal',
    path: '.agents/mcp.json',
    precedence: 2,
    root: 'home',
  },
  {
    displayPath: '~/.agents/mcp/mcp.json',
    id: 'agents-nested-global',
    nameKey: 'settings.piarium.mcp.config.source.agentsNestedGlobal',
    path: '.agents/mcp/mcp.json',
    precedence: 3,
    root: 'home',
  },
  {
    displayPath: 'Pi agent dir/mcp.json',
    id: 'pi-global',
    nameKey: 'settings.piarium.mcp.config.source.piGlobal',
    path: 'mcp.json',
    precedence: 4,
    root: 'agent',
  },
  {
    displayPath: '.mcp.json',
    id: 'shared-project',
    nameKey: 'settings.piarium.mcp.config.source.sharedProject',
    path: '.mcp.json',
    precedence: 5,
    root: 'project',
  },
  {
    displayPath: '.pi/mcp.json',
    id: 'pi-project',
    nameKey: 'settings.piarium.mcp.config.source.piProject',
    path: '.pi/mcp.json',
    precedence: 6,
    root: 'project',
  },
];

const statusTone = (status: McpAdapterServerStatus): string => {
  if (status === 'connected') return 'text-[var(--status-success)] bg-[var(--status-success)]/10';
  if (status === 'failed') return 'text-[var(--status-error)] bg-[var(--status-error)]/10';
  if (status === 'needs-auth') return 'text-[var(--status-warning)] bg-[var(--status-warning)]/10';
  return 'text-muted-foreground bg-muted';
};

const statusLabelKey: Record<McpAdapterServerStatus, string> = {
  cached: 'settings.piarium.mcp.runtime.status.cached',
  connected: 'settings.piarium.mcp.runtime.status.connected',
  disabled: 'settings.piarium.mcp.runtime.status.disabled',
  failed: 'settings.piarium.mcp.runtime.status.failed',
  'needs-auth': 'settings.piarium.mcp.runtime.status.needsAuth',
  'not-connected': 'settings.piarium.mcp.runtime.status.notConnected',
};

const McpConfigEditor: React.FC<{ runtimeTarget: RuntimeContextTarget }> = ({ runtimeTarget }) => {
  const { t } = useI18n();
  const text = (key: string, params?: I18nParams): string => t(key as never, params);
  const [targetId, setTargetId] = React.useState('pi-project');
  const [snapshot, setSnapshot] = React.useState<PiConfigTextDocumentSnapshot | null>(null);
  const [draft, setDraft] = React.useState('{}\n');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [sourceServerIndex, setSourceServerIndex] = React.useState<Record<string, string[]>>({});
  const generationRef = React.useRef(0);
  const sourceIndexGenerationRef = React.useRef(0);
  const editorExtensions = React.useMemo(() => [json()], []);
  const target = MCP_CONFIG_TARGETS.find((candidate) => candidate.id === targetId)
    ?? MCP_CONFIG_TARGETS[0]!;

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    setSnapshot(null);
    try {
      const next = await getPiConfigTextDocument(
        runtimeTarget,
        target.root,
        target.path,
        'jsonc',
      );
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setSnapshot(next);
      setDraft(next.content);
    } catch (error) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) setLoading(false);
    }
  }, [runtimeTarget, target.path, target.root]);

  const loadSourceIndex = React.useCallback(async () => {
    const generation = ++sourceIndexGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    const entries = await Promise.all(MCP_CONFIG_TARGETS.map(async (candidate) => {
      try {
        const sourceSnapshot = await getPiConfigTextDocument(
          runtimeTarget,
          candidate.root,
          candidate.path,
          'jsonc',
        );
        const names = mcpServerNames(parseMcpConfigObject(sourceSnapshot.content));
        return [candidate.id, names] as const;
      } catch {
        return [candidate.id, []] as const;
      }
    }));
    if (generation !== sourceIndexGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
    setSourceServerIndex(Object.fromEntries(entries));
  }, [runtimeTarget]);

  React.useEffect(() => {
    setDraft('{}\n');
    void load();
  }, [load]);

  React.useEffect(() => {
    setSourceServerIndex({});
    void loadSourceIndex();
  }, [loadSourceIndex]);

  const parsed = React.useMemo(() => {
    const errors: ParseError[] = [];
    const document = parse(draft.replace(/^\uFEFF/, ''), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      const first = errors[0];
      return {
        error: first
          ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
          : 'Invalid JSONC',
        valid: false,
      };
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return { error: 'Configuration root must be an object', valid: false };
    }
    return { error: null, valid: true };
  }, [draft]);
  const dirty = snapshot !== null && draft !== snapshot.content;
  const projectBlocked = target.root === 'project' && snapshot?.projectTrusted === false;
  const sourceConflicts = React.useMemo(() => {
    const index = { ...sourceServerIndex };
    if (parsed.valid) index[target.id] = mcpServerNames(parseMcpConfigObject(draft));
    return mcpServerSourceConflicts(index, MCP_CONFIG_TARGETS.map((candidate) => candidate.id));
  }, [draft, parsed.valid, sourceServerIndex, target.id]);

  const save = React.useCallback(async () => {
    if (!snapshot || !parsed.valid || !dirty || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    const contentToSave = prepareMcpConfigForSave(snapshot.content, draft);
    setSaving(true);
    try {
      const next = await updatePiConfigTextDocument(
        runtimeTarget,
        target.root,
        snapshot.path,
        'jsonc',
        contentToSave,
        snapshot.revision,
      );
      if (runtimeKey !== getRuntimeKey()) return;
      setSnapshot(next);
      setDraft(next.content);
      void loadSourceIndex();
    } catch (error) {
      console.error('Failed to save MCP adapter configuration:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, loadSourceIndex, parsed.valid, projectBlocked, runtimeTarget, saving, snapshot, t, target.root]);

  return (
    <SettingsSection
      title={t('settings.piarium.mcp.config.title')}
      info={t('settings.piarium.mcp.config.description')}
      settingsItem="mcp.configuration"
      divider={false}
    >
      <div className="space-y-4">
        <SettingsFieldRow
          label={text('settings.piarium.mcp.config.source.label')}
          info={text('settings.piarium.mcp.config.source.info')}
          alignEnd={false}
          controlClassName="w-full max-w-lg"
        >
          <Select
            value={targetId}
            disabled={loading || saving || !canLeaveMcpConfigSource(dirty)}
            onValueChange={(next) => {
              if (canLeaveMcpConfigSource(dirty)) setTargetId(next);
            }}
          >
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={text('settings.piarium.mcp.config.source.label')}
            >
              <SelectValue>{text(target.nameKey)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MCP_CONFIG_TARGETS.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  <span className="flex min-w-0 flex-col items-start">
                    <span>{text(candidate.nameKey)}</span>
                    <span className="font-mono typography-micro text-muted-foreground">
                      {candidate.displayPath}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={dirty ? 'outline' : 'ghost'}
            size="sm"
            disabled={loading || saving}
            onClick={() => void Promise.all([load(), loadSourceIndex()])}
            className="!font-normal gap-1.5"
          >
            <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {dirty
              ? text('settings.piarium.mcp.config.actions.reloadDiscard')
              : text('settings.piarium.mcp.config.actions.reload')}
          </Button>
        </SettingsFieldRow>

        <div className="space-y-1 typography-meta text-muted-foreground">
          <p>
            <span className="text-foreground">{text('settings.piarium.mcp.config.source.current')}:</span>{' '}
            {text(target.nameKey)}
          </p>
          <p>
            {text('settings.piarium.mcp.config.source.precedence', {
              position: target.precedence,
              total: MCP_CONFIG_TARGETS.length,
            })}
          </p>
          <p className="break-all font-mono typography-micro">
            {text('settings.piarium.mcp.config.source.path')}: {snapshot?.path ?? target.displayPath}
          </p>
        </div>

        {dirty ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {text('settings.piarium.mcp.config.source.dirtyGuard')}
          </p>
        ) : null}

        {sourceConflicts.length > 0 ? (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <div className="space-y-1">
              <h3 className="typography-settings-group-title text-foreground">
                {text('settings.piarium.mcp.config.conflicts.title')}
              </h3>
              <p className="typography-meta text-muted-foreground">
                {text('settings.piarium.mcp.config.conflicts.description')}
              </p>
            </div>
            <div className="divide-y divide-border/60">
              {sourceConflicts.map(([serverName, sourceIds]) => (
                <div key={serverName} className="grid gap-1 py-2.5 @xl:grid-cols-[12rem_minmax(0,1fr)] @xl:gap-4">
                  <code className="break-all typography-ui-label text-foreground">{serverName}</code>
                  <p className="typography-meta text-muted-foreground">
                    {sourceIds.map((sourceId) => {
                      const source = MCP_CONFIG_TARGETS.find((candidate) => candidate.id === sourceId);
                      return source ? text(source.nameKey) : sourceId;
                    }).join(' → ')}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {parsed.valid ? (
          <McpStructuredConfigEditor
            content={draft}
            disabled={loading || saving || projectBlocked}
            onChange={setDraft}
          />
        ) : null}

        <Collapsible open={rawOpen || !parsed.valid} onOpenChange={setRawOpen}>
          <CollapsibleTrigger disabled={!parsed.valid} className="border border-border/60 px-3 py-2.5">
            <span className="typography-ui-label text-foreground">
              {rawOpen || !parsed.valid
                ? text('settings.piarium.mcp.config.raw.hide')
                : text('settings.piarium.mcp.config.raw.show')}
            </span>
            <Icon name={rawOpen || !parsed.valid ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="h-80 overflow-hidden rounded-md border border-border/60 bg-background">
              <CodeMirrorEditor
                value={draft}
                onChange={setDraft}
                extensions={editorExtensions}
                className="h-full"
                enableSearch
                readOnly={loading || saving || projectBlocked}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {parsed.error && (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.piarium.mcp.config.invalid')}
          </p>
        )}
        {projectBlocked && !loading && (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.piarium.mcp.config.untrusted')}
          </p>
        )}
        {loadError && (
          <p className="break-words typography-meta text-[var(--status-error)]">{loadError}</p>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={loading || saving || !dirty || !parsed.valid || projectBlocked}
            onClick={() => void save()}
          >
            {saving
              ? t('settings.common.actions.saving')
              : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
};

const ServerCard: React.FC<{
  busy: string | null;
  onCommand: (action: string, serverName: string, command: string, reload?: boolean) => void;
  server: McpAdapterServerSnapshot;
}> = ({ busy, onCommand, server }) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const actionBusy = busy?.endsWith(`:${server.name}`) === true;
  const argument = mcpServerCommandArgument(server.name);
  const commandUnsupported = argument === null;
  return (
    <div className="py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate typography-ui-label text-foreground">{server.name}</span>
            <span className={cn(
              'rounded-full px-2 py-0.5 typography-micro font-medium',
              statusTone(server.status),
            )}>
              {text(statusLabelKey[server.status])}
            </span>
          </div>
          <p className="typography-micro text-muted-foreground">
            {t('settings.piarium.mcp.runtime.serverCounts', {
              tools: server.toolCount,
              resources: server.resourceCount ?? 0,
            })}
            {server.failedAgoSeconds === undefined
              ? ''
              : ` · ${t('settings.piarium.mcp.runtime.failedAgo', { seconds: server.failedAgoSeconds })}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!server.disabled && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={actionBusy || commandUnsupported}
              onClick={() => onCommand('reconnect', server.name, `/mcp reconnect ${argument}`)}
              className="!font-normal"
            >
              {t('settings.piarium.mcp.actions.reconnect')}
            </Button>
          )}
          {server.status === 'needs-auth' && (
            <Button
              type="button"
              size="xs"
              disabled={actionBusy || commandUnsupported}
              onClick={() => onCommand('authorize', server.name, `/mcp-auth ${argument}`)}
              className="!font-normal"
            >
              {t('settings.piarium.mcp.actions.authorize')}
            </Button>
          )}
          {!server.disabled && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={actionBusy || commandUnsupported}
              onClick={() => onCommand('logout', server.name, `/mcp logout ${argument}`)}
              className="!font-normal text-muted-foreground"
            >
              {t('settings.piarium.mcp.actions.logout')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={actionBusy || commandUnsupported}
            onClick={() => onCommand(
              server.disabled ? 'enable' : 'disable',
              server.name,
              `/mcp ${server.disabled ? 'enable' : 'disable'} ${argument}`,
              true,
            )}
            className="!font-normal text-muted-foreground"
          >
            {server.disabled
              ? t('settings.piarium.mcp.actions.enable')
              : t('settings.piarium.mcp.actions.disable')}
          </Button>
        </div>
      </div>
      {commandUnsupported ? (
        <p className="mt-2 typography-micro text-[var(--status-warning)]">
          {t('settings.piarium.mcp.runtime.commandNameUnsupported')}
        </p>
      ) : null}
    </div>
  );
};

export const McpPage: React.FC = () => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const sessionCwd = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.records[state.currentSessionId]?.snapshot?.cwd
  ));
  const extensionState = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.records[state.currentSessionId]?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL]
  ));
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const cwd = currentDirectory || sessionCwd || '';
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    currentSessionId ? { sessionId: currentSessionId } : { cwd }
  ), [currentSessionId, cwd]);
  const status = React.useMemo(() => parseMcpAdapterStatus(extensionState), [extensionState]);
  const [packages, setPackages] = React.useState<PackageDescriptor[]>([]);
  const [packagesLoading, setPackagesLoading] = React.useState(false);
  const [commandAction, setCommandAction] = React.useState<string | null>(null);
  const packageGenerationRef = React.useRef(0);
  const configuredPackage = findPiPackage(packages, 'pi-mcp-adapter');

  const refreshPackages = React.useCallback(async () => {
    const generation = ++packageGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    setPackagesLoading(true);
    try {
      const next = await listPiPackages(runtimeTarget);
      if (generation !== packageGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      setPackages(next);
    } catch (error) {
      if (generation === packageGenerationRef.current && runtimeKey === getRuntimeKey()) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === packageGenerationRef.current && runtimeKey === getRuntimeKey()) {
        setPackagesLoading(false);
      }
    }
  }, [runtimeTarget]);

  React.useEffect(() => {
    void refreshPackages();
  }, [refreshPackages]);

  const runCommand = React.useCallback(async (
    action: string,
    command: string,
    reload = false,
  ) => {
    if (!currentSessionId) return;
    setCommandAction(action);
    try {
      await executeCommand(currentSessionId, command);
      if (reload) await executeCommand(currentSessionId, '/reload');
    } catch (error) {
      console.error(`Failed to execute Pi MCP command ${command}:`, error);
      toast.error(error instanceof Error ? error.message : t('settings.piarium.mcp.toast.commandFailed'));
    } finally {
      setCommandAction(null);
    }
  }, [currentSessionId, executeCommand, t]);

  const runServerCommand = React.useCallback((
    action: string,
    serverName: string,
    command: string,
    reload = false,
  ) => {
    setCommandAction(`${action}:${serverName}`);
    void (async () => {
      try {
        if (!currentSessionId) return;
        await executeCommand(currentSessionId, command);
        if (reload) await executeCommand(currentSessionId, '/reload');
      } catch (error) {
        console.error(`Failed to execute Pi MCP command ${command}:`, error);
        toast.error(error instanceof Error ? error.message : t('settings.piarium.mcp.toast.commandFailed'));
      } finally {
        setCommandAction(null);
      }
    })();
  }, [currentSessionId, executeCommand, t]);

  return (
    <SettingsPageLayout
      title={t('settings.page.mcp.title')}
      description={t('settings.piarium.mcp.description')}
      showSaveStatus={false}
      headerEnd={currentSessionId ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={commandAction !== null}
          onClick={() => void runCommand('panel', '/mcp')}
          className="!font-normal"
        >
          {t('settings.piarium.mcp.actions.openPanel')}
        </Button>
      ) : undefined}
    >
      <McpConfigEditor runtimeTarget={runtimeTarget} />

      <SettingsSection
        title={t('settings.piarium.mcp.runtime.title')}
        info={t('settings.piarium.mcp.runtime.description')}
        settingsItem="mcp.runtime"
      >
        {!currentSessionId ? (
          <div className="rounded-lg border border-border/60 px-4 py-6 text-center typography-meta text-muted-foreground">
            {t('settings.piarium.mcp.runtime.noSession')}
          </div>
        ) : extensionState === undefined ? (
          <div className="rounded-lg border border-border/60 px-4 py-6 text-center typography-meta text-muted-foreground">
            {t('settings.piarium.mcp.runtime.noStatus')}
          </div>
        ) : status === null ? (
          <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-3 py-3">
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.piarium.mcp.runtime.unsupported')}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer typography-micro text-muted-foreground">
                {text('settings.piarium.mcp.runtime.rawSnapshot')}
              </summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all typography-micro">
                {JSON.stringify(extensionState, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 border-y border-border/60 @xl:grid-cols-4">
              {[
                [t('settings.piarium.mcp.runtime.servers'), status.servers.length],
                [t('settings.piarium.mcp.runtime.connected'), status.connectedCount],
                [t('settings.piarium.mcp.runtime.tools'), status.totalTools],
                [t('settings.piarium.mcp.runtime.resources'), status.totalResources],
              ].map(([label, value]) => (
                <div key={String(label)} className="px-3 py-2">
                  <p className="typography-micro text-muted-foreground">{label}</p>
                  <p className="typography-settings-group-title text-foreground">{value}</p>
                </div>
              ))}
            </div>
            {status.servers.length === 0 ? (
              <div className="rounded-lg border border-border/60 px-4 py-6 text-center typography-meta text-muted-foreground">
                {t('settings.piarium.mcp.runtime.empty')}
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {status.servers.map((server) => (
                  <ServerCard
                    key={server.name}
                    server={server}
                    busy={commandAction}
                    onCommand={runServerCommand}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.piarium.mcp.package.title')}
        info={t('settings.piarium.mcp.package.description')}
        settingsItem="mcp.package"
      >
        <div className="py-1">
          <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Icon
                  name="plug-2"
                  className={configuredPackage?.installed
                    ? 'size-4 text-[var(--status-success)]'
                    : configuredPackage
                      ? 'size-4 text-[var(--status-warning)]'
                    : 'size-4 text-muted-foreground'}
                />
                <span className="typography-ui-label text-foreground">pi-mcp-adapter</span>
                {!packagesLoading && (
                  <span className={configuredPackage?.installed
                    ? 'typography-micro text-[var(--status-success)]'
                    : configuredPackage
                      ? 'typography-micro text-[var(--status-warning)]'
                    : 'typography-micro text-muted-foreground'}>
                    {configuredPackage?.installed
                      ? t('settings.piarium.recovery.status.configured')
                      : configuredPackage
                        ? t('settings.piarium.plugins.status.missing')
                      : t('settings.piarium.recovery.status.notConfigured')}
                  </span>
                )}
              </div>
              <p className="break-all font-mono typography-micro text-muted-foreground">
                {configuredPackage?.source ?? MCP_PACKAGE_SOURCE}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={packagesLoading}
                onClick={() => setSettingsPage('plugins')}
                className="!font-normal"
              >
                {t('settings.piarium.pluginSettings.actions.openPackages')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

    </SettingsPageLayout>
  );
};
