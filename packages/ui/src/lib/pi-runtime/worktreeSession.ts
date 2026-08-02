import type { SessionSnapshot } from '@piarium/protocol';
import type { ProjectEntry } from '@/lib/api/types';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import {
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  type PiariumProjectRef,
} from '@/lib/piariumProjectConfig';
import {
  checkPiariumGitRepository,
  createPiariumWorktree,
  removePiariumWorktree,
} from '@/lib/piariumWorktrees';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { createPiSessionFromNavigation } from './sessionNavigation';

export interface PiWorktreeSessionResult {
  branch: string;
  path: string;
  sessionId: string;
}

export interface PiWorktreeSessionRuntime {
  checkIsGitRepository(directory: string): Promise<boolean>;
  createSession(target: { directory: string; projectId: string }): Promise<SessionSnapshot>;
  createWorktree(project: PiariumProjectRef, preferredName: string): Promise<WorktreeMetadata>;
  generateBranchName(): string;
  getActiveProject(): ProjectEntry | null;
  removeWorktree(project: PiariumProjectRef, worktree: WorktreeMetadata): Promise<void>;
  shouldWaitForBootstrap(project: PiariumProjectRef): Promise<boolean>;
  waitForBootstrap(directory: string): Promise<void>;
}

const defaultRuntime: PiWorktreeSessionRuntime = {
  checkIsGitRepository: checkPiariumGitRepository,
  createSession: (target) => createPiSessionFromNavigation(target),
  createWorktree: async (project, preferredName) => {
    const setupCommands = await getWorktreeSetupCommands(project);
    return createPiariumWorktree(project, {
      mode: 'new',
      preferredName,
      branchName: preferredName,
      returnAfterDirectoryCreated: true,
      setupCommands,
    });
  },
  generateBranchName,
  getActiveProject: () => useProjectsStore.getState().getActiveProject() ?? null,
  removeWorktree: (project, worktree) => removePiariumWorktree(project, worktree, { deleteLocalBranch: true }),
  shouldWaitForBootstrap: getWorktreeSetupWaitEnabled,
  waitForBootstrap: waitForWorktreeBootstrap,
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createPiWorktreeSessionWithRuntime = async (
  runtime: PiWorktreeSessionRuntime,
): Promise<PiWorktreeSessionResult> => {
  const activeProject = runtime.getActiveProject();
  if (!activeProject?.path) throw new Error('Select a project before creating a worktree session');
  const project: PiariumProjectRef = { id: activeProject.id, path: activeProject.path };
  if (!await runtime.checkIsGitRepository(project.path)) throw new Error('Worktree sessions require a Git repository');
  const preferredName = runtime.generateBranchName().trim();
  if (!preferredName) throw new Error('Could not generate a worktree branch name');
  const worktree = await runtime.createWorktree(project, preferredName);
  if (await runtime.shouldWaitForBootstrap(project)) await runtime.waitForBootstrap(worktree.path);
  try {
    const session = await runtime.createSession({ directory: worktree.path, projectId: project.id });
    return { branch: worktree.branch || preferredName, path: worktree.path, sessionId: session.sessionId };
  } catch (sessionError) {
    try {
      await runtime.removeWorktree(project, worktree);
    } catch (cleanupError) {
      throw new Error(
        `Failed to create the Pi session (${errorMessage(sessionError)}); the worktree also could not be removed (${errorMessage(cleanupError)})`,
        { cause: sessionError },
      );
    }
    throw sessionError;
  }
};

export const createPiWorktreeSession = async (): Promise<PiWorktreeSessionResult> => (
  createPiWorktreeSessionWithRuntime(defaultRuntime)
);
