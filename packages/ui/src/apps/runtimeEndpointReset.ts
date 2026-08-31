import type { RuntimeEndpointChangedDetail } from '@piarium/application-client';
import { syncDesktopSettings } from '@/lib/persistence';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useFilesExplorerStore } from '@/stores/useFilesExplorerStore';
import { resetDocumentRegistry } from '@/lib/documents/session';
import { resetLanguageServices } from '@/lib/language-services/session';
import { resetRunDebugServices } from '@/lib/run-debug/session';
import { resetAgentEditorCoordination } from '@/lib/agent-editor/session';
import { resetEditorWorkbenchForRuntimeSwitch } from '@/lib/workbench/editors/session';
import { resetIdeWorkbenchLayoutForRuntimeSwitch } from '@/lib/workbench/ide-layout';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  if (detail.previousRuntimeKey) {
    useAutoReviewStore.getState().stopRunningRunsForRuntime(detail.previousRuntimeKey);
  }
  disposeTerminalInputTransport();
  useTerminalStore.getState().clearAll();
  useProjectsStore.getState().resetForRuntimeSwitch();
  useFileSearchStore.getState().resetForRuntimeSwitch();
  useGitStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useFilesExplorerStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  resetEditorWorkbenchForRuntimeSwitch(detail.runtimeKey);
  resetIdeWorkbenchLayoutForRuntimeSwitch();
  resetDocumentRegistry();
  resetLanguageServices();
  resetRunDebugServices();
  resetAgentEditorCoordination();
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  queueMicrotask(() => void syncDesktopSettings());
};
