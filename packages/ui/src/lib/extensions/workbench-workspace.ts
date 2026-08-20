import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export const useWorkbenchWorkspaceId = (): string | undefined => {
  const documents = useRuntimeAPIs().documents;
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const [workspaceId, setWorkspaceId] = React.useState<string | undefined>();
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setRuntimeEpoch((value) => value + 1);
  }), []);

  React.useEffect(() => {
    if (!currentDirectory) {
      setWorkspaceId(undefined);
      return;
    }
    const generation = getRuntimeEndpointGeneration();
    let cancelled = false;
    void documents.resolveWorkspace({ path: currentDirectory }).then((identity) => {
      if (cancelled || generation !== getRuntimeEndpointGeneration()) return;
      setWorkspaceId(identity.workspaceId);
    }).catch(() => {
      if (!cancelled) setWorkspaceId(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [currentDirectory, documents, runtimeEpoch]);

  return workspaceId;
};
