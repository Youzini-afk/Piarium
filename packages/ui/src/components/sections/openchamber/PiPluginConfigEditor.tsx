import React from 'react';
import { json } from '@codemirror/lang-json';
import type { PiSettingsSnapshot } from '@piarium/protocol';
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
import { getPiConfigDocument, updatePiConfigDocument } from '@/lib/pi-runtime/config-documents';
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
}

type ConfigTarget = 'settings-global' | 'settings-project' | 'wtf-global';
type ConfigDocuments = Record<ConfigTarget, PiJsonObjectDocument>;
type ConfigDrafts = Record<ConfigTarget, string>;

const emptyDocuments = (): ConfigDocuments => ({
  'settings-global': {},
  'settings-project': {},
  'wtf-global': {},
});

const emptyDrafts = (): ConfigDrafts => ({
  'settings-global': '{}\n',
  'settings-project': '{}\n',
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

const draftsFromDocuments = (documents: ConfigDocuments): ConfigDrafts => ({
  'settings-global': formatPiJsonObjectDocument(documents['settings-global']),
  'settings-project': formatPiJsonObjectDocument(documents['settings-project']),
  'wtf-global': formatPiJsonObjectDocument(documents['wtf-global']),
});

export const PiPluginConfigEditor: React.FC<PiPluginConfigEditorProps> = ({ cwd }) => {
  const { t } = useI18n();
  const [target, setTarget] = React.useState<ConfigTarget>('settings-global');
  const [documents, setDocuments] = React.useState<ConfigDocuments>(emptyDocuments);
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
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, wtf] = await Promise.all([
        getPiSettings({ cwd }),
        getPiConfigDocument({ cwd }, 'global', 'wtf.json'),
      ]);
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      const nextDocuments = documentsFromSnapshots(settings, wtf.document);
      setDocuments(nextDocuments);
      setDrafts(draftsFromDocuments(nextDocuments));
      setProjectTrusted(settings.projectTrusted);
    } catch (error) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) {
        setLoading(false);
      }
    }
  }, [cwd]);

  React.useEffect(() => {
    setDocuments(emptyDocuments());
    setDrafts(emptyDrafts());
    void load();
  }, [load]);

  const parsed = React.useMemo(() => {
    try {
      return { document: parsePiJsonObjectDocument(drafts[target]), error: null };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [drafts, target]);
  const changes = React.useMemo(() => (
    parsed.document
      ? createPiJsonObjectChanges(documents[target], parsed.document)
      : { remove: [], set: {} }
  ), [documents, parsed.document, target]);
  const dirty = changes.remove.length > 0 || Object.keys(changes.set).length > 0;
  const projectBlocked = target === 'settings-project' && !projectTrusted;

  const save = React.useCallback(async () => {
    if (!parsed.document || !dirty || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    setSaving(true);
    try {
      let savedDocument: PiJsonObjectDocument;
      if (target === 'wtf-global') {
        const snapshot = await updatePiConfigDocument(
          { cwd },
          'global',
          'wtf.json',
          changes,
        );
        if (runtimeKey !== getRuntimeKey()) return;
        savedDocument = snapshot.document;
        setProjectTrusted(snapshot.projectTrusted);
      } else {
        const scope = target === 'settings-global' ? 'global' : 'project';
        const snapshot = await updatePiSettings({ cwd }, scope, changes);
        if (runtimeKey !== getRuntimeKey()) return;
        savedDocument = snapshot[scope];
        setProjectTrusted(snapshot.projectTrusted);
        setDocuments((current) => ({
          ...current,
          'settings-global': snapshot.global,
          'settings-project': snapshot.project,
        }));
      }
      setDocuments((current) => ({ ...current, [target]: savedDocument }));
      setDrafts((current) => ({
        ...current,
        [target]: formatPiJsonObjectDocument(savedDocument),
      }));
      toast.success(t('settings.common.status.saved'));
    } catch (error) {
      console.error('Failed to save Pi plugin configuration:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [changes, cwd, dirty, parsed.document, projectBlocked, saving, target, t]);

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
            <SelectTrigger size="settings" className="min-w-44">
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

      <div className="h-72 overflow-hidden rounded-md border border-border/60 bg-background">
        <CodeMirrorEditor
          value={drafts[target]}
          onChange={(value) => setDrafts((current) => ({ ...current, [target]: value }))}
          extensions={editorExtensions}
          className="h-full"
          enableSearch
          readOnly={loading}
        />
      </div>

      {parsed.error && (
        <p className="typography-meta text-[var(--status-error)]">
          {t('settings.piarium.recovery.pluginSettings.invalidJson')}: {parsed.error}
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
          disabled={loading || saving || !dirty || parsed.document === null || projectBlocked}
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
