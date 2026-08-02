import React from 'react';
import { json } from '@codemirror/lang-json';
import type {
  PiConfigTextDocumentSnapshot,
  PiSettingsSnapshot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
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
  type PiJsonObjectDocument,
} from '@/lib/pi-runtime/json-object-document';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey } from '@/lib/runtime-switch';

interface PiPluginConfigEditorProps {
  cwd: string;
  sessionId?: string | null;
}

type JsonConfigTarget = 'settings-global' | 'settings-project' | 'wtf-global';
type TextConfigTarget = 'magic-user' | 'magic-project' | 'web-access-agent';
type ConfigTarget = JsonConfigTarget | TextConfigTarget;
type ConfigDocuments = Record<JsonConfigTarget, PiJsonObjectDocument>;
type TextConfigDocuments = Record<TextConfigTarget, PiConfigTextDocumentSnapshot>;
type ConfigDrafts = Record<ConfigTarget, string>;

const TEXT_TARGETS = {
  'magic-project': {
    format: 'jsonc',
    paths: ['.cortexkit/magic-context.jsonc', '.cortexkit/magic-context.json'],
    root: 'project',
  },
  'magic-user': {
    format: 'jsonc',
    paths: ['cortexkit/magic-context.jsonc', 'cortexkit/magic-context.json'],
    root: 'user-config',
  },
  'web-access-agent': {
    format: 'json',
    paths: ['web-search.json'],
    root: 'agent',
  },
} as const;

const isTextConfigTarget = (target: ConfigTarget): target is TextConfigTarget => (
  target === 'magic-user' || target === 'magic-project' || target === 'web-access-agent'
);

const emptyDocuments = (): ConfigDocuments => ({
  'settings-global': {},
  'settings-project': {},
  'wtf-global': {},
});

const emptyTextDocument = (target: TextConfigTarget): PiConfigTextDocumentSnapshot => {
  const definition = TEXT_TARGETS[target];
  return {
    content: '{}\n',
    exists: false,
    format: definition.format,
    path: definition.paths[0],
    projectTrusted: false,
    revision: '',
    root: definition.root,
  };
};

const emptyTextDocuments = (): TextConfigDocuments => ({
  'magic-project': emptyTextDocument('magic-project'),
  'magic-user': emptyTextDocument('magic-user'),
  'web-access-agent': emptyTextDocument('web-access-agent'),
});

const emptyDrafts = (): ConfigDrafts => ({
  'magic-project': '{}\n',
  'magic-user': '{}\n',
  'settings-global': '{}\n',
  'settings-project': '{}\n',
  'web-access-agent': '{}\n',
  'wtf-global': '{}\n',
});

const documentsFromSnapshots = (
  settings: PiSettingsSnapshot,
  wtf: PiJsonObjectDocument,
): ConfigDocuments => ({
  'settings-global': settings.global,
  'settings-project': settings.project,
  'wtf-global': wtf,
});

const draftsFromDocuments = (
  documents: ConfigDocuments,
  textDocuments: TextConfigDocuments,
): ConfigDrafts => ({
  'magic-project': textDocuments['magic-project'].content,
  'magic-user': textDocuments['magic-user'].content,
  'settings-global': formatPiJsonObjectDocument(documents['settings-global']),
  'settings-project': formatPiJsonObjectDocument(documents['settings-project']),
  'web-access-agent': textDocuments['web-access-agent'].content,
  'wtf-global': formatPiJsonObjectDocument(documents['wtf-global']),
});

const loadTextConfigDocument = async (
  runtimeTarget: RuntimeContextTarget,
  target: TextConfigTarget,
): Promise<PiConfigTextDocumentSnapshot> => {
  const definition = TEXT_TARGETS[target];
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
  return fallback ?? emptyTextDocument(target);
};

