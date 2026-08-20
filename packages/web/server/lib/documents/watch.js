const toResource = (workspaceId, relativePath) => ({
  workspaceId,
  resourceId: relativePath.replace(/\\/g, '/'),
});

const mergeEventType = (previous, next) => (
  previous === 'rename' || next === 'rename' ? 'rename' : 'change'
);

/**
 * Translate the host filesystem watch into invalidation events. File bodies and
 * revisions deliberately stay out of this path: consumers re-read through the
 * document authority, which is the only component allowed to establish a new
 * authoritative revision.
 */
export const createWorkspaceWatcher = ({
  workspaceId,
  rootPath,
  fsModule,
  fsPromises,
  pathModule,
  overflowLimit,
  onEvent,
}) => {
  let sequence = 0;
  let generation = 1;
  let closed = false;
  let watcher = null;
  let reconnectScheduled = false;
  let batch = new Map();
  let batchTimer = null;
  let flushChain = Promise.resolve();

  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };

  const relativeFrom = (absolutePath) => {
    const relative = pathModule.relative(rootPath, absolutePath).replace(/\\/g, '/');
    if (!relative || relative === '.' || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const emit = (event) => {
    if (closed) return;
    onEvent(event);
  };

  const reset = (reason) => {
    batch.clear();
    generation += 1;
    sequence = 0;
    emit({ kind: 'reset', sequence: nextSequence(), reason });
  };

  const flushBatch = async () => {
    const current = batch;
    const capturedGeneration = generation;
    batch = new Map();
    if (current.size === 0 || closed) return;

    for (const [absolutePath, eventType] of current) {
      const resourceId = relativeFrom(absolutePath);
      if (!resourceId) continue;
      const resource = toResource(workspaceId, resourceId);
      let stat = null;
      try {
        stat = await fsPromises.stat(absolutePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (closed || capturedGeneration !== generation) return;

      if (!stat || !stat.isFile()) {
        emit({ kind: 'deleted', sequence: nextSequence(), resource });
      } else {
        emit({
          kind: eventType === 'rename' ? 'created' : 'changed',
          sequence: nextSequence(),
          resource,
        });
      }
    }
  };

  const reportBatchFailure = () => {
    if (closed) return;
    reset('authority-changed');
  };

  const scheduleFlush = () => {
    if (batchTimer || closed) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushChain = flushChain.then(flushBatch, flushBatch).catch(reportBatchFailure);
    }, 20);
  };

  const queuePath = (eventType, filename) => {
    if (closed) return;
    if (!filename) {
      reset('authority-changed');
      return;
    }
    const absolutePath = pathModule.resolve(rootPath, filename);
    const previous = batch.get(absolutePath);
    batch.set(absolutePath, previous ? mergeEventType(previous, eventType) : eventType);
    if (Number.isSafeInteger(overflowLimit) && overflowLimit > 0 && batch.size > overflowLimit) {
      reset('overflow');
      return;
    }
    scheduleFlush();
  };

  const start = () => {
    watcher = fsModule.watch(rootPath, { recursive: true, persistent: false }, (eventType, filename) => {
      queuePath(eventType === 'rename' ? 'rename' : 'change', typeof filename === 'string' ? filename : '');
    });
    watcher.on('error', () => {
      if (closed || reconnectScheduled) return;
      reconnectScheduled = true;
      watcher?.close();
      watcher = null;
      setTimeout(() => {
        reconnectScheduled = false;
        if (closed) return;
        try {
          start();
          reset('reconnected');
        } catch {
          reset('authority-changed');
        }
      }, 0);
    });
  };

  start();

  return {
    get generation() {
      return generation;
    },
    overflow() {
      reset('overflow');
    },
    reconnect() {
      watcher?.close();
      watcher = null;
      start();
      reset('reconnected');
    },
    authorityChanged() {
      reset('authority-changed');
    },
    close() {
      closed = true;
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      batch.clear();
      watcher?.close();
      watcher = null;
    },
  };
};
