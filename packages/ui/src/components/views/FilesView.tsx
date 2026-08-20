import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
import { GoToLineDialog } from './GoToLineDialog';
import { PreviewToggleButton } from './PreviewToggleButton';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { languageByExtension, loadLanguageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { File as PierreFile } from '@pierre/diffs/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { cn, getModifierLabel, hasModifier } from '@/lib/utils';
import { getLanguageFromExtension, getImageMimeType, isBinaryFile, isDrawioFile, isImageFile, isPdfFile, isSvgFile } from '@/lib/toolHelpers';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getOutsideFileGrant } from '@/lib/outsideFileGrants';
import { DiagramEditor } from '@/components/diagram';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getDocumentRegistry } from '@/lib/documents/session';
import { documentIdentityForPath, resourceIdFromWorkspacePath, workspacePathFromResourceId } from '@/lib/documents/path';
import { useDocumentRecord, useDirtyResourceIds } from '@/lib/documents/hooks';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { activeEditorTab, listEditorGroups, listOpenResourceIds } from '@/lib/workbench/editors/groups';
import {
  closeWorkbenchEditor,
  ensureEditorWorkbench,
  moveWorkbenchEditor,
  openWorkbenchEditor,
  patchEditorViewState,
  pinWorkbenchEditor,
  setActiveWorkbenchEditor,
  setActiveWorkbenchWorkspaceId,
  setWorkbenchSplitRatio,
  splitActiveEditor,
} from '@/lib/workbench/editors/session';
import { applyEditorViewState, captureEditorViewState } from '@/lib/workbench/editors/view-state';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';
import { EditorGroupsLayout } from '@/components/workbench/EditorGroupsLayout';
import { ResourceEditorHost } from '@/components/workbench/ResourceEditorHost';
import { DocumentConflictBanner } from '@/components/workbench/DocumentConflictBanner';
import { FilesExplorer, ScrollingFileName } from '@/components/workbench/FilesExplorer';
import { WorkbenchPanelArea } from '@/components/workbench/WorkbenchPanelArea';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { isBrowserClientRuntime, isDesktopLocalOriginActive, openDesktopFileInApp, openDesktopPath } from '@/lib/desktop';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

type SelectedLineRange = {
  start: number;
  end: number;
};

const getParentDirectoryPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return normalized;
  }
  if (lastSlash === 0) {
    return '/';
  }

  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
};

const OpenInAppListIcon = ({ label, iconDataUrl }: { label: string; iconDataUrl?: string }) => {
  const [failed, setFailed] = React.useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  if (iconDataUrl && !failed) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        className="size-4 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        'size-4 rounded-sm flex items-center justify-center',
        'bg-[var(--surface-muted)] text-[9px] font-medium text-muted-foreground'
      )}
    >
      {initial}
    </span>
  );
};

const sortNodes = (items: FileNode[]) =>
  items.slice().sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const toComparablePath = (value: string): string => {
  if (/^[A-Za-z]:\//.test(value)) {
    return value.toLowerCase();
  }
  return value;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

const getAncestorPaths = (filePath: string, root: string): string[] => {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);

  // Ensure file is within root
  if (!isPathWithinRoot(normalizedFile, normalizedRoot)) return [];

  const relative = normalizedFile.slice(normalizedRoot.length).replace(/^\//, '');
  const parts = relative.split('/');
  const ancestors: string[] = [];
  let current = normalizedRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    ancestors.push(current);
  }
  return ancestors;
};

const getDisplayPath = (root: string | null, path: string): string => {
  if (!path) {
    return '';
  }

  const normalizedFilePath = normalizePath(path);
  if (!root || !isPathWithinRoot(normalizedFilePath, root)) {
    return normalizedFilePath;
  }

  const relative = normalizedFilePath.slice(root.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

const isDirectoryReadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('is a directory') || normalized.includes('eisdir');
};

const isFileMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('file not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist');
};

const MAX_VIEW_CHARS = 200_000;

const isMarkdownFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'md' || ext === 'markdown';
};

const isJsonFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson';
};

const isHtmlFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'html' || ext === 'htm';
};

