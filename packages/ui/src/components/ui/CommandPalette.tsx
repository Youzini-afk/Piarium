import React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUIStore } from '@/stores/useUIStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitAllBranches, useGitStore } from '@/stores/useGitStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toast } from '@/components/ui';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { SessionSummary } from '@piarium/protocol';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { getSettingsNavIcon, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { useSettingsPageRegistrations } from '@/lib/settings/surface-registry';
import { useWorkbenchCommandRegistrations } from '@/lib/commands/surface-command-registry';
import { Icon } from "@/components/icon/Icon";
import { McpIcon } from '@/components/icons/McpIcon';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { truncatePathMiddle } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildCommandPaletteFileSearchKey, scoreCommandPaletteFiles } from './commandPaletteFilesState';
import { comparePiSessions, piSessionTitle } from '@/components/pi-session/sessionPresentation';
import {
  openPiSessionFromNavigation,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import {
  refreshMcpSettingsAvailability,
  useMcpSettingsAvailabilityState,
} from '@/lib/settings/mcp-availability';

const EMPTY_PINNED_SESSION_IDS = new Set<string>();

type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: string;
  searchText: string;
  onSelect: () => void;
};

type FileHit = { path: string; name: string; relativePath: string };
const EMPTY_SESSIONS: SessionSummary[] = [];

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

