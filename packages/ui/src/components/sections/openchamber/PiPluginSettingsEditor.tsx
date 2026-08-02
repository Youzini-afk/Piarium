import React from 'react';
import { json } from '@codemirror/lang-json';
import type { PiSettingsScope, PiSettingsSnapshot } from '@piarium/protocol';
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
  createPiSettingsChanges,
  formatPiSettingsDocument,
  parsePiSettingsDocument,
  type PiSettingsDocument,
} from '@/lib/pi-runtime/settings-document';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey } from '@/lib/runtime-switch';

interface PiPluginSettingsEditorProps {
  cwd: string;
}

type SettingsDrafts = Record<PiSettingsScope, string>;
type SettingsDocuments = Record<PiSettingsScope, PiSettingsDocument>;

const emptyDocuments = (): SettingsDocuments => ({ global: {}, project: {} });
const emptyDrafts = (): SettingsDrafts => ({ global: '{}\n', project: '{}\n' });

export const PiPluginSettingsEditor: React.FC<PiPluginSettingsEditorProps> = ({ cwd }) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiSettingsScope>('global');
  const [documents, setDocuments] = React.useState<SettingsDocuments>(emptyDocuments);
  const [drafts, setDrafts] = React.useState<SettingsDrafts>(emptyDrafts);
  const [projectTrusted, setProjectTrusted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const editorExtensions = React.useMemo(() => [json()], []);

  const applySnapshot = React.useCallback((snapshot: PiSettingsSnapshot) => {
    const nextDocuments = {
      global: snapshot.global,
      project: snapshot.project,
    };
    setDocuments(nextDocuments);
    setDrafts({
      global: formatPiSettingsDocument(nextDocuments.global),
      project: formatPiSettingsDocument(nextDocuments.project),
    });
    setProjectTrusted(snapshot.projectTrusted);
  }, []);

  const load = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await getPiSettings({ cwd });
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      applySnapshot(snapshot);
    } catch (error) {
      if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current && runtimeKey === getRuntimeKey()) {
        setLoading(false);
      }
    }
  }, [applySnapshot, cwd]);

  React.useEffect(() => {
    setDocuments(emptyDocuments());
    setDrafts(emptyDrafts());
    void load();
  }, [load]);

  const parsed = React.useMemo(() => {
    try {
      return { document: parsePiSettingsDocument(drafts[scope]), error: null };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [drafts, scope]);
  const changes = React.useMemo(() => (
    parsed.document
      ? createPiSettingsChanges(documents[scope], parsed.document)
      : { remove: [], set: {} }
  ), [documents, parsed.document, scope]);
  const dirty = changes.remove.length > 0 || Object.keys(changes.set).length > 0;
  const projectBlocked = scope === 'project' && !projectTrusted;

  const save = React.useCallback(async () => {
    if (!parsed.document || !dirty || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    setSaving(true);
    try {
      const snapshot = await updatePiSettings({ cwd }, scope, changes);
      if (runtimeKey !== getRuntimeKey()) return;
      setDocuments((current) => ({
        ...current,
        global: snapshot.global,
        project: snapshot.project,
      }));
      setDrafts((current) => ({
        ...current,
        [scope]: formatPiSettingsDocument(snapshot[scope]),
      }));
      setProjectTrusted(snapshot.projectTrusted);
      toast.success(t('settings.common.status.saved'));
    } catch (error) {
      console.error('Failed to save Pi plugin settings:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [changes, cwd, dirty, parsed.document, projectBlocked, saving, scope, t]);

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
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger size="settings" className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
              <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
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
          value={drafts[scope]}
          onChange={(value) => setDrafts((current) => ({ ...current, [scope]: value }))}
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
