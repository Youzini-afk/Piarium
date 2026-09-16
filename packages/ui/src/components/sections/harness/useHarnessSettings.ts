import React from 'react';
import { getRuntimeKey } from '@piarium/application-client';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { reportSettingsSaveState } from '@/lib/persistence';
import { HarnessSettingsController } from './harness-settings-state';

// Only retain controllers with unfinished edits when their page unmounts.
const controllers = new Map<string, { controller: HarnessSettingsController; users: number }>();

export function useHarnessSettings() {
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const targetKey = JSON.stringify([getRuntimeKey(), cwd]);
  const entry = React.useMemo(() => {
    const existing = controllers.get(targetKey);
    if (existing) return existing;
    // Capture this runtime connection; a delayed save cannot follow a host switch.
    const connection = getPiRuntimeConnection();
    const target = { cwd };
    const controller = new HarnessSettingsController({
      read: async () => (await connection).client.request('settings.get', target),
      write: async (harness, expectedRevision) => (await connection).client.request('settings.update', {
        ...target, scope: 'global', expectedRevision, remove: [], set: { harness },
      }),
    });
    const next = { controller, users: 0 };
    controllers.set(targetKey, next);
    return next;
  }, [cwd, targetKey]);
  const { controller } = entry;
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => {
    entry.users += 1;
    if (controller.getSnapshot().status === 'loading') void controller.load();
    return () => {
      entry.users -= 1;
      const release = () => {
        if (['idle', 'saved'].includes(controller.getSnapshot().status)) {
          if (entry.users === 0 && controllers.get(targetKey) === entry) controllers.delete(targetKey);
          unsubscribe();
        }
      };
      const unsubscribe = controller.subscribe(release);
      // Child text fields flush during unmount; let those edits enter the queue.
      queueMicrotask(release);
    };
  }, [controller, entry, targetKey]);
  React.useEffect(() => {
    if (state.status === 'saving' || state.status === 'saved' || state.status === 'error') {
      reportSettingsSaveState(state.status);
    }
  }, [state.status]);
  return { ...state, update: controller.update, retry: controller.retry, targetKey };
}