export const PiPluginConfigEditor: React.FC<PiPluginConfigEditorProps> = ({ cwd, sessionId }) => {
  const { t } = useI18n();
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    sessionId ? { sessionId } : { cwd }
  ), [cwd, sessionId]);
  const runtimeTargetKey = sessionId ? `session:${sessionId}` : `cwd:${cwd}`;
  const runtimeTargetKeyRef = React.useRef(runtimeTargetKey);
  runtimeTargetKeyRef.current = runtimeTargetKey;
  const [target, setTarget] = React.useState<ConfigTarget>('settings-global');
  const [documents, setDocuments] = React.useState<ConfigDocuments>(emptyDocuments);
  const [textDocuments, setTextDocuments] = React.useState<TextConfigDocuments>(emptyTextDocuments);
  const [drafts, setDrafts] = React.useState<ConfigDrafts>(emptyDrafts);
  const [projectTrusted, setProjectTrusted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const editorExtensions = React.useMemo(() => [json()], []);

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = runtimeTargetKey;
    setLoading(true);
    setLoadError(null);
    try {
      const settings = await getPiSettings(runtimeTarget);
      const [wtf, magicUser, magicProject, webAccess] = await Promise.all([
        getPiConfigDocument(runtimeTarget, 'global', 'wtf.json'),
        loadTextConfigDocument(runtimeTarget, 'magic-user'),
        settings.projectTrusted
          ? loadTextConfigDocument(runtimeTarget, 'magic-project')
          : Promise.resolve(emptyTextDocuments()['magic-project']),
        loadTextConfigDocument(runtimeTarget, 'web-access-agent'),
      ]);
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const nextDocuments = documentsFromSnapshots(settings, wtf.document);
      const nextTextDocuments: TextConfigDocuments = {
        'magic-project': magicProject,
        'magic-user': magicUser,
        'web-access-agent': webAccess,
      };
      setDocuments(nextDocuments);
      setTextDocuments(nextTextDocuments);
      setDrafts(draftsFromDocuments(nextDocuments, nextTextDocuments));
      setProjectTrusted(settings.projectTrusted);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === runtimeTargetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) {
        setLoading(false);
      }
    }
  }, [runtimeTarget, runtimeTargetKey]);

  React.useEffect(() => {
    setDocuments(emptyDocuments());
    setTextDocuments(emptyTextDocuments());
    setDrafts(emptyDrafts());
    void load();
  }, [load]);

  const parsed = React.useMemo(() => {
    if (isTextConfigTarget(target)) {
      const format = TEXT_TARGETS[target].format;
      const errors: ParseError[] = [];
      const document = parse(drafts[target].replace(/^\uFEFF/, ''), errors, {
        allowTrailingComma: format === 'jsonc',
        disallowComments: format === 'json',
      });
      if (errors.length > 0) {
        const first = errors[0];
        return {
          document: null,
          error: first
            ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
            : 'Invalid JSONC',
          valid: false,
        };
      }
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        return { document: null, error: 'Configuration root must be an object', valid: false };
      }
      return { document: null, error: null, valid: true };
    }
    try {
      return {
        document: parsePiJsonObjectDocument(drafts[target]),
        error: null,
        valid: true,
      };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : String(error),
        valid: false,
      };
    }
  }, [drafts, target]);
  const changes = React.useMemo(() => (
    !isTextConfigTarget(target) && parsed.document
      ? createPiJsonObjectChanges(documents[target], parsed.document)
      : { remove: [], set: {} }
  ), [documents, parsed.document, target]);
  const dirty = isTextConfigTarget(target)
    ? drafts[target] !== textDocuments[target].content
    : changes.remove.length > 0 || Object.keys(changes.set).length > 0;
  const projectBlocked = (
    target === 'settings-project'
    || (isTextConfigTarget(target) && TEXT_TARGETS[target].root === 'project')
  ) && !projectTrusted;

  const save = React.useCallback(async () => {
    if (!parsed.valid || !dirty || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    const generation = generationRef.current;
    const actionTargetKey = runtimeTargetKey;
    const isCurrentSave = () => (
      generation === generationRef.current
      && actionTargetKey === runtimeTargetKeyRef.current
      && runtimeKey === getRuntimeKey()
    );
    setSaving(true);
    try {
      if (isTextConfigTarget(target)) {
        const currentDocument = textDocuments[target];
        const snapshot = await updatePiConfigTextDocument(
          runtimeTarget,
          currentDocument.root,
          currentDocument.path,
          currentDocument.format,
          drafts[target],
          currentDocument.revision,
        );
        if (!isCurrentSave()) return;
        setTextDocuments((current) => ({ ...current, [target]: snapshot }));
        setDrafts((current) => ({ ...current, [target]: snapshot.content }));
        setProjectTrusted(snapshot.projectTrusted);
      } else if (target === 'wtf-global') {
        const snapshot = await updatePiConfigDocument(
          runtimeTarget,
          'global',
          'wtf.json',
          changes,
        );
        if (!isCurrentSave()) return;
        setDocuments((current) => ({ ...current, [target]: snapshot.document }));
        setDrafts((current) => ({
          ...current,
          [target]: formatPiJsonObjectDocument(snapshot.document),
        }));
        setProjectTrusted(snapshot.projectTrusted);
      } else {
        const scope = target === 'settings-global' ? 'global' : 'project';
        const snapshot = await updatePiSettings(runtimeTarget, scope, changes);
        if (!isCurrentSave()) return;
        const savedDocument = snapshot[scope];
        setDocuments((current) => ({ ...current, [target]: savedDocument }));
        setDrafts((current) => ({
          ...current,
          [target]: formatPiJsonObjectDocument(savedDocument),
        }));
        setProjectTrusted(snapshot.projectTrusted);
      }
      toast.success(t('settings.common.status.saved'));
    } catch (error) {
      if (!isCurrentSave()) return;
      console.error('Failed to save Pi plugin configuration:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [changes, dirty, drafts, parsed.valid, projectBlocked, runtimeTarget, runtimeTargetKey, saving, target, t, textDocuments]);

  return (
    <div className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Icon name="settings-3" className="size-4 text-muted-foreground" />
            <h4 className="typography-ui-label text-foreground">
              {t('settings.piarium.recovery.pluginSettings.title')}
            </h4>
          </div>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.recovery.pluginSettings.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="settings" className="min-w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="settings-global">
                Pi settings · {t('settings.common.scope.global')}
              </SelectItem>
              <SelectItem value="settings-project">
                Pi settings · {t('settings.common.scope.project')}
              </SelectItem>
              <SelectItem value="wtf-global">pi-wtf · wtf.json</SelectItem>
              <SelectItem value="magic-user">Magic Context · user JSONC</SelectItem>
              <SelectItem value="magic-project">Magic Context · project JSONC</SelectItem>
              <SelectItem value="web-access-agent">Web Access · web-search.json</SelectItem>
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

      {isTextConfigTarget(target) && (
        <p className="break-all font-mono typography-micro text-muted-foreground">
          {textDocuments[target].root} · {textDocuments[target].path}
        </p>
      )}

      <div className="h-72 overflow-hidden rounded-md border border-border/60 bg-background">
        <CodeMirrorEditor
          value={drafts[target]}
          onChange={(value) => setDrafts((current) => ({ ...current, [target]: value }))}
          extensions={editorExtensions}
          className="h-full"
          enableSearch
          readOnly={loading || projectBlocked}
        />
      </div>

      {parsed.error && (
        <p className="typography-meta text-[var(--status-error)]">
          {isTextConfigTarget(target)
            ? `Invalid ${TEXT_TARGETS[target].format.toUpperCase()}`
            : t('settings.piarium.recovery.pluginSettings.invalidJson')}: {parsed.error}
        </p>
      )}
      {projectBlocked && !loading && (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.recovery.pluginSettings.projectUntrusted')}
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
  );
};
