import React from 'react';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
import { DocumentConflictBanner } from '@/components/workbench/DocumentConflictBanner';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { DiagramEditor } from '@/components/diagram';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isDrawioFile, isImageFile, isPdfFile, isSvgFile } from '@/lib/toolHelpers';
import { useI18n } from '@/lib/i18n';
import { BUILTIN_EDITOR_PROVIDER_IDS } from '@/lib/workbench/editors/types';
import type { EditorTab, EditorViewState } from '@/lib/workbench/editors/types';
import {
  getEditorProvidersRevision,
  isEditorProviderEnabled,
  selectEditorProvider,
  setUserEditorAssociation,
  subscribeEditorProviders,
} from '@/lib/workbench/editors/providers';
import { patchEditorViewState, setEditorPreviewMode } from '@/lib/workbench/editors/session';
import { applyEditorViewState, captureEditorViewState } from '@/lib/workbench/editors/view-state';
import { usePiEditorContextStore } from '@/stores/usePiEditorContextStore';
import type { DocumentIdentity } from '@/lib/documents/types';
import { useUIStore } from '@/stores/useUIStore';
import { getModifierLabel } from '@/lib/utils';

type ResourceEditorHostProps = {
  onViewStateChange?(viewState: EditorViewState): void;
  workspaceId: string;
  workspaceRoot: string;
  tab: EditorTab;
};

const TEXT_PROVIDERS = new Set<string>([
  BUILTIN_EDITOR_PROVIDER_IDS.text,
  BUILTIN_EDITOR_PROVIDER_IDS.markdown,
  BUILTIN_EDITOR_PROVIDER_IDS.json,
  BUILTIN_EDITOR_PROVIDER_IDS.html,
  BUILTIN_EDITOR_PROVIDER_IDS.drawio,
  BUILTIN_EDITOR_PROVIDER_IDS.diff,
]);

const HostFrame: React.FC<{
  chooser: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}> = ({ chooser, toolbar, children }) => (
  <div className="flex h-full min-h-0 flex-col">
    {chooser}
    {toolbar}
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>
);

