import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { usePiSessionAutoCleanup } from '@/hooks/usePiSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { resumeAutoReviewRun } from '@/lib/reviewFlow';
import { getRuntimeKey } from '@piarium/application-client';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

export function PiAppEffects({ backgroundWorkEnabled }: {
  backgroundWorkEnabled: boolean;
}) {
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const clearSessionAttention = usePiSessionStore((state) => state.clearSessionAttention);
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    for (const run of Object.values(autoReviewRuns)) {
      if (run.runtimeKey === runtimeKey && run.status === 'running') {
        resumeAutoReviewRun(run.originalSessionID);
      }
    }
  }, [autoReviewRuns]);
  React.useEffect(() => {
    const clearVisibleSessionAttention = () => {
      if (document.visibilityState !== 'visible' || currentSessionId === null) return;
      clearSessionAttention(currentSessionId);
    };
    clearVisibleSessionAttention();
    document.addEventListener('visibilitychange', clearVisibleSessionAttention);
    window.addEventListener('focus', clearVisibleSessionAttention);
    return () => {
      document.removeEventListener('visibilitychange', clearVisibleSessionAttention);
      window.removeEventListener('focus', clearVisibleSessionAttention);
    };
  }, [clearSessionAttention, currentSessionId]);
  usePiSessionAutoCleanup(backgroundWorkEnabled);
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();
  return null;
}
