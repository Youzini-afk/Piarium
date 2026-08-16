import React from 'react';
import type { PiRuntimeSnapshot } from '@piarium/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

const emptySnapshot = (): PiRuntimeSnapshot => ({
  installations: [],
  status: 'discovering',
});

export function usePiRuntimeSnapshot(): {
  snapshot: PiRuntimeSnapshot;
  loading: boolean;
} {
  const { piRuntime } = useRuntimeAPIs();
  const [snapshot, setSnapshot] = React.useState<PiRuntimeSnapshot>(emptySnapshot);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!piRuntime) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const unsubscribe = piRuntime.subscribe((next) => {
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    });
    void piRuntime.getSnapshot().then((next) => {
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [piRuntime]);

  return { loading, snapshot };
}
