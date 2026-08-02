import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

export const useChatSearchDirectory = (): string | undefined => {
  const sessionDirectory = usePiSessionStore((state) => (
    state.currentSessionId
      ? state.records[state.currentSessionId]?.snapshot?.cwd
      : undefined
  ));

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);

  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);

  if (sessionDirectory) return sessionDirectory;

  if (activeProjectId) {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (activeProject?.path) {
      return activeProject.path;
    }
  }

  return fallbackDirectory ?? undefined;
};
