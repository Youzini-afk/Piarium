import React from 'react';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type ExplorerFileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

type ExplorerFileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

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

const toComparablePath = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;
  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

const getExplorerDisplayPath = (root: string | null, path: string): string => {
  if (!path) return '';
  const normalizedFilePath = normalizePath(path);
  if (!root || !isPathWithinRoot(normalizedFilePath, root)) return normalizedFilePath;
  const relative = normalizedFilePath.slice(root.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
};

const FileStatusDot: React.FC<{ status: ExplorerFileStatus }> = ({ status }) => {
  const color = {
    open: 'var(--status-info)',
    modified: 'var(--status-warning)',
    'git-modified': 'var(--status-warning)',
    'git-added': 'var(--status-success)',
    'git-deleted': 'var(--status-error)',
  }[status];
  return <span className="size-2 rounded-full" style={{ backgroundColor: color }} />;
};

export const ScrollingFileName: React.FC<{ name: string }> = ({ name }) => {
  const containerRef = React.useRef<HTMLSpanElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;
    const updateOverflow = () => {
      setOverflowing(text.scrollWidth > container.clientWidth + 1);
    };
    updateOverflow();
    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(container);
    resizeObserver.observe(text);
    return () => {
      resizeObserver.disconnect();
    };
  }, [name]);

  return (
    <span ref={containerRef} className="relative block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span ref={textRef} aria-hidden="true" className="invisible absolute whitespace-nowrap">{name}</span>
      {overflowing ? (
        <span className="open-file-name-marquee-track">
          <span className="open-file-name-marquee-item">{name}</span>
          <span className="open-file-name-marquee-item" aria-hidden="true">{name}</span>
        </span>
      ) : (
        <span className="block min-w-0 truncate">{name}</span>
      )}
    </span>
  );
};

