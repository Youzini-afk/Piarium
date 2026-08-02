import type { SessionSummary } from '@piarium/protocol';
import { create } from 'zustand';
import { listPiSessions } from '@/lib/pi-runtime/sessions';
import { parseMultiRunSessionTitle } from '@/lib/multirun/title';
import {
  listProjectWorktrees,
  removeProjectWorktree,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';
import { useDirectoryStore } from './useDirectoryStore';
import { usePiSessionStore } from './usePiSessionStore';
import { useProjectsStore } from './useProjectsStore';

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

const pathKey = (value: string): string => {
  const normalized = normalize(value);
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase()
    : normalized;
};

export interface AgentGroupSession {
  branch: string;
  displayLabel: string;
  id: string;
  instanceNumber: number;
  modelId: string;
  path: string;
  providerId: string;
  worktreeMetadata?: WorktreeMetadata;
}

export interface AgentGroup {
  lastActive: number;
  name: string;
  sessionCount: number;
  sessions: AgentGroupSession[];
}

interface DeleteAgentGroupResult {
  failedIds: string[];
  failedWorktreePaths: string[];
}

const resolveProjectRef = (): ProjectRef | null => {
  const directory = useDirectoryStore.getState().currentDirectory;
  const projectsState = useProjectsStore.getState();
  const activeProject = projectsState.activeProjectId
    ? projectsState.projects.find((project) => project.id === projectsState.activeProjectId)
    : undefined;
  const raw = activeProject?.path || directory;
  if (!raw) return null;
  const path = normalize(raw);
  if (!path) return null;
  const project = projectsState.projects.find((candidate) => pathKey(candidate.path) === pathKey(path));
  return { id: project?.id ?? `path:${path}`, path };
};

const resolveProjectRefForWorktree = (session: AgentGroupSession): ProjectRef | null => {
  const projectPath = normalize(session.worktreeMetadata?.projectDirectory ?? '');
  if (!projectPath) return resolveProjectRef();
  const project = useProjectsStore.getState().projects.find((candidate) => (
    pathKey(candidate.path) === pathKey(projectPath)
  ));
  return { id: project?.id ?? `path:${projectPath}`, path: projectPath };
};

export const buildAgentGroups = (
  sessions: SessionSummary[],
  metaByPath: Map<string, WorktreeMetadata>,
): AgentGroup[] => {
  const grouped = new Map<string, AgentGroupSession[]>();
  const summaryById = new Map(sessions.map((session) => [session.id, session]));

  for (const session of sessions) {
    const parsed = parseMultiRunSessionTitle(session.name);
    if (!parsed || parsed.fusion) continue;
    const path = normalize(session.cwd);
    const metadata = metaByPath.get(pathKey(path));
    const entry: AgentGroupSession = {
      branch: metadata?.branch ?? '',
      displayLabel: `${parsed.providerID}/${parsed.modelID}`,
      id: session.id,
      instanceNumber: parsed.index ?? 1,
      modelId: parsed.modelID,
      path,
      providerId: parsed.providerID,
      ...(metadata === undefined ? {} : { worktreeMetadata: metadata }),
    };
    const existing = grouped.get(parsed.groupSlug);
    if (existing) existing.push(entry);
    else grouped.set(parsed.groupSlug, [entry]);
  }

  const groups = [...grouped].map(([name, groupSessions]): AgentGroup => {
    groupSessions.sort((left, right) => {
      const providerOrder = left.providerId.localeCompare(right.providerId);
      if (providerOrder !== 0) return providerOrder;
      const modelOrder = left.modelId.localeCompare(right.modelId);
      return modelOrder !== 0 ? modelOrder : left.instanceNumber - right.instanceNumber;
    });
    const lastActive = groupSessions.reduce((latest, session) => {
      const timestamp = Date.parse(summaryById.get(session.id)?.updatedAt ?? '');
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
    return {
      lastActive,
      name,
      sessionCount: groupSessions.length,
      sessions: groupSessions,
    };
  });
  return groups.sort((left, right) => left.name.localeCompare(right.name));
};

interface AgentGroupsState {
  clearError(): void;
  deleteGroupSessions(
    sessions: AgentGroupSession[],
    options?: { removeWorktrees?: boolean },
  ): Promise<DeleteAgentGroupResult>;
  error: string | null;
  groups: AgentGroup[];
  isLoading: boolean;
  loadGroups(): Promise<void>;
  selectGroup(groupName: string | null): void;
  selectedGroupName: string | null;
  selectedSessionId: string | null;
  selectSession(sessionId: string | null): void;
}

export const useAgentGroupsStore = create<AgentGroupsState>((set, get) => ({
  clearError: () => set({ error: null }),

  deleteGroupSessions: async (sessions, options) => {
    const failedIds: string[] = [];
    const failedWorktreePaths: string[] = [];
    const deletedIds = new Set<string>();
    const results = await Promise.allSettled(sessions.map(async (session) => {
      const deleted = await usePiSessionStore.getState().deleteSession(session.id);
      if (!deleted) throw new Error(`Pi session was not found: ${session.id}`);
      return session.id;
    }));
    results.forEach((result, index) => {
      const id = sessions[index]?.id;
      if (!id) return;
      if (result.status === 'fulfilled') deletedIds.add(id);
      else failedIds.push(id);
    });

    if (options?.removeWorktrees) {
      const byPath = new Map<string, AgentGroupSession[]>();
      for (const session of sessions) {
        if (!session.path) continue;
        const key = pathKey(session.path);
        const existing = byPath.get(key);
        if (existing) existing.push(session);
        else byPath.set(key, [session]);
      }
      for (const pathSessions of byPath.values()) {
        const path = normalize(pathSessions[0]?.path ?? '');
        if (!path || pathSessions.some((session) => failedIds.includes(session.id))) {
          if (path) failedWorktreePaths.push(path);
          continue;
        }
        const projectRef = pathSessions
          .map(resolveProjectRefForWorktree)
          .find((candidate): candidate is ProjectRef => candidate !== null) ?? null;
        if (projectRef && pathKey(projectRef.path) === pathKey(path)) {
          continue;
        }
        const metadata = pathSessions.find((session) => session.worktreeMetadata)?.worktreeMetadata;
        if (!projectRef || !metadata) {
          failedWorktreePaths.push(path);
          continue;
        }
        try {
          await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true });
          const directoryStore = useDirectoryStore.getState();
          if (pathKey(directoryStore.currentDirectory ?? '') === pathKey(path)) {
            directoryStore.setDirectory(projectRef.path, { showOverlay: false });
          }
        } catch {
          failedWorktreePaths.push(path);
        }
      }
    }

    const { selectedGroupName, selectedSessionId } = get();
    if (selectedSessionId && deletedIds.has(selectedSessionId)) {
      set({ selectedSessionId: null });
    }
    if (selectedGroupName) {
      const selectedGroup = get().groups.find((group) => group.name === selectedGroupName);
      if (selectedGroup?.sessions.every((session) => deletedIds.has(session.id))) {
        set({ selectedGroupName: null, selectedSessionId: null });
      }
    }
    await get().loadGroups();
    return { failedIds, failedWorktreePaths };
  },

  error: null,
  groups: [],
  isLoading: false,

  loadGroups: async () => {
    const projectRef = resolveProjectRef();
    if (!projectRef) {
      set({ error: 'No project directory', groups: [], isLoading: false });
      return;
    }
    set({ error: null, isLoading: true });
    try {
      let worktreeError: string | null = null;
      const worktrees = await listProjectWorktrees(projectRef).catch((error) => {
        worktreeError = error instanceof Error ? error.message : String(error);
        return [];
      });
      const metaByPath = new Map<string, WorktreeMetadata>();
      const directories = new Map<string, string>([[pathKey(projectRef.path), normalize(projectRef.path)]]);
      for (const metadata of worktrees) {
        if (!metadata.path) continue;
        const path = normalize(metadata.path);
        directories.set(pathKey(path), path);
        metaByPath.set(pathKey(path), metadata);
      }

      const sessionResults = await Promise.allSettled(
        [...directories.values()].map((directory) => listPiSessions(directory)),
      );
      const summaries = new Map<string, SessionSummary>();
      const failedDirectories: string[] = [];
      sessionResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          failedDirectories.push([...directories.values()][index] ?? projectRef.path);
          return;
        }
        for (const summary of result.value) summaries.set(summary.id, summary);
      });
      const groups = buildAgentGroups([...summaries.values()], metaByPath);
      const messages = [
        worktreeError ? `Worktree discovery failed: ${worktreeError}` : null,
        failedDirectories.length > 0
          ? `Failed to load Pi sessions for ${failedDirectories.length} director${failedDirectories.length === 1 ? 'y' : 'ies'}`
          : null,
      ].filter((message): message is string => message !== null);
      set((state) => {
        const selectedGroup = state.selectedGroupName
          ? groups.find((group) => group.name === state.selectedGroupName)
          : undefined;
        const selectedSessionId = selectedGroup?.sessions.some((session) => session.id === state.selectedSessionId)
          ? state.selectedSessionId
          : selectedGroup?.sessions[0]?.id ?? null;
        return {
          error: messages.length > 0 ? messages.join('\n') : null,
          groups,
          isLoading: false,
          selectedGroupName: selectedGroup ? selectedGroup.name : null,
          selectedSessionId,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load groups',
        isLoading: false,
      });
    }
  },

  selectGroup: (groupName) => {
    if (!groupName) {
      set({ selectedGroupName: null, selectedSessionId: null });
      return;
    }
    const group = get().groups.find((candidate) => candidate.name === groupName);
    set({
      selectedGroupName: groupName,
      selectedSessionId: group?.sessions[0]?.id ?? null,
    });
  },
  selectedGroupName: null,
  selectedSessionId: null,
  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),
}));
