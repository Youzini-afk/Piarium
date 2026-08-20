import React from 'react';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { Button } from '@/components/ui/button';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
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
import type { EditorTab } from '@/lib/workbench/editors/types';
import {
  getEditorProvidersRevision,
  isEditorProviderEnabled,
  selectEditorProvider,
  setUserEditorAssociation,
  subscribeEditorProviders,
} from '@/lib/workbench/editors/providers';
import { patchEditorViewState } from '@/lib/workbench/editors/session';
import { applyEditorViewState, captureEditorViewState } from '@/lib/workbench/editors/view-state';
import type { DocumentIdentity } from '@/lib/documents/types';

type ResourceEditorHostProps = {
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

const HostFrame: React.FC<{ chooser: React.ReactNode; children: React.ReactNode }> = ({ chooser, children }) => (
  <div className="flex h-full min-h-0 flex-col">
    {chooser}
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>
);

export const ResourceEditorHost: React.FC<ResourceEditorHostProps> = ({
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

  React.useEffect(() => {
    if (!needsText) return;
    void getDocumentRegistry().open(identity).catch(() => undefined);
  }, [identity, needsText]);

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
      patchEditorViewState(workspaceId, tab.viewId, captureEditorViewState(update.view));
    })
  ), [tab.viewId, workspaceId]);

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

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.image) {
    const src = runtime.isDesktop && !isSvgFile(path)
      ? desktopImageSrc
      : getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    return (
      <HostFrame chooser={ambiguousChooser}>
        <div className="flex h-full items-center justify-center p-3">
          <img src={src} alt={tab.resourceId} className="max-h-full max-w-full object-contain rounded-md border border-border/30" />
        </div>
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.pdf || isPdfFile(path)) {
    const src = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, directory: workspaceRoot });
    return (
      <HostFrame chooser={ambiguousChooser}>
        <iframe title={tab.resourceId} src={src} className="h-full w-full border-0" />
      </HostFrame>
    );
  }

  const buffer = record?.buffer ?? '';

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.markdown && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser}>
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
      <HostFrame chooser={ambiguousChooser}>
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
      <HostFrame chooser={ambiguousChooser}>
        <iframe title={tab.resourceId} src={src} className="h-full w-full border-none" sandbox="allow-scripts allow-same-origin allow-forms" />
      </HostFrame>
    );
  }

  if (activeProviderId === BUILTIN_EDITOR_PROVIDER_IDS.drawio && isDrawioFile(path) && tab.viewState.previewMode !== 'edit') {
    return (
      <HostFrame chooser={ambiguousChooser}>
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
      <HostFrame chooser={ambiguousChooser}>
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
      <HostFrame chooser={ambiguousChooser}>
        <div className="flex h-full items-center justify-center p-3 typography-ui text-muted-foreground">
          {t('filesView.editor.cannotPreviewBinary')}
        </div>
      </HostFrame>
    );
  }

  return (
    <HostFrame chooser={ambiguousChooser}>
      <DocumentCodeMirror
        identity={identity}
        className="h-full"
        extensions={[viewStateExtension]}
        onViewReady={(view) => applyEditorViewState(view, tab.viewState)}
      />
    </HostFrame>
  );
};
