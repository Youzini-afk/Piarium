import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { syncDesktopSettings } from '@/lib/persistence';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { resetDocumentRegistry } from '@/lib/documents/session';
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
  useFilesViewTabsStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  resetDocumentRegistry();
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  queueMicrotask(() => void syncDesktopSettings());
};
