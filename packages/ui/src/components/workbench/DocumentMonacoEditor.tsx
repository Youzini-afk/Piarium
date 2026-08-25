import React from 'react';

import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { cn } from '@/lib/utils';
import type { EditorViewState } from '@/lib/workbench/editors/types';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import { usePiEditorContextStore } from '@/stores/usePiEditorContextStore';
import { useUIStore } from '@/stores/useUIStore';
import { getMonacoLanguageBridge } from '@/lib/monaco/language-bridge-session';
import { getFileEditorModelRegistry } from '@/lib/monaco/model-session';
import { markMonacoPerformance } from '@/lib/monaco/performance';
import { loadMonacoRuntime, type MonacoRuntime } from '@/lib/monaco/runtime';
import { registerPiariumMonacoTheme } from '@/lib/monaco/theme';
import { applyMonacoEditorViewState, captureMonacoEditorViewState } from '@/lib/monaco/view-state';
import { createPiariumMonacoVimAdapter } from '@/lib/monaco/vim-adapter';
import { applyMonacoModelSettings, createMonacoEditorOptions } from '@/lib/monaco/editor-options';
import { registerFileEditorCommandTarget, saveFileEditorDocument } from '@/lib/monaco/editor-command-service';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';

type DocumentMonacoEditorProps = {
  className?: string;
  identity: DocumentIdentity;
  onViewStateChange?(viewState: EditorViewState): void;
  path: string;
  viewId: string;
  viewState: EditorViewState;
};