export const CommandPalette: React.FC = () => {
  const { t } = useI18n();

  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const sessionSummaries = usePiSessionStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.summaries : EMPTY_SESSIONS,
    [isCommandPaletteOpen],
  ));
  const catalogCwd = usePiSessionStore((state) => state.catalogCwd);
  const catalogLoaded = usePiSessionStore((state) => state.catalogLoaded);
  const catalogLoading = usePiSessionStore((state) => state.catalogLoading);
  const pinnedSessionIds = useSessionPinnedStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.ids : EMPTY_PINNED_SESSION_IDS,
    [isCommandPaletteOpen],
  ));
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const effectiveDirectory = useEffectiveDirectory();
  const searchFiles = useFileSearchStore((s) => s.searchFiles);
  const { documents, git: gitApi } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((s) => s.ensureStatus);
  const { isMobile } = useDeviceInfo();
  const { runtimeTarget: mcpRuntimeTarget, targetKey: mcpTargetKey } = useResourceRuntimeTarget();
  const mcpAvailability = useMcpSettingsAvailabilityState();
  const mcpInstalled = mcpAvailability.targetKey === mcpTargetKey
    && mcpAvailability.installed === true;
  const settingsPageRegistrations = useSettingsPageRegistrations();
  const workbenchCommandRegistrations = useWorkbenchCommandRegistrations();

  React.useEffect(() => {
    if (!isCommandPaletteOpen) return;
    void refreshMcpSettingsAvailability(mcpRuntimeTarget, mcpTargetKey);
  }, [isCommandPaletteOpen, mcpRuntimeTarget, mcpTargetKey]);

  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : null),
    [effectiveDirectory],
  );

  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) setQuery('');
  }, [isCommandPaletteOpen]);

  React.useEffect(() => {
    if (!isCommandPaletteOpen || catalogLoading || (catalogLoaded && catalogCwd === null)) return;
    void usePiSessionStore.getState().loadCatalog().catch((error) => {
      toast.error('Failed to load Pi sessions', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [catalogCwd, catalogLoaded, catalogLoading, isCommandPaletteOpen]);

  const activeSessions = React.useMemo(
    () => sessionSummaries.filter((session) => session.archivedAt === undefined),
    [sessionSummaries],
  );

  // Lazy-load git status for every session directory we plan to display so that
  // branch labels become available across all projects, not only the active one.
  // Deferred to idle to keep the first render (and the file-search effect) free
  // from a flood of git store updates.
  React.useEffect(() => {
    if (!isCommandPaletteOpen || !gitApi) return;
    const handle = setTimeout(() => {
      const seen = new Set<string>();
      for (const session of activeSessions) {
        const dir = normalizePath(session.cwd);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        void ensureGitStatus(dir, gitApi);
      }
    }, 0);
    return () => clearTimeout(handle);
  }, [isCommandPaletteOpen, activeSessions, gitApi, ensureGitStatus]);

  const close = React.useCallback(() => setCommandPaletteOpen(false), [setCommandPaletteOpen]);
  const run = React.useCallback(
    (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    },
    [close],
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const commands = React.useMemo<CommandEntry[]>(() => {
    const executionContext = { currentDirectory, isMobile };
    return workbenchCommandRegistrations
      .filter((registration) => registration.implementation.isAvailable?.(executionContext) ?? true)
      .map((registration) => {
        const titleKey = isMobile && registration.meta.mobileTitleKey
          ? registration.meta.mobileTitleKey
          : registration.meta.titleKey;
        const title = t(titleKey);
        return {
          id: registration.meta.commandId,
          title,
          icon: <Icon name={registration.meta.icon} className="mr-2 h-4 w-4" />,
          ...(registration.meta.shortcutId ? { shortcutId: registration.meta.shortcutId } : {}),
          searchText: `${title} ${registration.meta.keywords.join(' ')}`,
          onSelect: run(() => registration.implementation.execute(executionContext)),
        } satisfies CommandEntry;
      });
  }, [
    currentDirectory,
    isMobile,
    run,
    t,
    workbenchCommandRegistrations,
  ]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return {
      isVSCode: isVSCodeRuntime(),
      isWeb: !isDesktop && isWebRuntime(),
      isDesktop,
      isMobile,
      mcpInstalled,
    };
  }, [isMobile, mcpInstalled]);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return settingsPageRegistrations
      .map((registration) => registration.meta)
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const iconName = getSettingsNavIcon(page.slug) ?? 'settings-3';
        const keywords = (page.keywords ?? []).join(' ');
        const title = t(page.titleKey);
        return {
          id: `settings:${page.slug}`,
          title,
          icon: page.icon === 'mcp'
            ? <McpIcon className="mr-2 h-4 w-4" />
            : <Icon name={iconName} className="mr-2 h-4 w-4" />,
          searchText: `${title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsPageRegistrations, settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen, t]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const orderedActiveSessions = React.useMemo(() => {
    return activeSessions.slice().sort((left, right) => comparePiSessions(
      left,
      right,
      (session) => isSessionPinned(pinnedSessionIds, session.cwd, session.id),
    ));
  }, [activeSessions, pinnedSessionIds]);

  const allBranches = useGitAllBranches();

  const branchForSession = React.useCallback(
    (dir: string | null): string | null => {
      if (dir) return allBranches.get(dir)?.trim() || null;
      return null;
    },
    [allBranches],
  );

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const [fileResults, setFileResults] = React.useState<FileHit[]>([]);
  const [fileResultsKey, setFileResultsKey] = React.useState('');

  const fileSearchKey = buildCommandPaletteFileSearchKey(currentRoot, trimmedQuery);

  React.useEffect(() => {
    if (!isCommandPaletteOpen) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!fileSearchKey) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!currentRoot) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    let cancelled = false;
    void searchFiles(currentRoot, trimmedQuery, 10, { type: 'file' })
      .then((results) => {
        if (cancelled) return;
        setFileResults(
          results.map((file) => ({
            path: normalizePath(file.path),
            name: file.name,
            relativePath: file.relativePath,
          })),
        );
        setFileResultsKey(fileSearchKey);
      })
      .catch(() => {
        if (!cancelled) {
          setFileResults([]);
          setFileResultsKey(fileSearchKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCommandPaletteOpen, currentRoot, trimmedQuery, fileSearchKey, searchFiles]);

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) return commands.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(commands, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [commands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    return scoreByFuzzyQuery(settingsEntries, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const scoredSessions = React.useMemo(() => {
    if (!hasQuery) return orderedActiveSessions.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(orderedActiveSessions, liveTrimmed, (session) => [
      piSessionTitle(session, t('commandPalette.session.untitled')),
      session.cwd,
      session.firstMessage,
      session.allMessagesText,
    ].join('\n'), {
      threshold: 0.2,
    });
  }, [orderedActiveSessions, liveTrimmed, hasQuery, t]);

  const scoredFiles = React.useMemo(() => {
    if (!isCommandPaletteOpen) return [];
    return scoreCommandPaletteFiles(fileResults, trimmedQuery, fileSearchKey, fileResultsKey);
  }, [isCommandPaletteOpen, fileResults, fileResultsKey, fileSearchKey, trimmedQuery]);

  const isFileSearchStale = isCommandPaletteOpen && fileSearchKey.length > 0 && fileResultsKey !== fileSearchKey;

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const scoredProjects = React.useMemo(() => {
    if (!hasQuery) return [];
    const projectEntries = projects.map((project) => ({
      ...project,
      displayName: project.label || project.path.split('/').pop() || project.path,
      searchText: `${project.label || ''} ${project.path}`,
    }));
    return scoreByFuzzyQuery(projectEntries, liveTrimmed, (p) => p.searchText, {
      limit: 7,
      threshold: 0.4,
    });
  }, [projects, liveTrimmed, hasQuery]);

  const visibleCommands = scoredCommands.map((x) => x.item);
  const visibleSettings = scoredSettings.map((x) => x.item);
  const visibleSessions = scoredSessions.map((x) => x.item);
  const visibleFiles = hasQuery ? scoredFiles.map((x) => x.item) : [];
  const visibleProjects = hasQuery ? scoredProjects.map((x) => x.item) : [];

  const groupOrder = React.useMemo<('commands' | 'settings' | 'sessions' | 'files' | 'projects')[]>(() => {
    if (!hasQuery) return ['commands', 'sessions'];
    const best = (arr: { score: number }[]): number => (arr.length ? arr[0].score : Infinity);
    const groups: { key: 'commands' | 'settings' | 'sessions' | 'files' | 'projects'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      { key: 'sessions', score: best(scoredSessions) },
      { key: 'files', score: best(scoredFiles) },
      { key: 'projects', score: best(scoredProjects) },
    ];
    groups.sort((a, b) => a.score - b.score);
    return groups.map((g) => g.key);
  }, [hasQuery, scoredCommands, scoredSettings, scoredSessions, scoredFiles, scoredProjects]);

  const handleOpenSession = React.useCallback(
    (session: SessionSummary) => {
      close();
      void openPiSessionFromNavigation({
        directory: session.cwd,
        sessionId: session.id,
      }).catch((error) => {
        toast.error('Failed to open Pi session', {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [close],
  );

  const handleOpenFile = React.useCallback(
    async (filePath: string) => {
      if (!currentRoot) return;
      const validation = await validateContextFileOpen(documents, filePath, { directory: currentRoot });
      if (!validation.ok) {
        toast.error(getContextFileOpenFailureMessage(validation.reason));
        return;
      }
      openContextFile(currentRoot, filePath);
      close();
    },
    [currentRoot, documents, openContextFile, close],
  );

  const handleOpenProject = React.useCallback(
    (projectId: string, projectPath: string) => {
      close();
      void startPiSessionDraftFromNavigation({
        directory: projectPath,
        projectId,
      }).catch((error) => {
        toast.error('Failed to create Pi session', {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [close],
  );

  const shortcut = React.useCallback(
    (actionId: string) =>
      formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides)),
    [shortcutOverrides],
  );

  return (
    <Dialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <DialogDescription>{t('commandPalette.description')}</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0" showCloseButton>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-8 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]]:typography-meta"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('commandPalette.input.placeholder')}
          />
          <CommandList>
            <CommandEmpty>{t('commandPalette.empty.noResults')}</CommandEmpty>

            {groupOrder.map((groupKey) => {
              if (groupKey === 'commands' && visibleCommands.length > 0) {
                return (
                  <CommandGroup key="commands">
                    {visibleCommands.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                        {cmd.shortcutId ? (
                          <CommandShortcut>{shortcut(cmd.shortcutId)}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && visibleSettings.length > 0) {
                return (
                  <CommandGroup key="settings">
                    {visibleSettings.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions' && visibleSessions.length > 0) {
                return (
                  <CommandGroup key="sessions">
                    {visibleSessions.map((session) => {
                      const title = piSessionTitle(session, t('commandPalette.session.untitled'));
                      const dir = normalizePath(session.cwd);
                      const branch = branchForSession(dir);
                      return (
                        <CommandItem
                          key={session.id}
                          value={`session:${session.id}`}
                          onSelect={() => handleOpenSession(session)}
                        >
                          <Icon name="chat-ai-3" className="mr-2 h-4 w-4" />
                          <span className="truncate">{title}</span>
                          {branch ? (
                            <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground typography-meta">
                              <Icon name="git-branch" className="h-3 w-3" />
                              <span className="truncate max-w-[160px]">{branch}</span>
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files">
                    {visibleFiles.map((file) => {
                      const display = truncatePathMiddle(file.relativePath || file.name, {
                        maxLength: 80,
                      });
                      return (
                        <CommandItem
                          key={`file:${file.path}`}
                          value={`file:${file.path}`}
                          onSelect={() => {
                            void handleOpenFile(file.path);
                          }}
                        >
                          <FileTypeIcon filePath={file.path} className="mr-2 size-4 shrink-0" />
                          <span className="truncate" aria-label={file.relativePath}>
                            {display}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'projects' && visibleProjects.length > 0) {
                return (
                  <CommandGroup key="projects">
                    {visibleProjects.map((project) => {
                      const displayName = project.displayName;
                      return (
                        <CommandItem
                          key={`project:${project.id}`}
                          value={`project:${project.id}`}
                          onSelect={() => handleOpenProject(project.id, project.path)}
                        >
                          <Icon name="folder" className="mr-2 h-4 w-4" />
                          <span className="truncate">{displayName}</span>
                          <span className="ml-auto inline-flex items-center text-muted-foreground typography-meta truncate max-w-[160px]">
                            {project.path}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              return null;
            })}

            {isFileSearchStale ? (
              <div className="px-3 py-2 typography-meta text-muted-foreground">
                {t('commandPalette.empty.searchingFiles')}
              </div>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
