import React from 'react';
import type { PiRuntimeSnapshot } from '@piarium/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { shouldApplyPiRuntimeSnapshot } from '@/lib/pi-runtime/snapshot-order';

const emptySnapshot = (): PiRuntimeSnapshot => ({
  installations: [],
  revision: 0,
  status: 'discovering',
});

export function usePiRuntimeSnapshot(): {
  snapshot: PiRuntimeSnapshot;
  loading: boolean;
} {
  const { piRuntime } = useRuntimeAPIs();
  const [snapshot, setSnapshot] = React.useState<PiRuntimeSnapshot>(emptySnapshot);
  const [loading, setLoading] = React.useState(true);
  const receivedSnapshotRef = React.useRef(false);
  const revisionRef = React.useRef(0);

  React.useEffect(() => {
    receivedSnapshotRef.current = false;
    revisionRef.current = 0;
    setSnapshot(emptySnapshot());
    if (!piRuntime) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const applySnapshot = (next: PiRuntimeSnapshot) => {
      if (cancelled || !shouldApplyPiRuntimeSnapshot(revisionRef.current, next)) return;
      revisionRef.current = next.revision;
      receivedSnapshotRef.current = true;
      setSnapshot(next);
      setLoading(false);
    };
    const unsubscribe = piRuntime.subscribe(applySnapshot);
    void piRuntime.getSnapshot().then(applySnapshot).catch((error) => {
      if (cancelled) return;
      if (!receivedSnapshotRef.current) {
        setSnapshot({
          installations: [],
          issue: error instanceof Error ? error.message : String(error),
          revision: 0,
          status: 'failed',
        });
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [piRuntime]);

  return { loading, snapshot };
}
