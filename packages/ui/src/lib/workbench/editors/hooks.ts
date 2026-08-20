import React from 'react';
import { peekEditorWorkbench, subscribeEditorWorkbench } from './session';
import type { EditorWorkbenchState } from './types';

export const useEditorWorkbench = (workspaceId: string | undefined): EditorWorkbenchState | undefined => (
  React.useSyncExternalStore(
    subscribeEditorWorkbench,
    () => peekEditorWorkbench(workspaceId),
    () => undefined,
  )
);
