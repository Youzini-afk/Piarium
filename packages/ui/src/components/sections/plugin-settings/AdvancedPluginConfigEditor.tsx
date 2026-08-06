import React from 'react';
import { json } from '@codemirror/lang-json';
import type {
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
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
  getPiConfigTextDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import { getRuntimeKey } from '@/lib/runtime-switch';

interface AdvancedPluginConfigEditorProps {
  cwd: string;
  sessionId?: string | null;
}

interface CustomSelection {
  format: PiConfigTextFormat;
  path: string;
  root: PiConfigTextRoot;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const AdvancedPluginConfigEditor: React.FC<AdvancedPluginConfigEditorProps> = ({
  cwd,
  sessionId,
}) => {
  const { t } = useI18n();
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    sessionId ? { sessionId } : { cwd }
  ), [cwd, sessionId]);
  const runtimeTargetKey = sessionId ? `session:${sessionId}` : `cwd:${cwd}`;
  const runtimeTargetKeyRef = React.useRef(runtimeTargetKey);
  runtimeTargetKeyRef.current = runtimeTargetKey;
  const [root, setRoot] = React.useState<PiConfigTextRoot>('agent');
  const [format, setFormat] = React.useState<PiConfigTextFormat>('jsonc');
  const [path, setPath] = React.useState('');
  const [selection, setSelection] = React.useState<CustomSelection | null>(null);
  const [snapshot, setSnapshot] = React.useState<PiConfigTextDocumentSnapshot | null>(null);
  const [draft, setDraft] = React.useState('{}\n');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const editorExtensions = React.useMemo(() => [json()], []);

  const load = React.useCallback(async () => {
    if (!selection) return;
    const generation = ++generationRef.current;
    const actionTargetKey = runtimeTargetKey;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getPiConfigTextDocument(
        runtimeTarget,
        selection.root,
        selection.path,
        selection.format,
      );
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setSnapshot(next);
      setDraft(next.content);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setSnapshot(null);
      setDraft('{}\n');
      setLoadError(errorMessage(error));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === runtimeTargetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [runtimeTarget, runtimeTargetKey, selection]);

  React.useEffect(() => {
    setSnapshot(null);
    setDraft('{}\n');
    if (selection) void load();
  }, [load, selection]);

  const parsed = React.useMemo(() => {
    if (!selection) return { error: null, valid: false };
    const errors: ParseError[] = [];
    const value = parse(draft.replace(/^\uFEFF/, ''), errors, {
      allowTrailingComma: selection.format === 'jsonc',
      disallowComments: selection.format === 'json',
    });
    if (errors.length > 0) {
      const first = errors[0];
      return {
        error: first
          ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
          : `Invalid ${selection.format.toUpperCase()}`,
        valid: false,
      };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: 'Configuration root must be an object', valid: false };
    }
    return { error: null, valid: true };
  }, [draft, selection]);
  const dirty = snapshot !== null && draft !== snapshot.content;
  const selectionChanged = selection === null
    || root !== selection.root
    || format !== selection.format
    || path.trim() !== selection.path;
  const projectBlocked = selection?.root === 'project' && snapshot?.projectTrusted === false;

  const save = React.useCallback(async () => {
    if (!snapshot || !selection || !parsed.valid || !dirty || projectBlocked || saving) return;
    const generation = generationRef.current;
    const actionTargetKey = runtimeTargetKey;
    const runtimeKey = getRuntimeKey();
    setSaving(true);
    try {
      const next = await updatePiConfigTextDocument(
        runtimeTarget,
        selection.root,
        snapshot.path,
        snapshot.format,
        draft,
        snapshot.revision,
      );
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setSnapshot(next);
      setDraft(next.content);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== runtimeTargetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const message = errorMessage(error);
      setLoadError(message);
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === runtimeTargetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setSaving(false);
    }
  }, [dirty, draft, parsed.valid, projectBlocked, runtimeTarget, runtimeTargetKey, saving, selection, snapshot, t]);

  const chooseSelection = (): void => {
    const nextPath = path.trim();
    if (!nextPath || dirty) return;
    setSelection({ format, path: nextPath, root });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
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

      <SettingsFieldRow label={t('settings.piarium.pluginSettings.advanced.root')}>
        <Select value={root} disabled={saving || dirty} onValueChange={(value) => setRoot(value as PiConfigTextRoot)}>
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
            <SelectValue>
              {t(`settings.piarium.pluginSettings.advanced.root.${root === 'user-config' ? 'userConfig' : root}` as never)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent">{t('settings.piarium.pluginSettings.advanced.root.agent')}</SelectItem>
            <SelectItem value="user-config">{t('settings.piarium.pluginSettings.advanced.root.userConfig')}</SelectItem>
            <SelectItem value="project">{t('settings.piarium.pluginSettings.advanced.root.project')}</SelectItem>
            <SelectItem value="home">{t('settings.piarium.pluginSettings.advanced.root.home')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.piarium.pluginSettings.advanced.format')}>
        <Select value={format} disabled={saving || dirty} onValueChange={(value) => setFormat(value as PiConfigTextFormat)}>
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
            <SelectValue>{format.toUpperCase()}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="json">JSON</SelectItem>
            <SelectItem value="jsonc">JSONC</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t('settings.piarium.pluginSettings.advanced.path')}
        info={t('settings.piarium.pluginSettings.advanced.pathDescription')}
        controlClassName="w-full max-w-[24rem]"
      >
        <Input
          value={path}
          disabled={saving || dirty}
          onChange={(event) => setPath(event.target.value)}
          placeholder={t('settings.piarium.pluginSettings.advanced.customPath')}
          className="min-w-0 flex-1 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving || dirty || !path.trim() || (!selectionChanged && snapshot !== null)}
          onClick={chooseSelection}
        >
          {t('settings.piarium.pluginSettings.advanced.loadCustom')}
        </Button>
      </SettingsFieldRow>

      {snapshot ? (
        <p className="break-all font-mono typography-micro text-muted-foreground">
          {snapshot.root}:{snapshot.path}
        </p>
      ) : (
        <p className="typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.advanced.loadPrompt')}
        </p>
      )}

      <div className="h-80 overflow-hidden rounded-md border border-border/60 bg-background">
        <CodeMirrorEditor
          value={draft}
          onChange={setDraft}
          extensions={editorExtensions}
          className="h-full"
          enableSearch
          readOnly={loading || saving || projectBlocked || snapshot === null}
        />
      </div>

      {parsed.error ? (
        <p className="typography-meta text-[var(--status-error)]">
          {t('settings.piarium.recovery.pluginSettings.invalidJson')}
        </p>
      ) : null}
      {projectBlocked && !loading ? (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.recovery.pluginSettings.projectUntrusted')}
        </p>
      ) : null}
      {dirty ? (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.pluginSettings.advanced.dirtyGuard')}
        </p>
      ) : null}
      {loadError ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{loadError}</p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!selection || loading || saving}
          onClick={() => void load()}
          className="!font-normal gap-1.5"
        >
          <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {dirty
            ? t('settings.piarium.pluginSettings.source.discard')
            : t('settings.piarium.recovery.actions.refresh')}
        </Button>
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