export const ResourceEditorHost: React.FC<ResourceEditorHostProps> = ({
  onViewStateChange,
  workspaceId,
  workspaceRoot,
  tab,
}) => {
  const { t } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const path = workspacePathFromResourceId(workspaceRoot, tab.resourceId);
  const identity = React.useMemo<DocumentIdentity>(
    () => ({ workspaceId, resourceId: tab.resourceId }),
    [tab.resourceId, workspaceId],
  );
  React.useSyncExternalStore(subscribeEditorProviders, getEditorProvidersRevision, () => 0);
  const providerEnabled = isEditorProviderEnabled(tab.providerId);
  const selection = selectEditorProvider(tab.resourceId);
  const activeProviderId = providerEnabled ? tab.providerId : (
    selection.status === 'selected' ? selection.providerId : BUILTIN_EDITOR_PROVIDER_IDS.text
  );
  const needsText = TEXT_PROVIDERS.has(activeProviderId) && isEditorProviderEnabled(activeProviderId);
  const record = useDocumentRecord(needsText ? identity : undefined);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState('');
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);

  React.useEffect(() => {
    if (!needsText) return;
    void getDocumentRegistry().open(identity).catch(() => undefined);
  }, [identity, needsText]);

  React.useEffect(() => {
    if (!autoSaveEnabled || !record?.dirty || record.saving || record.status !== 'ready') return;
    const timer = setTimeout(() => {
      void getDocumentRegistry().save(identity).catch((error) => {
        console.error('[Editor] Auto-save failed:', error);
      });
    }, 1_500);
    return () => clearTimeout(timer);
  }, [autoSaveEnabled, identity, record?.dirty, record?.localEditRevision, record?.saving, record?.status]);

  React.useEffect(() => {
    if (activeProviderId !== BUILTIN_EDITOR_PROVIDER_IDS.image || isSvgFile(path) || !runtime.isDesktop) {
      return;
    }
    let cancelled = false;
    const readBinary = files.readFileBinary;
    if (!readBinary) return;
    void readBinary(path).then((result) => {
      if (!cancelled) setDesktopImageSrc(result.dataUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProviderId, files, path, runtime.isDesktop]);

  const viewStateExtension = React.useMemo<Extension>(() => (
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.viewportChanged) return;
      const viewState = captureEditorViewState(update.view);
      if (onViewStateChange) onViewStateChange(viewState);
      else patchEditorViewState(workspaceId, tab.viewId, viewState);
      if (!update.selectionSet) return;
      const open = getDocumentRegistry().get(identity);
      const range = update.state.selection.main;
      const hasText = range.from !== range.to;
      const fromLine = update.state.doc.lineAt(range.from);
      const toLine = update.state.doc.lineAt(range.to);
      usePiEditorContextStore.getState().setActiveEditorFile({
        fileName: tab.resourceId.split('/').pop() || tab.resourceId,
        filePath: path,
        fileSize: open?.byteLength ?? null,
        relativePath: tab.resourceId,
        selection: hasText
          ? {
            startLine: fromLine.number,
            endLine: toLine.number,
            text: update.state.sliceDoc(range.from, range.to),
          }
          : null,
        dirty: open?.dirty === true,
      });
    })
  ), [identity, onViewStateChange, path, tab.resourceId, tab.viewId, workspaceId]);

  if (selection.status === 'none' && !isEditorProviderEnabled(BUILTIN_EDITOR_PROVIDER_IDS.text)) {
    return (
      <div className="flex h-full items-center justify-center p-4 typography-ui text-muted-foreground">
        {t('filesView.editor.providerUnavailable')}
      </div>
    );
  }

  const ambiguousChooser = selection.status === 'ambiguous' ? (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
      <span className="typography-meta text-muted-foreground">{t('filesView.editor.providerAmbiguous')}</span>
      {selection.providerIds.map((providerId) => (
        <Button
          key={providerId}
          variant="outline"
          size="xs"
          onClick={() => setUserEditorAssociation(tab.resourceId, providerId)}
        >
          {t('filesView.editor.useProvider', { provider: providerId })}
        </Button>
      ))}
    </div>
  ) : null;

  const setMode = (previewMode: 'preview' | 'edit' | 'tree' | 'text'): void => {
    if (onViewStateChange) onViewStateChange({ previewMode });
    else setEditorPreviewMode(workspaceId, tab.viewId, previewMode);
  };
  const modeToggle = (() => {
    if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.json) {
      const tree = tab.viewState.previewMode !== 'text';
      return (
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode(tree ? 'text' : 'tree')}>
          {t(tree ? 'filesView.editor.switchToTextView' : 'filesView.editor.switchToTreeView')}
        </Button>
      );
    }
    if (
      activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.markdown
      || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.html
      || activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.drawio
    ) {
      const preview = tab.viewState.previewMode !== 'edit';
      return (
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode(preview ? 'edit' : 'preview')}>
          {t(preview ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
        </Button>
      );
    }
    return null;
  })();
  const toolbar = needsText ? (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border/40 px-2">
      {modeToggle}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ml-auto size-7 p-0"
        disabled={!record?.dirty || record.saving}
        title={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
        aria-label={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
        onClick={() => {
          void getDocumentRegistry().save(identity).catch((error) => {
            toast.error(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        <Icon name={record?.saving ? 'loader-4' : 'save-3'} className={record?.saving ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="size-7 p-0"
        aria-pressed={autoSaveEnabled}
        title={t(autoSaveEnabled ? 'filesView.editor.autoSaveOn' : 'filesView.editor.manualSave')}
        aria-label={t(autoSaveEnabled ? 'filesView.editor.autoSaveOn' : 'filesView.editor.manualSave')}
        onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
      >
        <Icon name={autoSaveEnabled ? 'file-check-fill' : 'file-check'} className="size-4" />
      </Button>
    </div>
  ) : null;

  if (needsText && (!record || record.status === 'loading' || record.status === 'unloaded')) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center typography-ui text-muted-foreground">
          {t('filesView.state.loading')}
        </div>
      </HostFrame>
    );
  }

  if (record?.status === 'binary' || record?.status === 'unsupported-encoding') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-muted-foreground">
          {record.status === 'binary'
            ? t('filesView.editor.binaryFileDescription')
            : t('filesView.error.previewUnavailable')}
        </div>
      </HostFrame>
    );
  }

  if (record?.status === 'error') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-status-error">
          {record.errorMessage ?? t('filesView.error.previewUnavailable')}
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.image) {
    const src = runtime.isDesktop && !isSvgFile(path)
      ? desktopImageSrc
      : getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-3">
          <img src={src} alt={tab.resourceId} className="max-h-full max-w-full object-contain rounded-md border border-border/30" />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.pdf || isPdfFile(path)) {
    const src = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <iframe title={tab.resourceId} src={src} className="h-full w-full border-0" />
      </HostFrame>
    );
  }

  const buffer = record?.buffer ?? '';

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.markdown && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="h-full overflow-auto p-3">
          <ErrorBoundary fallback={<div className="p-3 typography-ui text-status-error">{t('filesView.error.previewUnavailable')}</div>}>
            <SimpleMarkdownRenderer content={buffer} className="typography-markdown-body" stripFrontmatter enableFileReferences={false} />
          </ErrorBoundary>
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.json && tab.viewState.previewMode !== 'text') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="h-full overflow-auto">
          <JsonTreeView jsonString={buffer} maxHeight="100%" initiallyExpandedDepth={2} />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.html && tab.viewState.previewMode !== 'edit' && !runtime.isVSCode) {
    const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    const src = getRuntimeUrlResolver().authenticatedAsset(`/api/fs/serve${encoded.startsWith('/') ? encoded : `/${encoded}`}`);
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <iframe title={tab.resourceId} src={src} className="h-full w-full border-none" sandbox="allow-scripts allow-same-origin allow-forms" />
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.drawio && isDrawioFile(path) && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
          <DiagramEditor
            xml={buffer}
            onChange={(xml) => getDocumentRegistry().applyTransaction(identity, xml, { origin: 'drawio' })}
          />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.diff) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/40 px-3 py-1.5 typography-meta text-muted-foreground">
            {t('filesView.editor.diffAgainstDisk')}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3 typography-meta whitespace-pre-wrap">
            {record?.baseContent ?? ''}
          </div>
        </div>
      </HostFrame>
    );
  }

  if (isImageFile(path) && activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.text) {
    return (
      <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
        <div className="flex h-full items-center justify-center p-3 typography-ui text-muted-foreground">
          {t('filesView.editor.cannotPreviewBinary')}
        </div>
      </HostFrame>
    );
  }

  return (
    <HostFrame chooser={ambiguousChooser} toolbar={toolbar}>
      <div className="flex h-full min-h-0 flex-col">
        <DocumentConflictBanner identity={identity} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <DocumentCodeMirror
            identity={identity}
            className="h-full"
            extensions={[viewStateExtension]}
            onViewReady={(view) => applyEditorViewState(view, tab.viewState)}
          />
        </div>
      </div>
    </HostFrame>
  );
};
