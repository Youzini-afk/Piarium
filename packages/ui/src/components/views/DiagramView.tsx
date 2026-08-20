import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { pickWorkspaceRoot } from '@/lib/documents/path';
import { resolveTextDocumentIdentity } from '@/lib/documents/workspace-text';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';
import { DiagramEditor, type DiagramEditorHandle } from '@/components/diagram';
import { Icon } from '@/components/icon/Icon';

export function DiagramView() {
  const { t } = useI18n();
  const { documents } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory() ?? '';

  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [identity, setIdentity] = React.useState<DocumentIdentity | undefined>(undefined);
  const record = useDocumentRecord(identity);
  const xml = record?.buffer ?? '';
  const [loading, setLoading] = React.useState(true);
  const editorRef = React.useRef<DiagramEditorHandle>(null);
  const pendingDiagramFile = useUIStore((state) => state.pendingDiagramFile);

  const loadFile = React.useCallback(async (path: string) => {
    setLoading(true);
    setFilePath(path);
    try {
      const root = pickWorkspaceRoot(path, [currentDirectory]);
      if (!root) {
        setIdentity(undefined);
        return;
      }
      const next = await resolveTextDocumentIdentity(documents, root, path);
      await getDocumentRegistry().open(next);
      setIdentity(next);
    } catch {
      setIdentity(undefined);
    } finally {
      setLoading(false);
    }
  }, [currentDirectory, documents]);

  React.useEffect(() => {
    if (!pendingDiagramFile) {
      return;
    }
    const pending = useUIStore.getState().consumePendingDiagramFile();
    if (pending) {
      void loadFile(pending);
    }
  }, [loadFile, pendingDiagramFile]);

  const saveDiagram = React.useCallback(async () => {
    const newXml = editorRef.current?.getXml();
    if (!identity || !newXml || newXml === xml) return;
    getDocumentRegistry().applyTransaction(identity, newXml, { origin: 'diagram-view' });
    await getDocumentRegistry().save(identity);
  }, [identity, xml]);

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <div className="typography-ui text-muted-foreground">
          {t('filesView.editor.pickFileFromTree')}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <Icon name="loader-4" className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <Icon name="file" className="size-4 shrink-0 text-muted-foreground" />
        <span className="typography-ui text-muted-foreground truncate flex-1">{fileName}</span>
        <button
          type="button"
          onClick={() => void saveDiagram()}
          className="size-6 flex items-center justify-center rounded-md text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={t('filesView.diagram.saveDiagram')}
        >
          <Icon name="save-3" className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveMainTab('chat')}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={t('filesView.diagram.closeDiagramView')}
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {identity ? (
          <DiagramEditor
            ref={editorRef}
            xml={xml}
            className="h-full"
          />
        ) : null}
      </div>
    </div>
  );
}
