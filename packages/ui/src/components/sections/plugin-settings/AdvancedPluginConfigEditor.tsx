import React from 'react';
import { json } from '@codemirror/lang-json';
import type {
  JsonValue,
  PiConfigScope,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  getPiConfigDocument,
  getPiConfigTextDocument,
  updatePiConfigDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import {
  createPiJsonObjectChanges,
  formatPiJsonObjectDocument,
  parsePiJsonObjectDocument,
} from '@/lib/pi-runtime/json-object-document';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { asJsonObject, type JsonObject } from './plugin-config-model';

interface AdvancedPluginConfigEditorProps {
  cwd: string;
  sessionId?: string | null;
}

type ConfigTarget =
  | 'subagents-settings-global'
  | 'subagents-settings-project'
  | 'subagents-runtime'
  | 'workspace-history-global'
  | 'workspace-history-project'
  | 'wtf-global'
  | 'magic-user'
  | 'magic-project'
  | 'web-access-agent'
  | 'custom';
type StaticConfigTarget = Exclude<ConfigTarget, 'custom'>;

interface SettingsTargetDefinition {
  kind: 'settings';
  property: string;
  scope: PiConfigScope;
}

interface DocumentTargetDefinition {
  kind: 'document';
  path: string;
  scope: PiConfigScope;
}

interface TextTargetDefinition {
  format: PiConfigTextFormat;
  kind: 'text';
  paths: readonly string[];
  root: PiConfigTextRoot;
}

type TargetDefinition = SettingsTargetDefinition | DocumentTargetDefinition | TextTargetDefinition;

const TARGETS: Record<StaticConfigTarget, TargetDefinition> = {
  'magic-project': {
    format: 'jsonc',
    kind: 'text',
    paths: ['.cortexkit/magic-context.jsonc', '.cortexkit/magic-context.json'],
    root: 'project',
  },
  'magic-user': {
    format: 'jsonc',
    kind: 'text',
    paths: ['cortexkit/magic-context.jsonc', 'cortexkit/magic-context.json'],
    root: 'user-config',
  },
  'subagents-runtime': {
    kind: 'document',
    path: 'extensions/subagent/config.json',
    scope: 'global',
  },
  'subagents-settings-global': {
    kind: 'settings',
    property: 'subagents',
    scope: 'global',
  },
  'subagents-settings-project': {
    kind: 'settings',
    property: 'subagents',
    scope: 'project',
  },
  'web-access-agent': {
    format: 'json',
    kind: 'text',
    paths: ['web-search.json'],
    root: 'agent',
  },
  'workspace-history-global': {
    kind: 'settings',
    property: 'workspaceHistory',
    scope: 'global',
  },
  'workspace-history-project': {
    kind: 'settings',
    property: 'workspaceHistory',
    scope: 'project',
  },
  'wtf-global': {
    kind: 'document',
    path: 'wtf.json',
    scope: 'global',
  },
};

interface LoadedDocument {
  content: string;
  document: JsonObject | null;
  path: string;
  projectTrusted: boolean;
  textSnapshot: PiConfigTextDocumentSnapshot | null;
}

const emptyLoadedDocument = (): LoadedDocument => ({
  content: '{}\n',
  document: {},
  path: '',
  projectTrusted: false,
  textSnapshot: null,
});

const isProjectTarget = (definition: TargetDefinition): boolean => (
  (definition.kind === 'text' && definition.root === 'project')
  || (definition.kind !== 'text' && definition.scope === 'project')
);

const loadTextDocument = async (
  runtimeTarget: RuntimeContextTarget,
  definition: TextTargetDefinition,
): Promise<PiConfigTextDocumentSnapshot> => {
  let fallback: PiConfigTextDocumentSnapshot | undefined;
  for (const path of definition.paths) {
    const snapshot = await getPiConfigTextDocument(
      runtimeTarget,
      definition.root,
      path,
      definition.format,
    );
    fallback ??= snapshot;
    if (snapshot.exists) return snapshot;
  }
  if (fallback) return fallback;
  throw new Error('Could not resolve the plugin configuration path');
};

export const AdvancedPluginConfigEditor: React.FC<AdvancedPluginConfigEditorProps> = ({ cwd, sessionId }) => {
  const { t } = useI18n();
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    sessionId ? { sessionId } : { cwd }
  ), [cwd, sessionId]);
  const runtimeTargetKey = sessionId ? `session:${sessionId}` : `cwd:${cwd}`;
  const runtimeTargetKeyRef = React.useRef(runtimeTargetKey);
  runtimeTargetKeyRef.current = runtimeTargetKey;
  const [target, setTarget] = React.useState<ConfigTarget>('subagents-settings-global');
  const [customPath, setCustomPath] = React.useState('');
  const [customRoot, setCustomRoot] = React.useState<PiConfigTextRoot>('agent');
  const [customFormat, setCustomFormat] = React.useState<PiConfigTextFormat>('jsonc');
  const [customSelection, setCustomSelection] = React.useState<TextTargetDefinition>({
    format: 'jsonc',
    kind: 'text',
    paths: [],
    root: 'agent',
  });
  const [loaded, setLoaded] = React.useState<LoadedDocument>(emptyLoadedDocument);
  const [draft, setDraft] = React.useState('{}\n');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const editorExtensions = React.useMemo(() => [json()], []);

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const actionTargetKey = runtimeTargetKey;
    const runtimeKey = getRuntimeKey();
    const definition = target === 'custom' ? customSelection : TARGETS[target];
    setLoading(true);
    setLoadError(null);
    try {
      if (definition.kind === 'text' && definition.paths.length === 0) {
        if (
          generation === generationRef.current
          && actionTargetKey === runtimeTargetKeyRef.current
          && runtimeKey === getRuntimeKey()
        ) {
          setLoaded(emptyLoadedDocument());
          setDraft('{}\n');
        }
        return;
      }
      let next: LoadedDocument;
      if (definition.kind === 'text') {
        const snapshot = await loadTextDocument(runtimeTarget, definition);
        next = {
          content: snapshot.content,
          document: null,
          path: `${snapshot.root}:${snapshot.path}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: snapshot,
        };
      } else if (definition.kind === 'document') {
        const snapshot = await getPiConfigDocument(runtimeTarget, definition.scope, definition.path);
        next = {
          content: formatPiJsonObjectDocument(snapshot.document),
          document: snapshot.document,
          path: `${snapshot.scope}:${snapshot.path}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: null,
        };
      } else {
        const snapshot = await getPiSettings(runtimeTarget);
        const document = asJsonObject(snapshot[definition.scope][definition.property]);
        next = {
          content: formatPiJsonObjectDocument(document),
          document,
          path: `${definition.scope}:settings.json#${definition.property}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: null,
        };
      }
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoaded(next);
      setDraft(next.content);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoaded(emptyLoadedDocument());
      setDraft('{}\n');
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === runtimeTargetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [customSelection, runtimeTarget, runtimeTargetKey, target]);

  React.useEffect(() => {
    setLoaded(emptyLoadedDocument());
    setDraft('{}\n');
    void load();
  }, [load]);

  const definition = target === 'custom' ? customSelection : TARGETS[target];
  const parsed = React.useMemo(() => {
    try {
      if (definition.kind !== 'text') {
        return { document: parsePiJsonObjectDocument(draft), error: null };
      }
      const errors: ParseError[] = [];
      const value = parse(draft.replace(/^\uFEFF/, ''), errors, {
        allowTrailingComma: definition.format === 'jsonc',
        disallowComments: definition.format === 'json',
      }) as JsonValue | undefined;
      if (errors.length > 0) {
        const first = errors[0];
        throw new Error(first
          ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
          : `Invalid ${definition.format.toUpperCase()}`);
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Configuration root must be an object');
      }
      return { document: value as JsonObject, error: null };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [definition, draft]);
  const changes = React.useMemo(() => (
    definition.kind !== 'text' && parsed.document && loaded.document
      ? createPiJsonObjectChanges(loaded.document, parsed.document)
      : { remove: [], set: {} }
  ), [definition.kind, loaded.document, parsed.document]);
  const dirty = definition.kind === 'text'
    ? draft !== loaded.content
    : changes.remove.length > 0 || Object.keys(changes.set).length > 0;
  const projectBlocked = isProjectTarget(definition) && !loaded.projectTrusted;

  const save = React.useCallback(async () => {
    if (!parsed.document || !dirty || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    const generation = generationRef.current;
    const actionTargetKey = runtimeTargetKey;
    const currentDefinition = target === 'custom' ? customSelection : TARGETS[target];
    const isCurrent = () => (
      generation === generationRef.current
      && actionTargetKey === runtimeTargetKeyRef.current
      && runtimeKey === getRuntimeKey()
    );
    setSaving(true);
    try {
      if (currentDefinition.kind === 'text') {
        const current = loaded.textSnapshot;
        if (!current) throw new Error('The configuration document is not loaded');
        const snapshot = await updatePiConfigTextDocument(
          runtimeTarget,
          current.root,
          current.path,
          current.format,
          draft,
          current.revision,
        );
        if (!isCurrent()) return;
        const next = {
          content: snapshot.content,
          document: null,
          path: `${snapshot.root}:${snapshot.path}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: snapshot,
        } satisfies LoadedDocument;
        setLoaded(next);
        setDraft(next.content);
      } else if (currentDefinition.kind === 'document') {
        const snapshot = await updatePiConfigDocument(
          runtimeTarget,
          currentDefinition.scope,
          currentDefinition.path,
          changes,
        );
        if (!isCurrent()) return;
        const content = formatPiJsonObjectDocument(snapshot.document);
        setLoaded({
          content,
          document: snapshot.document,
          path: `${snapshot.scope}:${snapshot.path}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: null,
        });
        setDraft(content);
      } else {
        const propertyChanges = Object.keys(parsed.document).length === 0
          ? { remove: [currentDefinition.property], set: {} }
          : { remove: [], set: { [currentDefinition.property]: parsed.document } };
        const snapshot = await updatePiSettings(
          runtimeTarget,
          currentDefinition.scope,
          propertyChanges,
        );
        if (!isCurrent()) return;
        const document = asJsonObject(snapshot[currentDefinition.scope][currentDefinition.property]);
        const content = formatPiJsonObjectDocument(document);
        setLoaded({
          content,
          document,
          path: `${currentDefinition.scope}:settings.json#${currentDefinition.property}`,
          projectTrusted: snapshot.projectTrusted,
          textSnapshot: null,
        });
        setDraft(content);
      }
      toast.success(t('settings.common.status.saved'));
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to save advanced Pi plugin configuration:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }, [changes, customSelection, dirty, draft, loaded.textSnapshot, parsed.document, projectBlocked, runtimeTarget, runtimeTargetKey, saving, t, target]);

  const customSelectionDirty = target === 'custom' && (
    customPath.trim() !== (customSelection.paths[0] ?? '')
    || customRoot !== customSelection.root
    || customFormat !== customSelection.format
  );

  return (
    <div className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Icon name="code-box" className="size-4 text-muted-foreground" />
            <h4 className="typography-ui-label text-foreground">
              {t('settings.piarium.pluginSettings.advanced.title')}
            </h4>
          </div>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.advanced.description')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="settings" className="min-w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="subagents-settings-global">pi-subagents · settings · {t('settings.common.scope.global')}</SelectItem>
              <SelectItem value="subagents-settings-project">pi-subagents · settings · {t('settings.common.scope.project')}</SelectItem>
              <SelectItem value="subagents-runtime">pi-subagents · runtime config</SelectItem>
              <SelectItem value="workspace-history-global">pi-workspace-history · {t('settings.common.scope.global')}</SelectItem>
              <SelectItem value="workspace-history-project">pi-workspace-history · {t('settings.common.scope.project')}</SelectItem>
              <SelectItem value="wtf-global">pi-wtf · wtf.json</SelectItem>
              <SelectItem value="magic-user">Magic Context · user JSONC</SelectItem>
              <SelectItem value="magic-project">Magic Context · project JSONC</SelectItem>
              <SelectItem value="web-access-agent">Web Access · web-search.json</SelectItem>
              <SelectItem value="custom">{t('settings.piarium.pluginSettings.advanced.custom')}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void load()}
            disabled={loading || saving}
            className="!font-normal gap-1.5"
          >
            <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        </div>
      </div>

      {target === 'custom' ? (
        <div className="grid grid-cols-1 gap-2 rounded-lg bg-[var(--surface-elevated)] p-3 @xl:grid-cols-[10rem_8rem_minmax(0,1fr)_auto]">
          <Select value={customRoot} disabled={saving} onValueChange={setCustomRoot}>
            <SelectTrigger size="settings"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Pi agent</SelectItem>
              <SelectItem value="user-config">User config</SelectItem>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="home">Home</SelectItem>
            </SelectContent>
          </Select>
          <Select value={customFormat} disabled={saving} onValueChange={setCustomFormat}>
            <SelectTrigger size="settings"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="jsonc">JSONC</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={customPath}
            disabled={saving}
            onChange={(event) => setCustomPath(event.target.value)}
            placeholder={t('settings.piarium.pluginSettings.advanced.customPath')}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !customPath.trim()}
            onClick={() => setCustomSelection({
              format: customFormat,
              kind: 'text',
              paths: [customPath.trim()],
              root: customRoot,
            })}
          >
            {t('settings.piarium.pluginSettings.advanced.loadCustom')}
          </Button>
        </div>
      ) : null}

      <p className="break-all font-mono typography-micro text-muted-foreground">{loaded.path}</p>

      <div className="h-80 overflow-hidden rounded-md border border-border/60 bg-background">
        <CodeMirrorEditor
          value={draft}
          onChange={setDraft}
          extensions={editorExtensions}
          className="h-full"
          enableSearch
          readOnly={loading || projectBlocked}
        />
      </div>

      {parsed.error ? (
        <p className="typography-meta text-[var(--status-error)]">
          {t('settings.piarium.recovery.pluginSettings.invalidJson')}: {parsed.error}
        </p>
      ) : null}
      {projectBlocked && !loading ? (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.recovery.pluginSettings.projectUntrusted')}
        </p>
      ) : null}
      {loadError ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{loadError}</p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={loading || saving || !dirty || Boolean(parsed.error) || projectBlocked || customSelectionDirty}
          onClick={() => void save()}
        >
          {saving
            ? t('settings.common.actions.saving')
            : t('settings.common.actions.saveChanges')}
        </Button>
      </div>
    </div>
  );
};
