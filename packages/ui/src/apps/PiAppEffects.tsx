import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { usePiSessionAutoCleanup } from '@/hooks/usePiSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { resumeAutoReviewRun } from '@/lib/reviewFlow';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';

export function PiAppEffects({ backgroundWorkEnabled }: {
  backgroundWorkEnabled: boolean;
}) {
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    for (const run of Object.values(autoReviewRuns)) {
      if (run.runtimeKey === runtimeKey && run.status === 'running') {
        resumeAutoReviewRun(run.originalSessionID);
      }
    }
  }, [autoReviewRuns]);
  usePiSessionAutoCleanup(backgroundWorkEnabled);
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();
  return null;
}