export const DocumentMonacoEditor: React.FC<DocumentMonacoEditorProps> = ({
  className,
  identity,
  onViewStateChange,
  path,
  viewId,
  viewState,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const fileEditorSettings = useUIStore((state) => state.fileEditorSettings);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const updateFileEditorSettings = useUIStore((state) => state.updateFileEditorSettings);
  const profileId = useWorkbenchProfileId();
  const record = useDocumentRecord(identity);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const vimStatusRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<import('monaco-editor/editor').editor.IStandaloneCodeEditor | null>(null);
  const viewStateRef = React.useRef(viewState);
  const onViewStateChangeRef = React.useRef(onViewStateChange);
  const recordRef = React.useRef(record);
  const [monaco, setMonaco] = React.useState<MonacoRuntime | null>(null);
  const [editorInstance, setEditorInstance] = React.useState<import('monaco-editor/editor').editor.IStandaloneCodeEditor | null>(null);
  const models = getFileEditorModelRegistry();
  const ownerId = `view:${viewId}`;

  viewStateRef.current = viewState;
  onViewStateChangeRef.current = onViewStateChange;
  recordRef.current = record;

  React.useEffect(() => {
    models.acquire(identity, ownerId);
    return () => models.release(ownerId);
  }, [identity, models, ownerId]);

  const modelSnapshot = React.useSyncExternalStore(
    React.useCallback((listener) => models.subscribe(identity, listener), [identity, models]),
    React.useCallback(() => models.getSnapshot(identity), [identity, models]),
    React.useCallback(() => models.getSnapshot(identity), [identity, models]),
  );

  React.useEffect(() => {
    let cancelled = false;
    void loadMonacoRuntime().then((loaded) => {
      if (!cancelled) setMonaco(loaded);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!monaco) return;
    const themeName = registerPiariumMonacoTheme(monaco, currentTheme);
    monaco.editor.setTheme(themeName);
  }, [currentTheme, monaco]);

  React.useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    applyMonacoModelSettings(editorInstance.getModel()!, fileEditorSettings);
    editorInstance.updateOptions(createMonacoEditorOptions({
      ariaLabel: path,
      fontSize: editorFontSize,
      profileId,
      settings: fileEditorSettings,
    }));
  }, [editorFontSize, fileEditorSettings, path, profileId]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !monaco || modelSnapshot.status !== 'ready') return undefined;
    const themeName = registerPiariumMonacoTheme(monaco, currentTheme);
    applyMonacoModelSettings(modelSnapshot.model, fileEditorSettings);
    const editorInstance = monaco.editor.create(host, {
      ...createMonacoEditorOptions({
        ariaLabel: path,
        fontSize: editorFontSize,
        profileId,
        settings: fileEditorSettings,
      }),
      model: modelSnapshot.model,
      theme: themeName,
    });
    editorRef.current = editorInstance;
    setEditorInstance(editorInstance);
    applyMonacoEditorViewState(editorInstance, viewStateRef.current);
    editorInstance.layout();

    const bridge = getMonacoLanguageBridge(monaco, models);
    const languageOwnerId = `language:${viewId}`;
    bridge.acquire(modelSnapshot.model, identity, languageOwnerId);

    let captureFrame: number | null = null;
    const capture = (): void => {
      captureFrame = null;
      const next = captureMonacoEditorViewState(editorInstance);
      if (onViewStateChangeRef.current) onViewStateChangeRef.current(next);
      else patchEditorViewState(identity.workspaceId, viewId, next);
      const selection = editorInstance.getSelection();
      const open = recordRef.current;
      const hasSelection = Boolean(selection && !selection.isEmpty());
      usePiEditorContextStore.getState().setActiveEditorFile({
        fileName: identity.resourceId.split('/').pop() || identity.resourceId,
        filePath: path,
        fileSize: open?.byteLength ?? null,
        relativePath: identity.resourceId,
        selection: hasSelection && selection
          ? {
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
              text: modelSnapshot.model.getValueInRange(selection),
            }
          : null,
        dirty: open?.dirty === true,
      });
    };
    const scheduleCapture = (): void => {
      if (captureFrame !== null) return;
      captureFrame = requestAnimationFrame(capture);
    };
    const disposables = [
      editorInstance.onDidChangeCursorSelection(scheduleCapture),
      editorInstance.onDidScrollChange(scheduleCapture),
      editorInstance.onDidChangeHiddenAreas(scheduleCapture),
    ];
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => editorInstance.layout())
      : null;
    resizeObserver?.observe(host);
    const handleWindowResize = (): void => editorInstance.layout();
    if (!resizeObserver) window.addEventListener('resize', handleWindowResize);
    void Promise.resolve(editorInstance.renderAsync()).then(() => markMonacoPerformance('editor.first.paint'));

    return () => {
      if (captureFrame !== null) cancelAnimationFrame(captureFrame);
      capture();
      bridge.release(languageOwnerId);
      for (const disposable of disposables) disposable.dispose();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', handleWindowResize);
      editorRef.current = null;
      setEditorInstance(null);
      editorInstance.dispose();
    };
    // Theme, profile presentation and settings update the live editor separately; none may recreate the view/model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, modelSnapshot.status === 'ready' ? modelSnapshot.model : null, models, monaco, path, viewId]);

  React.useEffect(() => {
    if (!monaco || !editorInstance) return undefined;
    return registerFileEditorCommandTarget({
      editor: editorInstance,
      identity,
      ownerId,
      getSettings: () => useUIStore.getState().fileEditorSettings,
      getShortcutOverrides: () => useUIStore.getState().shortcutOverrides,
      updateSettings: updateFileEditorSettings,
      viewId,
    });
  }, [
    editorInstance,
    identity,
    monaco,
    ownerId,
    updateFileEditorSettings,
    viewId,
  ]);

  React.useEffect(() => {
    const statusNode = vimStatusRef.current;
    if (!monaco || !editorInstance || !statusNode || fileEditorKeymap !== 'vim') return undefined;
    const adapter = createPiariumMonacoVimAdapter({
      commandAriaLabel: t('settings.piarium.visual.field.fileEditorKeymap'),
      editor: editorInstance,
      monaco,
      onSave: () => {
        void saveFileEditorDocument(identity).catch((error) => {
          console.error('[Editor] Save failed:', error);
        });
      },
      statusNode,
    });
    return () => adapter.dispose();
  }, [editorInstance, fileEditorKeymap, identity, monaco, t]);

  if (modelSnapshot.status === 'failed') {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-4 text-center', className)}>
        <p className="typography-ui text-status-error">{modelSnapshot.errorMessage}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => models.retry(identity)}>
          {t('startup.initRecovery.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {modelSnapshot.status === 'ready' && modelSnapshot.syncFailure ? (
        <div className="shrink-0 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1.5 typography-meta text-status-warning">
          {t('filesView.editor.syncRecovered')}
        </div>
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
      <div
        ref={vimStatusRef}
        className={cn(
          'hidden h-6 shrink-0 items-center gap-2 border-t border-border/50 bg-muted/30 px-2 font-mono typography-micro text-muted-foreground',
          fileEditorKeymap === 'vim' && 'flex',
        )}
      />
    </div>
  );
};