interface DialogsProps {
  activeDialog: 'createFile' | 'createFolder' | 'rename' | 'delete' | null;
  dialogData: { path: string; name?: string; type?: 'file' | 'directory' } | null;
  dialogInputValue: string;
  onDialogInputChange: (value: string) => void;
  isDialogSubmitting: boolean;
  onDialogSubmit: (e?: React.FormEvent) => Promise<void>;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const Dialogs: React.FC<DialogsProps> = ({
  activeDialog,
  dialogData,
  dialogInputValue,
  onDialogInputChange,
  isDialogSubmitting,
  onDialogSubmit,
  onClose,
  inputRef,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={!!activeDialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>
            {activeDialog === 'createFile' && t('filesView.dialog.createFile.title')}
            {activeDialog === 'createFolder' && t('filesView.dialog.createFolder.title')}
            {activeDialog === 'rename' && t('filesView.dialog.rename.title')}
            {activeDialog === 'delete' && t('filesView.dialog.delete.title')}
          </DialogTitle>
          <DialogDescription>
            {activeDialog === 'createFile' && t('filesView.dialog.createFile.description', { path: dialogData?.path ?? t('filesView.dialog.rootFallback') })}
            {activeDialog === 'createFolder' && t('filesView.dialog.createFolder.description', { path: dialogData?.path ?? t('filesView.dialog.rootFallback') })}
            {activeDialog === 'rename' && t('filesView.dialog.rename.description', { name: dialogData?.name ?? '' })}
            {activeDialog === 'delete' && t('filesView.dialog.delete.description', { name: dialogData?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {activeDialog !== 'delete' && (
          <div className="py-4">
            <Input
              value={dialogInputValue}
              onChange={(e) => onDialogInputChange(e.target.value)}
              placeholder={activeDialog === 'rename' ? t('filesView.dialog.rename.placeholder') : t('filesView.dialog.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void onDialogSubmit();
                }
              }}
              ref={inputRef}
              />
            </div>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDialogSubmitting}>
            {t('filesView.dialog.cancel')}
          </Button>
          <Button
            variant={activeDialog === 'delete' ? 'destructive' : 'default'}
            onClick={() => void onDialogSubmit()}
            disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
          >
            {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
                activeDialog === 'delete' ? t('filesView.dialog.delete.confirm') : t('filesView.dialog.confirm')
            )}
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
    );
};

interface FilesViewProps {
  mode?: 'full' | 'editor-only';
}

/**
 * Keeps a token-bearing asset preview (image/HTML/PDF) authenticated. While
 * `assetKey` is set this registers an active url-token consumer (so runtime-auth
 * proactively refreshes the shared token before it expires) and subscribes to
 * token replacements, bumping `nonce` so the iframe/img remounts with the fresh
 * token — but only when the token actually changed, not on every interval.
 */
const useAssetAuthRefresh = (
  assetKey: string,
  setFileError: React.Dispatch<React.SetStateAction<string | null>>,
  errorFallback: string,
): { readyKey: string; nonce: number } => {
  const [readyKey, setReadyKey] = React.useState('');
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    if (!assetKey) {
      setReadyKey('');
      return;
    }

    let cancelled = false;
    setReadyKey('');
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);

    void refreshRuntimeUrlAuthToken(apiBaseUrl)
      .then((token) => {
        if (cancelled || !token) return;
        setReadyKey(assetKey);
        setFileError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFileError(error instanceof Error ? error.message : errorFallback);
        setReadyKey(assetKey);
      });

    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (cancelled) return;
      // Token was refreshed underneath us — remount the asset with the fresh URL.
      setReadyKey(assetKey);
      setNonce((n) => n + 1);
      setFileError(null);
    });

    return () => {
      cancelled = true;
      release();
      unsubscribe();
    };
  }, [assetKey, setFileError, errorFallback]);

  return { readyKey, nonce };
};

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full' }) => {
  const { t } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const workspaceId = useWorkbenchWorkspaceId();
  const editorWorkbench = useEditorWorkbench(workspaceId);
  const editorGroups = editorWorkbench ? listEditorGroups(editorWorkbench.tree) : [];
  const activeWorkbenchTab = editorWorkbench ? activeEditorTab(editorWorkbench) : undefined;
  const isBrowserClient = isBrowserClientRuntime(runtime.platform);
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const { isMobile, isTablet, screenWidth } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();

  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  const showEditorTabsRow = (isMobile || mode !== 'editor-only') && editorGroups.length <= 1;
  const suppressFileLoadingIndicator = mode === 'editor-only' && !isMobile;
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const [wrapLines, setWrapLines] = React.useState(true);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const [isFloatingToolbarOpen, setIsFloatingToolbarOpen] = React.useState(false);
  const floatingToolbarRef = React.useRef<HTMLDivElement | null>(null);
  const toolbarDropdownOpenCountRef = React.useRef(0);

  const handleToolbarDropdownOpenChange = React.useCallback((open: boolean) => {
    toolbarDropdownOpenCountRef.current = Math.max(
      0,
      toolbarDropdownOpenCountRef.current + (open ? 1 : -1),
    );
  }, []);

  const isClickInsidePortalledMenu = React.useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return target.closest('[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-item"]') !== null;
  }, []);

  React.useEffect(() => {
    if (!isFloatingToolbarOpen) return;
    const handler = (event: MouseEvent) => {
      if (toolbarDropdownOpenCountRef.current > 0) return;
      if (isClickInsidePortalledMenu(event.target)) return;
      if (floatingToolbarRef.current && !floatingToolbarRef.current.contains(event.target as Node)) {
        setIsFloatingToolbarOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isClickInsidePortalledMenu, isFloatingToolbarOpen]);
  type TextViewMode = 'view' | 'edit';
  type PreviewViewMode = 'preview' | 'edit';

  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<'tree' | 'text'>('tree');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('preview');
  const [drawioRemountNonce, setDrawioRemountNonce] = React.useState(0);
  const textViewModeByPathRef = React.useRef<Record<string, TextViewMode>>({});
  const mdViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const htmlViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const drawioViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});

  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [lightTheme, darkTheme]);

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const removeExpandedPathsByPrefix = useFilesViewTabsStore((state) => state.removeExpandedPathsByPrefix);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);

  const toFileNode = React.useCallback((path: string): FileNode => {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || normalized;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
    return {
      name,
      path: normalized,
      type: 'file',
      extension,
    };
  }, []);

  const openFiles = React.useMemo(() => openPaths.map(toFileNode), [openPaths, toFileNode]);
  const effectiveSelectedPath = React.useMemo(() => {
    if (selectedPath) {
      const comparableSelected = toComparablePath(selectedPath);
      if (openPaths.some((path) => toComparablePath(path) === comparableSelected)) {
        return selectedPath;
      }
    }
    return openPaths[0] ?? null;
  }, [openPaths, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);
  const selectedFilePath = selectedFile?.path ?? '';
  const selectedDocumentIdentity = React.useMemo(() => {
    if (!selectedFile?.path) return undefined;
    if (isPdfFile(selectedFile.path) || isBinaryFile(selectedFile.path)) return undefined;
    if (isImageFile(selectedFile.path) && !isSvgFile(selectedFile.path)) return undefined;
    return documentIdentityForPath(workspaceId, root, selectedFile.path);
  }, [root, selectedFile?.path, workspaceId]);
  const selectedDocument = useDocumentRecord(selectedDocumentIdentity);
  const dirtyResourceIds = useDirtyResourceIds(workspaceId);

  React.useEffect(() => {
    if (!workspaceId) {
      setActiveWorkbenchWorkspaceId(undefined);
      return;
    }
    setActiveWorkbenchWorkspaceId(workspaceId);
    const resourceIds = openPaths
      .map((path) => resourceIdFromWorkspacePath(root, path))
      .filter((value): value is string => value !== null);
    const selectedResourceId = selectedPath ? resourceIdFromWorkspacePath(root, selectedPath) : null;
    ensureEditorWorkbench(workspaceId, {
      resourceIds,
      ...(selectedResourceId ? { selectedResourceId } : {}),
    });
    if (selectedResourceId && !listOpenResourceIds(ensureEditorWorkbench(workspaceId).tree).includes(selectedResourceId)) {
      openWorkbenchEditor(workspaceId, selectedResourceId);
    }
    const currentIds = listOpenResourceIds(ensureEditorWorkbench(workspaceId).tree);
    if (currentIds.length === 0) {
      for (const resourceId of resourceIds) openWorkbenchEditor(workspaceId, resourceId);
    }
  }, [openPaths, root, selectedPath, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const tab = editorWorkbench ? activeEditorTab(editorWorkbench) : undefined;
    setWorkbenchContextKey('editorIsOpen', Boolean(tab));
    setWorkbenchContextKey('editorDirty', Boolean(tab && dirtyResourceIds.has(tab.resourceId)));
    if (tab) setWorkbenchContextKey('editorResource', tab.resourceId);
  }, [dirtyResourceIds, editorWorkbench, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const dispose = [
      registerWorkbenchCommand('workbench.action.splitEditor', 'files', () => {
        splitActiveEditor(workspaceId, 'vertical');
      }),
      registerWorkbenchCommand('workbench.action.splitEditorOrthogonal', 'files', () => {
        splitActiveEditor(workspaceId, 'horizontal');
      }),
      registerWorkbenchCommand('workbench.action.closeActiveEditor', 'files', () => {
        const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
        if (tab) closeWorkbenchEditor(workspaceId, tab.tabId);
      }),
      registerWorkbenchMenuItem({
        id: 'editor.tab.split',
        commandId: 'workbench.action.splitEditor',
        group: 'editor/tab',
        order: 1,
        when: { editorIsOpen: true },
      }),
    ];
    return () => {
      for (const fn of dispose) fn();
    };
  }, [workspaceId]);

  React.useEffect(() => {
    if (!root || !selectedPath) return;
    const comparableSelected = toComparablePath(selectedPath);
    const selectedIsOpen = openPaths.some((path) => toComparablePath(path) === comparableSelected);
    if (!selectedIsOpen) {
      setSelectedPath(root, openPaths[0] ?? null);
    }
  }, [openPaths, root, selectedPath, setSelectedPath]);

  const selectedFileIsOutsideWorkspace = Boolean(root && selectedFilePath && !isPathWithinRoot(selectedFilePath, root));
  const selectedOutsideFileGrant = selectedFileIsOutsideWorkspace ? getOutsideFileGrant(selectedFilePath) : undefined;
  const selectedFileReadOptions = React.useMemo(
    () => ({
      allowOutsideWorkspace: mode === 'editor-only' && selectedFileIsOutsideWorkspace,
      outsideFileGrant: selectedOutsideFileGrant,
      directory: root || undefined,
    }),
    [mode, selectedFileIsOutsideWorkspace, selectedOutsideFileGrant, root],
  );

  // Editor tabs horizontal scroll fades
  const editorTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const [editorTabsOverflow, setEditorTabsOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const updateEditorTabsOverflow = React.useCallback(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    setEditorTabsOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  const updateEditorTabsOverflowRef = React.useRef(updateEditorTabsOverflow);
  updateEditorTabsOverflowRef.current = updateEditorTabsOverflow;
  React.useEffect(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    const handler = () => updateEditorTabsOverflowRef.current();
    handler();
    el.addEventListener('scroll', handler, { passive: true });
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, [openFiles.length]);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());
  const activeDirectoryLoadIdsRef = React.useRef<Map<string, number>>(new Map());
  const nextDirectoryLoadIdRef = React.useRef(0);

  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  const [localFileContent, setLocalFileContent] = React.useState<string>('');
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const [localFileLoading, setLocalFileLoading] = React.useState(false);
  const [localFileError, setLocalFileError] = React.useState<string | null>(null);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState<string>('');
  const desktopImageBlobUrlRef = React.useRef<string>('');

  const [loadedFilePath, setLoadedFilePath] = React.useState<string | null>(null);

  const [localDraftContent, setLocalDraftContent] = React.useState('');
  const [localIsSaving, setLocalIsSaving] = React.useState(false);
  const dialogInputRef = React.useRef<HTMLInputElement>(null);
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramAutoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramXmlRef = React.useRef('');
  const diagramSavedXmlRef = React.useRef('');
  const pendingDrawioPreviewFrameRef = React.useRef<number | null>(null);
  const diagramEditorRef = React.useRef<React.ComponentRef<typeof DiagramEditor>>(null);
  const activeFileLoadIdRef = React.useRef(0);
  const loadingFilePathRef = React.useRef<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const [diagramSaved, setDiagramSaved] = React.useState(false);
  const [contentDetectedBinary, setContentDetectedBinary] = React.useState(false);
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);
  const documentBacked = Boolean(selectedDocumentIdentity);
  const fileContent = documentBacked ? (selectedDocument?.baseContent ?? '') : localFileContent;
  const draftContent = documentBacked ? (selectedDocument?.buffer ?? '') : localDraftContent;
  const fileLoading = documentBacked
    ? !selectedDocument || selectedDocument.status === 'loading' || selectedDocument.status === 'unloaded'
    : localFileLoading;
  const fileError = !documentBacked
    ? localFileError
    : selectedDocument?.status === 'error' || selectedDocument?.status === 'unsupported-encoding'
      ? (selectedDocument.errorMessage ?? t('filesView.error.readFileFailed'))
      : localFileError;
  const isSaving = documentBacked ? Boolean(selectedDocument?.saving) : localIsSaving;
  const setFileContent = React.useCallback((value: string) => {
    if (!selectedDocumentIdentity) setLocalFileContent(value);
  }, [selectedDocumentIdentity]);
  const setFileLoading = setLocalFileLoading;
  const setFileError = setLocalFileError;
  const setDraftContent = React.useCallback((value: string) => {
    if (selectedDocumentIdentity) {
      getDocumentRegistry().applyTransaction(selectedDocumentIdentity, value, { origin: 'files-view' });
      return;
    }
    setLocalDraftContent(value);
  }, [selectedDocumentIdentity]);

  const copiedContentTimeoutRef = React.useRef<number | null>(null);
  const copiedPathTimeoutRef = React.useRef<number | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [editorViewReadyNonce, setEditorViewReadyNonce] = React.useState(0);
  const pendingNavigationRafRef = React.useRef<number | null>(null);
  const pendingNavigationCycleRef = React.useRef<{ key: string; attempts: number }>({ key: '', attempts: 0 });

  React.useEffect(() => {
    return () => {
      if (pendingNavigationRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingNavigationRafRef.current);
        pendingNavigationRafRef.current = null;
      }
    };
  }, []);

  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);
  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);
  const [rightClickMenuPath, setRightClickMenuPath] = React.useState<string | null>(null);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);
  const [isGoToLineOpen, setIsGoToLineOpen] = React.useState(false);

  const canCreateFile = Boolean(workspaceId);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = Boolean(files.revealPath)
    && (runtime.platform === 'vscode' || isDesktopLocalOriginActive());
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.revealFailed'));
    });
  }, [files, t]);

  const handleOpenInApp = React.useCallback(async (app: { id: string; appName: string }) => {
    if (!selectedFile?.path) {
      return;
    }

    const openedInApp = await openDesktopFileInApp(selectedFile.path, app.id, app.appName);
    if (openedInApp) {
      return;
    }

    const openedFile = await openDesktopPath(selectedFile.path, app.appName);
    if (openedFile) {
      return;
    }

    const fileDirectory = getParentDirectoryPath(selectedFile.path) || root;
    if (fileDirectory) {
      const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
      if (openedDirectory) {
        return;
      }
    }
    toast.error(t('filesView.toast.openInAppFailed', { app: app.appName }));
  }, [root, selectedFile?.path, t]);

  const handleOpenDialog = React.useCallback((type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);

  // Line selection state for commenting
  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);
  const isSelectingRef = React.useRef(false);
  const selectionStartRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  // Session/config for sending comments
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingFileNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const settingsDefaultFileViewerPreview = usePreferencesStore((state) => state.settingsDefaultFileViewerPreview);
  const showMessageTTSButtons = usePreferencesStore((state) => state.showMessageTTSButtons);
  const settingsExpandedEditorToolbar = useUIStore((state) => state.expandedEditorToolbar);

  // Global mouseup to end drag selection
  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingRef.current = false;
      selectionStartRef.current = null;
      setIsDragging(false);
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
      if (copiedPathTimeoutRef.current !== null) {
        window.clearTimeout(copiedPathTimeoutRef.current);
      }
    };
  }, []);

  // Extract selected code
  const extractSelectedCode = React.useCallback((content: string, range: SelectedLineRange): string => {
    const lines = content.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const fileCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'file',
    fileLabel: selectedFile?.path ?? null,
    language: selectedFile?.path ? getLanguageFromExtension(selectedFile.path) || 'text' : 'text',
    getCodeForRange: (range) => extractSelectedCode(fileContent, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
  });

  const {
    drafts: filesFileDrafts,
    commentText,
    setCommentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = fileCommentController;

  React.useEffect(() => {
    setLineSelection(null);
    reset();
    setMainTabGuard(null);
    setLocalDraftContent('');
    setLocalIsSaving(false);
  }, [selectedFile?.path, reset, setMainTabGuard]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  React.useEffect(() => {
    if (!lineSelection && !editingDraftId) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      if (target.closest('[data-comment-input="true"]') || target.closest('[data-comment-card="true"]')) return;
      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      if (!commentText.trim()) {
        setLineSelection(null);
        cancel();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, commentText, editingDraftId, lineSelection]);

  const handleSaveComment = React.useCallback((text: string, range?: { start: number; end: number }) => {
    const finalRange = range ?? lineSelection ?? undefined;
    if (range) {
      setLineSelection(range);
    }
    saveComment(text, finalRange);
    setLineSelection(null);
  }, [lineSelection, saveComment]);

  const mapDirectoryEntries = React.useCallback((dirPath: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): FileNode[] => {
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (!(entry && typeof entry.name === 'string' && entry.name.length > 0)) continue;
      if (!showHidden && entry.name.startsWith('.')) continue;
      if (!showGitignored && shouldIgnoreEntryName(entry.name)) continue;
      const name = entry.name;
      const normalizedEntryPath = normalizePath(entry.path || '');
      const path = normalizedEntryPath
        ? (isAbsolutePath(normalizedEntryPath)
          ? normalizedEntryPath
          : normalizePath(`${dirPath}/${normalizedEntryPath}`))
        : normalizePath(`${dirPath}/${name}`);
      const type = entry.isDirectory ? 'directory' : 'file';
      const extension = type === 'file' && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
      nodes.push({ name, path, type, extension });
    }

    return sortNodes(nodes);
  }, [showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string) => {
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) {
      return;
    }

    if (loadedDirsRef.current.has(normalizedDir) || inFlightDirsRef.current.has(normalizedDir)) {
      return;
    }

    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.add(normalizedDir);
    const requestId = nextDirectoryLoadIdRef.current + 1;
    nextDirectoryLoadIdRef.current = requestId;
    activeDirectoryLoadIdsRef.current = new Map(activeDirectoryLoadIdsRef.current);
    activeDirectoryLoadIdsRef.current.set(normalizedDir, requestId);

    const isCurrentRequest = () => activeDirectoryLoadIdsRef.current.get(normalizedDir) === requestId;

    const listPromise = files.listDirectory(normalizedDir).then((result) => result.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
    })));

    await listPromise
      .then((entries) => {
        if (!isCurrentRequest()) {
          return;
        }

        const mapped = mapDirectoryEntries(normalizedDir, entries);

        loadedDirsRef.current = new Set(loadedDirsRef.current);
        loadedDirsRef.current.add(normalizedDir);
        setLoadErrorsByDir((prev) => {
          if (!prev[normalizedDir]) return prev;
          const next = { ...prev };
          delete next[normalizedDir];
          return next;
        });
        setChildrenByDir((prev) => ({ ...prev, [normalizedDir]: mapped }));
      })
      .catch((error) => {
        if (!isCurrentRequest()) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message === 'Directory not found' && root && normalizedDir !== root) {
          removeExpandedPathsByPrefix(root, normalizedDir);
          setLoadErrorsByDir((prev) => {
            if (!prev[normalizedDir]) return prev;
            const next = { ...prev };
            delete next[normalizedDir];
            return next;
          });
          return;
        }
        console.error('Failed to load files directory:', error);
        setLoadErrorsByDir((prev) => ({
          ...prev,
          [normalizedDir]: message,
        }));
      })
      .finally(() => {
        if (!isCurrentRequest()) {
          return;
        }

        activeDirectoryLoadIdsRef.current = new Map(activeDirectoryLoadIdsRef.current);
        activeDirectoryLoadIdsRef.current.delete(normalizedDir);
        inFlightDirsRef.current = new Set(inFlightDirsRef.current);
        inFlightDirsRef.current.delete(normalizedDir);
      });
  }, [files, mapDirectoryEntries, removeExpandedPathsByPrefix, root]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) {
      return;
    }

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    activeDirectoryLoadIdsRef.current = new Map();
    setLoadErrorsByDir({});
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [loadDirectory, root]);

  /**
   * Incrementally refresh a single directory without nuking the rest of the
   * tree.  After the operation the parent directory is reloaded in-place so
   * the new/renamed/deleted entry becomes visible immediately while every
   * other expanded directory keeps its cached children.
   */
  const refreshDirectory = React.useCallback(async (dirPath: string) => {
    if (!dirPath) {
      await refreshRoot();
      return;
    }
    const normalized = normalizePath(dirPath);
    // Remove from loaded set so loadDirectory will actually fetch again.
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(normalized);
    // Also cancel any in-flight request for this dir so the new fetch wins.
    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.delete(normalized);
    await loadDirectory(normalized);
  }, [loadDirectory, refreshRoot]);

  const lastFilesViewDirRef = React.useRef<string>('');
  const lastFilesViewTreeKeyRef = React.useRef<string>('');

  React.useEffect(() => {
    if (!root) {
      return;
    }

    const treeKey = `${root}|h${showHidden ? '1' : '0'}|g${showGitignored ? '1' : '0'}`;
    const dirChanged = lastFilesViewDirRef.current !== root;
    const treeKeyChanged = lastFilesViewTreeKeyRef.current !== treeKey;

    if (!dirChanged && !treeKeyChanged) {
      return;
    }

    if (dirChanged) {
      lastFilesViewDirRef.current = root;
      setFileContent('');
      setFileError(null);
      setDesktopImageSrc('');
      setLoadedFilePath(null);
      setShowMobilePageContent(false);
    }

    if (treeKeyChanged) {
      lastFilesViewTreeKeyRef.current = treeKey;
      loadedDirsRef.current = new Set();
      inFlightDirsRef.current = new Set();
      activeDirectoryLoadIdsRef.current = new Map();
      setLoadErrorsByDir({});
      setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      void loadDirectory(root);
    }
  }, [loadDirectory, root, showGitignored, showHidden]);

  // Auto-refresh expanded directories when user returns to the tab
  React.useEffect(() => {
    if (!files.listDirectory) return;

    const handleVisibilityChange = () => {
      if (!document.hidden && expandedPaths.length > 0) {
        for (const dir of expandedPaths) {
          void refreshDirectory(dir);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [expandedPaths, files.listDirectory, refreshDirectory]);

  // Poll expanded directories for external changes
  React.useEffect(() => {
    if (!files.listDirectory) return;
    if (expandedPaths.length === 0) return;

    const interval = setInterval(() => {
      if (document.hidden) return;
      for (const dir of expandedPaths) {
        void refreshDirectory(dir);
      }
    }, 8000);

    return () => clearInterval(interval);
  }, [expandedPaths, files.listDirectory, refreshDirectory]);

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const finishDialogOperation = () => {
      setActiveDialog(null);
    };

    const failDialogOperation = (message: string) => {
      toast.error(message);
    };

    const done = () => {
      setIsDialogSubmitting(false);
    };

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.filenameRequired'));
        done();
        return;
      }
      if (!workspaceId) {
        failDialogOperation(t('sidebarFilesTree.toast.writeNotSupported'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);
      const identity = documentIdentityForPath(workspaceId, root, newPath);
      if (!identity) {
        failDialogOperation(t('filesView.document.outsideWorkspace'));
        done();
        return;
      }
      await getDocumentRegistry().create(identity, '')
        .then(async () => {
          toast.success(t('sidebarFilesTree.toast.fileCreated'));
          await refreshDirectory(parentPath);
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.folderNameRequired'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);
      await files.createDirectory(newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.folderCreated'));
            await refreshDirectory(parentPath);
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.nameRequired'));
        done();
        return;
      }

      if (!files.rename) {
        failDialogOperation(t('sidebarFilesTree.toast.renameNotSupported'));
        done();
        return;
      }

      const oldPath = dialogData.path;
      const parentDir = oldPath.split('/').slice(0, -1).join('/');
      const prefix = parentDir ? `${parentDir}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.rename(oldPath, newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.renamedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, oldPath);
            }
            if (selectedFile?.path === oldPath || selectedFile?.path.startsWith(`${oldPath}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        failDialogOperation(t('sidebarFilesTree.toast.deleteNotSupported'));
        done();
        return;
      }

      const deletedPath = dialogData.path;
      const parentDir = deletedPath.split('/').slice(0, -1).join('/');
      await files.delete(deletedPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.deletedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, deletedPath);
            }
            if (selectedFile?.path === deletedPath || selectedFile?.path.startsWith(`${deletedPath}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, refreshDirectory, isMobile, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath, t]);

  React.useEffect(() => {
    if (!currentDirectory) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const trimmedQuery = debouncedSearchQuery.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        const mapped: FileNode[] = filtered.map((hit) => ({
          name: hit.name,
          path: normalizePath(hit.path),
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
        }));

        setSearchResults(mapped);
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, debouncedSearchQuery, searchFiles, showHidden, showGitignored]);

  React.useEffect(() => {
    if (!root || !files.statFile || openPaths.length === 0) {
      return;
    }

    let cancelled = false;
    const paths = [...openPaths];

    void Promise.all(paths.map(async (path) => {
      try {
        const stat = await files.statFile?.(path, { directory: root || undefined });
        if (!cancelled && stat && !stat.isFile) {
          removeOpenPathsByPrefix(root, path);
        }
      } catch (error) {
        if (!cancelled && isFileMissingError(error)) {
          removeOpenPathsByPrefix(root, path);
        }
      }
    }));

    return () => {
      cancelled = true;
    };
  }, [files, openPaths, removeOpenPathsByPrefix, root]);

  const displayedContent = React.useMemo(() =>
    fileContent.length > MAX_VIEW_CHARS
      ? `${fileContent.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
      : fileContent,
    [fileContent]
  );

  const isDirty = documentBacked ? Boolean(selectedDocument?.dirty) : draftContent !== displayedContent;

  const saveDraft = React.useCallback(async () => {
    if (!selectedFile || !selectedDocumentIdentity) {
      toast.error(t('filesView.toast.savingNotSupported'));
      return false;
    }

    const selectedIsBinary = isBinaryFile(selectedFile.path) || contentDetectedBinary || selectedDocument?.status === 'binary';
    if (!shouldAllowFileDraftSave({
      selectedFilePath: selectedFile.path,
      loadedFilePath,
      fileLoading,
      isDirty,
      draftContent,
      fileContent,
      isNonEditableBinary: selectedIsBinary,
    })) {
      if (selectedIsBinary) {
        console.warn(`[saveDraft] refusing to save binary file "${selectedFile.path}".`);
      }
      return false;
    }

    if (!isDirty) {
      return true;
    }

    try {
      const saved = await getDocumentRegistry().save(selectedDocumentIdentity);
      if (saved.status === 'conflict') {
        toast.error(t('filesView.toast.writeFileFailed'));
        return false;
      }
      if (selectedFile.path && isDrawioFile(selectedFile.path)) {
        diagramXmlRef.current = saved.buffer;
        diagramSavedXmlRef.current = saved.buffer;
      }
      return !saved.dirty || saved.status === 'ready';
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      return false;
    }
  }, [contentDetectedBinary, draftContent, fileContent, fileLoading, isDirty, loadedFilePath, selectedDocument?.status, selectedDocumentIdentity, selectedFile, t]);

  React.useEffect(() => {
    if (autoSaveEnabled) {
      return;
    }

    setAutoSaveStatus('idle');
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, [autoSaveEnabled]);

  // Auto-save: debounce 1.5s after user stops typing
  const AUTO_SAVE_DELAY = 1500;

  React.useEffect(() => {
    const canWrite = Boolean(selectedFile && selectedDocumentIdentity);
    const selectedIsBinary = Boolean(selectedFile?.path && (isBinaryFile(selectedFile.path) || contentDetectedBinary));
    if (!shouldScheduleFileAutosave({
      autoSaveEnabled,
      isDirty,
      canWrite,
      isSaving,
      fileLoading,
      selectedFilePath: selectedFile?.path,
      loadedFilePath,
      isNonEditableBinary: selectedIsBinary,
    })) {
      return;
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void saveDraft().then((saved) => {
        if (!saved) return;
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus('idle'), 2000);
      });
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [autoSaveEnabled, contentDetectedBinary, draftContent, fileLoading, isDirty, loadedFilePath, selectedDocumentIdentity, selectedFile, isSaving, saveDraft]);

  // Reset auto-save status when switching files
  React.useEffect(() => {
    setAutoSaveStatus('idle');
  }, [selectedFile?.path]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hasModifier(e)) {
        return;
      }

      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Cancel pending auto-save; user wants immediate save
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        if (!isSaving) {
          void saveDraft().then((saved) => {
            if (!saved) return;
            setAutoSaveStatus('saved');
            setTimeout(() => setAutoSaveStatus('idle'), 2000);
          });
        }
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, saveDraft]);

  const loadSelectedFile = React.useCallback(async (node: FileNode) => {
    const loadId = activeFileLoadIdRef.current + 1;
    activeFileLoadIdRef.current = loadId;
    const isCurrentLoad = () => {
      if (!root) return false;
      const rootState = useFilesViewTabsStore.getState().byRoot[root];
      const currentPath = rootState?.selectedPath ?? rootState?.openPaths[0] ?? null;
      return activeFileLoadIdRef.current === loadId && currentPath === node.path;
    };

    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    setContentDetectedBinary(false);

    const selectedIsImage = isImageFile(node.path);
    const isSvg = isSvgFile(node.path);
    const selectedIsPdf = isPdfFile(node.path);
    const selectedIsBinary = isBinaryFile(node.path);

    if (isMobile) {
      setShowMobilePageContent(true);
    }

    // Desktop: binary images are loaded via readFileBinary (data URL).
    if (runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      setFileLoading(true);
      return;
    }

    // Web: binary images should not be read as utf8.
    if (!runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    if (selectedIsPdf) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    // Other known binaries (docx/xlsx/zip/…) must never be opened as text —
    // a later autosave would corrupt them.
    if (selectedIsBinary) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    setFileLoading(true);

    if (!workspaceId) {
      return;
    }

    const identity = documentIdentityForPath(workspaceId, root, node.path);
    if (!identity) {
      if (!isCurrentLoad()) return;
      setFileError(t('filesView.document.outsideWorkspace'));
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    try {
      const record = await getDocumentRegistry().open(identity);
      if (!isCurrentLoad()) return;
      if (record.status === 'binary') {
        setContentDetectedBinary(true);
        setLoadedFilePath(node.path);
        return;
      }
      if (record.status === 'error') {
        setFileError(record.errorMessage ?? t('filesView.error.readFileFailed'));
        setLoadedFilePath(node.path);
        return;
      }
      diagramXmlRef.current = record.buffer;
      diagramSavedXmlRef.current = record.baseContent;
      setLoadedFilePath(node.path);
    } catch (error) {
      if (!isCurrentLoad()) return;
      if (isDirectoryReadError(error)) {
        setFileLoading(false);
        if (root) {
          setSelectedPath(root, null);
        }
        setFileError(null);
        setLoadedFilePath(null);
        if (searchQuery.trim().length > 0) {
          setSearchQuery('');
        }
        if (isMobile) {
          setShowMobilePageContent(false);
        }
        if (root) {
          const ancestors = getAncestorPaths(node.path, root);
          const pathsToExpand = [...ancestors, node.path];
          if (pathsToExpand.length > 0) {
            expandPaths(root, pathsToExpand);
          }
          for (const path of pathsToExpand) {
            if (!loadedDirsRef.current.has(path)) {
              void loadDirectory(path);
            }
          }
        }
        return;
      }
      if (isFileMissingError(error)) {
        if (root) {
          removeOpenPathsByPrefix(root, node.path);
        }
        setFileError(null);
        if (isMobile) {
          setShowMobilePageContent(false);
        }
        return;
      }
      setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
    } finally {
      if (isCurrentLoad()) {
        setFileLoading(false);
      }
    }
  }, [expandPaths, isMobile, loadDirectory, removeOpenPathsByPrefix, root, runtime.isDesktop, searchQuery, setSelectedPath, t, workspaceId]);

  const ensurePathVisible = React.useCallback(async (targetPath: string, includeTarget: boolean) => {
    if (!root) {
      return;
    }

    const ancestors = getAncestorPaths(targetPath, root);
    const pathsToExpand = includeTarget ? [...ancestors, targetPath] : ancestors;

    if (pathsToExpand.length > 0) {
      expandPaths(root, pathsToExpand);
    }

    const loadPromises = pathsToExpand.map((path) => {
      if (!loadedDirsRef.current.has(path)) {
        return loadDirectory(path);
      }
      return undefined;
    }).filter(Boolean);
    await Promise.all(loadPromises);
  }, [expandPaths, loadDirectory, root]);

  const getNextOpenFile = React.useCallback((path: string, filesList: FileNode[]) => {
    const index = filesList.findIndex((file) => file.path === path);
    if (index === -1 || filesList.length <= 1) {
      return null;
    }
    return filesList[index + 1] ?? filesList[index - 1] ?? null;
  }, []);

  const handleSelectFile = React.useCallback(async (node: FileNode) => {
    if (root) {
      setSelectedPath(root, node.path);
      void ensurePathVisible(node.path, false);
      const resourceId = workspaceId ? resourceIdFromWorkspacePath(root, node.path) : null;
      if (workspaceId && resourceId) {
        openWorkbenchEditor(workspaceId, resourceId);
      }
    }

    setFileError(null);
    setDesktopImageSrc('');
    setLocalFileContent('');
    diagramXmlRef.current = '';
    diagramSavedXmlRef.current = '';
    setLocalDraftContent('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [ensurePathVisible, isMobile, root, setSelectedPath, workspaceId]);

  React.useEffect(() => {
    if (!selectedFile?.path) {
      return;
    }

    void ensurePathVisible(selectedFile.path, false);
  }, [ensurePathVisible, selectedFile?.path]);

  React.useEffect(() => {
    if (!selectedFile) {
      activeFileLoadIdRef.current += 1;
      loadingFilePathRef.current = null;
      setFileLoading(false);
      return;
    }

    if (loadedFilePath === selectedFile.path || loadingFilePathRef.current === selectedFile.path) {
      return;
    }

    const loadingPath = selectedFile.path;
    loadingFilePathRef.current = loadingPath;
    void loadSelectedFile(selectedFile).finally(() => {
      if (loadingFilePathRef.current === loadingPath) {
        loadingFilePathRef.current = null;
      }
    });
  }, [loadSelectedFile, loadedFilePath, selectedFile, workspaceId]);

  const handleCloseFile = React.useCallback((path: string) => {
    const resourceId = root && workspaceId ? resourceIdFromWorkspacePath(root, path) : null;
    if (workspaceId && resourceId && editorWorkbench) {
      for (const group of listEditorGroups(editorWorkbench.tree)) {
        for (const tab of group.tabs) {
          if (tab.resourceId === resourceId) closeWorkbenchEditor(workspaceId, tab.tabId);
        }
      }
    }
    const isActive = selectedFile?.path === path;
    const nextFile = getNextOpenFile(path, openFiles);

    if (root) {
      removeOpenPath(root, path);
    }

    if (!isActive) {
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

    if (root) {
      setSelectedPath(root, null);
    }
    setLocalFileContent('');
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(false);
    }
  }, [editorWorkbench, getNextOpenFile, handleSelectFile, isMobile, openFiles, removeOpenPath, root, selectedFile?.path, setSelectedPath, workspaceId]);

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    const resourceId = root ? resourceIdFromWorkspacePath(root, path) : null;
    if (resourceId !== null && dirtyResourceIds.has(resourceId)) return 'modified';
    if (openPaths.includes(path)) return 'open';

    if (gitStatus?.files) {
      const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
      const file = gitStatus.files.find(f => f.path === relative);
      if (file) {
        if (file.index === 'A' || file.working_dir === '?') return 'git-added';
        if (file.index === 'D') return 'git-deleted';
        if (file.index === 'M' || file.working_dir === 'M') return 'git-modified';
      }
    }
    return null;
  }, [dirtyResourceIds, openPaths, gitStatus, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (!gitStatus?.files) return null;
    const relativeDir = dirPath.startsWith(root + '/') ? dirPath.slice(root.length + 1) : dirPath;
    const prefix = relativeDir ? `${relativeDir}/` : '';

    let modified = 0, added = 0;
    for (const f of gitStatus.files) {
      if (f.path.startsWith(prefix)) {
        if (f.index === 'M' || f.working_dir === 'M') modified++;
        if (f.index === 'A' || f.working_dir === '?') added++;
      }
    }
    return modified + added > 0 ? { modified, added } : null;
  }, [gitStatus, root]);

  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    toggleExpandedPath(root, normalized);

    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, root, toggleExpandedPath]);

  const fileRowPermissions = React.useMemo(
    () => ({ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }),
    [canRename, canCreateFile, canCreateFolder, canDelete, canReveal]
  );

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && isSvgFile(selectedFile.path));
  const isSelectedPdf = Boolean(selectedFile?.path && isPdfFile(selectedFile.path));
  const isSelectedBinary = Boolean(
    selectedFile?.path
    && (isBinaryFile(selectedFile.path) || contentDetectedBinary)
  );
  const isUnsupportedBinary = isSelectedBinary && !isSelectedImage && !isSelectedPdf;
  const pendingNavigationTargetPath = React.useMemo(
    () => normalizePath(pendingFileNavigation?.path ?? ''),
    [pendingFileNavigation?.path],
  );
  const shouldMaskEditorForPendingNavigation = Boolean(
    pendingFileNavigation
      && pendingNavigationTargetPath
      && selectedFilePath
      && selectedFilePath === pendingNavigationTargetPath
      && !fileLoading
      && !fileError
      && !isSelectedImage
      && !isSelectedPdf
      && !isUnsupportedBinary,
  );

  const displaySelectedPath = React.useMemo(() => {
    return getDisplayPath(root, selectedFilePath);
  }, [selectedFilePath, root]);

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && !isSelectedPdf && !isUnsupportedBinary && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  // Keep image/SVG on the preview path: `isBinaryFile` excludes `.svg`, so binary
  // alone would flip canEdit/isTextFile true and show a dead edit toggle + no-op Save.
  const canEdit = Boolean(selectedFile && selectedDocumentIdentity && !isSelectedBinary && !isSelectedImage && fileContent.length <= MAX_VIEW_CHARS);
  const isMarkdown = Boolean(selectedFile?.path && isMarkdownFile(selectedFile.path));
  const isJson = Boolean(selectedFile?.path && isJsonFile(selectedFile.path));
  const isHtml = Boolean(selectedFile?.path && isHtmlFile(selectedFile.path));
  const isDrawio = Boolean(selectedFile?.path && isDrawioFile(selectedFile.path));
  const isTextFile = Boolean(selectedFile && !isSelectedBinary && !isSelectedImage);
  const canUseShikiFileView = isTextFile && !isMarkdown && !isDrawio && !(isHtml && htmlViewMode === 'preview');
  const isEditingFile = (isMarkdown && mdViewMode === 'edit')
    || (isHtml && htmlViewMode === 'edit')
    || (isJson && jsonViewMode === 'text')
    || (!isMarkdown && !isHtml && !isJson && textViewMode === 'edit');
  const staticLanguageExtension = React.useMemo(
    () => (selectedFilePath ? languageByExtension(selectedFilePath) : null),
    [selectedFilePath],
  );
  const [dynamicLanguageExtension, setDynamicLanguageExtension] = React.useState<Extension | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const selectedPath = selectedFile?.path;

    if (!selectedPath || staticLanguageExtension) {
      setDynamicLanguageExtension(null);
      return;
    }

    setDynamicLanguageExtension(null);
    void loadLanguageByExtension(selectedPath).then((extension) => {
      if (!cancelled) {
        setDynamicLanguageExtension(extension);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.path, staticLanguageExtension]);

  React.useEffect(() => {
    if (!canEdit && textViewMode === 'edit') {
      setTextViewMode('view');
    }
  }, [canEdit, textViewMode]);

  const MD_VIEWER_MODE_KEY = 'piarium:files:md-viewer-mode';
  const HTML_VIEWER_MODE_KEY = 'piarium:files:html-viewer-mode';
  const JSON_VIEWER_MODE_KEY = 'piarium:files:json-viewer-mode';

  React.useEffect(() => {
    const selectedPath = selectedFile?.path;
    if (!selectedPath) {
      return;
    }

    setTextViewMode(textViewModeByPathRef.current[selectedPath] ?? 'edit');

    // Respect per-type localStorage preference when available,
    // falling back to the setting-derived default when nothing is stored.
    let mdDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        mdDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setMdViewMode(mdViewModeByPathRef.current[selectedPath] ?? mdDefault);

    let htmlDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(HTML_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        htmlDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setHtmlViewMode(htmlViewModeByPathRef.current[selectedPath] ?? htmlDefault);
    setDrawioViewMode(drawioViewModeByPathRef.current[selectedPath] ?? (settingsDefaultFileViewerPreview ? 'preview' : 'edit'));

    let jsonDefault: 'tree' | 'text' = settingsDefaultFileViewerPreview ? 'tree' : 'text';
    try {
      const stored = localStorage.getItem(JSON_VIEWER_MODE_KEY);
      if (stored === 'tree' || stored === 'text') {
        jsonDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setJsonViewMode(jsonDefault);
  }, [selectedFile?.path, settingsDefaultFileViewerPreview]);

  const saveTextViewMode = React.useCallback((mode: TextViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      textViewModeByPathRef.current[selectedPath] = mode;
    }
    setTextViewMode(mode);
  }, [selectedFile?.path]);

  const saveMdViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      mdViewModeByPathRef.current[selectedPath] = mode;
    }
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const getMdViewMode = React.useCallback((): PreviewViewMode => {
    return mdViewMode;
  }, [mdViewMode]);

  const saveJsonViewMode = React.useCallback((mode: 'tree' | 'text') => {
    setJsonViewMode(mode);
    try {
      localStorage.setItem(JSON_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const saveHtmlViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      htmlViewModeByPathRef.current[selectedPath] = mode;
    }
    setHtmlViewMode(mode);
    try {
      localStorage.setItem(HTML_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const saveDrawioViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      drawioViewModeByPathRef.current[selectedPath] = mode;
    }
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    if (pendingDrawioPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
      pendingDrawioPreviewFrameRef.current = null;
    }
    if (mode === 'edit') {
      setDraftContent(diagramXmlRef.current || fileContent);
      setDrawioViewMode(mode);
    } else {
      diagramXmlRef.current = draftContent;
      const pathAtToggle = selectedPath;
      setDrawioViewMode('edit');
      pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
        pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
          pendingDrawioPreviewFrameRef.current = null;
          if (root && pathAtToggle && useFilesViewTabsStore.getState().byRoot[root]?.selectedPath !== pathAtToggle) {
            return;
          }
          setDrawioRemountNonce((value) => value + 1);
          setDrawioViewMode('preview');
        });
      });
      return;
    }
  }, [draftContent, fileContent, root, selectedFile?.path]);

  const saveDiagramXml = React.useCallback(async (path: string, xml: string) => {
    const identity = documentIdentityForPath(workspaceId, root, path);
    if (!identity || xml === diagramSavedXmlRef.current) {
      return false;
    }

    getDocumentRegistry().applyTransaction(identity, xml, { origin: 'drawio' });
    try {
      const saved = await getDocumentRegistry().save(identity);
      if (saved.status === 'conflict') {
        toast.error(t('filesView.toast.writeFileFailed'));
        return false;
      }
      diagramXmlRef.current = saved.buffer;
      diagramSavedXmlRef.current = saved.baseContent;
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      return false;
    }
  }, [root, t, workspaceId]);

  React.useEffect(() => {
    return () => {
      if (diagramAutoSaveTimerRef.current) {
        clearTimeout(diagramAutoSaveTimerRef.current);
        diagramAutoSaveTimerRef.current = null;
      }
      if (pendingDrawioPreviewFrameRef.current !== null) {
        cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
        pendingDrawioPreviewFrameRef.current = null;
      }
    };
  }, [drawioViewMode, selectedFile?.path]);

  const handleDiagramChange = React.useCallback((xml: string) => {
    diagramXmlRef.current = xml;
    if (!autoSaveEnabled || !selectedFile?.path || drawioViewMode !== 'preview' || !selectedDocumentIdentity) {
      return;
    }

    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
    }

    const path = selectedFile.path;
    diagramAutoSaveTimerRef.current = setTimeout(() => {
      diagramAutoSaveTimerRef.current = null;
      void saveDiagramXml(path, xml).then((saved) => {
        if (!saved) return;
        setDiagramSaved(true);
        setTimeout(() => setDiagramSaved(false), 1500);
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      });
    }, AUTO_SAVE_DELAY);
  }, [autoSaveEnabled, drawioViewMode, saveDiagramXml, selectedDocumentIdentity, selectedFile?.path, t]);

  const diagramEditorXml = React.useMemo(() => {
    if (!isDrawio) {
      return fileContent;
    }
    return diagramXmlRef.current || draftContent || fileContent;
  }, [draftContent, fileContent, isDrawio]);

  const getHtmlViewMode = React.useCallback((): PreviewViewMode => {
    return htmlViewMode;
  }, [htmlViewMode]);

  React.useEffect(() => {
    const applyDefaultFileViewerMode = (enabled: boolean) => {
      const previewMode: PreviewViewMode = enabled ? 'preview' : 'edit';
      const nextJsonMode: 'tree' | 'text' = enabled ? 'tree' : 'text';

      for (const path of openPaths) {
        textViewModeByPathRef.current[path] = 'edit';
        if (isMarkdownFile(path)) {
          mdViewModeByPathRef.current[path] = previewMode;
        }
        if (isHtmlFile(path)) {
          htmlViewModeByPathRef.current[path] = previewMode;
        }
        if (isDrawioFile(path)) {
          drawioViewModeByPathRef.current[path] = previewMode;
        }
      }

      setTextViewMode('edit');
      setMdViewMode(previewMode);
      setHtmlViewMode(previewMode);
      setDrawioViewMode(previewMode);
      setJsonViewMode(nextJsonMode);

      try {
        localStorage.setItem(MD_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(HTML_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(JSON_VIEWER_MODE_KEY, nextJsonMode);
      } catch {
        // Ignore localStorage errors
      }
    };

    const handleFileViewerModeChanged = (event: Event) => {
      const enabled = Boolean((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled);
      applyDefaultFileViewerMode(enabled);
    };

    window.addEventListener('piarium:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    return () => {
      window.removeEventListener('piarium:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    };
  }, [openPaths]);

  React.useEffect(() => {
    if (!pendingFileNavigation || !root) {
      return;
    }

    const scheduleNavigationRetry = () => {
      if (typeof window === 'undefined') {
        return;
      }
      if (pendingNavigationRafRef.current !== null) {
        return;
      }

      pendingNavigationRafRef.current = window.requestAnimationFrame(() => {
        pendingNavigationRafRef.current = null;
        setEditorViewReadyNonce((value) => value + 1);
      });
    };

    const isEditorSyncedWithDraft = (view: EditorView, expectedContent: string): boolean => {
      if (view.state.doc.length !== expectedContent.length) {
        return false;
      }

      if (expectedContent.length === 0) {
        return true;
      }

      const sampleSize = Math.min(128, expectedContent.length);
      const startSample = view.state.sliceDoc(0, sampleSize);
      if (startSample !== expectedContent.slice(0, sampleSize)) {
        return false;
      }

      const endFrom = Math.max(0, expectedContent.length - sampleSize);
      const endSample = view.state.sliceDoc(endFrom, expectedContent.length);
      return endSample === expectedContent.slice(endFrom);
    };

    const targetPath = normalizePath(pendingFileNavigation.path);
    if (!targetPath) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    const navigationKey = `${targetPath}:${pendingFileNavigation.line}:${pendingFileNavigation.column ?? 1}`;
    if (pendingNavigationCycleRef.current.key !== navigationKey) {
      pendingNavigationCycleRef.current = { key: navigationKey, attempts: 0 };
    }

    if (selectedFile?.path !== targetPath) {
      void handleSelectFile(toFileNode(targetPath));
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath) {
      return;
    }

    if (fileError || isSelectedImage || isSelectedPdf || isUnsupportedBinary) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    if (!canEdit) {
      return;
    }

    if (textViewMode !== 'edit') {
      setTextViewMode('edit');
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
      scheduleNavigationRetry();
      return;
    }

    if (!isEditorSyncedWithDraft(view, draftContent)) {
      scheduleNavigationRetry();
      return;
    }

    const targetLineNumber = Math.max(1, Math.min(pendingFileNavigation.line, view.state.doc.lines));
    const targetLine = view.state.doc.line(targetLineNumber);
    const targetColumn = Math.max(1, pendingFileNavigation.column || 1);
    const lineLength = Math.max(0, targetLine.to - targetLine.from);
    const clampedColumnOffset = Math.min(lineLength, targetColumn - 1);
    const targetPosition = targetLine.from + clampedColumnOffset;
    const isAtTarget = view.state.selection.main.head === targetPosition;
    const shouldDispatch = !isAtTarget || pendingNavigationCycleRef.current.attempts === 0;

    if (shouldDispatch) {
      pendingNavigationCycleRef.current.attempts += 1;
      view.dispatch({
        selection: { anchor: targetPosition },
        effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
      });
      view.focus();
      scheduleNavigationRetry();
      return;
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const syncedView = editorViewRef.current;
        if (!syncedView) {
          return;
        }

        syncedView.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
        });
        syncedView.focus();
      });
    }

    setPendingFileNavigation(null);
    pendingNavigationCycleRef.current = { key: '', attempts: 0 };
  }, [
    canEdit,
    draftContent,
    editorViewReadyNonce,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    handleSelectFile,
    pendingFileNavigation,
    root,
    selectedFile?.path,
    setPendingFileNavigation,
    textViewMode,
    toFileNode,
  ]);

  React.useEffect(() => {
    if (!pendingFileFocusPath || !root) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    if (selectedFile?.path !== targetPath) {
      // Selection is owned by the tab sync / user. A pending focus request must
      // not steal selection back (e.g. after the user switched to another tab
      // while this file was still loading). Wait; clear once it loads or the
      // request is superseded.
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath) {
      return;
    }

    // Best-effort focus: preview renderers (markdown/html preview, drawio,
    // JSON tree, images, PDFs) never mount a CodeMirror editor, so the request
    // must clear regardless — otherwise it lingers and replays on every
    // dependency change.
    if (!fileError && !isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && canEdit && textViewMode === 'edit') {
      editorViewRef.current?.focus();
    }

    setPendingFileFocusPath(null);
  }, [
    canEdit,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    pendingFileFocusPath,
    root,
    selectedFile?.path,
    setPendingFileFocusPath,
    textViewMode,
  ]);

  const nudgeEditorSelectionAboveKeyboard = React.useCallback((view: EditorView | null) => {
    if (!isMobile || !view || !view.hasFocus || typeof window === 'undefined') {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const occludedBottom = Math.max(0, layoutHeight - (viewport.offsetTop + viewport.height));
    if (occludedBottom <= 0) {
      return;
    }

    const head = view.state.selection.main.head;
    const cursorRect = view.coordsAtPos(head);
    if (!cursorRect) {
      return;
    }

    const visibleBottom = Math.round(viewport.offsetTop + viewport.height);
    const clearance = 20;
    const overlap = cursorRect.bottom + clearance - visibleBottom;
    if (overlap <= 0) {
      return;
    }

    view.scrollDOM.scrollTop += overlap;
  }, [isMobile]);

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      return;
    }

    const runNudge = () => {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(editorViewRef.current);
      });
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', runNudge);
    viewport?.addEventListener('scroll', runNudge, { passive: true });
    document.addEventListener('selectionchange', runNudge);

    return () => {
      viewport?.removeEventListener('resize', runNudge);
      viewport?.removeEventListener('scroll', runNudge);
      document.removeEventListener('selectionchange', runNudge);
    };
  }, [isMobile, nudgeEditorSelectionAboveKeyboard]);

  React.useEffect(() => {
    if (!canEdit || textViewMode !== 'edit' || isMobile) {
      return;
    }

    const goToLineCombo = getEffectiveShortcutCombo('open_go_to_line', shortcutOverrides);

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[role="dialog"]')) {
        return;
      }

      const isEditorTarget = Boolean(target?.closest('.cm-editor'));
      const isTypingTarget = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')
      );
      if (isTypingTarget && !isEditorTarget) {
        return;
      }

      const activeElement = document.activeElement as Element | null;
      const editorHasFocus = Boolean(activeElement?.closest('.cm-editor'));
      if (!editorHasFocus) {
        return;
      }

      if (eventMatchesShortcut(event, goToLineCombo)) {
        event.preventDefault();
        setIsGoToLineOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canEdit, isMobile, shortcutOverrides, textViewMode]);

  const editorFontSize = useUIStore((state) => state.editorFontSize);

  const editorExtensions = React.useMemo(() => {
    if (!selectedFile?.path) {
      return [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    }

    // Shiki token colors (worker-backed) match the Shiki file view exactly.
    // Same language resolver as the view, so both agree on the language. When
    // Shiki is the color source, drop the lezer token colors to avoid a
    // competing highlighter (Keep the lezer language for indentation/folding).
    const shikiLanguage = getLanguageFromExtension(selectedFile.path);
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, shikiLanguage ? { syntaxColors: false, fontSize: editorFontSize } : { fontSize: editorFontSize })];
    const language = staticLanguageExtension ?? dynamicLanguageExtension;
    if (language) {
      extensions.push(language);
    }
    if (shikiLanguage) {
      extensions.push(shikiHighlightExtension({
        language: shikiLanguage,
        themeName: currentTheme.metadata.id,
        theme: getResolvedShikiTheme(currentTheme),
      }));
    }
    if (wrapLines) {
      extensions.push(EditorView.lineWrapping);
    }
    if (workspaceId && activeWorkbenchTab?.viewId) {
      const viewId = activeWorkbenchTab.viewId;
      extensions.push(EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.viewportChanged) return;
        patchEditorViewState(workspaceId, viewId, captureEditorViewState(update.view));
      }));
    }
    if (isMobile) {
      extensions.push(EditorView.updateListener.of((update) => {
        if (!update.view.hasFocus) {
          return;
        }
        if (!(update.selectionSet || update.focusChanged || update.viewportChanged || update.geometryChanged)) {
          return;
        }

        window.requestAnimationFrame(() => {
          nudgeEditorSelectionAboveKeyboard(update.view);
        });
      }));
    }
    return extensions;
  }, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, workspaceId, activeWorkbenchTab?.viewId]);

  const pierreTheme = React.useMemo(
    () => ({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id }),
    [lightTheme.metadata.id, darkTheme.metadata.id],
  );

  const imageAssetAuthKey = selectedFile?.path && isSelectedImage && !runtime.isDesktop && !isSelectedSvg
    ? `${selectedFile.path}|${selectedFileReadOptions.allowOutsideWorkspace ? 'outside' : 'workspace'}|${selectedFileReadOptions.outsideFileGrant ?? ''}`
    : '';

  const pdfAssetAuthKey = selectedFile?.path && isSelectedPdf
    ? `${selectedFile.path}|${selectedFileReadOptions.allowOutsideWorkspace ? 'outside' : 'workspace'}|${selectedFileReadOptions.outsideFileGrant ?? ''}`
    : '';

  const htmlAssetAuthKey = selectedFile?.path && isHtml && htmlViewMode === 'preview' && !runtime.isVSCode
    ? selectedFile.path
    : '';

  const assetAuthErrorFallback = t('filesView.error.readFileFailed');
  const { readyKey: imageAssetAuthReadyKey, nonce: imagePreviewNonce } =
    useAssetAuthRefresh(imageAssetAuthKey, setFileError, assetAuthErrorFallback);
  const { readyKey: htmlAssetAuthReadyKey, nonce: htmlPreviewNonce } =
    useAssetAuthRefresh(htmlAssetAuthKey, setFileError, assetAuthErrorFallback);
  const { readyKey: pdfAssetAuthReadyKey, nonce: pdfPreviewNonce } =
    useAssetAuthRefresh(pdfAssetAuthKey, setFileError, assetAuthErrorFallback);

  const isImageAssetAuthLoading = Boolean(imageAssetAuthKey && imageAssetAuthReadyKey !== imageAssetAuthKey);
  const isHtmlAssetAuthLoading = Boolean(htmlAssetAuthKey && htmlAssetAuthReadyKey !== htmlAssetAuthKey);
  const isPdfAssetAuthLoading = Boolean(pdfAssetAuthKey && pdfAssetAuthReadyKey !== pdfAssetAuthKey);

  const imageSrc = selectedFile?.path && isSelectedImage
    ? (runtime.isDesktop
      ? (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : desktopImageSrc)
      : (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : imageAssetAuthReadyKey === imageAssetAuthKey ? getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
          path: selectedFile.path,
          allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
          outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
          directory: root || undefined,
        }) : ''))
    : '';

  const pdfSrc = selectedFile?.path && isSelectedPdf && pdfAssetAuthReadyKey === pdfAssetAuthKey
    ? getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: selectedFile.path,
      allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
      outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
      directory: root || undefined,
    })
    : '';

  const renderPdfPreview = React.useCallback((file: FileNode) => (
    <div className="h-full overflow-hidden bg-[var(--surface-background)]">
      <iframe
        key={pdfPreviewNonce}
        src={pdfSrc}
        className="h-full w-full border-0"
        title={file.name}
      />
    </div>
  ), [pdfSrc, pdfPreviewNonce]);

  React.useEffect(() => {
    let cancelled = false;

    const resolveDesktopImage = async () => {
      if (!runtime.isDesktop || !selectedFile?.path || !isSelectedImage || isSelectedSvg) {
        if (desktopImageBlobUrlRef.current) {
          URL.revokeObjectURL(desktopImageBlobUrlRef.current);
          desktopImageBlobUrlRef.current = '';
        }
        setDesktopImageSrc('');
        return;
      }

      setFileError(null);

      if (desktopImageBlobUrlRef.current) {
        URL.revokeObjectURL(desktopImageBlobUrlRef.current);
        desktopImageBlobUrlRef.current = '';
      }

      const srcPromise = files.readFileBinary
        ? files.readFileBinary(selectedFile.path, selectedFileReadOptions).then((result) => result.dataUrl)
        : (async () => {
          const response = await runtimeFetch('/api/fs/raw', {
            query: {
              path: selectedFile.path,
              allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
              outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
              directory: root || undefined,
            },
          });
          if (!response.ok) {
            throw new Error(t('filesView.error.readFileFailed'));
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return '';
          }
          desktopImageBlobUrlRef.current = url;
          return url;
        })();

      await srcPromise
        .then((src) => {
          if (!cancelled) {
            setDesktopImageSrc(src);
            setLoadedFilePath(selectedFile.path);
          }
        })
        .catch((error) => {
          if (desktopImageBlobUrlRef.current) {
            URL.revokeObjectURL(desktopImageBlobUrlRef.current);
            desktopImageBlobUrlRef.current = '';
          }
          if (!cancelled) {
            setDesktopImageSrc('');
            setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
            setLoadedFilePath(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setFileLoading(false);
          }
        });
    };

    void resolveDesktopImage();

    return () => {
      cancelled = true;
    };
  }, [files, isSelectedImage, isSelectedSvg, root, runtime.isDesktop, selectedFile?.path, selectedFileReadOptions, t]);

  React.useEffect(() => {
    return () => {
      if (desktopImageBlobUrlRef.current) {
        URL.revokeObjectURL(desktopImageBlobUrlRef.current);
        desktopImageBlobUrlRef.current = '';
      }
    };
  }, []);

  const handleCloseDialog = React.useCallback(() => setActiveDialog(null), []);

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: filesFileDrafts,
      editingDraftId,
      commentText,
      onTextChange: setCommentText,
      selection: lineSelection,
      isDragging,
      fileLabel: selectedFile?.path ?? '',
      newWidgetId: 'files-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: () => {
        setLineSelection(null);
        cancel();
      },
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [cancel, commentText, deleteDraft, editingDraftId, filesFileDrafts, handleSaveComment, isDragging, lineSelection, selectedFile?.path, setCommentText, startEdit]);

  const renderShikiFileView = React.useCallback((file: FileNode, content: string) => {
    return (
      <div className="h-full">
        <PierreFile
          file={{
            name: file.name,
            contents: content,
            lang: getLanguageFromExtension(file.path) || undefined,
          }}
          options={{
            disableFileHeader: true,
            overflow: wrapLines ? 'wrap' : 'scroll',
            theme: pierreTheme,
            themeType: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
          }}
          className="block h-full w-full"
          style={{ height: '100%' }}
        />
      </div>
    );
  }, [currentTheme.metadata.variant, pierreTheme, wrapLines]);

  const renderFloatingFileControls = ({
    exitFullscreenOnly = false,
    layout = 'floating',
  }: { exitFullscreenOnly?: boolean; layout?: 'floating' | 'docked' } = {}) => {
    if (!selectedFile) {
      return null;
    }

    const docked = layout === 'docked';
    const wrapperCls = docked
      ? 'pointer-events-auto flex flex-wrap items-center gap-1'
      : 'pointer-events-auto flex items-center gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 shadow-sm';

    const withTooltip = (label: React.ReactNode, trigger: React.ReactElement) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            {trigger}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
      </Tooltip>
    );

    return (
      <div className={wrapperCls}>
        {canEdit && isEditingFile && (
          <>
            {isSaving ? (
              <span className="flex items-center gap-1 px-1 text-muted-foreground typography-meta">
                <Icon name="loader-4" className="size-3.5 animate-spin" />
                {t('filesView.editor.saving')}
              </span>
            ) : autoSaveEnabled && autoSaveStatus === 'saved' && !isDirty ? (
              <span className="flex items-center gap-1 px-1 text-[color:var(--status-success)] typography-meta">
                <Icon name="check" className="size-3.5" />
                {t('filesView.editor.saved')}
              </span>
            ) : isDirty ? withTooltip(t(autoSaveEnabled ? 'filesView.editor.saveNowTitle' : 'filesView.editor.saveNowManualTitle', { shortcut: `${getModifierLabel()}+S` }),
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void saveDraft()}
                className="h-6 gap-1 px-1 text-muted-foreground opacity-80 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
                title={t(autoSaveEnabled ? 'filesView.editor.saveNowTitle' : 'filesView.editor.saveNowManualTitle', { shortcut: `${getModifierLabel()}+S` })}
                aria-label={t('filesView.editor.saveAria', { shortcut: `${getModifierLabel()}+S` })}
              >
                <Icon name="save-3" className="size-4" />
              </Button>
            ) : null}
            {withTooltip(autoSaveEnabled ? t('filesView.editor.autoSaveOn') : t('filesView.editor.manualSave'),
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
                className={cn(
                  'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                  autoSaveEnabled ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-65 hover:opacity-100'
                )}
                title={autoSaveEnabled ? t('filesView.editor.autoSaveOn') : t('filesView.editor.manualSave')}
                aria-label={autoSaveEnabled ? t('filesView.editor.autoSaveOn') : t('filesView.editor.manualSave')}
              >
                {autoSaveEnabled ? <Icon name="file-check-fill" className="size-4" /> : <Icon name="file-check" className="size-4" />}
              </Button>
            )}
          </>
        )}

        <DropdownMenu onOpenChange={handleToolbarDropdownOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0 text-foreground opacity-100 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={t('filesView.editor.openInDesktopApp')}
                    aria-label={t('filesView.editor.openInDesktopApp')}
                  >
                    <Icon name="file-transfer" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('filesView.editor.openInDesktopApp')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
            {openInApps.map((app) => (
              <DropdownMenuItem
                key={app.id}
                className="flex items-center gap-2"
                onClick={() => void handleOpenInApp(app)}
              >
                <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
                <span className="typography-ui-label text-foreground">{app.label}</span>
              </DropdownMenuItem>
            ))}
            {openInCacheStale ? (
              <DropdownMenuItem
                className="flex items-center gap-2"
                onClick={() => void loadOpenInApps(true)}
              >
                <Icon name="refresh" className="size-4" />
                <span className="typography-ui-label text-foreground">{t('filesView.editor.refreshApps')}</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        {!isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && (
          <>
            {withTooltip(wrapLines ? t('filesView.editor.disableLineWrap') : t('filesView.editor.enableLineWrap'),
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWrapLines(!wrapLines)}
                className={cn(
                  'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                  wrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-65 hover:opacity-100'
                )}
                title={wrapLines ? t('filesView.editor.disableLineWrap') : t('filesView.editor.enableLineWrap')}
              >
                <Icon name="text-wrap" className="size-4" />
              </Button>
            )}
            {textViewMode === 'edit' && (
              <>
                {withTooltip(t('filesView.editor.findInFile'),
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      setIsSearchOpen(!isSearchOpen);
                      event.currentTarget.blur();
                    }}
                    className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={t('filesView.editor.findInFile')}
                  >
                    <Icon name="search" className="size-4" />
                  </Button>
                )}
                {withTooltip(t('filesView.editor.goToLine'),
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      setIsGoToLineOpen((open) => !open);
                      event.currentTarget.blur();
                    }}
                    className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={t('filesView.editor.goToLine')}
                  >
                    <Icon name="menu-fold-2" className="size-4" />
                  </Button>
                )}
                <GoToLineDialog
                  open={isGoToLineOpen}
                  onOpenChange={setIsGoToLineOpen}
                  view={editorViewRef.current}
                  variant="inline"
                />
              </>
            )}
          </>
        )}

        {canUseShikiFileView && canEdit && !isJson && !isHtml && (
          <PreviewToggleButton
            currentMode={textViewMode === 'view' ? 'preview' : 'edit'}
            onToggle={() => {
              saveTextViewMode(textViewMode === 'view' ? 'edit' : 'view');
            }}
          />
        )}

        {isMarkdown && (
          withTooltip(
            t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
              className={cn(
                'size-6 p-0 transition-colors hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] active:bg-[var(--interactive-hover)]',
                getMdViewMode() === 'preview'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)] focus-visible:bg-[var(--interactive-selection)] active:bg-[var(--interactive-selection)]'
                  : 'text-muted-foreground opacity-65 hover:opacity-100'
              )}
              title={t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
              aria-label={t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
            >
              <Icon name={getMdViewMode() === 'preview' ? 'eye' : 'eye-off'} className="size-4" />
            </Button>
          )
        )}

        {isHtmlFile(selectedFile?.path ?? '') && (
          <PreviewToggleButton
            currentMode={getHtmlViewMode()}
            onToggle={() => {
              saveHtmlViewMode(getHtmlViewMode() === 'preview' ? 'edit' : 'preview');
            }}
          />
        )}

        {isMarkdown && getMdViewMode() === 'preview' && showMessageTTSButtons && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-muted-foreground opacity-65 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
                aria-label={isTTSPlaying ? t('filesView.tts.stopSpeaking') : t('filesView.tts.readAloud')}
                onClick={() => {
                  if (isTTSPlaying) {
                    stopTTS();
                  } else if (fileContent.trim()) {
                    void playTTS(fileContent);
                  }
                }}
              >
                {isTTSPlaying ? (
                  <Icon name="stop" className="size-4 text-[color:var(--status-success)]" />
                ) : (
                  <Icon name="volume-up" className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>
              {isTTSPlaying ? t('filesView.tts.stopSpeaking') : t('filesView.tts.readAloud')}
            </TooltipContent>
          </Tooltip>
        )}

        {isDrawio && (
          <>
            <PreviewToggleButton
              currentMode={drawioViewMode}
              onToggle={() => saveDrawioViewMode(drawioViewMode === 'preview' ? 'edit' : 'preview')}
            />
            {drawioViewMode === 'preview' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const xml = diagramEditorRef.current?.getXml();
                  if (diagramAutoSaveTimerRef.current) {
                    clearTimeout(diagramAutoSaveTimerRef.current);
                    diagramAutoSaveTimerRef.current = null;
                  }
                  if (selectedFile?.path && xml) {
                    const saved = await saveDiagramXml(selectedFile.path, xml);
                    if (!saved) return;
                    setDiagramSaved(true);
                    setTimeout(() => setDiagramSaved(false), 1500);
                  }
                }}
                className="size-6 p-0 text-foreground hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                title={t('filesView.diagram.saveDiagram')}
              >
                {diagramSaved ? (
                  <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
                ) : (
                  <Icon name="save-3" className="size-4" />
                )}
              </Button>
            )}
          </>
        )}

        {isJson && (
          withTooltip(jsonViewMode === 'tree' ? t('filesView.editor.switchToTextView') : t('filesView.editor.switchToTreeView'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveJsonViewMode(jsonViewMode === 'tree' ? 'text' : 'tree')}
              className="size-6 p-0 text-muted-foreground opacity-65 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
              title={jsonViewMode === 'tree' ? t('filesView.editor.switchToTextView') : t('filesView.editor.switchToTreeView')}
            >
              {jsonViewMode === 'tree' ? (
                <Icon name="code-sslash" className="size-4" />
              ) : (
                <Icon name="node-tree" className="size-4" />
              )}
            </Button>
          )
        )}

        {canCopy && (
          withTooltip(t('filesView.editor.copyFileContents'),
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(fileContent);
                if (result.ok) {
                  setCopiedContent(true);
                  if (copiedContentTimeoutRef.current !== null) {
                    window.clearTimeout(copiedContentTimeoutRef.current);
                  }
                  copiedContentTimeoutRef.current = window.setTimeout(() => {
                    setCopiedContent(false);
                  }, 1200);
                } else {
                  toast.error(t('filesView.toast.copyFailed'));
                }
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={t('filesView.editor.copyFileContents')}
              aria-label={t('filesView.editor.copyFileContents')}
            >
              {copiedContent ? (
                <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="clipboard" className="size-4" />
              )}
            </Button>
          )
        )}

        {canCopyPath && (
          withTooltip(t('filesView.editor.copyFilePathTitle', { path: displaySelectedPath }),
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(displaySelectedPath);
                if (result.ok) {
                  setCopiedPath(true);
                  if (copiedPathTimeoutRef.current !== null) {
                    window.clearTimeout(copiedPathTimeoutRef.current);
                  }
                  copiedPathTimeoutRef.current = window.setTimeout(() => {
                    setCopiedPath(false);
                  }, 1200);
                } else {
                  toast.error(t('filesView.toast.copyFailed'));
                }
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={t('filesView.editor.copyFilePathTitle', { path: displaySelectedPath })}
              aria-label={t('filesView.editor.copyFilePathTitle', { path: displaySelectedPath })}
            >
              {copiedPath ? (
                <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="file-copy-2" className="size-4" />
              )}
            </Button>
          )
        )}

        {files.downloadFile && (
          withTooltip(t('filesView.editor.saveFile'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const fn = files.downloadFile;
                if (fn) void fn(selectedFile.path).catch((error) => {
                  console.error('Download failed:', error);
                  toast.error(t('sidebarFilesTree.toast.operationFailed'));
                });
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={t('filesView.editor.saveFile')}
              aria-label={t('filesView.editor.saveFile')}
            >
              <Icon name="download" className="size-4" />
            </Button>
          )
        )}

        {workspaceId && selectedDocumentIdentity && !isMobile ? (
          withTooltip(t('filesView.editor.splitEditor'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!workspaceId) return;
                const resourceId = selectedDocumentIdentity.resourceId;
                openWorkbenchEditor(workspaceId, resourceId);
                splitActiveEditor(workspaceId, 'vertical');
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={t('filesView.editor.splitEditor')}
              aria-label={t('filesView.editor.splitEditor')}
            >
              <Icon name="split-cells-horizontal" className="size-4" />
            </Button>
          )
        ) : null}

        {exitFullscreenOnly ? (
          withTooltip(t('filesView.editor.exitFullscreen'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFullscreen(false)}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={t('filesView.editor.exitFullscreen')}
              aria-label={t('filesView.editor.exitFullscreen')}
            >
              <Icon name="fullscreen-exit" className="size-4" />
            </Button>
          )
        ) : (!isMobile && mode === 'full' && (
          withTooltip(isFullscreen ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen'),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={isFullscreen ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen')}
              aria-label={isFullscreen ? t('filesView.editor.exitFullscreen') : t('filesView.editor.fullscreen')}
            >
              {isFullscreen ? (
                <Icon name="fullscreen-exit" className="size-4" />
              ) : (
                <Icon name="fullscreen" className="size-4" />
              )}
            </Button>
          )
        ))}
      </div>
    );
  };

  const fileViewer = (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
    >
      {selectedDocumentIdentity && (selectedDocument?.status === 'conflict' || selectedDocument?.status === 'deleted') ? (
        <DocumentConflictBanner identity={selectedDocumentIdentity} />
      ) : null}
      <div className={cn('flex flex-col flex-shrink-0', showEditorTabsRow && 'border-b border-border/40')}>
        {/* Row 1: Tabs */}
        {showEditorTabsRow ? (
        <div className="flex min-w-0 items-center px-3 py-1.5">
          {isMobile && showMobilePageContent && (
            <button
              type="button"
              onClick={() => setShowMobilePageContent(false)}
              aria-label={t('filesView.editor.back')}
              className="inline-flex size-7 flex-shrink-0 items-center justify-center mr-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="arrow-left-s" className="size-5" />
            </button>
          )}

          {isMobile ? (
            selectedFile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
                    aria-label={t('filesView.editor.openFilesAria')}
                  >
                    <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="size-3.5 flex-shrink-0" />
                    <ScrollingFileName name={selectedFile.name} />
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <DropdownMenuItem
                        key={file.path}
                        onSelect={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('[data-close-open-file]')) {
                            event.preventDefault();
                            return;
                          }
                          if (!isActive) {
                            void handleSelectFile(file);
                          }
                        }}
                        className={cn(
                          'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                          isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                          <ScrollingFileName name={file.name} />
                          {root && dirtyResourceIds.has(resourceIdFromWorkspacePath(root, file.path) ?? '') ? (
                            <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                          ) : null}
                        </span>
                        <button
                          type="button"
                          data-close-open-file
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                          aria-label={t('filesView.editor.closeFileAria', { name: file.name })}
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
            )
          ) : (
            openFiles.length > 0 ? (
              <div className="relative min-w-0 flex-1">
                {editorTabsOverflow.left && (
                  <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent" />
                )}
                {editorTabsOverflow.right && (
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
                )}
                <div
                  ref={editorTabsScrollRef}
                  className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <div
                        key={file.path}
                        title={getDisplayPath(root, file.path)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                          isActive
                            ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                            : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                        )}
                      >
                        <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isActive) {
                              void handleSelectFile(file);
                            }
                          }}
                          className="max-w-[12rem] truncate text-left"
                        >
                          {file.name}
                        </button>
                        {root && dirtyResourceIds.has(resourceIdFromWorkspacePath(root, file.path) ?? '') ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                        ) : null}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className={cn(
                            'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                            !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100'
                          )}
                          aria-label={t('filesView.editor.closeFileAria', { name: file.name })}
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
            )
          )}
        </div>
        ) : null}

        {/* Row 2: Docked editor toolbar (expanded). Desktop-only opt-in. */}
        {settingsExpandedEditorToolbar && !isMobile && selectedFile ? (
          <div className="flex min-w-0 items-center gap-3 border-t border-border/40 bg-[var(--surface-subtle)] px-3 py-1">
            {displaySelectedPath ? (
              <span
                className="min-w-0 flex-1 truncate typography-meta text-muted-foreground"
                title={displaySelectedPath}
              >
                {displaySelectedPath}
              </span>
            ) : null}
            <div className="ml-auto min-w-0 shrink-0 overflow-x-auto">
              {renderFloatingFileControls({ layout: 'docked' })}
            </div>
          </div>
        ) : null}

      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        {selectedFile && !isSearchOpen && !(settingsExpandedEditorToolbar && !isMobile) && (
          <div
            ref={floatingToolbarRef}
            className="absolute right-3 top-3 z-30"
            onMouseLeave={() => {
              if (toolbarDropdownOpenCountRef.current > 0) return;
              setIsFloatingToolbarOpen(false);
            }}
          >
            {isFloatingToolbarOpen ? (
              renderFloatingFileControls()
            ) : (
              <div className="flex items-center gap-1">
                {isMarkdown ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
                          className={cn(
                            'size-8 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-0 shadow-sm transition-colors',
                            getMdViewMode() === 'preview'
                              ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)]'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                          aria-label={t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
                          title={t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
                        >
                          <Icon name={getMdViewMode() === 'preview' ? 'eye' : 'eye-off'} className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {t(getMdViewMode() === 'preview' ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex"
                      onMouseEnter={() => setIsFloatingToolbarOpen(true)}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsFloatingToolbarOpen(true)}
                        className="size-8 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-0 text-muted-foreground shadow-sm hover:text-foreground"
                        aria-label={t('filesView.editor.showControlsAria')}
                        title={t('filesView.editor.controlsTitle')}
                      >
                        <Icon name="more-2-fill" className="size-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>{t('filesView.editor.controlsTitle')}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
        )}
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {!selectedFile ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('filesView.editor.pickFileFromTree')}</div>
          ) : (fileLoading || isImageAssetAuthLoading || isPdfAssetAuthLoading) ? (
            suppressFileLoadingIndicator
              ? <div className="p-3" />
              : (
                <div className="p-3 flex items-center gap-2 typography-ui text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  {t('filesView.state.loading')}
                </div>
              )
          ) : fileError ? (
            <div className="p-3 typography-ui text-[color:var(--status-error)]">{fileError}</div>
          ) : isSelectedImage ? (
            <div className="flex h-full items-center justify-center p-3">
              <img
                key={imagePreviewNonce}
                src={imageSrc}
                alt={selectedFile?.name ?? t('filesView.editor.imageAltFallback')}
                className="max-w-full max-h-[70vh] object-contain rounded-md border border-border/30 bg-primary/10"
              />
            </div>
          ) : isSelectedPdf ? (
            renderPdfPreview(selectedFile)
          ) : isUnsupportedBinary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="typography-ui-header text-foreground">{t('filesView.editor.cannotPreviewBinary')}</div>
              <div className="max-w-md typography-ui text-muted-foreground">{t('filesView.editor.binaryFileDescription')}</div>
              {files.downloadFile ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const fn = files.downloadFile;
                    if (!fn || !selectedFile) return;
                    void fn(selectedFile.path).catch((error) => {
                      console.error('Download failed:', error);
                      toast.error(t('sidebarFilesTree.toast.operationFailed'));
                    });
                  }}
                >
                  <Icon name="download" className="mr-2 size-4" />
                  {t('filesView.editor.saveFile')}
                </Button>
              ) : null}
            </div>
          ) : selectedFile && isDrawio && drawioViewMode === 'preview' ? (
            <div className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
              <DiagramEditor
                key={`${selectedFile.path}:${drawioRemountNonce}`}
                ref={diagramEditorRef}
                xml={diagramEditorXml}
                onChange={handleDiagramChange}
              />
            </div>
          ) : selectedFile && isJson && jsonViewMode === 'tree' ? (
            <ErrorBoundary
              fallback={
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <div className="mb-1 font-medium text-destructive">{t('filesView.error.jsonViewerUnavailable')}</div>
                  <div className="text-sm text-muted-foreground">
                    {t('filesView.error.switchToTextMode')}
                  </div>
                </div>
              }
            >
              <div className="h-full overflow-auto">
                <JsonTreeView
                  jsonString={fileContent}
                  maxHeight="100%"
                  initiallyExpandedDepth={2}
                />
              </div>
            </ErrorBoundary>
          ) : selectedFile && isMarkdown && getMdViewMode() === 'preview' ? (
            <div className="h-full overflow-auto p-3">
              {fileContent.length > 500 * 1024 && (
                <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                  {t('filesView.warning.largeFilePreviewLimited', { sizeKb: Math.round(fileContent.length / 1024) })}
                </div>
              )}
              <ErrorBoundary
                fallback={
                  <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                    <div className="mb-1 font-medium text-destructive">{t('filesView.error.previewUnavailable')}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('filesView.error.switchToEditMode')}
                    </div>
                  </div>
                }
              >
                <SimpleMarkdownRenderer
                  content={fileContent}
                  className="typography-markdown-body"
                  stripFrontmatter
                  enableFileReferences={false}
                />
              </ErrorBoundary>
            </div>
          ) : selectedFile && isHtml && htmlViewMode === 'preview' ? (
            isHtmlAssetAuthLoading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground typography-ui-label">
                {t('common.loading')}
              </div>
            ) : (
            <div className="h-full overflow-hidden">
              <iframe
                key={htmlPreviewNonce}
                src={!runtime.isVSCode && htmlAssetAuthReadyKey === htmlAssetAuthKey ? (() => {
                  const encoded = selectedFile.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
                  return getRuntimeUrlResolver().authenticatedAsset(`/api/fs/serve${encoded.startsWith('/') ? encoded : `/${encoded}`}`);
                })() : undefined}
                srcDoc={runtime.isVSCode ? (() => {
                  const basePath = selectedFile.path.substring(0, selectedFile.path.lastIndexOf('/') + 1);
                  if (!basePath) return fileContent;
                  return fileContent.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`);
                })() : undefined}
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-same-origin allow-forms"
                title={t('filesView.editor.htmlPreviewTitle')}
              />
            </div>
            )
          ) : selectedFile && canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent)
          ) : (
            <div
              className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}
              ref={editorWrapperRef}
            >
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
                <DocumentCodeMirror
                  identity={selectedDocumentIdentity}
                  readOnly={!canEdit}
                  vimMode={fileEditorKeymap === 'vim'}
                  extensions={editorExtensions}
                  className="h-full"
                  blockWidgets={blockWidgets}
                  onViewReady={(view) => {
                    editorViewRef.current = view;
                    setEditorViewReadyNonce((value) => value + 1);
                    if (activeWorkbenchTab) applyEditorViewState(view, activeWorkbenchTab.viewState);
                    window.requestAnimationFrame(() => {
                      nudgeEditorSelectionAboveKeyboard(view);
                    });
                  }}
                  onViewDestroy={() => {
                    if (editorViewRef.current) {
                      editorViewRef.current = null;
                    }
                    setEditorViewReadyNonce((value) => value + 1);
                  }}
                  enableSearch
                  searchOpen={isSearchOpen}
                  onSearchOpenChange={setIsSearchOpen}
                  highlightLines={lineSelection
                    ? {
                      start: Math.min(lineSelection.start, lineSelection.end),
                      end: Math.max(lineSelection.start, lineSelection.end),
                    }
                    : undefined}
                  lineNumbersConfig={{
                    domEventHandlers: {
                      mousedown: (view: EditorView, line: { from: number; to: number }, event: Event) => {
                        if (!(event instanceof MouseEvent)) {
                          return false;
                        }
                        if (event.button !== 0) {
                          return false;
                        }
                        event.preventDefault();

                        const lineNumber = view.state.doc.lineAt(line.from).number;

                        if (
                          lineSelection &&
                          !event.shiftKey &&
                          Math.min(lineSelection.start, lineSelection.end) === lineNumber &&
                          Math.max(lineSelection.start, lineSelection.end) === lineNumber
                        ) {
                          setLineSelection(null);
                          cancel();
                          isSelectingRef.current = false;
                          selectionStartRef.current = null;
                          setIsDragging(false);
                          return true;
                        }

                        // Mobile: tap-to-extend selection
                          if (isMobile && lineSelection && !event.shiftKey) {
                            const start = Math.min(lineSelection.start, lineSelection.end, lineNumber);
                            const end = Math.max(lineSelection.start, lineSelection.end, lineNumber);
                            setLineSelection({ start, end });
                            isSelectingRef.current = false;
                            selectionStartRef.current = null;
                            setIsDragging(false);
                            return true;
                          }

                          isSelectingRef.current = true;
                          selectionStartRef.current = lineNumber;
                          setIsDragging(true);

                          if (lineSelection && event.shiftKey) {
                          const start = Math.min(lineSelection.start, lineNumber);
                          const end = Math.max(lineSelection.end, lineNumber);
                          setLineSelection({ start, end });
                        } else {
                          setLineSelection({ start: lineNumber, end: lineNumber });
                        }

                        return true;
                      },
                      mouseover: (view: EditorView, line: { from: number; to: number }, event: Event) => {
                        if (!(event instanceof MouseEvent)) {
                          return false;
                        }
                        if (event.buttons !== 1) {
                          return false;
                        }
                        if (!isSelectingRef.current || selectionStartRef.current === null) {
                          return false;
                        }

                        const lineNumber = view.state.doc.lineAt(line.from).number;
                          const start = Math.min(selectionStartRef.current, lineNumber);
                          const end = Math.max(selectionStartRef.current, lineNumber);
                          setLineSelection({ start, end });
                          setIsDragging(true);
                          return false;
                        },
                        mouseup: () => {
                          isSelectingRef.current = false;
                          selectionStartRef.current = null;
                          setIsDragging(false);
                          return false;
                        },
                      },
                  }}
                />
              </div>
              {shouldMaskEditorForPendingNavigation && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                  <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('filesView.state.openingFileAtChange')}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  const hasTree = Boolean(root && childrenByDir[root]);
  const rootLoadError = root ? loadErrorsByDir[root] : null;

  const treePanel = (
    <FilesExplorer
      isMobile={isMobile}
      root={root}
      currentDirectory={currentDirectory}
      searchQuery={searchQuery}
      searchInputRef={searchInputRef}
      onSearchQueryChange={setSearchQuery}
      searching={searching}
      searchResults={searchResults}
      rootLoadError={rootLoadError}
      hasTree={hasTree}
      childrenByDir={childrenByDir}
      loadErrorsByDir={loadErrorsByDir}
      expandedPaths={expandedPaths}
      selectedPath={selectedFile?.path ?? selectedPath}
      isBrowserClient={isBrowserClient}
      alwaysShowActions={alwaysShowActions}
      permissions={fileRowPermissions}
      {...(files.downloadFile ? { downloadFile: files.downloadFile } : {})}
      contextMenuPath={contextMenuPath}
      setContextMenuPath={setContextMenuPath}
      rightClickMenuPath={rightClickMenuPath}
      setRightClickMenuPath={setRightClickMenuPath}
      onSelect={(node) => { void handleSelectFile(node); }}
      onToggle={(path) => { void toggleDirectory(path); }}
      onRevealPath={handleRevealPath}
      onOpenDialog={handleOpenDialog}
      onRefreshRoot={() => { void refreshRoot(); }}
      onRefreshDirectory={(path) => { void refreshDirectory(path); }}
      getFileStatus={getFileStatus}
      getFolderBadge={getFolderBadge}
    />
  );

  // Fullscreen file viewer overlay
  const fullscreenViewer = mode === 'full' && isFullscreen && selectedFile && (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Fullscreen content */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div className="absolute right-4 top-4 z-30">
          {renderFloatingFileControls({ exitFullscreenOnly: true })}
        </div>
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {(fileLoading || isImageAssetAuthLoading || isPdfAssetAuthLoading) ? (
            suppressFileLoadingIndicator
              ? <div className="p-4" />
              : (
                <div className="p-4 flex items-center gap-2 typography-ui text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  Loading…
                </div>
              )
          ) : fileError ? (
            <div className="p-4 typography-ui text-[color:var(--status-error)]">{fileError}</div>
          ) : isSelectedImage ? (
            <div className="flex h-full items-center justify-center p-4">
              <img
                key={imagePreviewNonce}
                src={imageSrc}
                alt={selectedFile.name}
                className="max-w-full max-h-full object-contain rounded-md border border-border/30 bg-primary/10"
              />
            </div>
          ) : isSelectedPdf ? (
            renderPdfPreview(selectedFile)
          ) : isUnsupportedBinary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="typography-ui-header text-foreground">{t('filesView.editor.cannotPreviewBinary')}</div>
              <div className="max-w-md typography-ui text-muted-foreground">{t('filesView.editor.binaryFileDescription')}</div>
              {files.downloadFile ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const fn = files.downloadFile;
                    if (!fn || !selectedFile) return;
                    void fn(selectedFile.path).catch((error) => {
                      console.error('Download failed:', error);
                      toast.error(t('sidebarFilesTree.toast.operationFailed'));
                    });
                  }}
                >
                  <Icon name="download" className="mr-2 size-4" />
                  {t('filesView.editor.saveFile')}
                </Button>
              ) : null}
            </div>
          ) : isMarkdown && getMdViewMode() === 'preview' ? (
            <div className="h-full overflow-auto p-4">
              {fileContent.length > 500 * 1024 && (
                  <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                    {t('filesView.warning.largeFilePreviewLimited', { sizeKb: Math.round(fileContent.length / 1024) })}
                  </div>
                )}
              <ErrorBoundary
                fallback={
                  <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                    <div className="mb-1 font-medium text-destructive">{t('filesView.error.previewUnavailable')}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('filesView.error.switchToEditMode')}
                    </div>
                  </div>
                }
              >
                <SimpleMarkdownRenderer
                  content={fileContent}
                  className="typography-markdown-body"
                  stripFrontmatter
                  enableFileReferences={false}
                />
              </ErrorBoundary>
            </div>
          ) : canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent)
          ) : (
            <div className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}>
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
              <DocumentCodeMirror
                identity={selectedDocumentIdentity}
                readOnly={!canEdit}
                vimMode={fileEditorKeymap === 'vim'}
                extensions={editorExtensions}
                className="h-full"
                onViewReady={(view) => {
                  editorViewRef.current = view;
                  if (activeWorkbenchTab) applyEditorViewState(view, activeWorkbenchTab.viewState);
                  window.requestAnimationFrame(() => {
                    nudgeEditorSelectionAboveKeyboard(view);
                  });
                }}
                onViewDestroy={() => {
                  if (editorViewRef.current) {
                    editorViewRef.current = null;
                  }
                }}
              />
              </div>
              {shouldMaskEditorForPendingNavigation && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                  <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('filesView.state.openingFileAtChange')}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  const editorArea = workspaceId && editorWorkbench && editorGroups.length > 1 && !isMobile ? (
    <EditorGroupsLayout
      tree={editorWorkbench.tree}
      activeGroupId={editorWorkbench.activeGroupId}
      workspaceRoot={root}
      dirtyResourceIds={dirtyResourceIds}
      alwaysShowActions={alwaysShowActions}
      isMobile={isMobile}
      onActivate={(groupId, tabId) => {
        setActiveWorkbenchEditor(workspaceId, groupId, tabId);
        const found = editorGroups.flatMap((group) => group.tabs).find((tab) => tab.tabId === tabId);
        if (found) setSelectedPath(root, workspacePathFromResourceId(root, found.resourceId));
      }}
      onClose={(tabId) => {
        const found = editorGroups.flatMap((group) => group.tabs).find((tab) => tab.tabId === tabId);
        closeWorkbenchEditor(workspaceId, tabId);
        if (found) removeOpenPath(root, workspacePathFromResourceId(root, found.resourceId));
      }}
      onPin={(tabId, pinned) => pinWorkbenchEditor(workspaceId, tabId, pinned)}
      onMove={(tabId, targetGroupId) => moveWorkbenchEditor(workspaceId, tabId, targetGroupId)}
      onSplitRatio={(splitId, ratio) => setWorkbenchSplitRatio(workspaceId, splitId, ratio)}
      renderEditor={(group, tab) => {
        if (!tab) {
          return <div className="p-3 typography-ui text-muted-foreground">{t('filesView.editor.pickFileFromTree')}</div>;
        }
        if (group.groupId === editorWorkbench.activeGroupId) return fileViewer;
        return <ResourceEditorHost workspaceId={workspaceId} workspaceRoot={root} tab={tab} />;
      }}
    />
  ) : fileViewer;

  const editorWithPanel = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">{editorArea}</div>
      {workspaceId ? <WorkbenchPanelArea workspaceId={workspaceId} directory={root} /> : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background relative">
      <Dialogs
        activeDialog={activeDialog}
        dialogData={dialogData}
        dialogInputValue={dialogInputValue}
        onDialogInputChange={setDialogInputValue}
        isDialogSubmitting={isDialogSubmitting}
        onDialogSubmit={handleDialogSubmit}
        onClose={handleCloseDialog}
        inputRef={dialogInputRef}
      />
      {fullscreenViewer}
      {isMobile ? (
        showMobilePageContent ? (
          fileViewer
        ) : (
          treePanel
        )
       ) : mode === 'editor-only' ? (
         <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
             {editorWithPanel}
            </div>
          </div>
       ) : (
         <div className="flex flex-1 min-h-0 min-w-0 gap-3 px-3 pb-3 pt-2">
            {screenWidth >= 700 && (
              <div className="w-72 flex-shrink-0 min-h-0 overflow-hidden">
               {treePanel}
             </div>
           )}
           <div className="flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background">
             {editorWithPanel}
           </div>
         </div>
       )}
    </div>
  );
};