type FilesExplorerRowProps = {
  node: ExplorerFileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isMobile: boolean;
  isBrowserClient: boolean;
  alwaysShowActions: boolean;
  status?: ExplorerFileStatus | null;
  badge?: { modified: number; added: number } | null;
  permissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  rightClickMenuPath: string | null;
  setRightClickMenuPath: (path: string | null) => void;
  onSelect: (node: ExplorerFileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
};

const FilesExplorerRow: React.FC<FilesExplorerRowProps> = ({
  node,
  root,
  isExpanded,
  isActive,
  isMobile,
  isBrowserClient,
  alwaysShowActions,
  status,
  badge,
  permissions,
  downloadFile,
  contextMenuPath,
  setContextMenuPath,
  rightClickMenuPath,
  setRightClickMenuPath,
  onSelect,
  onToggle,
  onRevealPath,
  onOpenDialog,
}) => {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;
  const canDownload = !isDir && Boolean(downloadFile);
  const canRevealPath = canReveal && !isBrowserClient;
  const hasMenuActions = canRename || canCreateFile || canCreateFolder || canDelete || canDownload || canRevealPath;

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!hasMenuActions) return;
    event?.preventDefault();
    setRightClickMenuPath(node.path);
  }, [hasMenuActions, node.path, setRightClickMenuPath]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) onToggle(node.path);
    else onSelect(node);
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickMenuPath(null);
    setContextMenuPath(node.path);
  }, [node.path, setContextMenuPath, setRightClickMenuPath]);

  const renderMenuItems = ({
    Item,
    Separator,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
  }) => (
    <>
      {canRename && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('rename', node); }}>
          <Icon name="edit" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.rename')}
        </Item>
      )}
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        void copyTextToClipboard(node.path).then((result) => {
          if (result.ok) {
            toast.success(t('sidebarFilesTree.toast.pathCopied'));
            return;
          }
          toast.error(t('sidebarFilesTree.toast.copyFailed'));
        });
      }}>
        <Icon name="file-copy" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.copyPath')}
      </Item>
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        const relativePath = getExplorerDisplayPath(root, node.path) || node.path;
        void copyTextToClipboard(relativePath).then((result) => {
          if (result.ok) {
            toast.success(t('filesView.toast.relativePathCopied'));
            return;
          }
          toast.error(t('sidebarFilesTree.toast.copyFailed'));
        });
      }}>
        <Icon name="file-copy-2" className="mr-2 size-4" /> {t('filesView.tree.menu.copyRelativePath')}
      </Item>
      {canDownload && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="download" className="mr-2 size-4" /> {t(isBrowserClient ? 'sidebarFilesTree.menu.download' : 'sidebarFilesTree.menu.save')}
        </Item>
      )}
      {canRevealPath && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="mr-2 size-4" /> {t(getRevealLabelKey())}
        </Item>
      )}
      {isDir && (canCreateFile || canCreateFolder) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.newFile')}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.newFolder')}
            </Item>
          )}
        </>
      )}
      {canDelete && (
        <>
          <Separator />
          <Item
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('delete', node); }}
            className="text-destructive focus:text-destructive"
          >
            <Icon name="delete-bin" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.delete')}
          </Item>
        </>
      )}
    </>
  );

  return (
    <ContextMenu open={rightClickMenuPath === node.path} onOpenChange={(open) => setRightClickMenuPath(open ? node.path : null)}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" onContextMenu={!isMobile ? handleContextMenu : undefined} />}>
        <button
          type="button"
          onClick={handleInteraction}
          onContextMenu={!isMobile ? handleContextMenu : undefined}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
            isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
          )}
        >
          {isDir ? (
            isExpanded ? (
              <Icon name="folder-open" className="size-4 flex-shrink-0 text-muted-foreground" />
            ) : (
              <Icon name="folder-3" className="size-4 flex-shrink-0 text-muted-foreground" />
            )
          ) : (
            <FileTypeIcon filePath={node.path} extension={node.extension} className="size-4 flex-shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate typography-meta" title={node.path}>
            {node.name}
          </span>
          {!isDir && status ? <FileStatusDot status={status} /> : null}
          {isDir && badge ? (
            <span className="text-xs flex items-center gap-1 ml-auto mr-1">
              {badge.modified > 0 && <span className="text-[var(--status-warning)]">M{badge.modified}</span>}
              {badge.added > 0 && <span className="text-[var(--status-success)]">+{badge.added}</span>}
            </span>
          ) : null}
        </button>
        {hasMenuActions ? (
          <div className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2',
            alwaysShowActions ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
          )}
          >
            <DropdownMenu
              open={contextMenuPath === node.path}
              onOpenChange={(open) => setContextMenuPath(open ? node.path : null)}
            >
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6" onClick={handleMenuButtonClick}>
                  <Icon name="more-2-fill" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuPath(null)}>
                {renderMenuItems({ Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {renderMenuItems({ Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  );
};

type FilesExplorerProps = {
  isMobile: boolean;
  root: string;
  currentDirectory: string;
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchQueryChange: (value: string) => void;
  searching: boolean;
  searchResults: ExplorerFileNode[];
  rootLoadError: string | null;
  hasTree: boolean;
  childrenByDir: Record<string, ExplorerFileNode[]>;
  loadErrorsByDir: Record<string, string>;
  expandedPaths: string[];
  selectedPath: string | null;
  isBrowserClient: boolean;
  alwaysShowActions: boolean;
  permissions: FilesExplorerRowProps['permissions'];
  downloadFile?: (path: string) => Promise<void>;
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  rightClickMenuPath: string | null;
  setRightClickMenuPath: (path: string | null) => void;
  onSelect: (node: ExplorerFileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: FilesExplorerRowProps['onOpenDialog'];
  onRefreshRoot: () => void;
  onRefreshDirectory: (path: string) => void;
  getFileStatus: (path: string) => ExplorerFileStatus | null;
  getFolderBadge: (dirPath: string) => { modified: number; added: number } | null;
};

export const FilesExplorer: React.FC<FilesExplorerProps> = (props) => {
  const { t } = useI18n();
  const {
    isMobile,
    root,
    currentDirectory,
    searchQuery,
    searchInputRef,
    onSearchQueryChange,
    searching,
    searchResults,
    rootLoadError,
    hasTree,
    childrenByDir,
    loadErrorsByDir,
    expandedPaths,
    selectedPath,
    isBrowserClient,
    alwaysShowActions,
    permissions,
    downloadFile,
    contextMenuPath,
    setContextMenuPath,
    rightClickMenuPath,
    setRightClickMenuPath,
    onSelect,
    onToggle,
    onRevealPath,
    onOpenDialog,
    onRefreshRoot,
    onRefreshDirectory,
    getFileStatus,
    getFolderBadge,
  } = props;

  const renderTree = (dirPath: string, depth: number): React.ReactNode => {
    const nodes = childrenByDir[dirPath] ?? [];
    return nodes.map((node, index) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedPath === node.path;
      const isLast = index === nodes.length - 1;
      return (
        <li key={node.path} className="relative">
          {depth > 0 ? (
            <>
              <span className="absolute top-3.5 left-[-12px] w-3 h-px bg-border/40" />
              {isLast ? (
                <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-background" />
              ) : null}
            </>
          ) : null}
          <FilesExplorerRow
            node={node}
            root={root}
            isExpanded={isExpanded}
            isActive={isActive}
            isMobile={isMobile}
            isBrowserClient={isBrowserClient}
            alwaysShowActions={alwaysShowActions}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={permissions}
            {...(downloadFile ? { downloadFile } : {})}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            rightClickMenuPath={rightClickMenuPath}
            setRightClickMenuPath={setRightClickMenuPath}
            onSelect={onSelect}
            onToggle={onToggle}
            onRevealPath={onRevealPath}
            onOpenDialog={onOpenDialog}
          />
          {isDir && isExpanded ? (
            <ul className="flex flex-col gap-1 ml-3 pl-3 border-l border-border/40 relative">
              {loadErrorsByDir[node.path] ? (
                <li className="flex items-center gap-2 px-2 py-1 typography-meta text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate text-[var(--status-error)]" title={loadErrorsByDir[node.path]}>{loadErrorsByDir[node.path]}</span>
                  <Button variant="ghost" size="xs" className="h-6 gap-1" onClick={() => onRefreshDirectory(node.path)}>
                    <Icon name="refresh" className="size-3.5" />
                    {t('filesView.tree.actions.refreshTitle')}
                  </Button>
                </li>
              ) : null}
              {renderTree(node.path, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  };

  return (
    <section className={cn(
      'flex min-h-0 flex-col overflow-hidden',
      isMobile ? 'h-full w-full bg-background' : 'h-full rounded-xl border border-border/60 bg-background/70',
    )}
    >
      <div className={cn('flex flex-col gap-2 py-2', isMobile ? 'px-3' : 'px-2')}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Icon name="search" className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder={t('filesView.tree.search.placeholder')}
              className="h-8 pl-8 pr-8 typography-meta"
            />
            {searchQuery.trim().length > 0 ? (
              <button
                type="button"
                aria-label={t('filesView.tree.search.clearAria')}
                className="absolute right-2 top-2 inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onSearchQueryChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <Icon name="close" className="size-4" />
              </button>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
                  className="size-8 p-0 flex-shrink-0"
                  title={t('filesView.tree.actions.newFileTitle')}
                  aria-label={t('filesView.tree.actions.newFileTitle')}
                >
                  <Icon name="file-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.newFileTitle')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
                  className="size-8 p-0 flex-shrink-0"
                  title={t('filesView.tree.actions.newFolderTitle')}
                  aria-label={t('filesView.tree.actions.newFolderTitle')}
                >
                  <Icon name="folder-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.newFolderTitle')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => onRefreshRoot()} className="size-8 p-0 flex-shrink-0" title={t('filesView.tree.actions.refreshTitle')} aria-label={t('filesView.tree.actions.refreshTitle')}>
                  <Icon name="refresh" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.refreshTitle')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn('py-2', isMobile ? 'px-3' : 'px-2')}>
        <ul className="flex flex-col">
          {searching ? (
            <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('filesView.tree.search.searching')}
            </li>
          ) : searchResults.length > 0 ? (
            searchResults.map((node) => {
              const isActive = selectedPath === node.path;
              return (
                <li key={node.path}>
                  <button
                    type="button"
                    onClick={() => onSelect(node)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors',
                      isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
                    )}
                  >
                    <FileTypeIcon filePath={node.path} extension={node.extension} className="size-4 flex-shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate typography-meta"
                      style={{ direction: 'rtl', textAlign: 'left' }}
                      title={node.path}
                    >
                      {node.relativePath ?? node.path}
                    </span>
                  </button>
                </li>
              );
            })
          ) : rootLoadError ? (
            <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
              <span className="text-[var(--status-error)]">{rootLoadError}</span>
              <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={() => onRefreshRoot()}>
                <Icon name="refresh" className="size-3.5" />
                {t('filesView.tree.actions.refreshTitle')}
              </Button>
            </li>
          ) : hasTree ? (
            renderTree(root, 0)
          ) : (
            <li className="px-2 py-1 typography-meta text-muted-foreground">{t('filesView.state.loading')}</li>
          )}
        </ul>
      </ScrollableOverlay>
    </section>
  );
};
